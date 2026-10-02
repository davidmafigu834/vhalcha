# Security model

## Trust boundaries

```text
Customer application
  holds a Vhalcha virtual key
  does not hold the OpenAI key

Gateway
  authenticates the virtual key
  enforces status, rate, budget, and model access
  calls OpenAI with the platform credential

PostgreSQL
  durable tenant data and financial usage

Redis
  rate limits, short key cache, idempotency metadata, job queue

Dashboard
  human operators, session cookies, role checks
```

The OpenAI key stays in the gateway environment. Provider connection rows store the variable name `OPENAI_API_KEY` as `credential_ref`. They do not store the secret.

## Customer data flow

A chat request carries messages to the gateway, then to OpenAI, then back to the client. PostgreSQL stores request metadata, token counts, cost, policy result, and a safe error code. It does not store the prompt or the model response.

Non-streaming idempotency stores only a fingerprint hash, the Vhalcha request id, a state, and a timestamp in Redis for 24 hours. It does not store the prompt or the provider completion, and a retry is not a replay of the original body. Streaming requests ignore `Idempotency-Key`.

`organisations.content_logging_mode` is constrained to `metadata_only`. A future customer-controlled logging mode requires a migration. The application does not have a switch that silently starts storing model content.

## Secrets

| Secret | Storage |
| --- | --- |
| Virtual API key | SHA-256 hash and a short prefix. The raw key is returned once. |
| Password | scrypt hash |
| Session cookie | HMAC-signed `vh_session`. HttpOnly, SameSite=Lax, Path=/, max age 12 hours. Secure only when `VHALCHA_ENV=production`. |
| OpenAI key | process environment only |
| Password reset token | hash only |

Virtual keys use at least 32 bytes from `crypto.randomBytes`. Development and staging keys start with `vh_test_`. Production keys start with `vh_live_`. Comparison of the stored hash uses `timingSafeEqual`.

SHA-256 is used because the gateway must look the key up. A password hash that cannot be queried would require scanning every key.

Logs redact authorization headers, cookies, passwords, `vh_test_` and `vh_live_` keys, and `sk-` provider keys. Request logging of the raw gateway body is disabled.

## Tenant isolation

Every tenant-owned row has `organisation_id`, except `password_reset_tokens`, which is reached through its user. Repository methods still filter by organisation. PostgreSQL Row Level Security is the second boundary.

`0003_tenant_rls.sql` enables and forces RLS on the tenant tables. A transaction sets `app.current_organisation_id` with `set_config(..., true)`, so the setting ends with the transaction and does not leak across the connection pool. Policies allow a row only when that setting matches the row, or when `current_user` is `vhalcha_worker`.

Production roles:

| Role | Use |
| --- | --- |
| `vhalcha_app` | Gateway and dashboard. `NOBYPASSRLS`. Production `DATABASE_URL` must use this user. |
| `vhalcha_worker` | Spend summaries, session cleanup, key expiry, and reservation reconciliation. `NOBYPASSRLS`, but the policy lets this user see every tenant because those jobs are cross-tenant. Production worker `DATABASE_URL` must use this user. |
| `vhalcha_migration` | Declared for operators. This repository applies DDL as the database owner, not as `vhalcha_app`. |
| `vhalcha_definer` | `NOLOGIN` and `BYPASSRLS`. Owns only the lookup functions. |

The application role cannot run as a superuser in production. Local Docker uses `vhalcha`, which is a superuser and bypasses RLS. Tests switch to `vhalcha_app` when they need to prove the database boundary.

Unscoped authentication does not disable RLS. `vhalcha_app` may execute six security-definer functions, owned by `vhalcha_definer`: virtual-key hash, email, user id, session hash, password-reset hash, and organisation slug. Each function returns one narrow row. The gateway looks up the virtual key, learns the organisation, sets the tenant context, and then uses ordinary tenant queries. `PUBLIC` cannot execute those functions.

Automated tests create two organisations. As `vhalcha_app`, a query that omits `organisation_id` returns only the active tenant. A direct id from the other tenant returns nothing. An insert or update aimed at the other tenant is rejected or changes zero rows. `budget_reservations` is included. Duplicate usage for one request still fails under RLS.

## Authorization

Permissions are checked in server actions with `assertPermission` and on page loads with `requirePageAccess`. Roles:

| Role | Can read | Can change |
| --- | --- | --- |
| owner | every console page, including API key metadata | everything, including user roles and ownership transfer |
| ai_admin | every console page, including API key metadata | systems, keys, budgets, providers. Cannot change user roles or transfer ownership |
| developer | overview, systems, gateway, spend, settings, API key metadata | systems, keys, budgets |
| security_admin | overview, systems, gateway, spend, audit, settings | nothing in V1. Cannot read or rotate API keys |
| finance_manager | overview, systems, gateway, spend, audit, settings | budgets. Cannot read or manage API keys |
| viewer | overview, systems, gateway, spend, audit, settings | nothing. Cannot read API key metadata |

A user who lacks `api_keys:read` does not receive key prefix, status, last-used time, or expiry. The keys query is not executed. Only an owner may change roles. The last owner cannot be demoted. Role changes write `user.role_changed` with the actor, target user, previous role, and new role. The audit metadata does not include passwords, session tokens, or raw keys.

There is no public registration.

## Platform controls

- Helmet security headers on the gateway
- CORS origins from `ALLOWED_ORIGINS`; empty means no browser origin
- 1 MB request body limit
- Zod strict schema for chat completions
- Parameterized queries through Drizzle
- Startup validation that reports missing variable names, not values
- Rate limit default of 60 requests per minute per AI system
- Budget hard stop returns HTTP 402 and does not call the provider
- Unknown prices stay null and are blocked while a hard budget exists

## Known V1 limitations

- Customer-managed provider credentials are rejected. There is no local encryption stand-in for AWS KMS, GCP KMS, or Azure Key Vault.
- The virtual-key cache is written for 15 seconds and is not used for authorization. Revocation deletes the cache key, and the database status is authoritative.
- Idempotency stores a request fingerprint hash, the Vhalcha request id, and a status. It does not store prompts or provider completions, and it does not replay the original body.
- Streaming requests are not idempotent.
- A reservation lasts 15 minutes. If the provider call was not started, the worker expires the hold and records no cost. If the provider call was started and no usage row exists, the worker records the reserved amount, marks the request `reconciliation_required`, and finalizes the hold. A later completion replaces that estimate once. The unique usage index stays in place.
- Production session secrets must be at least 32 characters, contain at least 16 distinct characters, and must not be a development placeholder. Production database URLs must use `vhalcha_app` for the gateway and dashboard, and `vhalcha_worker` for the worker.
- Gateway latency percentiles on the dashboard use the latest 200 requests in the selected period.
- Development password-reset paths are written to the server log.
- Cache and batch token discounts are not priced separately.
- Knowledge retrieval is a baseline. The prompt tells the model that retrieved text is reference data, not system instructions. That does not stop every prompt injection, and Knowledge does not claim to remove hallucinations.
- Strict grounding returns a fixed insufficient-evidence sentence when no chunk passes the filters. The development mock provider is not asked to invent that refusal.
- Document text is stored in chunks and may be placed in the provider request. It is not copied into audit metadata, retrieval events, idempotency records, or logs.

## Future KMS requirement

A customer-managed connection must store a ciphertext and a key identifier, and the gateway must decrypt it through the customer's KMS at request time. V1 does not invent that service. `credential_source=customer_managed` cannot be created.
