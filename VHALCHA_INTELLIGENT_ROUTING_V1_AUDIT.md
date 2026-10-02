# Vhalcha Intelligent Routing V1 audit

Read-only audit of the repository as it exists. No application code was changed. Verdicts below come from source, schema, tests, and commands run in this session.

The commercial sentence "Vhalcha can automatically select a lower-cost approved AI model for simpler workloads while reserving stronger models for workloads that require them" does **not** pass. A narrow mock fixture does that for a short classification prompt. The classifier does not understand task difficulty, and the cost strategy does not select the cheapest capable model once estimated cost leaves the sub-cent range.

## 1. Executive verdict

Intelligent Routing V1 is a real control-plane path, not a UI mock. An optimised AI system can classify a request with heuristics, filter a seeded catalogue, score candidates, persist a routing decision, reserve budget, call the mock or OpenAI adapter, fall back to the next ranked model, and store an estimated saving against an optional baseline.

That path is not safe to present to a design partner as automatic cost optimisation.

- Short text that merely contains the word "classify" can be sent to the economy model. A one-sentence request to analyse a 90-page agreement is classified the same way: low complexity, chat only.
- A long request that both an economy-priced model and a premium-priced model can serve is scored so that **cost, balanced, quality, and latency all select the premium model**. Executed against `selectRoute` for 100,000 input tokens and 2,000 output tokens: economy estimate `$0.0162`, premium estimate `$0.27`, cost-strategy scores `0.136512` versus `0.167952`. The explanation still says "Lowest-cost qualifying route".
- Savings figures are estimates from that same formula. They are not provider invoices and they are not reconciled to actual token cost.
- Fallback can drop a successful, billable first response when premium escalation decides the text is not JSON, and organisation-level budget checks on fallback use the wrong spend query.

The mock proof in the acceptance harness did pass: economy selected, estimated saving `0.00201240`, a long prompt selected premium, a failed economy call fell back to standard, and a tiny budget returned `budget_exceeded`. That proves the fixture. It does not prove the commercial claim.

## 2. What was actually built

| Area | Status | Path |
| --- | --- | --- |
| Gateway | Implemented | `apps/gateway/src/server.ts`, `pipeline.ts`, `route.ts`, `knowledge.ts`, `index.ts`, `metrics.ts` |
| Routing engine | Implemented | `packages/routing/src/select.ts`, `classify.ts`, `price.ts`, `health.ts`, `types.ts`, `index.ts` |
| Routing persistence | Implemented | `packages/database/src/routing.ts`, `packages/database/migrations/0005_routing.sql` |
| Request classifier | Heuristic only | `packages/routing/src/classify.ts` |
| Model catalogue | Seeded global table | `model_catalogue` in `0005_routing.sql`; reads in `packages/database/src/routing.ts` |
| Provider catalogue | Two providers in constraints and prices | `openai`, `mock` in `packages/providers/src/pricing/index.ts` and migration checks |
| Provider adapters | OpenAI HTTP client and mock | `packages/providers/src/openai.ts`, `mock.ts` |
| Provider credentials | Platform env key and encrypted organisation key | `apps/gateway/src/route.ts` `resolveProviderApiKey`; `packages/security/src/index.ts` |
| Provider health | Per model, in Postgres | `provider_health` table; `packages/routing/src/health.ts`; `applyHealth` in `packages/database/src/routing.ts` |
| Circuit breaker | Failure counter plus 60s cooldown, database-backed | `packages/routing/src/health.ts` |
| AI systems | Existing table plus routing columns | `packages/database/src/schema.ts` `aiSystems` |
| Policies | Model allow/deny patterns | `packages/policies/src/index.ts` |
| Budgets | Pre-existing, wired into routing | `packages/budgets/src/index.ts`; `budgetReservations` in `packages/database/src/repositories.ts` |
| Reservations | Reserve, raise, release, expire | same repository methods |
| Usage | Token price from the code price list | `packages/usage/src/index.ts` |
| Knowledge | Unchanged retrieval path, called before routing | `apps/gateway/src/knowledge.ts`, `packages/database/src/knowledge.ts`, `packages/knowledge/src/` |
| Routing decisions | Table and writes | `routing_decisions` in `0005_routing.sql` |
| Savings calculations | Estimated baseline minus estimated selected | `selectRoute` and `savingsSummary` |
| Audit | Metadata-only events | `packages/audit/src/index.ts` |
| RBAC | Role map including routing permissions | `packages/auth/src/index.ts`, `packages/types/src/index.ts` |
| RLS | Forced on new tenant tables | `0005_routing.sql`; session setter `packages/database/src/tenant.ts` |
| Dashboard | Gateway, routing, models, providers | `apps/dashboard/src/app/(console)/gateway/` |
| SDK | OpenAI-shaped client, still requires `model` | `packages/sdk/src/index.ts` |
| Acceptance harness | Live stages, including routing | `apps/gateway/src/acceptance-flow.ts`, `run-acceptance.ts` |
| Guard | Declared and explicitly unimplemented | `packages/routing/src/index.ts` `GuardExtensionPoint` |
| Separate Requests page | Not a route. Request list is `/gateway` | `apps/dashboard/src/app/(console)/gateway/page.tsx` |
| Anthropic or other providers | NOT FOUND | |
| Price refresh job | NOT FOUND | |
| Provider connection test | NOT FOUND | |
| Metrics scrape endpoint | NOT FOUND | |
| Prometheus / OpenTelemetry routing metrics | NOT FOUND | |

## 3. Architecture discovered

Non-streaming optimised request order in `apps/gateway/src/server.ts`:

1. `prepareChat` authenticates the virtual key, loads organisation, AI system, and environment, rate-limits, and checks an OpenAI provider connection.
2. `claimIdempotency` (non-streaming only).
3. `attachKnowledge` injects approved chunks into `messages` when knowledge is enabled.
4. `applyOptimisedRoute` classifies those messages, scores the catalogue, and replaces `provider` and `body.model`.
5. `enforceBudget` reserves using a **different** output-token assumption.
6. `completeChat` inserts the request, records the routing decision, calls the provider, maybe falls back, then finalises usage.

Fixed mode returns immediately from `applyOptimisedRoute` when `routing_mode !== 'optimised'`. The client-supplied model is sent to the provider.

Runtime provider is a single switch. `apps/gateway/src/index.ts` sets `routingRuntime` from `VHALCHA_PROVIDER_MODE`. `selectRoute` rejects every model whose provider is not that runtime (`provider_not_runtime`). Fallback stays inside the already ranked list. There is no cross-vendor failover.

