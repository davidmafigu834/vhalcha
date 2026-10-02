-- Knowledge spaces, documents, versions, chunks, embeddings, and retrieval traces.
-- Requires the pgvector extension. Local Docker and CI use a PostgreSQL 16 image that ships it.
-- Existing migrations 0001-0003 are unchanged.

create extension if not exists vector;

alter table ai_systems
  add column if not exists knowledge_enabled boolean not null default false,
  add column if not exists strict_grounding boolean not null default false,
  add column if not exists knowledge_top_k integer not null default 6,
  add column if not exists minimum_similarity numeric(6, 5) not null default 0.20000,
  add column if not exists knowledge_allow_stale boolean not null default false;

alter table ai_systems drop constraint if exists ai_systems_knowledge_top_k_check;
alter table ai_systems
  add constraint ai_systems_knowledge_top_k_check check (knowledge_top_k between 1 and 20);

create table if not exists knowledge_spaces (
  id uuid primary key,
  organisation_id uuid not null references organisations (id),
  name text not null,
  slug text not null,
  description text not null default '',
  status text not null,
  owner_user_id uuid references users (id),
  default_freshness_days integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint knowledge_spaces_status_check check (status in ('active', 'archived')),
  constraint knowledge_spaces_org_slug_unique unique (organisation_id, slug)
);

create table if not exists knowledge_sources (
  id uuid primary key,
  organisation_id uuid not null references organisations (id),
  knowledge_space_id uuid not null references knowledge_spaces (id),
  name text not null,
  source_type text not null,
  status text not null,
  created_by_user_id uuid references users (id),
  last_sync_at timestamptz,
  last_successful_sync_at timestamptz,
  last_error_code text,
  last_error_safe text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint knowledge_sources_type_check check (source_type in (
    'manual_upload',
    'manual_text',
    'google_drive',
    'sharepoint',
    'onedrive',
    'website',
    'api',
    'database',
    'notion'
  )),
  constraint knowledge_sources_status_check check (status in ('active', 'syncing', 'failed', 'disabled'))
);

create table if not exists knowledge_documents (
  id uuid primary key,
  organisation_id uuid not null references organisations (id),
  knowledge_space_id uuid not null references knowledge_spaces (id),
  knowledge_source_id uuid references knowledge_sources (id),
  title text not null,
  description text,
  document_type text not null,
  mime_type text,
  status text not null,
  current_version_id uuid,
  owner_user_id uuid references users (id),
  effective_date timestamptz,
  expiry_date timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  constraint knowledge_documents_status_check check (status in ('processing', 'ready', 'failed', 'archived'))
);

create table if not exists knowledge_document_versions (
  id uuid primary key,
  organisation_id uuid not null references organisations (id),
  document_id uuid not null references knowledge_documents (id),
  version_number integer not null,
  storage_key text,
  original_filename text,
  mime_type text,
  file_size_bytes bigint,
  content_hash text not null,
  extracted_text text,
  processing_status text not null,
  processing_error_code text,
  processing_error_safe text,
  ingest_attempts integer not null default 0,
  created_by_user_id uuid references users (id),
  created_at timestamptz not null default now(),
  indexed_at timestamptz,
  constraint knowledge_document_versions_status_check check (processing_status in (
    'pending',
    'extracting',
    'chunking',
    'embedding',
    'ready',
    'failed'
  )),
  constraint knowledge_document_versions_number_unique unique (document_id, version_number)
);

alter table knowledge_documents drop constraint if exists knowledge_documents_current_version_fk;
alter table knowledge_documents
  add constraint knowledge_documents_current_version_fk
  foreign key (current_version_id) references knowledge_document_versions (id);

create table if not exists knowledge_chunks (
  id uuid primary key,
  organisation_id uuid not null references organisations (id),
  knowledge_space_id uuid not null references knowledge_spaces (id),
  document_id uuid not null references knowledge_documents (id),
  document_version_id uuid not null references knowledge_document_versions (id) on delete cascade,
  chunk_index integer not null,
  content text not null,
  token_count integer not null,
  page_number integer,
  section_title text,
  content_hash text not null,
  created_at timestamptz not null default now(),
  constraint knowledge_chunks_version_index_unique unique (document_version_id, chunk_index)
);

