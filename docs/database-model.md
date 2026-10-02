# Database model

PostgreSQL is the durable record. Redis is not a financial source of truth.

Migrations:

- `packages/database/migrations/0001_init.sql`
- `packages/database/migrations/0002_budget_reservations.sql`
- `packages/database/migrations/0003_tenant_rls.sql`
- `packages/database/migrations/0004_knowledge.sql`

`0002` adds `budget_reservations` and a unique index on `usage_events.request_id`. If that table already contains more than one usage row for a request, the migration stops and prints the request ids. It does not delete financial rows. Application identifiers are generated in the application, not by `gen_random_uuid()`.

## Tenant tables

Every table below includes `organisation_id` except `organisations` itself and `password_reset_tokens`. `0003_tenant_rls.sql` enables and forces row level security on these tables. `schema_migrations` is not tenant-scoped. Policies are named `tenant_isolation`. A row is visible when `app.current_organisation_id()` matches it, or when the session user is `vhalcha_worker`. Inserts must match the same check. Lookup functions in schema `app` are the only cross-tenant reads granted to `vhalcha_app`.

| Table | Purpose |
| --- | --- |
| `organisations` | Tenant, status (`active`, `suspended`, `closed`), currency, timezone, content logging mode |
| `users` | Operator account, role, status, password hash |
| `sessions` | Server-side session rows checked with the signed cookie |
| `password_reset_tokens` | Hashed reset tokens |
| `environments` | `development`, `staging`, or `production` |
| `ai_systems` | Connected application, agent, workflow, assistant, or service |
| `virtual_api_keys` | Prefix, hash, status, expiry, last use, revocation |
| `provider_connections` | Provider, credential source, credential reference |
| `model_access_rules` | Provider, model pattern, allow or deny, priority |
| `budgets` | Daily or monthly amount, warning percent, hard limit, `notify` or `block` |
| `budget_reservations` | Estimated hold for one request and budget. Status is `reserved`, `finalized`, `released`, or `expired` |
| `requests` | Metadata for one gateway call |
| `usage_events` | Token counts and cost for a request. `request_id` is unique |
| `audit_events` | Append-only operator and API actions |
| `policy_events` | Budget, model, rate, and status decisions |
| `spend_summaries` | Worker-built daily and monthly totals |

## AI system fields

Status is `active`, `disabled`, `attention`, or `offline`. Traffic is served for `active` and `attention`. Risk is `low`, `medium`, `high`, or `critical`. `requests_per_minute` defaults to 60.

## Requests

`requests` stores provider, model, status, HTTP status, token counts, estimated cost, latency, provider latency, time to first token, policy result, and a safe error message. It does not store prompts or responses.

## Money

Amounts are numeric and cross the TypeScript boundary as strings. Cost calculation uses the pricing registry and writes `usage_events.cost_usd`.

A blocking budget (`hard_limit` or `action = block`) is locked with `SELECT ... FOR UPDATE` while Vhalcha adds committed usage, unexpired reservations, and the new estimate. The new hold is inserted in that same transaction. Finalization of usage, request status, reservation reconciliation, and the completion audit is one later transaction. Retrying that finalization does not insert a second usage row or a second completion audit.

Reservations last 15 minutes. The worker does not drop every old hold. A request that is still `pending`, `blocked`, or `failed`, or that has no request row, becomes `expired` and does not create usage, because the provider was not called. A request in `provider_started`, `streaming`, or `reconciliation_required` with no usage row gets one `usage_events` row at the reserved amount, the holds are finalized, and the request becomes `reconciliation_required`. If usage already exists, leftover holds are finalized to that cost and no second usage row is inserted. A later real completion updates the reconciliation estimate. Expired, released, and finalized rows do not reduce available budget. The index `budget_reservations_expiry_idx` supports the worker scan.

## Content logging

`content_logging_mode` accepts only `metadata_only`. The schema test rejects any other value.

## Knowledge

`0004_knowledge.sql` enables `pgvector` and adds tenant tables: `knowledge_spaces`, `knowledge_sources`, `knowledge_documents`, `knowledge_document_versions`, `knowledge_chunks`, `knowledge_chunk_embeddings`, `ai_system_knowledge_access`, `knowledge_retrieval_events`, and `knowledge_ingestion_usage`. Each has `organisation_id`, forced row level security, and the `tenant_isolation` policy. Child rows also have triggers that reject a parent id the current tenant cannot see.

Embeddings are `vector(1536)`. The HNSW index uses `vector_cosine_ops` with `m = 16` and `ef_construction = 64`. Distance is cosine (`<=>`). Similarity is `1 - distance`. A vector is only compared with rows that store the same `embedding_model` and 1536 dimensions. Changing the embedding model requires reindexing; V1 does not mix dimensions.

`ai_systems` gains `knowledge_enabled` (default false), `strict_grounding` (default false), `knowledge_top_k` (default 6, check 1–20), `minimum_similarity` (default 0.2), and `knowledge_allow_stale` (default false). Existing systems stay off.

Local Docker and CI use `pgvector/pgvector:pg16`. The Postgres 16 data volume can be reused when the image changes. `CREATE EXTENSION vector` runs in the migration. Do not point the Knowledge application connection at the local `vhalcha` superuser in production; use `vhalcha_app` and `vhalcha_worker`.
