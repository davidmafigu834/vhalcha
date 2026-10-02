-- no-transaction
-- Row Level Security for tenant tables.
-- CREATE ROLE cannot run inside a transaction block, so the migrator applies this file on its own.
-- Roles are created without passwords. Operators set passwords outside this file.
--
-- Policies:
--   tenant_isolation on each organisation_id table, and on organisations.id
--     visible when organisation matches app.current_organisation_id()
--     OR the session user is vhalcha_worker (cross-tenant jobs only)
--   password_reset_tokens has no organisation_id.
--     A token is visible when its user belongs to the active organisation, or the user is vhalcha_worker.
--
-- vhalcha_app: gateway and dashboard. NOBYPASSRLS. Cannot read another tenant by omitting a filter.
-- vhalcha_worker: background jobs. NOBYPASSRLS. Cross-tenant only through the worker exception above.
-- vhalcha_migration: declared for deployment. DDL in this repository is applied by the database owner, not by vhalcha_app.
-- vhalcha_definer: NOLOGIN BYPASSRLS. Owns only the narrow lookup functions below.
--
-- Lookup functions are the only cross-tenant reads available to vhalcha_app.
-- They resolve a virtual-key hash, an email, a session hash, a reset hash, or an organisation slug.
-- They do not accept arbitrary SQL.

create schema if not exists app;

-- Top-level role statements. PostgreSQL rejects CREATE ROLE inside a transaction or a DO block.
-- The migrator applies this file one statement at a time and ignores duplicate_object on retry.
create role vhalcha_definer nologin bypassrls;
create role vhalcha_app login nosuperuser nobypassrls noinherit;
create role vhalcha_worker login nosuperuser nobypassrls noinherit;
create role vhalcha_migration login nosuperuser nobypassrls noinherit;

create or replace function app.current_organisation_id()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('app.current_organisation_id', true), '')::uuid
$$;

create or replace function app.tenant_visible(row_organisation_id uuid)
returns boolean
language sql
stable
as $$
  select current_user = 'vhalcha_worker'
    or row_organisation_id = app.current_organisation_id()
$$;

grant usage on schema app to vhalcha_app, vhalcha_worker, vhalcha_migration;
grant execute on function app.current_organisation_id() to vhalcha_app, vhalcha_worker;
grant execute on function app.tenant_visible(uuid) to vhalcha_app, vhalcha_worker;

grant usage on schema public to vhalcha_app, vhalcha_worker, vhalcha_migration;
grant select on organisations, users, sessions, password_reset_tokens, virtual_api_keys to vhalcha_definer;

grant select, insert, update, delete on
  organisations,
  users,
  sessions,
  password_reset_tokens,
  environments,
  ai_systems,
  virtual_api_keys,
  provider_connections,
  model_access_rules,
  budgets,
  budget_reservations,
  requests,
  usage_events,
  audit_events,
  policy_events,
  spend_summaries
to vhalcha_app, vhalcha_worker;

alter table requests drop constraint if exists requests_status_check;
alter table requests add constraint requests_status_check
  check (status in (
    'pending',
    'provider_started',
    'streaming',
    'succeeded',
    'failed',
    'blocked',
    'reconciliation_required'
  ));

create index if not exists budget_reservations_expiry_idx
  on budget_reservations (status, expires_at);

do $$
declare
  tenant_table text;
begin
  foreach tenant_table in array array[
    'users',
    'sessions',
    'environments',
    'ai_systems',
    'virtual_api_keys',
    'provider_connections',
    'model_access_rules',
    'budgets',
    'budget_reservations',
    'requests',
    'usage_events',
    'audit_events',
    'policy_events',
    'spend_summaries'
  ]
  loop
    execute format('alter table %I enable row level security', tenant_table);
    execute format('alter table %I force row level security', tenant_table);
    execute format('drop policy if exists tenant_isolation on %I', tenant_table);
    execute format(
      'create policy tenant_isolation on %I using (app.tenant_visible(organisation_id)) with check (app.tenant_visible(organisation_id))',
      tenant_table
    );
  end loop;
end $$;

alter table organisations enable row level security;
alter table organisations force row level security;
drop policy if exists tenant_isolation on organisations;
create policy tenant_isolation on organisations
  using (app.tenant_visible(id))
  with check (app.tenant_visible(id));

