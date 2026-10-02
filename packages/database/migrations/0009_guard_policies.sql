-- Guard policy decisions. Versions are insert-only.
-- This migration does not change gateway request behaviour.

alter table guard_settings
  add column if not exists policy_set_version integer not null default 1;

create table guard_policies (
  id uuid primary key,
  organisation_id uuid not null references organisations (id),
  name text not null,
  description text not null default '',
  category text not null check (category in (
    'data', 'provider', 'model', 'prompt', 'tool', 'agent', 'access', 'runtime', 'security'
  )),
  status text not null check (status in ('draft', 'active', 'disabled')),
  mode text not null check (mode in ('monitor', 'enforce')),
  priority integer not null check (priority between 1 and 1000),
  current_version integer not null check (current_version >= 1),
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organisation_id, name)
);

create index guard_policies_org_status_priority_idx
  on guard_policies (organisation_id, status, priority desc);

create table guard_policy_versions (
  id uuid primary key,
  policy_id uuid not null references guard_policies (id) on delete cascade,
  organisation_id uuid not null references organisations (id),
  version integer not null check (version >= 1),
  scope jsonb not null,
  conditions jsonb not null,
  actions jsonb not null,
  summary text not null,
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  unique (policy_id, version)
);

create index guard_policy_versions_org_policy_idx
  on guard_policy_versions (organisation_id, policy_id, version desc);

create table guard_decisions (
  id uuid primary key,
  organisation_id uuid not null references organisations (id),
  request_id uuid references requests (id) on delete set null,
  trace_id text,
  system_id uuid references ai_systems (id),
  decision text not null,
  effective_mode text not null check (effective_mode in ('monitor', 'enforce')),
  would_enforce_action text,
  would_enforce_policy_id uuid,
  matched_policies jsonb not null default '[]'::jsonb,
  reasons jsonb not null default '[]'::jsonb,
  context_summary jsonb not null default '{}'::jsonb,
  source text not null check (source in ('tester', 'simulation', 'gateway')),
  evaluation_ms integer not null,
  policies_considered integer not null,
  policies_matched integer not null,
  evaluated_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index guard_decisions_org_time_idx on guard_decisions (organisation_id, evaluated_at desc);
create index guard_decisions_org_source_idx on guard_decisions (organisation_id, source);

grant select, insert, update, delete on
  guard_policies,
  guard_policy_versions,
  guard_decisions
to vhalcha_app, vhalcha_worker;

alter table guard_policies enable row level security;
alter table guard_policies force row level security;
drop policy if exists tenant_isolation on guard_policies;
create policy tenant_isolation on guard_policies
  using (app.tenant_visible(organisation_id))
  with check (app.tenant_visible(organisation_id));

alter table guard_policy_versions enable row level security;
alter table guard_policy_versions force row level security;
drop policy if exists tenant_isolation on guard_policy_versions;
create policy tenant_isolation on guard_policy_versions
  using (app.tenant_visible(organisation_id))
  with check (app.tenant_visible(organisation_id));

alter table guard_decisions enable row level security;
alter table guard_decisions force row level security;
drop policy if exists tenant_isolation on guard_decisions;
create policy tenant_isolation on guard_decisions
  using (app.tenant_visible(organisation_id))
  with check (app.tenant_visible(organisation_id));