create table if not exists knowledge_chunk_embeddings (
  id uuid primary key,
  organisation_id uuid not null references organisations (id),
  chunk_id uuid not null references knowledge_chunks (id) on delete cascade,
  embedding_model text not null,
  embedding_dimensions integer not null,
  embedding vector(1536) not null,
  created_at timestamptz not null default now(),
  constraint knowledge_chunk_embeddings_model_unique unique (chunk_id, embedding_model)
);

create index if not exists knowledge_chunk_embeddings_hnsw_idx
  on knowledge_chunk_embeddings
  using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

create table if not exists ai_system_knowledge_access (
  id uuid primary key,
  organisation_id uuid not null references organisations (id),
  ai_system_id uuid not null references ai_systems (id),
  knowledge_space_id uuid not null references knowledge_spaces (id),
  access_level text not null,
  created_at timestamptz not null default now(),
  created_by_user_id uuid references users (id),
  constraint ai_system_knowledge_access_level_check check (access_level in ('read')),
  constraint ai_system_knowledge_access_unique unique (ai_system_id, knowledge_space_id)
);

create table if not exists knowledge_retrieval_events (
  id uuid primary key,
  organisation_id uuid not null references organisations (id),
  request_id uuid not null,
  ai_system_id uuid not null references ai_systems (id),
  knowledge_space_id uuid not null references knowledge_spaces (id),
  document_id uuid not null references knowledge_documents (id),
  document_version_id uuid not null references knowledge_document_versions (id),
  chunk_id uuid not null references knowledge_chunks (id),
  rank integer not null,
  similarity_score numeric(8, 6) not null,
  created_at timestamptz not null default now()
);

create table if not exists knowledge_ingestion_usage (
  id uuid primary key,
  organisation_id uuid not null references organisations (id),
  document_id uuid not null references knowledge_documents (id),
  document_version_id uuid not null references knowledge_document_versions (id),
  embedding_provider text not null,
  embedding_model text not null,
  input_tokens integer not null,
  estimated_cost_usd numeric(14, 6) not null,
  created_at timestamptz not null default now()
);

create index if not exists knowledge_documents_space_idx on knowledge_documents (organisation_id, knowledge_space_id);
create index if not exists knowledge_chunks_version_idx on knowledge_chunks (document_version_id);
create index if not exists knowledge_retrieval_events_request_idx on knowledge_retrieval_events (organisation_id, request_id);

create or replace function app.assert_same_organisation(parent_organisation_id uuid, child_organisation_id uuid)
returns void
language plpgsql
as $$
begin
  if parent_organisation_id is distinct from child_organisation_id then
    raise exception 'knowledge_tenant_mismatch';
  end if;
end;
$$;

create or replace function app.assert_knowledge_source_tenant()
returns trigger
language plpgsql
as $$
declare
  parent_organisation uuid;
begin
  select organisation_id into parent_organisation from knowledge_spaces where id = new.knowledge_space_id;
  if parent_organisation is null then
    raise exception 'knowledge_space_not_visible';
  end if;
  perform app.assert_same_organisation(parent_organisation, new.organisation_id);
  return new;
end;
$$;

create or replace function app.assert_knowledge_document_tenant()
returns trigger
language plpgsql
as $$
declare
  space_organisation uuid;
  source_organisation uuid;
  source_space uuid;
begin
  select organisation_id into space_organisation from knowledge_spaces where id = new.knowledge_space_id;
  if space_organisation is null then
    raise exception 'knowledge_space_not_visible';
  end if;
  perform app.assert_same_organisation(space_organisation, new.organisation_id);
  if new.knowledge_source_id is not null then
    select organisation_id, knowledge_space_id into source_organisation, source_space
    from knowledge_sources where id = new.knowledge_source_id;
    if source_organisation is null or source_space is distinct from new.knowledge_space_id then
      raise exception 'knowledge_source_not_visible';
    end if;
    perform app.assert_same_organisation(source_organisation, new.organisation_id);
  end if;
  return new;
end;
$$;

create or replace function app.assert_knowledge_version_tenant()
returns trigger
language plpgsql
as $$
declare
  parent_organisation uuid;