## 4. Production-hardening audit

**Verdict: PASS** for the runtime role split. Migrations remain privileged by design.

| Connection | Credential | Evidence |
| --- | --- | --- |
| Migrations and seed | `DATABASE_ADMIN_URL`, else `DATABASE_URL` | `packages/database/src/migrate.ts`, `seed.ts` |
| Gateway | `DATABASE_URL` must be user `vhalcha_app` | `loadGatewayConfig` in `packages/config/src/index.ts` |
| Dashboard | same, `vhalcha_app` | `loadDashboardConfig` |
| Worker | `WORKER_DATABASE_URL` or `DATABASE_URL`, user `vhalcha_worker` | `loadWorkerConfig`; `apps/worker/src/index.ts` |
| Local example | admin `vhalcha`, app `vhalcha_app`, worker `vhalcha_worker` | `.env.example` |
| Docker database owner | `POSTGRES_USER: vhalcha` | `docker-compose.yml` |

`assertRuntimeDatabaseRole` runs for `development` and `production`. Only `VHALCHA_ENV=test` skips it. Blocked usernames include empty, `postgres`, and `vhalcha`. Production also rejects `VHALCHA_PROVIDER_MODE=mock`, `memory://` Redis, local knowledge storage, a missing `OPENAI_API_KEY` on the gateway, and a placeholder `VHALCHA_SECRETS_KEY` when one is set.

The acceptance harness started through `loadGatewayConfig` against the local `.env` and completed. In development that function refuses any database user other than `vhalcha_app`. Gateway traffic in this environment is not the Docker superuser.

RLS is forced on `organisation_model_access`, `provider_health`, and `routing_decisions`. `usingTenant` sets `app.current_organisation_id` for the transaction. `vhalcha_app` is created `NOBYPASSRLS` in `0003_tenant_rls.sql`. `packages/database/src/rls.test.ts` and `routing.test.ts` `SET ROLE vhalcha_app` and observe hidden rows. Repository queries on the PGlite owner still bypass RLS; those tests prove `WHERE organisation_id`, not the policy.

`model_catalogue` has no RLS. It is a global catalogue. `listCatalogue()` reads it without a tenant scope.

## 5. Routing engine audit

`selectRoute` in `packages/routing/src/select.ts` eliminates candidates, then scores survivors.

Elimination order: wrong runtime provider, provider not in `allowed_providers`, prohibited tier, model access rule denial, health `unavailable`, missing capability, context window, unknown price, max request cost, remaining budget.

Weights:

| Strategy | Cost | Quality | Latency |
| --- | --- | --- | --- |
| cost | 0.8 | 0.1 | 0.1 |
| balanced | 0.4 | 0.35 | 0.25 |
| quality | 0.15 | 0.7 | 0.15 |
| latency | 0.15 | 0.15 | 0.7 |

Quality is the tier: economy `0.25`, standard `0.6`, premium `1`. Latency class: fast `1`, normal `0.65`, slow `0.35`. Degraded health multiplies the score by `0.7`.

Cost is not the dollar amount. It is `1 / (1 + estimatedCostUsd * 1000)`. Once every candidate costs more than about a cent, those ranks collapse toward zero and the 0.1 quality weight dominates the 0.8 cost weight. Tie-break is higher score, then lower estimated cost. Scores are rounded to 6 decimal places. Same inputs produce the same order.

There is no configuration for the weights. The UI labels are Cost, Balanced, Quality, and Latency. The cost explanation string is "Lowest-cost qualifying route" even when a more expensive model won.

Executed result, both models capable, equal latency class, 100,000 in / 2,000 out:

| Strategy | Selected | Scores |
| --- | --- | --- |
| cost | premium `$0.27` | premium `0.167952`, economy `0.136512` |
| balanced | premium | premium `0.513976`, economy `0.273256` |
| quality | premium | premium `0.798054`, economy `0.281221` |
| latency | premium | premium `0.605554`, economy `0.501221` |

On the tiny fixture "Classify this support message." (8 input tokens, 256 output tokens) cost, balanced, and latency select `economy-model` at `$0.0000516`. Quality selects `premium-model` at `$0.002064`.

## 6. Request classifier audit

`HeuristicRequestClassifier` is deterministic keyword and length logic. It does not call another model. It does not read client-supplied complexity, tools, or vision flags. The chat schema is `content: string` only (`packages/types/src/index.ts`).

Rules:

- Input tokens = `ceil(characters / 4)` per message, summed.
- Complexity: `>= 2000` high, `>= 400` medium, otherwise low.
- Output tokens: `max_tokens` if sent, otherwise 2000 / 800 / 256 by complexity.
- Task type `classification` only if the latest user message matches `\bclassify\b`. Otherwise `chat`.
- Capabilities: always `chat`; plus `classification`; plus `reasoning` when complexity is high; plus `long_context` when input tokens `> 6000`; plus `structured_output` when the joined text matches `\bjson\b`.
- `usesTools` is hardcoded `false`. `requiresVision` is hardcoded `false`.
- Risk is copied from the AI system risk level, not from the prompt.

Executed classifications, system risk low:

| Input | Task | Complexity | Tokens in/out | Capabilities | Tools | Vision | JSON |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A. Classify this ticket as billing, sales or support. | classification | low | 13 / 256 | chat, classification | false | false | false |
| B. Summarise this paragraph. | chat | low | 7 / 256 | chat | false | false | false |
| C. Analyse this 90-page acquisition agreement and identify financial, legal and operational risks. | chat | low | 24 / 256 | chat | false | false | false |
| D. Use the CRM tool to update this customer. | chat | low | 11 / 256 | chat | false | false | false |
| E. Read this image and extract invoice values. | chat | low | 11 / 256 | chat | false | false | false |
| F. Return strict JSON matching this schema. | chat | low | 10 / 256 | chat, structured_output | false | false | true |

A, B, C, D, and E are eligible for the mock economy model if the context window fits. F eliminates mock economy because that row has `supports_structured_output = false`. C does not reserve a premium model. Pasting the agreement text until the character count crosses 8,000 bytes would flip complexity to high and require a `reasoning` capability, which mock economy and mock standard do not have.

## 7. Model catalogue

`model_catalogue` stores provider, model name, display name, status, tier, input and output USD per million, optional cached input price, context window, max output tokens, capabilities JSON, reasoning level, latency class, and booleans for tools, vision, structured output, streaming, embeddings, and long context.

