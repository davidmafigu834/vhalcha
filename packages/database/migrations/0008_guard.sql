-- Guard foundation: organisation settings, per-system coverage, security events, and incidents.
-- Existing organisations receive no rows until an administrator or the development seed writes them.
-- Missing settings are treated as monitor mode by the application. This migration does not enable blocking.

create table guard_settings (
  id uuid primary key,
  organisation_id uuid not null unique references organisations (id),
  mode text not null default 'monitor' check (mode in ('monitor', 'protect')),
  enforcement_failure_mode text not null default 'fail_open' check (enforcement_failure_mode in ('fail_open', 'fail_closed', 'fallback')),
  retention_days integer not null default 90 check (retention_days between 7 and 3650),
  audit_logging_enabled boolean not null default true,
  guard_enabled boolean not null default true,
  organisation_label text not null default 'standard' check (organisation_label in ('standard', 'demo')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table guard_system_profiles (
  id uuid primary key,
  organisation_id uuid not null references organisations (id),
  ai_system_id uuid not null references ai_systems (id),
  guard_status text not null check (guard_status in ('protected', 'monitored', 'unprotected', 'unknown')),
  runtime text not null check (runtime in ('vhalcha_gateway', 'direct', 'external', 'unknown')),
  data_access jsonb not null default '[]'::jsonb,
  sensitive_data_unrestricted boolean not null default false,
  overprivileged boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organisation_id, ai_system_id)
);

create index guard_system_profiles_org_idx on guard_system_profiles (organisation_id);

create table guard_events (
  id uuid primary key,
  organisation_id uuid not null references organisations (id),
  ai_system_id uuid references ai_systems (id),
  environment_id uuid references environments (id),
  event_type text not null check (event_type in (
    'policy_violation',
    'prompt_injection',
    'sensitive_data',
    'tool_access',
    'permission_escalation',
    'model_violation',
    'blocked_request',
    'redacted_request',
    'runtime_alert',
    'anomalous_activity',
    'system_event'
  )),
  severity text not null check (severity in ('info', 'low', 'medium', 'high', 'critical')),
  title text not null,
  description text not null default '',
  action_taken text not null check (action_taken in (
    'allow', 'monitor', 'warn', 'redact', 'block', 'require_approval', 'route', 'log'
  )),
  status text not null default 'open' check (status in ('open', 'expected', 'dismissed')),
  provider text,
  model text,
  runtime text,
  actor_label text,
  data_category text check (data_category is null or data_category in (
    'pii', 'financial', 'secrets', 'health', 'confidential', 'source_code', 'custom'
  )),
  policy_name text,
  policy_id uuid,
  policy_version integer,
  request_id uuid references requests (id) on delete set null,
  trace_id text,
  decision_id text,
  evidence_json jsonb not null default '{}'::jsonb,
  metadata_json jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index guard_events_org_time_idx on guard_events (organisation_id, occurred_at desc);
create index guard_events_org_system_idx on guard_events (organisation_id, ai_system_id, occurred_at desc);

create table guard_incidents (
  id uuid primary key,
  organisation_id uuid not null references organisations (id),
  title text not null,
  severity text not null check (severity in ('critical', 'high', 'medium', 'low')),
  status text not null check (status in ('open', 'investigating', 'contained', 'resolved', 'dismissed')),
  owner_user_id uuid references users (id),
  summary text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index guard_incidents_org_status_idx on guard_incidents (organisation_id, status);

grant select, insert, update, delete on
  guard_settings,
  guard_system_profiles,
  guard_events,
  guard_incidents
to vhalcha_app, vhalcha_worker;

alter table guard_settings enable row level security;
alter table guard_settings force row level security;
drop policy if exists tenant_isolation on guard_settings;
create policy tenant_isolation on guard_settings
  using (app.tenant_visible(organisation_id))
  with check (app.tenant_visible(organisation_id));

alter table guard_system_profiles enable row level security;
alter table guard_system_profiles force row level security;
drop policy if exists tenant_isolation on guard_system_profiles;
create policy tenant_isolation on guard_system_profiles
  using (app.tenant_visible(organisation_id))
  with check (app.tenant_visible(organisation_id));

alter table guard_events enable row level security;
alter table guard_events force row level security;
drop policy if exists tenant_isolation on guard_events;
create policy tenant_isolation on guard_events
  using (app.tenant_visible(organisation_id))
  with check (app.tenant_visible(organisation_id));

alter table guard_incidents enable row level security;
alter table guard_incidents force row level security;
drop policy if exists tenant_isolation on guard_incidents;
create policy tenant_isolation on guard_incidents
  using (app.tenant_visible(organisation_id))
  with check (app.tenant_visible(organisation_id));
