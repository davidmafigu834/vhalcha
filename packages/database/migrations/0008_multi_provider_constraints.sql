-- Multi-provider constraint unblock (V1.2.1).
-- Widens provider CHECKs so Anthropic and Google BYOK / model policies can persist.
-- Preserves existing rows, RLS, indexes, and foreign keys.

do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select c.conname
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'provider_connections'
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%provider%'
      and pg_get_constraintdef(c.oid) ilike '%openai%'
  loop
    execute format('alter table provider_connections drop constraint %I', constraint_name);
  end loop;
end $$;

alter table provider_connections
  add constraint provider_connections_provider_check
  check (provider in ('openai', 'anthropic', 'google', 'mock'));

do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select c.conname
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'model_access_rules'
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%provider%'
  loop
    execute format('alter table model_access_rules drop constraint %I', constraint_name);
  end loop;
end $$;

alter table model_access_rules
  add constraint model_access_rules_provider_check
  check (provider in ('openai', 'anthropic', 'google', 'mock'));