alter table password_reset_tokens enable row level security;
alter table password_reset_tokens force row level security;
drop policy if exists tenant_isolation on password_reset_tokens;
create policy tenant_isolation on password_reset_tokens
  using (
    current_user = 'vhalcha_worker'
    or exists (
      select 1
      from users
      where users.id = password_reset_tokens.user_id
        and users.organisation_id = app.current_organisation_id()
    )
  )
  with check (
    current_user = 'vhalcha_worker'
    or exists (
      select 1
      from users
      where users.id = password_reset_tokens.user_id
        and users.organisation_id = app.current_organisation_id()
    )
  );

create or replace function app.lookup_virtual_api_key(p_key_hash text)
returns table (
  id uuid,
  organisation_id uuid,
  ai_system_id uuid,
  environment_id uuid,
  name text,
  key_prefix text,
  key_hash text,
  status text,
  created_at timestamptz,
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    id,
    organisation_id,
    ai_system_id,
    environment_id,
    name,
    key_prefix,
    key_hash,
    status,
    created_at,
    expires_at,
    last_used_at,
    revoked_at
  from virtual_api_keys
  where key_hash = p_key_hash
  limit 1
$$;

create or replace function app.lookup_user_by_email(p_email text)
returns table (
  id uuid,
  organisation_id uuid,
  email text,
  name text,
  role text,
  status text,
  password_hash text,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select id, organisation_id, email, name, role, status, password_hash, created_at, updated_at
  from users
  where email = lower(p_email)
  limit 2
$$;

create or replace function app.lookup_user_by_id(p_user_id text)
returns table (
  id uuid,
  organisation_id uuid,
  email text,
  name text,
  role text,
  status text,
  password_hash text,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select id, organisation_id, email, name, role, status, password_hash, created_at, updated_at
  from users
  where id = p_user_id::uuid
  limit 1
$$;

create or replace function app.lookup_session(p_token_hash text)
returns table (
  id uuid,
  user_id uuid,
  organisation_id uuid,
  token_hash text,
  expires_at timestamptz,
  created_at timestamptz,
  revoked_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select id, user_id, organisation_id, token_hash, expires_at, created_at, revoked_at
  from sessions
  where token_hash = p_token_hash
  limit 1
$$;

create or replace function app.lookup_password_reset(p_token_hash text)
returns table (
  id uuid,
  user_id uuid,
  organisation_id uuid,
  token_hash text,
  expires_at timestamptz,
  used_at timestamptz,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select token.id, token.user_id, account.organisation_id, token.token_hash, token.expires_at, token.used_at, token.created_at
  from password_reset_tokens token
  inner join users account on account.id = token.user_id
  where token.token_hash = p_token_hash
  limit 1
$$;

create or replace function app.lookup_organisation_by_slug(p_slug text)
returns table (
  id uuid,
  name text,
  slug text,
  status text,
  default_currency text,
  timezone text,
  content_logging_mode text,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select id, name, slug, status, default_currency, timezone, content_logging_mode, created_at, updated_at
  from organisations
  where slug = p_slug
  limit 1
$$;

alter function app.lookup_virtual_api_key(text) owner to vhalcha_definer;
alter function app.lookup_user_by_email(text) owner to vhalcha_definer;
alter function app.lookup_user_by_id(text) owner to vhalcha_definer;
alter function app.lookup_session(text) owner to vhalcha_definer;
alter function app.lookup_password_reset(text) owner to vhalcha_definer;
alter function app.lookup_organisation_by_slug(text) owner to vhalcha_definer;

revoke all on function app.lookup_virtual_api_key(text) from public;
revoke all on function app.lookup_user_by_email(text) from public;
revoke all on function app.lookup_user_by_id(text) from public;
revoke all on function app.lookup_session(text) from public;
revoke all on function app.lookup_password_reset(text) from public;
revoke all on function app.lookup_organisation_by_slug(text) from public;

grant execute on function app.lookup_virtual_api_key(text) to vhalcha_app;
grant execute on function app.lookup_user_by_email(text) to vhalcha_app;
grant execute on function app.lookup_user_by_id(text) to vhalcha_app;
grant execute on function app.lookup_session(text) to vhalcha_app;
grant execute on function app.lookup_password_reset(text) to vhalcha_app;
grant execute on function app.lookup_organisation_by_slug(text) to vhalcha_app;