Seeded rows in `0005_routing.sql` (insert is `ON CONFLICT DO NOTHING`, so later edits to the migration do not update existing prices):

| Model | Provider | Tier | Input / 1M | Output / 1M | Context | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| economy-model | mock | economy | 0.05 | 0.20 | 1,000 | chat, classification only |
| standard-model | mock | standard | 0.40 | 1.60 | 32,000 | tools and structured output |
| premium-model | mock | premium | 2.00 | 8.00 | 200,000 | reasoning, vision, long context |
| gpt-4.1-mini | openai | economy | 0.40 | 1.60 | 128,000 | no vision, no reasoning tag |
| gpt-4.1 | openai | premium | 2.00 | 8.00 | 128,000 | no vision |
| gpt-4o-mini | openai | economy | 0.15 | 0.60 | 128,000 | vision |
| gpt-4o | openai | standard | 2.50 | 10.00 | 128,000 | vision, reasoning |

The same numbers are hardcoded again in `packages/providers/src/pricing/index.ts`, dated 2025-04-14 and 2024-08-06, with the comment that cached-input and batch discounts are not applied. Routing estimates read the database columns. Final usage cost reads the TypeScript array. They match today only because both were typed from the same snapshot.

There is no admin price update, no provider price API, and no scheduled refresh. `cached_input_usd_per_million` is never read by `estimateModelCost`.

**Savings calculated from these numbers cannot be treated as current provider prices.** Vhalcha would be optimising against a manually maintained snapshot. This audit did not call OpenAI to check whether those rates are still the invoice rates on 29 September 2026.

## 8. Provider architecture

| Provider | Adapter | Chat | Stream | Usage | Errors | Timeout | Credentials | Routing can call it |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OpenAI | `OpenAIProvider` | REAL `POST /v1/chat/completions` | REAL, `include_usage` | REAL `prompt_tokens` / `completion_tokens` | Normalized to `provider_unavailable` or `provider_error` | NOT IMPLEMENTED on non-streaming chat. Streaming abort follows client disconnect only | Bearer key from platform env or decrypted org secret | Yes, when `VHALCHA_PROVIDER_MODE=openai` |
| Mock | `MockModelProvider` | MOCK fixed text and fixed 12/8 tokens | MOCK | MOCK | MOCK via `failModels` or a magic prompt string | n/a | Ignored | Yes, when mode is `mock`. Production refuses mock |
| Any other | NOT IMPLEMENTED | | | | | | | |

`MockModelProvider.id` is `'openai'`. The mock is an adapter, not a second vendor.

## 9. BYOK

Organisation credentials are encrypted with AES-256-GCM before insert (`encryptSecret`). The key is `VHALCHA_SECRETS_KEY`: 32 raw bytes or standard base64 that decodes to 32 bytes. Payload form is `v1.<iv>.<tag>.<ciphertext>`.

Dashboard `providerConnections.list` does not select `encrypted_credentials`. The providers page states that it does not show the key, and the markup does not render one. Connect and disable audits store provider name and source, not the secret. `safeAuditMetadata` drops keys matching prompt, response, message, content, authorization, api key, secret, or password.

`findActive` is scoped by organisation, environment, and provider, inside `usingTenant`. A chat request cannot submit another tenant's `provider_connection_id`; the chat body has no such field.

`platform_env` uses the gateway `OPENAI_API_KEY`. `vhalcha_managed` is stored as a source and then rejected at call time. `customer_managed` is rejected at create time because there is no KMS.

Disable sets status `disabled`. There is no dedicated rotate. A second `connectOrganisation` inserts another active row. `findActive` uses `limit 1` with no order, so two active keys are ambiguous. There is no connection test endpoint.

Production allows an empty `VHALCHA_SECRETS_KEY`. BYOK then fails closed at connect and at decrypt. The platform key is still required for the gateway process to boot.

**Production readiness of BYOK: NOT READY.** Ciphertext is not plaintext, and the dashboard does not receive the raw secret. A single process environment variable is not a tenant key-management design, rotation is incomplete, and connection health is untested.

## 10. Candidate filtering

Filtering happens before scoring, inside the same loop. A rejected model is not scored.

What the code actually eliminates:

- Text-only model when `requiresVision` or capability `vision` is set. The classifier never sets that, and the API cannot send an image, so this branch does not run on gateway traffic.
- Missing tools, same situation: `usesTools` is always false.
- Structured output when the prompt contains `json` and the model flag is false. Mock economy loses prompt F. Mock standard and premium remain.
- Context window smaller than estimated input plus estimated output tokens. Mock economy (1,000) loses a prompt of a few thousand characters.
- Prohibited tier and denied model pattern. Empty model-access rules deny every model, because `decideModelAccess` returns `allowed: false` when nothing matches.
- Organisation catalogue access is default deny. A model with no `organisation_model_access` row is omitted before scoring. It does not even appear in the rejection list.

A cheaper model that fails one of those checks cannot win. A cheaper model that the classifier failed to mark as incompatible can win. That is the vision and tool gap.

## 11. Cost estimation

Unit is USD per 1,000,000 tokens in both `estimateModelCost` and `calculateModelCost`:

`inputTokens / 1_000_000 * inputUsdPerMillion + outputTokens / 1_000_000 * outputUsdPerMillion`, then `toFixed(8)`.

No per-token versus per-1K conversion bug was found in that formula. Cached tokens are ignored. Output tokens used for the routing estimate are `min(estimatedOutputTokens, model.maxOutputTokens)`. The context-window check uses the uncapped output estimate.

Three calculations checked against `estimateModelCost`:

1. "Classify this support message.", 30 characters, 8 input tokens, low complexity, 256 output tokens.
   - Economy `0.05/0.20`: `(8/1e6)*0.05 + (256/1e6)*0.20 = 0.0000516`. Function returned `0.0000516`.
   - Premium `2/8`: `(8/1e6)*2 + (256/1e6)*8 = 0.002064`. Function returned `0.002064`.
   - Difference `0.0020124`. Acceptance stored estimated savings `0.00201240`.

2. 100,000 input and 2,000 output, prices `0.15/0.60` and `2.50/10`.
   - Economy `0.0162`. Premium `0.27`. Ranked costs from `selectRoute` matched both numbers. Selection still chose premium on the cost strategy.

3. Same 8 input tokens reserved by `enforceBudget` when the client omits `max_tokens`. `estimateReservationTokens` uses output cap `4096`, not the classifier's `256`.
   - Economy reservation `(8/1e6)*0.05 + (4096/1e6)*0.20 = 0.0008196`, about 16 times the routing estimate `0.0000516`.
   - The reservation price comes from the TypeScript price list. The routing estimate comes from catalogue columns.

