# Architecture

Vhalcha is three processes plus PostgreSQL and Redis.

```text
External application
        |
        | Authorization: Bearer vh_test_... or vh_live_...
        v
Gateway (stateless)
        |
        +-- PostgreSQL: keys, systems, budgets, requests, usage, audit
        +-- Redis: rate limits, short caches, idempotency, job queue
        |
        v
OpenAI

Dashboard and worker are separate processes.
They are not on the request path.
```

## Gateway

`POST /v1/chat/completions` runs an explicit pipeline:

1. Confirm PostgreSQL can answer a trivial query.
2. Authenticate the virtual key against PostgreSQL.
3. Load the organisation, environment, and AI system.
4. Reject a suspended organisation or a disabled/offline system.
5. Enforce the AI system rate limit in Redis.
6. Validate the body with a strict Zod schema.
7. Apply model-access rules. No matching allow rule means deny.
8. Refuse an unpriced model when a hard budget is active.
9. Claim a metadata-only idempotency record when the client sends `Idempotency-Key` on a non-streaming call.
10. Atomically reserve the estimated maximum cost against blocking budgets in PostgreSQL.
11. Call the provider adapter, streaming when requested.
12. In one database transaction, write usage, complete the request, reconcile the reservation, and write the audit event.

Process memory holds only the in-flight request and local counters. Budget holds live in `budget_reservations`. Two gateway processes cannot both reserve the same remaining amount because the decision locks the budget rows with `SELECT ... FOR UPDATE`.

## Dashboard

The dashboard is a Next.js application. Session cookies are signed with HMAC. The role is loaded from PostgreSQL on each session read; it is not trusted from the cookie payload.

Server actions enforce permissions before they write. Page reads call `requirePageAccess` before loading data. A hidden button is not the authorization control. Only an organisation owner can change user roles, and the last owner cannot be demoted.

## Worker

The worker rebuilds daily and monthly spend summaries, deletes expired sessions and expired virtual keys, and reconciles budget reservations after `expires_at`. It runs as `vhalcha_worker` in production so those jobs can see every organisation. Gateway and dashboard traffic use `vhalcha_app` and cannot. A hold with no provider call is expired. A hold whose provider call had started is recorded at the reserved amount and marked `reconciliation_required` instead of being forgotten. Summaries are a reporting convenience. The dashboard spend page reads `usage_events` directly, so a stopped worker does not hide current spend. Holds stop counting once `expires_at` passes, even before the worker updates the status.

## Provider boundary

Gateway code depends on the provider interface in `@vhalcha/providers`. OpenAI is the production adapter. `VHALCHA_PROVIDER_MODE=mock` selects a local adapter and is refused when `VHALCHA_ENV=production`. Adding another provider later means a new adapter and a connection record, not a new pipeline.

## Failure behaviour

| Dependency | Behaviour |
| --- | --- |
| PostgreSQL unavailable | The gateway returns `control_plane_unavailable` and does not call the provider. |
| Redis unavailable during rate limiting | The gateway returns `rate_limiter_unavailable` and does not call the provider. |
| Redis unavailable during authentication | Authentication uses PostgreSQL. The key cache is optional. |
| Redis unavailable when `Idempotency-Key` is present | The gateway returns `control_plane_unavailable` and does not call the provider. |
| Dashboard unavailable | Gateway traffic continues. |
| Worker unavailable | Gateway traffic continues. Spend summaries lag; enforcement does not. |
| OpenAI error | The gateway records a failed request and returns `provider_error` or `provider_unavailable`. The upstream body is not forwarded. |
| Knowledge retrieval error while Knowledge is enabled | The gateway returns `knowledge_unavailable` and does not call the model. One failed document index does not take the gateway down. |

## Knowledge

For an AI system with `knowledge_enabled`, the gateway retrieves after model access and before the budget reservation. The reserved estimate includes the retrieved context. Embedding cost is stored on `knowledge_ingestion_usage`, not on chat `usage_events`. Production refuses `VHALCHA_EMBEDDING_MODE=mock`. Details are in `docs/knowledge-architecture.md`.

Budget decisions use PostgreSQL: committed `usage_events` plus unexpired `reserved` rows, locked on the budget row. Redis is not a financial source of truth. The gateway writes `provider_started` before provider I/O. A provider failure releases the hold. A completed call replaces the estimate with the actual cost. If the actual cost is higher than the estimate, the real cost is still stored and a budget warning is recorded. If the process dies after `provider_started` and before finalization, the worker keeps the reserved amount until the request is reconciled.
