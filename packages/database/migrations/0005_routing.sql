-- Intelligent routing metadata, organisation model access, provider health, and routing decisions.
-- Existing migrations 0001-0004 are unchanged. Existing AI systems stay routing_mode = fixed.

alter table ai_systems
  add column if not exists routing_mode text not null default 'fixed',
  add column if not exists routing_strategy text not null default 'balanced',
  add column if not exists baseline_model_id uuid,
  add column if not exists max_request_cost_usd numeric(18, 8),
  add column if not exists premium_escalation boolean not null default false,
  add column if not exists fallback_enabled boolean not null default true,
  add column if not exists max_provider_attempts integer not null default 2,
  add column if not exists routing_constraints jsonb not null default '{}'::jsonb;

alter table ai_systems drop constraint if exists ai_systems_routing_mode_check;
alter table ai_systems
  add constraint ai_systems_routing_mode_check check (routing_mode in ('fixed', 'optimised'));

alter table ai_systems drop constraint if exists ai_systems_routing_strategy_check;
alter table ai_systems
  add constraint ai_systems_routing_strategy_check check (routing_strategy in ('cost', 'balanced', 'quality', 'latency'));

alter table ai_systems drop constraint if exists ai_systems_max_provider_attempts_check;
alter table ai_systems
  add constraint ai_systems_max_provider_attempts_check check (max_provider_attempts between 1 and 3);

alter table model_access_rules drop constraint if exists model_access_rules_provider_check;
alter table model_access_rules
  add constraint model_access_rules_provider_check check (provider in ('openai', 'mock'));

alter table provider_connections drop constraint if exists provider_connections_credential_source_check;
alter table provider_connections
  add constraint provider_connections_credential_source_check
  check (credential_source in ('platform_env', 'customer_managed', 'organisation', 'vhalcha_managed'));

create table if not exists model_catalogue (
  id uuid primary key,
  provider text not null,
  model_name text not null,
  display_name text not null,
  status text not null,
  tier text not null,
  input_usd_per_million numeric(14, 6) not null,
  output_usd_per_million numeric(14, 6) not null,
  cached_input_usd_per_million numeric(14, 6),
  context_window integer not null,
  max_output_tokens integer not null,
  capabilities jsonb not null,
  reasoning_level text not null,
  latency_class text not null,
  supports_tools boolean not null default false,
  supports_vision boolean not null default false,
  supports_structured_output boolean not null default false,
  supports_streaming boolean not null default true,
  supports_embeddings boolean not null default false,
  supports_long_context boolean not null default false,
  created_at timestamptz not null default now(),
  constraint model_catalogue_status_check check (status in ('active', 'disabled')),
  constraint model_catalogue_tier_check check (tier in ('economy', 'standard', 'premium')),
  constraint model_catalogue_provider_model_unique unique (provider, model_name)
);

alter table ai_systems drop constraint if exists ai_systems_baseline_model_fk;
alter table ai_systems
  add constraint ai_systems_baseline_model_fk
  foreign key (baseline_model_id) references model_catalogue (id);