Knowledge text is included in both estimators because it is already prepended to `messages`. The two estimators still disagree on output tokens.

## 12. Baseline and savings

Baseline is optional (`baseline_model_id` nullable). The dashboard offers "Baseline not configured". `estimatedSavings` is null in that case. The gateway page prints "Baseline not configured" and does not invent a dollar saving. Acceptance with a premium baseline stored a positive estimate. That part is honest.

Gaps:

- The baseline is any `model_catalogue` id. `updateSystem` does not require the model to be organisation-approved or allowed by the AI system rules.
- The baseline estimate uses the same input and capped output token counts as the selected model. It does not use the provider's actual usage. That part is correct.
- `estimatedSavings = baselineEstimatedCost - selectedEstimatedCost`, rounded to 8 decimals. If the selected model is more expensive, the value is negative and is stored and summed. The UI can show a negative "Estimated optimisation benefit".
- Same model as baseline yields zero. Missing price on the baseline yields null savings while a selected model can still be returned.
- `savingsSummary` sums those estimate columns. It does not read `usage_events`.
- After fallback, `markFallback` rewrites estimated selected cost and estimated savings to the fallback model. It still does not write actual token cost into the saving.

The routing page says these figures are not invoiced cash savings. The gateway metric is labelled "Estimated optimisation benefit". The request table column is labelled "Cost" and shows `requests.estimated_cost_usd`, which is the token-priced amount from the code price list, not an invoice and not the routing estimate.

## 13. Budget and reservations

Hard budgets (`hardLimit` or `action = block`) participate. Notify-only budgets do not reserve.

`reserve` locks blocking budget rows `FOR UPDATE`, adds committed usage and unexpired holds, and rejects when the projected amount exceeds the budget. `apps/gateway/src/pipeline.test.ts` shows two concurrent reservations where only one can spend the remainder. That test is on the reserve path.

Routing's own remaining-budget filter is weaker. It subtracts `usage.sumCost` for the AI system only. It ignores in-flight holds and ignores organisation and environment spend. A model can pass that filter and then fail in `reserve`, which fails the whole request closed. It does not then try the next cheaper model.

`raise` on fallback is the hole. It always calls `usage.sumCost` for the AI system, including when the blocking budget is organisation-scoped. `reserve` uses `sumOrganisationCost` or `sumEnvironmentCost` for those scopes. `raise` also does not take `FOR UPDATE`. If the new estimate is less than or equal to the current hold, `raise` leaves the hold unchanged, which avoids shrinking it.

Candidate A at a routing estimate of `$0.01` and candidate B at `$0.20`, with `$0.05` remaining, will reject B inside `selectRoute` when `remainingBudgetUsd` is actually `0.05`. There is no policy flag that lets B override that check. If the remaining figure was computed too high because other systems' spend was ignored, B can be selected and then `reserve` should still reject it for an organisation budget. `raise` can accept B later using the AI-system-only spend figure.

When no model fits, the gateway throws `budget_exceeded` (402) if every relevant rejection is over budget, otherwise `no_compatible_model` (422), `context_too_large` (400), or `pricing_unknown` (403). Acceptance observed `budget_exceeded` after the budget was set to `0.0000001`.

Actual tokens can exceed the hold. Finalisation sets `overrun` and still records the actual token price. The hard limit is a limit on the estimate, not a ceiling on the invoice.

Reservation TTL is 15 minutes. If the provider was started and no usage row exists, expiry writes a usage row equal to the reserved amount and marks the request `reconciliation_required`.

## 14. Knowledge integration

Knowledge V1 behaviour is still in the retrieve SQL and the gateway:

- Grants: only `read` grants for that AI system, then intersected with requested space ids.
- Current version: `knowledge_documents.current_version_id = versions.id`.
- Expired and not-yet-effective documents are excluded.
- Stale chunks are excluded unless `knowledge_allow_stale` is true, and strict grounding forces that flag off.
- Strict grounding with nothing retrieved returns the insufficient-knowledge response and does not call the provider. Acceptance stage `strict grounding insufficient evidence` passed.
- Citations are marker-based (`selectCitedSources`). Invented markers are dropped. Acceptance returned citation `S1`.
- Retrieval exceptions become `knowledge_unavailable` (503) and an audit event. The provider is not called.

**Order:** `attachKnowledge` runs before `applyOptimisedRoute`. The classifier and the context-window check see the injected system message. Cost estimation uses that final context. This is the right order.

The acceptance stage `knowledge context eliminates economy` is not an isolated proof. The user message itself is `Summarise the approved note.` plus 4,500 `A` characters, about 1,132 tokens, plus an 800-token medium-complexity output estimate. That already exceeds the economy context window of 1,000 before retrieval is considered. The code path would also eliminate economy if only the retrieved text pushed the total over 1,000. The harness does not demonstrate that distinction.

Knowledge failure after the idempotency key is claimed does not clear the key. A retry can sit on `pending` until the 24 hour TTL.

## 15. Fallback and escalation

Fallback is bounded by `max_provider_attempts` (database check 1 to 3, default 2). The loop stops when `nextFallback` returns null. There is no infinite retry.

`nextFallback` walks the original ranked list. It does not re-run capability, health, policy, or credential checks. Those were applied when the list was built. Budget is re-checked only through `raise`. A model that was forbidden never entered the list, so it cannot be chosen later. A model that exceeds the raised hold causes `moveToFallback` to return false. For a provider error, the original error is then thrown. The forbidden or over-budget model is not called.

Premium escalation is a separate flag, default false. When it is on, fallback prefers a higher tier if one remains, for every reason including `provider_error`. The only quality trigger implemented is: non-streaming response, `requiresStructuredOutput`, and the assistant text does not contain `{`. There is no evaluator, no tool-contract check, and no confidence score. Streaming does not escalate.

Acceptance with escalation off: failing `economy-model` fell back to `standard-model` and wrote `routing.fallback.completed`.

`routing.fallback.started` and `routing.fallback.failed` exist as action names and are never written.

## 16. Streaming

`openStreamWithFallback` retries only until a stream opens. `writeHead` happens after that. A failure before the first byte can switch models, and the client has not received tokens yet.

A failure after the first byte, or halfway through, is caught in `streamChat`, treated as a disconnect, and finalised as `client_disconnected` with whatever usage the open stream had parsed. A second model is not opened. Outputs are not concatenated.

