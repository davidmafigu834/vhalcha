-- Budget holds and one usage row per gateway request.
-- Duplicate usage rows are reported and left in place. They are not deleted.

do $$
declare
  duplicates text;
begin
  select string_agg(request_id::text, ', ' order by request_id::text)
    into duplicates
  from (
    select request_id
    from usage_events
    group by request_id
    having count(*) > 1
  ) duplicated;
  if duplicates is not null then
    raise exception
      'usage_events has duplicate request_id values. Remediate these development rows manually before retrying the migration: %',
      duplicates;
  end if;
end $$;

create unique index if not exists usage_events_request_id_uidx on usage_events (request_id);

create table if not exists budget_reservations (
  id uuid primary key,
  organisation_id uuid not null references organisations (id),
  ai_system_id uuid not null references ai_systems (id),
  request_id uuid not null,
  budget_id uuid not null references budgets (id),
  reserved_usd numeric(18, 8) not null check (reserved_usd >= 0),
  actual_usd numeric(18, 8),
  status text not null check (status in ('reserved', 'finalized', 'released', 'expired')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  finalized_at timestamptz
);

create unique index if not exists budget_reservations_request_budget_uidx
  on budget_reservations (request_id, budget_id);

create index if not exists budget_reservations_hold_idx
  on budget_reservations (budget_id, status, expires_at);

create index if not exists budget_reservations_organisation_idx
  on budget_reservations (organisation_id, created_at desc);