insert into model_catalogue (
  id, provider, model_name, display_name, status, tier,
  input_usd_per_million, output_usd_per_million, context_window, max_output_tokens,
  capabilities, reasoning_level, latency_class,
  supports_tools, supports_vision, supports_structured_output, supports_streaming, supports_long_context
) values
  (
    '11111111-1111-4111-8111-111111111111', 'mock', 'economy-model', 'Economy', 'active', 'economy',
    0.050000, 0.200000, 1000, 512,
    '["chat","classification"]'::jsonb, 'low', 'fast',
    false, false, false, true, false
  ),
  (
    '22222222-2222-4222-8222-222222222222', 'mock', 'standard-model', 'Standard', 'active', 'standard',
    0.400000, 1.600000, 32000, 4096,
    '["chat","classification","extraction","summarization","structured_output"]'::jsonb, 'medium', 'normal',
    true, false, true, true, false
  ),
  (
    '33333333-3333-4333-8333-333333333333', 'mock', 'premium-model', 'Premium', 'active', 'premium',
    2.000000, 8.000000, 200000, 8192,
    '["chat","classification","extraction","summarization","reasoning","structured_output","long_context"]'::jsonb, 'high', 'slow',
    true, true, true, true, true
  ),
  (
    '44444444-4444-4444-8444-444444444444', 'openai', 'gpt-4.1-mini', 'GPT-4.1 mini', 'active', 'economy',
    0.400000, 1.600000, 128000, 16384,
    '["chat","classification","extraction","summarization","structured_output"]'::jsonb, 'medium', 'fast',
    true, false, true, true, true
  ),
  (
    '55555555-5555-4555-8555-555555555555', 'openai', 'gpt-4.1', 'GPT-4.1', 'active', 'premium',
    2.000000, 8.000000, 128000, 16384,
    '["chat","classification","extraction","summarization","reasoning","structured_output","long_context"]'::jsonb, 'high', 'normal',
    true, false, true, true, true
  ),
  (
    '66666666-6666-4666-8666-666666666666', 'openai', 'gpt-4o-mini', 'GPT-4o mini', 'active', 'economy',
    0.150000, 0.600000, 128000, 16384,
    '["chat","classification","extraction","summarization","vision","structured_output"]'::jsonb, 'medium', 'fast',
    true, true, true, true, true
  ),
  (
    '77777777-7777-4777-8777-777777777777', 'openai', 'gpt-4o', 'GPT-4o', 'active', 'standard',
    2.500000, 10.000000, 128000, 16384,
    '["chat","classification","extraction","summarization","reasoning","vision","structured_output","long_context"]'::jsonb, 'high', 'normal',
    true, true, true, true, true
  )
on conflict (provider, model_name) do nothing;

create table if not exists organisation_model_access (
  id uuid primary key,
  organisation_id uuid not null references organisations (id),
  model_catalogue_id uuid not null references model_catalogue (id),
  status text not null,
  tier_override text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organisation_model_access_status_check check (status in ('allowed', 'blocked')),
  constraint organisation_model_access_tier_check check (
    tier_override is null or tier_override in ('economy', 'standard', 'premium')
  ),
  constraint organisation_model_access_unique unique (organisation_id, model_catalogue_id)
);

create table if not exists provider_health (
  id uuid primary key,
  organisation_id uuid not null references organisations (id),
  environment_id uuid not null references environments (id),
  provider text not null,
  model_name text not null default '',
  status text not null,
  consecutive_failures integer not null default 0,
  cooldown_until timestamptz,
  updated_at timestamptz not null default now(),
  constraint provider_health_status_check check (status in ('healthy', 'degraded', 'unavailable')),
  constraint provider_health_target_unique unique (organisation_id, environment_id, provider, model_name)
);

create table if not exists routing_decisions (
  id uuid primary key,
  organisation_id uuid not null references organisations (id),
  request_id uuid not null references requests (id),
  ai_system_id uuid not null references ai_systems (id),
  routing_mode text not null,
  routing_strategy text not null,
  selected_provider text not null,
  selected_model text not null,
  selected_model_id uuid references model_catalogue (id),
  candidate_count integer not null,
  complexity text not null,
  risk text not null,
  estimated_input_tokens integer not null,
  estimated_output_tokens integer not null,
  estimated_selected_cost numeric(18, 8),
  estimated_baseline_cost numeric(18, 8),
  estimated_savings numeric(18, 8),
  decision_reason jsonb not null default '{}'::jsonb,
  fallback_from text,
  fallback_reason text,
  created_at timestamptz not null default now()
);

create index if not exists routing_decisions_org_created_idx
  on routing_decisions (organisation_id, created_at);

create or replace function app.assert_routing_decision_tenant()
returns trigger
language plpgsql
as $$
begin
  if not exists (
    select 1
    from ai_systems
    where ai_systems.id = new.ai_system_id
      and ai_systems.organisation_id = new.organisation_id
      and app.tenant_visible(ai_systems.organisation_id)
  ) then
    raise exception 'routing_decision_tenant_mismatch';
  end if;
  return new;
end;
$$;

drop trigger if exists routing_decisions_tenant on routing_decisions;
create trigger routing_decisions_tenant
  before insert or update on routing_decisions
  for each row execute function app.assert_routing_decision_tenant();

grant select on model_catalogue to vhalcha_app, vhalcha_worker;

grant select, insert, update, delete on
  organisation_model_access,
  provider_health,
  routing_decisions
to vhalcha_app, vhalcha_worker;

do $$
declare
  tenant_table text;
begin
  foreach tenant_table in array array[
    'organisation_model_access',
    'provider_health',
    'routing_decisions'
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