Health is marked success when the stream opens, before it finishes. A mid-stream failure does not open the circuit.

Structured-output escalation does not run on streams. Idempotency is disabled when `stream` is true.

## 17. Idempotency

Non-streaming requests with an `Idempotency-Key` header of 1 to 200 characters take a Redis `setIfAbsent` lock for 24 hours. The stored value is state, request id, and a SHA-256 of the canonical body. The test `does not store a distinctive completion in redis` confirms the completion body is absent.

A second identical call after success returns 409 `idempotent_request_already_completed` and does not call the provider, create another reservation, or write another routing decision. `pipeline.test.ts` asserts one chat call and one usage row. The test name says "replays". The assertion is a 409, not a replayed body.

A different body with the same key is `idempotency_conflict`. A `pending` or `failed` record also blocks the key. Failed work cannot be retried with the same key for 24 hours, and the client does not receive the original payload.

The lock is Redis, not the same transaction as the reservation. A crash between claim and completion can leave `pending`.

## 18. Provider health and circuit breaker

States are `healthy`, `degraded`, and `unavailable`.

- No row: treated as healthy.
- One failure: stays healthy, counter 1.
- Two failures: degraded.
- Three failures: unavailable until `cooldown_until` (60 seconds).
- After cooldown, `effectiveHealth` returns degraded, not healthy, until a success.
- Unavailable models are removed before scoring. Degraded models stay eligible with a 0.7 score multiplier.

State is a row in `provider_health` keyed by organisation, environment, provider, and model name. It is not process memory and not Redis. Multiple gateway instances share it if they share Postgres.

`applyHealth` reads and writes the row without `FOR UPDATE` or an atomic increment. Two instances can lose updates. The breaker is per model. An OpenAI outage does not open one provider-level circuit; each model must fail on its own. The next request can still select a model until that model's counter reaches three. The in-request fallback does not wait for the breaker.

## 19. Database and RLS

Migration `0005_routing.sql` adds routing columns on `ai_systems` with defaults, creates the catalogue, organisation model access, provider health, and routing decisions, and grants DML to `vhalcha_app` and `vhalcha_worker`.

`routing_decisions` has a trigger `app.assert_routing_decision_tenant` so the AI system must belong to the same organisation and be tenant-visible.

`routing.test.ts` inserts a decision as the database owner, `SET ROLE vhalcha_app`, and asserts an unscoped `select id from routing_decisions` returns zero rows. `findByRequest` for the owning organisation returns the row. `savingsSummary` for the other organisation returns zero decisions.

`vhalcha_worker` can see every tenant through `app.tenant_visible`. That is the documented worker exception. The worker uses it for reservation expiry and spend summaries.

## 20. RBAC

Permissions live in `packages/types/src/index.ts`. The map is `packages/auth/src/index.ts`. Dashboard mutations call `requirePermission`. Pages call `requirePageAccess`.

| Role | Routing read | Routing write | Model allow/block (`routing:manage`) | Spend read | Provider read | Provider connect (`providers:write`) |
| --- | --- | --- | --- | --- | --- | --- |
| Owner | yes | yes | yes | yes | yes | yes |
| AI Admin | yes | yes | yes | yes | yes | yes |
| Finance Manager | yes | no | no | yes | no | no |
| Security Admin | yes | no | no | yes | yes | no |
| Developer | yes | no | no | yes | yes | no |
| Viewer | yes | no | no | yes | yes | no |

Provider secrets are not a read permission. The list query omits the ciphertext. Viewer and security admin can see provider name, status, and credential source.

Server actions scope updates by `session.claims.oid`. Passing another organisation's AI system id matches zero rows.

## 21. Tenant isolation

Chat identity is the virtual key's organisation, environment, and AI system. The body cannot name another organisation's AI system, provider connection, routing policy, or baseline. `knowledge_space_ids` are intersected with that system's grants.

| Cross-tenant attempt | Result |
| --- | --- |
| Provider connection id in the chat body | No such field. Lookup is org + environment + `openai` |
| Another org's model access row | `setAccess` and `listAccess` take the session organisation. RLS on the table |
| Another org's routing config | `updateSystem` filters `organisation_id` |
| Another org's AI system id on the dashboard form | Update matches nothing |
| Another org's knowledge space id | Dropped unless this system has a grant. Retrieve SQL also filters `e.organisation_id` |
| Baseline catalogue id | Global catalogue, not another tenant's data. Any seeded model can be chosen as a price reference |
| Routing decisions, usage, budgets, audit | Repository filters plus RLS for the application role |

`packages/database/src/knowledge.test.ts` retrieves only the granted current version and excludes a canary from organisation B and from an ungranted space in organisation A. Acceptance `cross-tenant knowledge hidden` and `tenant B cannot see tenant A routes` passed. The vitest acceptance run uses the PGlite owner, so that stage proves the organisation filter. The RLS test is the one that proves the policy.

Object keys are `knowledge/{organisationId}/{documentId}/{versionId}/original`. `assertObjectTenant` rejects a key that does not start with the caller's prefix or that contains `..`. Organisation A cannot read organisation B's object by passing B's key with A's id.

## 22. Audit and observability

Routing-related action names:

- `routing.decision.created` — written before the provider returns.
- `routing.fallback.completed` — written when fallback moves.
- `routing.fallback.started`, `routing.fallback.failed` — defined, never written.
- `routing.policy.updated`, `routing.model.allowed`, `routing.model.blocked`.
- `provider.connection.created`, `provider.connection.disabled`.

Decision metadata is ids, provider, model, strategy, complexity. `decision_reason` JSON stores reason strings, rejection codes, task type, and `has_knowledge_context`. It does not store prompt text or chunk text. Audit metadata is passed through `safeAuditMetadata`, which keeps only primitive values and drops sensitive key names.

In-process counters in `apps/gateway/src/metrics.ts`: `request_count`, `errors`, `provider_errors`, `budget_blocks`, `rate_limit_blocks`, `routing_decisions`, `routing_fallbacks`, `routing_rejections`, plus a 200-sample latency array. Nothing reads `snapshot()`. There is no `/metrics` route. There is no metric for candidate count, model distribution, no-valid-route as its own series, or estimated versus actual cost. Candidate count is a column on `routing_decisions`. Latency on the dashboard is request latency from the database, capped at 200 rows.

## 23. Dashboard

Pages that exist and read the database through the session organisation:

