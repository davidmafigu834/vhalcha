-- Routing correctness: pricing provenance, one active provider connection,
-- and a tenant-scoped ledger of provider attempts.
-- Prices are updated in place. ON CONFLICT DO NOTHING is not the update path.

alter table model_catalogue
  add column if not exists currency text not null default 'USD',
  add column if not exists price_effective_at timestamptz,
  add column if not exists price_verified_at timestamptz,
  add column if not exists price_source text;

update model_catalogue set
  currency = 'USD',
  price_effective_at = timestamptz '2026-01-01T00:00:00Z',
  price_verified_at = now(),
  price_source = 'Vhalcha mock catalogue fixture. Not a provider invoice.'
where provider = 'mock';

update model_catalogue set
  input_usd_per_million = 2.000000,
  output_usd_per_million = 8.000000,
  currency = 'USD',
  price_effective_at = timestamptz '2025-04-14T00:00:00Z',
  price_verified_at = now(),
  price_source = 'OpenAI published gpt-4.1 standard rates, verified for Vhalcha on 2026-09-29. Cached input is not applied.'
where provider = 'openai' and model_name = 'gpt-4.1';

update model_catalogue set
  input_usd_per_million = 0.400000,
  output_usd_per_million = 1.600000,
  currency = 'USD',
  price_effective_at = timestamptz '2025-04-14T00:00:00Z',
  price_verified_at = now(),
  price_source = 'OpenAI published gpt-4.1-mini standard rates, verified for Vhalcha on 2026-09-29. Cached input is not applied.'
where provider = 'openai' and model_name = 'gpt-4.1-mini';

update model_catalogue set
  input_usd_per_million = 2.500000,
  output_usd_per_million = 10.000000,
  currency = 'USD',
  price_effective_at = timestamptz '2024-08-06T00:00:00Z',
  price_verified_at = now(),
  price_source = 'OpenAI published gpt-4o standard rates, verified for Vhalcha on 2026-09-29. Cached input is not applied.'
where provider = 'openai' and model_name = 'gpt-4o';

update model_catalogue set
  input_usd_per_million = 0.150000,
  output_usd_per_million = 0.600000,
  currency = 'USD',
  price_effective_at = timestamptz '2024-07-18T00:00:00Z',
  price_verified_at = now(),
  price_source = 'OpenAI published gpt-4o-mini standard rates, verified for Vhalcha on 2026-09-29. Cached input is not applied.'
where provider = 'openai' and model_name = 'gpt-4o-mini';

alter table provider_connections
  add column if not exists verification_status text not null default 'unverified';

alter table provider_connections drop constraint if exists provider_connections_verification_status_check;
alter table provider_connections
  add constraint provider_connections_verification_status_check
  check (verification_status in ('unverified', 'verified', 'failed'));

with ranked as (
  select id, row_number() over (
    partition by organisation_id, environment_id, provider
    order by updated_at desc, id desc
  ) as n
  from provider_connections
  where status = 'active'
)
update provider_connections
set status = 'disabled', updated_at = now()
where id in (select id from ranked where n > 1);

create unique index if not exists provider_connections_one_active_idx
  on provider_connections (organisation_id, environment_id, provider)
  where status = 'active';

create table if not exists request_provider_attempts (
  id uuid primary key,
  organisation_id uuid not null references organisations (id),
  request_id uuid not null references requests (id),
  routing_decision_id uuid references routing_decisions (id),
  attempt_number integer not null,
  provider text not null,
  model text not null,
  reason text not null,
  status text not null,
  input_tokens integer,
  output_tokens integer,
  estimated_cost_usd numeric(18, 8),
  actual_cost_usd numeric(18, 8),
  error_code text,
  billable boolean not null default false,
  started_at timestamptz not null,
  completed_at timestamptz,
  constraint request_provider_attempts_status_check check (status in ('succeeded', 'failed', 'escalated')),
  constraint request_provider_attempts_unique unique (organisation_id, request_id, attempt_number)
);

create index if not exists request_provider_attempts_org_request_idx
  on request_provider_attempts (organisation_id, request_id);

grant select, insert, update, delete on request_provider_attempts to vhalcha_app, vhalcha_worker;

alter table request_provider_attempts enable row level security;
alter table request_provider_attempts force row level security;
drop policy if exists tenant_isolation on request_provider_attempts;
create policy tenant_isolation on request_provider_attempts
  using (app.tenant_visible(organisation_id))
  with check (app.tenant_visible(organisation_id));
