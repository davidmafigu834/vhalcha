-- Vhalcha V1 control-plane schema.
-- PostgreSQL is the durable source of truth. Redis is never the only financial record.

create table if not exists schema_migrations (
  id text primary key,
  applied_at timestamptz not null default now()
);

create table organisations (
  id uuid primary key,
  name text not null,
  slug text not null unique,
  status text not null check (status in ('active', 'suspended', 'closed')),
  default_currency text not null default 'USD',
  timezone text not null default 'UTC',
  content_logging_mode text not null default 'metadata_only' check (content_logging_mode in ('metadata_only')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table users (
  id uuid primary key,
  organisation_id uuid not null references organisations (id),
  email text not null,
  name text not null,
  role text not null check (
    role in ('owner', 'ai_admin', 'developer', 'security_admin', 'finance_manager', 'viewer')
  ),
  status text not null check (status in ('active', 'disabled')),
  password_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organisation_id, email)
);

create index users_organisation_idx on users (organisation_id);

create table sessions (
  id uuid primary key,
  user_id uuid not null references users (id) on delete cascade,
  organisation_id uuid not null references organisations (id),
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index sessions_organisation_idx on sessions (organisation_id);

create table password_reset_tokens (
  id uuid primary key,
  user_id uuid not null references users (id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table environments (
  id uuid primary key,
  organisation_id uuid not null references organisations (id),
  name text not null,
  slug text not null,
  type text not null check (type in ('development', 'staging', 'production')),
  created_at timestamptz not null default now(),
  unique (organisation_id, slug)
);

create index environments_organisation_idx on environments (organisation_id);

create table ai_systems (
  id uuid primary key,
  organisation_id uuid not null references organisations (id),
  environment_id uuid not null references environments (id),
  name text not null,
  slug text not null,
  description text not null default '',
  type text not null check (type in ('application', 'agent', 'workflow', 'assistant', 'service')),
  owner_user_id uuid references users (id),
  status text not null check (status in ('active', 'disabled', 'attention', 'offline')),
  risk_level text not null check (risk_level in ('low', 'medium', 'high', 'critical')),
  monthly_budget_usd numeric(14, 6),
  daily_budget_usd numeric(14, 6),
  requests_per_minute integer not null default 60 check (requests_per_minute > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_activity_at timestamptz,
  unique (organisation_id, slug)
);

create index ai_systems_organisation_idx on ai_systems (organisation_id);
create index ai_systems_environment_idx on ai_systems (organisation_id, environment_id);

create table virtual_api_keys (
  id uuid primary key,
  organisation_id uuid not null references organisations (id),
  ai_system_id uuid not null references ai_systems (id),
  environment_id uuid not null references environments (id),
  name text not null,
  key_prefix text not null,
  key_hash text not null unique,
  status text not null check (status in ('active', 'revoked', 'expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz
);

create index virtual_api_keys_organisation_idx on virtual_api_keys (organisation_id, ai_system_id);

create table provider_connections (
  id uuid primary key,
  organisation_id uuid not null references organisations (id),
  environment_id uuid not null references environments (id),
  provider text not null check (provider in ('openai')),
  name text not null,
  status text not null check (status in ('active', 'disabled', 'error')),
  credential_source text not null check (credential_source in ('platform_env', 'customer_managed')),
  credential_ref text,
  encrypted_credentials text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index provider_connections_organisation_idx on provider_connections (organisation_id, environment_id);

create table model_access_rules (
  id uuid primary key,
  organisation_id uuid not null references organisations (id),
  ai_system_id uuid not null references ai_systems (id),
  provider text not null check (provider in ('openai')),
  model_pattern text not null,
  is_allowed boolean not null,
  priority integer not null default 100,
  created_at timestamptz not null default now()
);

create index model_access_rules_system_idx on model_access_rules (organisation_id, ai_system_id, priority);

create table budgets (
  id uuid primary key,
  organisation_id uuid not null references organisations (id),
  ai_system_id uuid references ai_systems (id),
  environment_id uuid references environments (id),
  name text not null,
  period text not null check (period in ('daily', 'monthly')),
  amount_usd numeric(14, 6) not null check (amount_usd >= 0),
  warning_threshold_percent integer not null default 80 check (
    warning_threshold_percent > 0 and warning_threshold_percent <= 100
  ),
  hard_limit boolean not null default false,
  action text not null check (action in ('notify', 'block')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index budgets_organisation_idx on budgets (organisation_id, ai_system_id);

create table requests (
  id uuid primary key,
  organisation_id uuid not null references organisations (id),
  ai_system_id uuid not null references ai_systems (id),
  environment_id uuid not null references environments (id),
  virtual_api_key_id uuid not null references virtual_api_keys (id),
  provider text not null,
  model text not null,
  status text not null check (status in ('pending', 'streaming', 'succeeded', 'failed', 'blocked')),
  http_status integer,
  input_tokens integer,
  output_tokens integer,
  total_tokens integer,
  estimated_cost_usd numeric(18, 8),
  latency_ms integer,
  provider_latency_ms integer,
  time_to_first_token_ms integer,
  policy_result text not null check (policy_result in ('allowed', 'warning', 'blocked')),
  error_code text,
  error_message_safe text,
  started_at timestamptz not null,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create index requests_organisation_created_idx on requests (organisation_id, created_at desc);
create index requests_system_created_idx on requests (organisation_id, ai_system_id, created_at desc);

create table usage_events (
  id uuid primary key,
  organisation_id uuid not null references organisations (id),
  ai_system_id uuid not null references ai_systems (id),
  request_id uuid not null references requests (id),
  provider text not null,
  model text not null,
  input_tokens integer not null,
  output_tokens integer not null,
  total_tokens integer not null,
  cost_usd numeric(18, 8),
  created_at timestamptz not null default now()
);

create index usage_events_organisation_created_idx on usage_events (organisation_id, created_at desc);
create index usage_events_system_created_idx on usage_events (organisation_id, ai_system_id, created_at desc);

create table audit_events (
  id uuid primary key,
  organisation_id uuid not null references organisations (id),
  environment_id uuid references environments (id),
  actor_type text not null check (actor_type in ('user', 'ai_system', 'api', 'system')),
  actor_id text,
  action text not null,
  resource_type text not null,
  resource_id text,
  result text not null check (result in ('success', 'failure', 'blocked')),
  severity text not null check (severity in ('info', 'warning', 'critical')),
  request_id uuid,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index audit_events_organisation_created_idx on audit_events (organisation_id, created_at desc);

create table policy_events (
  id uuid primary key,
  organisation_id uuid not null references organisations (id),
  ai_system_id uuid not null references ai_systems (id),
  request_id uuid,
  policy_type text not null,
  policy_name text not null,
  result text not null check (result in ('allowed', 'warning', 'blocked')),
  severity text not null check (severity in ('info', 'warning', 'critical')),
  details_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index policy_events_organisation_created_idx on policy_events (organisation_id, created_at desc);

create table spend_summaries (
  id uuid primary key,
  organisation_id uuid not null references organisations (id),
  ai_system_id uuid not null references ai_systems (id),
  provider text not null,
  model text not null,
  period text not null check (period in ('daily', 'monthly')),
  period_start timestamptz not null,
  total_cost_usd numeric(18, 8) not null default 0,
  total_requests integer not null default 0,
  total_tokens bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organisation_id, ai_system_id, provider, model, period, period_start)
);