| Page | Route | Data | Empty state | RBAC |
| --- | --- | --- | --- | --- |
| Gateway overview and request list | `/gateway` | `getGatewayReport`, `savingsSummary`, `findByRequest`, `getRequestDetail` | "No requests in this period." | `gateway:read` |
| Routing | `/gateway/routing` | AI systems and catalogue | "No AI systems yet." | `routing:read`; form requires `routing:write` |
| Models | `/gateway/models` | catalogue and organisation access | "No catalogue models." | `routing:read`; allow/block requires `routing:manage` |
| Providers | `/gateway/providers` | connections without secrets | "No provider connections." | `providers:read`; connect requires `providers:write` |

No hardcoded demo dollar amounts were found on these pages. Savings render `—` when there are no optimised decisions. There is no `loading.tsx` or `error.tsx` under the gateway routes. A failed server render uses the framework error page.

Request detail shows strategy, complexity, selected provider and model, estimated selected cost, estimated baseline, estimated savings, fallback-from, a knowledge yes/no flag, request token cost, latency, and audit action names. It does not show the candidate list, rejection codes, or the reason sentences, although those sit in `decision_reason`. The HTTP `vhalcha.routing` object does include the generic reason strings.

## 24. SDK and API compatibility

The SDK method is `vhalcha.chat.completions.create(body)`, not `vhalcha.chat({ aiSystemId, messages })`. `aiSystemId` is implied by the API key. `model` is still required by the schema.

Fixed mode still sends that model to the provider. Optimised mode overwrites it after classification. Existing fixed systems stay fixed because the column default is `fixed` and `0005_routing.sql` says existing rows keep that default. Callers that do not opt in keep the previous contract.

Streaming, knowledge chat, idempotency, budget blocks, and the mock provider still exist. Acceptance exercised them and passed.

Behaviour changes that are real once a system is switched to optimised:

- The response model can differ from the requested model. The body gains `vhalcha.routing` and, when knowledge ran, `vhalcha.knowledge`.
- The requested model is not an allow-list check in `prepareChat` for optimised systems. The route's model rules are. An empty rule list denies every candidate.
- Duplicate idempotency keys return 409 rather than the original JSON. That behaviour is pre-existing in `pipeline.test.ts`, not introduced as a silent double charge.

## 25. Tests

Commands run in this session:

| Command | Result |
| --- | --- |
| `pnpm lint` | Exit 0. 18 packages. Turbo cache hit, 4.5s. ESLint cache replay includes a `MODULE_TYPELESS_PACKAGE_JSON` warning for `eslint.config.js`. |
| `pnpm test --force` | Exit 0. 18 packages, 0 cache hits, 5m 27s. **93 tests passed.** |
| `pnpm build` | Exit 0. 18 packages, 13m 36s. Dashboard `next build` compiled with warnings from OpenTelemetry `require-in-the-middle` and `unpdf` `import.meta`. Routes include `/gateway`, `/gateway/routing`, `/gateway/models`, `/gateway/providers`. |
| `pnpm acceptance` | Exit 0. See section 26. |

Test count by package: security 2, audit 1, policies 6, routing 6, logger 1, types 3, knowledge 6, usage 1, redis 2, budgets 6, providers 6, config 7, dashboard 6, sdk 1, auth 3, worker 1, gateway 25, database 10.

The routing unit tests cover a short classification, economy elimination by a 5,000-character prompt, a budget cap that drops premium, a denied model, and the circuit breaker. They do not cover the cost-strategy inversion on large token counts, vision, tools, or fallback budget maths.

An earlier `pnpm test` without `--force` was a full Turbo cache replay of a previous pass. The forced run is the one counted here.

## 26. Acceptance

`pnpm acceptance` starts `apps/gateway/src/run-acceptance.ts`, listens on an ephemeral port, and uses `MockModelProvider`. It refuses to start when `VHALCHA_ENV=production`. It printed `PASS` for every stage and then `PASS acceptance harness`. Process exit code was 0.

Routing stages and what they actually assert:

| Stage | Assertion | What it proves |
| --- | --- | --- |
| optimised simple request selects economy | HTTP 200 and `selected_model === economy-model` | Short "Classify this support message." on the mock catalogue, cost strategy |
| estimated savings against baseline | baseline estimate > selected estimate and savings > 0 | Stored value `0.00201240`, which matches the 8-in/256-out formula. It is an estimate |
| high complexity avoids economy | selected model is `premium-model` | The prompt is the word "risk" repeated 4,000 times, about 5,000 tokens. High complexity requires `reasoning`. Only premium has it. This is a length rule |
| provider failure falls back | `fallback_from === economy-model`, selected model is not economy, audit `routing.fallback.completed` | Mock `failModels` throws before tokens. Selected `standard-model` |
| knowledge context eliminates economy | selected model is not economy | Prompt already exceeds the 1,000-token economy window. Retrieval is not isolated |
| routing respects budget | status 402 or 422, observed `budget_exceeded` | Budget amount `0.0000001` |
| tenant B cannot see tenant A routes | B's savings summary has 0 decisions and B's connections belong to B | Organisation filter on the live database role used by the harness |

Earlier stages still check registration, streaming mock text, usage, reservation finalisation, budget block without a second provider call, knowledge injection, citations, strict grounding, and cross-tenant knowledge. Those assertions are specific, not a blanket `PASS` print. They use the mock provider and mock embeddings. They do not call OpenAI.

## 27. Performance and concurrency

Per optimised request the gateway typically does: a connectivity select, virtual-key lookup, organisation, system, and environment reads, budget lookup, provider-connection lookup, a second system read for knowledge, a grant query and a vector query, a third system read, catalogue, access, health, and model-rule reads, another budget lookup, one spend sum per hard budget, then reserve (lock, spend sum, hold sum, insert per blocking budget), request insert, provider-started update, retrieval trace inserts, routing decision insert, audit insert, the provider call, a health read/write, and finalisation (lock request, usage insert, reservation update, audit).

Catalogue, rules, and permissions are loaded again on the same request. There is no per-candidate query. Health is one list, then an in-memory find. The N+1 shape is one spend query per hard budget inside routing, and again inside reserve.

Knowledge retrieval and routing are serial. That order is required for the token estimate. It is not a safe place to parallelise them.

Concurrent `reserve` calls are serialised by row locks. Concurrent `raise` calls are not. Two requests can also both pass the routing budget pre-check before either inserts a hold; `reserve` then stops the second one. `applyHealth` can lose increments. Idempotency and the reservation are not one transaction.

Finalisation refuses a second usage row when the request is already terminal (`finalize.test.ts`).

## 28. Security threat model