begin
  select organisation_id into parent_organisation from knowledge_documents where id = new.document_id;
  if parent_organisation is null then
    raise exception 'knowledge_document_not_visible';
  end if;
  perform app.assert_same_organisation(parent_organisation, new.organisation_id);
  return new;
end;
$$;

create or replace function app.assert_knowledge_chunk_tenant()
returns trigger
language plpgsql
as $$
declare
  version_organisation uuid;
  version_document uuid;
begin
  select organisation_id, document_id into version_organisation, version_document
  from knowledge_document_versions where id = new.document_version_id;
  if version_organisation is null or version_document is distinct from new.document_id then
    raise exception 'knowledge_version_not_visible';
  end if;
  perform app.assert_same_organisation(version_organisation, new.organisation_id);
  return new;
end;
$$;

create or replace function app.assert_knowledge_embedding_tenant()
returns trigger
language plpgsql
as $$
declare
  parent_organisation uuid;
begin
  select organisation_id into parent_organisation from knowledge_chunks where id = new.chunk_id;
  if parent_organisation is null then
    raise exception 'knowledge_chunk_not_visible';
  end if;
  perform app.assert_same_organisation(parent_organisation, new.organisation_id);
  if new.embedding_dimensions <> 1536 then
    raise exception 'embedding_dimensions_mismatch';
  end if;
  return new;
end;
$$;

create or replace function app.assert_knowledge_access_tenant()
returns trigger
language plpgsql
as $$
declare
  system_organisation uuid;
  space_organisation uuid;
begin
  select organisation_id into system_organisation from ai_systems where id = new.ai_system_id;
  select organisation_id into space_organisation from knowledge_spaces where id = new.knowledge_space_id;
  if system_organisation is null or space_organisation is null then
    raise exception 'knowledge_access_target_not_visible';
  end if;
  perform app.assert_same_organisation(system_organisation, new.organisation_id);
  perform app.assert_same_organisation(space_organisation, new.organisation_id);
  return new;
end;
$$;

drop trigger if exists knowledge_sources_tenant on knowledge_sources;
create trigger knowledge_sources_tenant
  before insert or update on knowledge_sources
  for each row execute function app.assert_knowledge_source_tenant();

drop trigger if exists knowledge_documents_tenant on knowledge_documents;
create trigger knowledge_documents_tenant
  before insert or update on knowledge_documents
  for each row execute function app.assert_knowledge_document_tenant();

drop trigger if exists knowledge_versions_tenant on knowledge_document_versions;
create trigger knowledge_versions_tenant
  before insert or update on knowledge_document_versions
  for each row execute function app.assert_knowledge_version_tenant();

drop trigger if exists knowledge_chunks_tenant on knowledge_chunks;
create trigger knowledge_chunks_tenant
  before insert or update on knowledge_chunks
  for each row execute function app.assert_knowledge_chunk_tenant();

drop trigger if exists knowledge_embeddings_tenant on knowledge_chunk_embeddings;
create trigger knowledge_embeddings_tenant
  before insert or update on knowledge_chunk_embeddings
  for each row execute function app.assert_knowledge_embedding_tenant();

drop trigger if exists knowledge_access_tenant on ai_system_knowledge_access;
create trigger knowledge_access_tenant
  before insert or update on ai_system_knowledge_access
  for each row execute function app.assert_knowledge_access_tenant();

grant select, insert, update, delete on
  knowledge_spaces,
  knowledge_sources,
  knowledge_documents,
  knowledge_document_versions,
  knowledge_chunks,
  knowledge_chunk_embeddings,
  ai_system_knowledge_access,
  knowledge_retrieval_events,
  knowledge_ingestion_usage
to vhalcha_app, vhalcha_worker;

do $$
declare
  tenant_table text;
begin
  foreach tenant_table in array array[
    'knowledge_spaces',
    'knowledge_sources',
    'knowledge_documents',
    'knowledge_document_versions',
    'knowledge_chunks',
    'knowledge_chunk_embeddings',
    'ai_system_knowledge_access',
    'knowledge_retrieval_events',
    'knowledge_ingestion_usage'
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