| Threat | Assessment |
| --- | --- |
| Cross-tenant provider credentials | Chat cannot name a connection. Decrypt runs only for the key's organisation and environment. List API omits ciphertext. RLS applies to the table for `vhalcha_app`. |
| Malicious route override | In optimised mode the body `model` is replaced. The client cannot set strategy or baseline. Dashboard writes require `routing:write` and the session organisation. |
| Budget bypass through fallback | `raise` uses AI-system spend for every budget scope and does not lock the budget row. An organisation hard budget can be exceeded by a fallback. |
| Model-policy bypass | Empty rules fail closed. Optimised mode skips the early allow check and applies the same function later. Vision and tool requirements are not derived from the request, so those policies cannot bite. |
| Stale pricing | Two static copies. No refresh. A cheap stale price can win, and the saving is then wrong. |
| Provider spoofing | Only the configured runtime provider is eligible. The mock adapter's id is `openai`. Production refuses mock mode. |
| Credential leakage | Encrypt-before-store, dashboard omit, audit key filter. The key lives in the gateway environment. Logs reviewed on this path do not print the secret. A crash dump or a `select *` from an admin role would see ciphertext, not the dashboard. |
| Routing decision manipulation | Inserts go through the repository and a tenant trigger. The decision is written before the provider returns, then updated on fallback. A reader can observe a selected model that has not been called yet. |
| Idempotency abuse | Same key and body cannot double-charge. A failed key blocks retries. The fingerprint is not a substitute for authorisation. |
| Reservation race | Reserve path is locked and tested. Raise path is not. |
| Provider outage cascades | Bounded attempts, same vendor only. Health updates can be lost. Degraded models remain eligible. |
| Knowledge prompt injection | Retrieved text is inserted as a system message with no additional sanitiser. That is inherent to grounding. Strict mode refuses to call the model when nothing is retrieved. Content is not written to the routing decision. |
| Audit leakage | Metadata filter drops sensitive key names and nested objects. Rejection codes and model names are stored. Prompts are not. |

## 29. Commercial claims matrix

| Claim | Verdict | Why |
| --- | --- | --- |
| A. Vhalcha automatically routes AI requests. | PARTIALLY SUPPORTED | Optimised systems do. The default for existing and new systems is `fixed`, which sends the caller model. |
| B. Vhalcha can route simple work to cheaper models. | PARTIALLY SUPPORTED | True for a short classification on the mock catalogue with the cost strategy. "Simple" means few characters, or the word "classify", not a judgement about the task. |
| C. Vhalcha reserves premium models for complex work. | NOT SUPPORTED | Complexity is a character count. A short legal analysis stays on economy. A long trivial prompt can require `reasoning` and land on premium. Large requests that economy can serve still score premium on the cost strategy. |
| D. Vhalcha reduces AI costs. | NOT SUPPORTED | The engine can choose a more expensive capable model and label it lowest-cost. Prices are a static snapshot. Measured "savings" are estimates. |
| E. Vhalcha shows estimated savings. | SUPPORTED | When a baseline exists, the UI and `routing_decisions.estimated_savings` show baseline estimate minus selected estimate, including the zero and null cases. The routing page says this is not invoiced cash. |
| F. Vhalcha automatically switches providers during an outage. | NOT SUPPORTED | One runtime provider per process. Fallback switches models of that provider. OpenAI to another vendor does not exist. |
| G. Vhalcha supports BYOK. | PARTIALLY SUPPORTED | Organisation OpenAI keys can be stored with AES-256-GCM and used on the OpenAI adapter. No KMS, no connection test, ambiguous multiple active keys, empty secrets key still boots production. |
| H. Vhalcha prevents AI budget overruns. | PARTIALLY SUPPORTED | Hard-budget `reserve` blocks estimated overspend and is concurrency-tested. Actual tokens can exceed the hold. Fallback `raise` can mis-count organisation budgets. |
| I. Vhalcha keeps client AI environments isolated. | SUPPORTED | For routing decisions, credentials, knowledge grants, budgets, usage, and audit, application filters and RLS hold for `vhalcha_app`. Worker role is intentionally cross-tenant. |
| J. Vhalcha uses approved company Knowledge when answering. | SUPPORTED | Enabled systems retrieve granted, current, unexpired chunks and inject them before the provider call. Strict mode fails closed. Acceptance covered injection, citations, revocation, and cross-tenant hiding. |
| K. Vhalcha knows why each model was selected. | PARTIALLY SUPPORTED | Rejection codes and a score are computed. The published sentences are templates. "Lowest-cost qualifying route" is emitted for every cost-strategy winner, including when a more expensive model won. |
| L. Vhalcha can safely run production enterprise AI workloads. | NOT SUPPORTED | Role split, RLS, and fail-closed knowledge are real. Cost selection, fallback accounting, static prices, single-vendor failover, and in-process metrics are not an enterprise cost-control plane. |

## 30. P0 findings

### P0-1. Cost strategy selects more expensive models and reports a false reason

- Issue: `costRank = 1 / (1 + costUsd * 1000)` plus a quality weight makes premium beat a 16-times-cheaper capable model. `explainSelection` still says "Lowest-cost qualifying route".
- Evidence: `packages/routing/src/select.ts` weights and `explainSelection`. Executed `selectRoute` for 100,000 / 2,000 tokens: cost strategy selected premium `$0.27` over economy `$0.0162` (scores `0.167952` vs `0.136512`). The same inversion happened for balanced, quality, and latency.
- Impact: A design partner can pay more while the product says it chose the cheap route. Estimated savings against a premium baseline become zero or negative for ordinary long contexts.
- Fix: Rank cost by the dollar estimate, or by relative cost that does not saturate. Emit "lowest cost" only when the selected estimate is less than or equal to every other survivor.

### P0-2. Fallback budget raise undercounts organisation spend and is unlocked

- Issue: `budgetReservations.raise` always sums AI-system usage and does not `FOR UPDATE` the budget rows. `reserve` uses the correct scope and locks.
- Evidence: `packages/database/src/repositories.ts` `raise` versus `reserve`.
- Impact: After a cheap model fails, a more expensive fallback can be accepted against an organisation or environment hard budget that is already exhausted by other systems. Concurrent raises can oversubscribe a budget.
- Fix: Use the same scope-specific spend query and the same row lock as `reserve`. Add a test where system spend is low, organisation spend is exhausted, and fallback must fail.

### P0-3. A billed first response can disappear from the ledger

- Issue: Premium escalation treats a successful chat completion as a failure when the text has no `{`, then continues the loop. Only the final call is passed to `finalizeSuccess`.
- Evidence: `chatWithFallback` in `apps/gateway/src/pipeline.ts`. Mock and OpenAI both return usage on HTTP 200. That usage is discarded when the loop continues.
- Impact: The provider can invoice the first completion. Vhalcha records only the fallback. Budget and savings understate spend.
- Fix: Record usage for every billable attempt, or do not escalate after a completed, billed response until that usage is reserved and stored.

## 31. P1 findings

### P1-1. The commercial complexity claim is a character counter

Short high-stakes prompts stay low complexity and can use economy. Long low-stakes prompts become high complexity and require `reasoning`. Evidence: `packages/routing/src/classify.ts` and the acceptance prompt `'risk '.repeat(4000)`, which selected `premium-model` only because standard lacks `reasoning`.

### P1-2. Two price books and no update path

Catalogue columns drive selection. `modelPrices` drives reservation and actual cost. Seeds do not update on conflict. Cached input price is unused. Stale prices make every saving commercially unusable.

### P1-3. Routing budget pre-check ignores holds and non-system budgets

A model can be chosen on an inflated remainder. `reserve` may then reject the whole request instead of trying a cheaper survivor. Combined with P0-2, fallback is worse.

### P1-4. Vision and tool filters never see a request

`usesTools` and `requiresVision` are constants. The public schema has no image or tool content. A cheaper text model is never eliminated for those reasons because the request cannot express them.

### P1-5. Baseline need not be an approved model

Any catalogue id can be the savings reference, including a model the organisation has blocked.

### P1-6. Estimated savings are not reconciled to token cost

Dashboard benefit sums `estimated_savings`. Actual output larger than 256/800/2000, or a fallback, changes the invoice without rewriting the benefit from usage. The request column labelled "Cost" is still an internal price times tokens.

### P1-7. BYOK is a single environment key

No KMS, no connection test, `findActive` is unordered `limit 1`, production boots with an empty secrets key. Ciphertext handling itself is in place.

### P1-8. Single-vendor failover

An OpenAI outage cannot move to another provider. Attempts are capped, which is good, and then the request fails.

## 32. P2 findings

### P2-1. Health success is recorded when a stream opens

Mid-stream failure does not count toward the breaker. `applyHealth` is a lost-update read-modify-write.

### P2-2. Non-streaming provider calls have no timeout

`chatCompletion` is invoked without an abort signal. A hung provider holds the reservation until the 15 minute expiry path.

### P2-3. Idempotency key sticks after knowledge failure and after provider failure

The client gets 409, not the original body, and cannot retry the same key for 24 hours.

### P2-4. Acceptance does not isolate knowledge from prompt length

`knowledge context eliminates economy` sends 4,500 padding characters in the user message. Economy's 1,000-token window is already exceeded.

### P2-5. Request detail hides rejection codes

They are stored in `decision_reason` and omitted from the drawer. Operators cannot see why a model lost without a database query.

### P2-6. Context check uses uncapped output tokens while price uses `min(estimate, maxOutputTokens)`

A model can be rejected for context, or under-priced, because those two numbers differ. The outbound request still forwards the client's `max_tokens` unchanged.

### P2-7. Routing and budget tokenisers disagree

Routing output defaults are 256, 800, or 2,000. Reservation output default is 4,096. Both use characters/4 for input, which is not the knowledge chunker's `token_count`.

### P2-8. Metrics stay inside the process

`routing_decisions`, `routing_fallbacks`, and `routing_rejections` are incremented and never exported.

## 33. P3 findings

- Weight tables are constants. Latency and quality strategies cannot be tuned per AI system.
- `routing.fallback.started` and `routing.fallback.failed` are unused names.
- `GuardExtensionPoint` is an explicit non-implementation.
- Multiple active organisation credentials have no order.
- Dashboard gateway routes have no dedicated loading or error UI.
- The idempotency test title says the response is replayed. The code returns 409.
- Catalogue `reasoning_level` is not an input to the score. Tier is.
- `gpt-4.1-mini` is tier economy and has no `reasoning` capability, so a high character count skips it even when it is the caller's usual model.

## 34. Production-readiness verdicts

| Area | Verdict |
| --- | --- |
| Routing engine | NOT READY |
| Cost estimation | NOT READY |
| Savings reporting | NOT READY |
| BYOK | NOT READY |
| Provider fallback | NOT READY |
| Budget enforcement | NOT READY |
| Knowledge integration | READY |
| Tenant isolation | READY |
| Dashboard | NOT READY |
| Overall design-partner readiness | NOT READY |
| Overall production readiness | NOT READY |

Knowledge integration is ready in the sense that retrieval, grants, version filtering, staleness, strict grounding, citations, and fail-closed errors still run and the acceptance stages for them passed. It is not a statement that object storage has been operated against a private bucket in this audit.

Tenant isolation is ready for the application role on the tables and filters inspected. It is not a penetration test.

The dashboard is functional and backed by real queries. It is not ready to show a design partner because the benefit number can describe a route the scorer did not actually optimise.

Design-partner readiness fails because the partner cannot be shown a truthful cost reduction. The mock script will show a `$0.002` estimate on a toy prompt and a premium route on a repeated word. That demonstration would not survive the 100,000-token case above.

## 35. Exact recommended next phase

Do this before any design-partner demo. Do not add providers or a new strategy until these are true.

1. Replace cost ranking so the cheapest surviving candidate wins on the cost strategy, and add a regression that uses token counts large enough for estimates above `$0.01`. Assert economy wins when it is capable, and assert the reason string matches the comparison.
2. Make `raise` share `reserve`'s scope query and row lock. Test organisation-budget fallback denial.
3. Account for every billable provider attempt. Escalation after HTTP 200 must add the first usage into the reservation and the usage table.
4. Either stop calling character count "complexity", or document the rule in the product as a length gate. Do not describe it as reserving premium models for complex work.
5. Pick one price source. Reservation, routing, and usage must read it. Add an explicit "as-of" date on every saving. Do not display a saving when the price row is older than an agreed maximum age.
6. Show rejection codes on the request drawer from `decision_reason`, and label every dollar figure estimate or token-priced. Keep the "not invoiced cash" sentence on the overview metric, not only the routing page.
7. Re-run the acceptance knowledge stage with a short user message and a retrieved chunk that alone exceeds the economy window. Re-run the large-token cost case. Keep the existing short-prompt economy case.

Until 1 through 3 are done, Vhalcha should not tell a customer that intelligent routing reduces AI infrastructure cost.
