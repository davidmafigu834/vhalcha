# Vhalcha Multi-Provider Routing V1.2 — Adversarial Audit

**Audit type:** read-only  
**Date:** 2026-09-29  
**Scope:** OpenAI, Anthropic, Google Gemini routing architecture  
**Sources:** migrations, schema, gateway, providers, routing, dashboard, tests, acceptance; official pricing/docs cross-checks  
**Not trusted:** `VHALCHA_MULTI_PROVIDER_ROUTING_V1_2_BUILD_REPORT.md` (used only as a claim list to falsify)

**Live credentials:** `OPENAI_API_KEY` empty/placeholder in `.env`; Anthropic/Google keys not present.  
**Smoke scripts:** MISSING (`smoke:openai` / `smoke:anthropic` / `smoke:google` do not exist).  
**Live authenticated calls:** NOT TESTED.

---

## 1. Executive verdict

The **routing algorithm** and **adapter registry** are genuinely provider-neutral in process memory: one gateway process in `VHALCHA_PROVIDER_MODE=openai` can select OpenAI, Anthropic, or Google per request without restart.

That statement is **not** yet design-partner ready as a complete product path, because:

1. **P0 — Database CHECK constraints still forbid non-OpenAI `provider_connections` (and Anthropic/Google `model_access_rules`).** Dashboard BYOK for Anthropic/Google cannot persist on a migrated database that retains `0001_init.sql` / `0005_routing.sql` checks. Migration `0007_multi_provider.sql` never widens them.
2. Cross-provider Cost selection and fallback are proven primarily via **unit tests + mock acceptance**, not live multi-vendor traffic.
3. Platform API keys make providers eligible **without organisation consent** whenever env keys exist — ambiguous commercial semantics.
4. Pricing has known under-billing gaps (Gemini Pro >200k tier; OpenAI cache; Anthropic cache writes; Gemini thinking billed only if folded into output counts Google reports).

**Design-partner verdict:** **READY FOR INTERNAL LIVE PROVIDER TESTING** — not ready for controlled design-partner pilot until the connection CHECK is fixed and at least one live path per vendor is exercised.

**Production verdict:** **NOT PRODUCTION READY** for multi-provider BYOK or for claims of invoice-accurate multi-vendor FinOps.

---

## 2. Architecture verified

### Actual optimised call chain (source)

| Step | File | Function |
|------|------|----------|
| Boot | `apps/gateway/src/index.ts` | `createProviderRegistry`, `platformKeys`, `routingRuntime` |
| HTTP | `apps/gateway/src/server.ts` | `POST /v1/chat/completions` |
| Auth / prepare | `apps/gateway/src/pipeline.ts` | `prepareChat` |
| Idempotency | `pipeline.ts` | `claimIdempotency` |
| Knowledge | `apps/gateway/src/knowledge.ts` | `attachKnowledge` |
| Route | `apps/gateway/src/route.ts` | `applyOptimisedRoute` → `listEligibleProviders` → `HeuristicRequestClassifier.classify` → `selectRoute` |
| Budget | `pipeline.ts` | `enforceBudget` |
| Execute | `pipeline.ts` | `completeChat` / `streamChat` → `chatWithFallback` / `openStreamWithFallback` |
| Credential | `route.ts` | `resolveProviderApiKey` |
| Adapter | `pipeline.ts` | `resolveModelProvider` → `ProviderRegistry.get` → `chatCompletion` / `streamChatCompletion` |
| Attempts / health / fallback | `pipeline.ts` + `route.ts` | `recordProviderAttempt`, `noteProviderHealth`, `moveToFallback` |
| Finalize | `pipeline.ts` | `finalizeSuccess` / `finalizeFailure` |
| Extensions | `route.ts`, `knowledge.ts` | `routingExtension`, `knowledgeExtension` |

**Server order** (`server.ts`): `prepareChat` → `claimIdempotency` → `attachKnowledge` → `applyOptimisedRoute` → `enforceBudget` → `completeChat` | `streamChat`.

The conceptual path in the audit brief matches this chain. Knowledge runs **before** routing; strict grounding can prevent **all** provider calls.

---

## 3. Provider registry

**File:** `packages/providers/src/registry.ts` — `createProviderRegistry` / `get`

| Mode | openai | anthropic | google | mock |
|------|--------|-----------|--------|------|
| `includeMock: true` | MockModelProvider (alias) | **real** AnthropicProvider | **real** GeminiProvider | MockModelProvider |
| production (`includeMock` false) | OpenAIProvider | AnthropicProvider | GeminiProvider | not registered |

- `get(missing)` → `null` (gateway throws `provider_unavailable`).
- Duplicate keys: last `Map.set` wins; factory does not intentionally register duplicates.
- **Mock-mode risk:** Anthropic/Google remain live HTTP adapters even when OpenAI is mocked.

**Gateway branches outside adapters (credential wiring only):**

- `platformKey` / `platformKeyFor` switches on anthropic/google/openai (`pipeline.ts`, `route.ts`)
- `listEligibleProviders` hardcodes `['openai','anthropic','google']`
- `resolveFixedProvider` prefers OpenAI on ambiguous catalogue name collisions
- No vendor HTTP in gateway business logic

---

## 4. OpenAI adapter

**Class:** `packages/providers/src/openai.ts` — `OpenAIProvider`

| Item | Status |
|------|--------|
| Endpoint | `POST {base}/chat/completions` (`https://api.openai.com/v1`) |
| Auth | `Authorization: Bearer` |
| Messages | Pass-through OpenAI-shaped messages |
| Stream | Raw SSE forward; `stream_options.include_usage` |
| Usage | `prompt_tokens` / `completion_tokens` / `total_tokens` |
| Cached tokens | **Not extracted** |
| Timeout / abort | `AbortSignal.timeout` + optional caller signal |
| Errors | `classifyProviderStatus` (401/403/429/400/5xx/timeout) |
| Model name | Request `model` field = catalogue-selected name |

**Unit tests:** PASS (usage, stream, timeout → `provider_timeout`, safe errors).  
**Live:** NOT TESTED.

---

## 5. Anthropic adapter

**Class:** `packages/providers/src/anthropic.ts` — `AnthropicProvider`

| Item | Status |
|------|--------|
| Endpoint | `POST {base}/messages` (`https://api.anthropic.com/v1`) |
| Auth | `x-api-key` + `anthropic-version: 2023-06-01` |
| System | Lifted via `splitChatMessages` → top-level `system` |
| Turns | user/assistant; empty turns → empty user |
| `max_tokens` | defaults to 1024 if omitted |
| Stream | Parses `content_block_delta`, `message_start`/`message_delta`; **rewrites to OpenAI-shaped SSE** |
| Usage | `input_tokens`, `output_tokens`, `cache_read_input_tokens` |
| Cache writes | **Not extracted** (`cache_creation_input_tokens` ignored) |
| Errors | Shared `classifyProviderStatus` |

**Catalogue IDs vs Anthropic docs (2026-09-29):**

- `claude-haiku-4-5-20251001` — matches official API ID  
- `claude-sonnet-5` — matches official Claude API ID  

**Unit tests:** PASS (system/user mapping, cache read).  
**Live:** NOT TESTED.

---

## 6. Gemini adapter

**Class:** `packages/providers/src/gemini.ts` — `GeminiProvider` (`id = 'google'`)

| Item | Status |
|------|--------|
| Endpoint | `{base}/models/{model}:generateContent` / `:streamGenerateContent?alt=sse` |
| Auth | Header `x-goog-api-key` only (not query string) — good for secret isolation |
| System | `systemInstruction.parts[].text` |
| Roles | assistant → `model`, else `user` |
| Stream | JSON SSE → OpenAI-shaped text deltas |
| Usage | `promptTokenCount`, `candidatesTokenCount`, optional cache/thoughts |
| Empty candidates | **HTTP 200 with empty/missing candidates treated as success with empty text** |
| Blocked / safety | **Not mapped** to `provider_content_rejected` (enum exists but unused) |

**Unit tests:** PASS (URL, systemInstruction, cache omit).  
**Live:** NOT TESTED.

---

## 7. Message translation

**File:** `packages/providers/src/messages.ts` — `splitChatMessages`  
**No dedicated unit tests.**

| Case | Behaviour |
|------|-----------|
| A system+user | System lifted; user turn preserved |
| B multi-turn | Order preserved; consecutive same roles merged with `\n` |
| C multi-system | Joined with `\n\n` |
| D assistant-first | Allowed locally; vendor may reject |
| E empty | Empty system/turns; adapters inject empty user |
| F Knowledge | Gateway prepends Knowledge as **system** (`knowledge.ts:130`) → Anthropic `system` / Gemini `systemInstruction` / OpenAI system message |

Trusted grounding instructions are **not** demoted to user content for providers that support system instruction.

---

## 8. Credential resolution

### Eligibility (`listEligibleProviders`)

| Condition | Eligible? |
|-----------|-----------|
| `routingRuntime === 'mock'` | `['mock']` only |
| Platform env key present | **Yes** (independent of DB) |
| Active org BYOK + `verified` | Yes |
| Active BYOK unverified / failed | No (via BYOK path) |
| `vhalcha_managed` | Never |
| Disabled connection | Ignored |

### Attempt-time key (`resolveProviderApiKey`)

| Active row | Result |
|------------|--------|
| None + platform key | Platform key |
| `platform_env` + key | Platform key |
| Org + verified | Decrypt BYOK |
| Org + unverified/failed | **Throw** even if platform key exists |
| Disabled (no active row) + platform key | Platform key |
| `vhalcha_managed` | Fail closed |

**Precedence:** Eligibility is OR (platform **or** verified BYOK). Resolution prefers active org BYOK when present and refuses platform fallback for that attempt.

---

## 9. Credential verification

**Flow:** Dashboard `connectOrganisationProvider` → encrypt → insert `unverified` → `verifyProviderCredential` → `verified`/`failed`.

| Provider | Verify mechanism | Costly generation? |
|----------|------------------|--------------------|
| OpenAI | `GET /v1/models` | No |
| Anthropic | `GET /v1/models` | No |
| Google | `GET /v1beta/models` | No |

- Timeout: 10s (`verify.ts`)
- Failed keys remain encrypted
- Failed keys are **not** routing-eligible via BYOK
- Test connection mutates verification fields
- Replace path: disable prior active then insert (plus partial unique index)

**P0 blocker:** inserts of `provider='anthropic'|'google'` hit leftover CHECK `provider in ('openai')` from `0001_init.sql`. No later migration drops/replaces it. Dashboard UI offers those providers anyway.

Similarly `model_access_rules.provider` CHECK is still `('openai','mock')` after `0005` — system-level deny rules for Anthropic/Google cannot be stored.

---

## 10. Secret security

**Strengths**

- RLS on `provider_connections`, `request_provider_attempts`, `provider_health`, routing tables
- List endpoints omit ciphertext
- Decrypt only in gateway resolve + dashboard verify
- Audit redacts key-like metadata keys; pino redacts `apiKey` / `authorization` / credential patterns
- Gemini auth uses header, not query URL

**Tenant isolation (reasoning)**

- Dashboard actions scope by `session.claims.oid`
- Gateway resolves connections by prepared organisation/environment
- RLS FORCE on attempts

**Ambiguities / gaps**

- Platform keys are process-global shared credentials — every org with no BYOK can consume them if eligible
- Active failed BYOK blocks platform for that provider (good) but disabled BYOK silently re-enables platform (document as intentional or not)

---

## 11. Model catalogue

Production (non-mock) routable models from `0005`/`0007` + `catalogue-prices.ts`:

| provider | model_name (API id) | tier | context | max out | in $/M | cache $/M | out $/M | notes |
|----------|---------------------|------|---------|---------|--------|-----------|---------|-------|
| openai | gpt-4.1-mini | economy | 128000 | 16384 | 0.40 | null | 1.60 | cache not applied |
| openai | gpt-4.1 | premium | 128000 | 16384 | 2.00 | null | 8.00 | |
| openai | gpt-4o-mini | economy | 128000 | 16384 | 0.15 | null | 0.60 | vision claimed |
| openai | gpt-4o | standard | 128000 | 16384 | 2.50 | null | 10.00 | |
| anthropic | claude-haiku-4-5-20251001 | economy | 200000 | 64000 | 1.00 | 0.10 | 5.00 | tools not claimed |
| anthropic | claude-sonnet-5 | premium | 1000000 | 128000 | 2.00 | 0.20 | 10.00 | tools not claimed |
| google | gemini-2.5-flash | economy | 1048576 | 65536 | 0.30 | 0.03 | 2.50 | tools/vision not claimed |
| google | gemini-2.5-pro | premium | 1048576 | 65536 | 1.25 | 0.125 | 10.00 | **≤200k tier only** |

IDs for Anthropic match current Anthropic docs. Gemini names match Developer API naming.  
`price_verified_at` is migrate/`now()` stamped; effective dates fixed in SQL.

---

## 12. Pricing

**Single runtime source:** `model_catalogue` → `catalogueUnitPrice` / routing model fields → `calculateTokenCost`.  
Ops sync file `catalogue-prices.ts` is not read at request time. No second production price map found.

**Gaps vs invoices**

| Dimension | Behaviour |
|-----------|-----------|
| Gemini 2.5 Pro >200k | Official $2.50/$15; Vhalcha always $1.25/$10 → **under-bill** |
| OpenAI cached input | Not extracted → may over-estimate vs invoice when cache hits |
| Anthropic cache read | Accounted when reported |
| Anthropic cache write | Not extracted → under-bill |
| Gemini cache | Accounted when reported |
| Gemini thoughts | Mapped to `reasoningTokens` but **not separately priced**; depends on Google folding into output counts |
| Routing estimates | Ignore cache rates |
| `buildUsageDraft` | Ignores cache fields (gateway multi-attempt path uses `priceUsage` with cache) |

Adapters do **not** send tools/search/grounding — non-token feature fees are not accidentally invoked by V1.2 text adapters.

---

## 13. Candidate discovery

`applyOptimisedRoute` loads org-allowed catalogue models across providers, drops provider-wide unavailable vendors, applies policy/capability/context/price/budget filters inside `selectRoute`.

No pre-selector “lock” to OpenAI when `routingRuntime === 'multi'`. Mock runtime locks to `['mock']`.

---

## 14. Cost routing

**Code:** `select.ts` Cost path sorts by estimated cost; preferred providers ignored.

**Evidence**

- Unit: three-provider Cost selects Gemini when cheapest (`routing.test.ts`)
- Acceptance stage: `cross-provider cost selects cheapest vendor — google/gemini-economy`
- Preferred Anthropic does not override Cost

**Not executed in this audit:** live reverse-price matrix against real APIs. Deterministic selector behaviour is sound in code/tests.

Provider **name** does not influence Cost ordering except via eligibility/health filters.

---

## 15. Balanced routing

Preferred providers apply only when non-cost score delta ≤ **0.02**, as soft tie-break.

Impact: large price gaps still dominate via cost term `cheapest/this`. Preference cannot override a score gap > 0.02. Degraded health multiplies score by 0.7. Documented soft factor is implemented as coded.

---

## 16. Provider policies

| Policy | Mechanism | Works? |
|--------|-----------|--------|
| allowed_providers | hard filter in `selectRoute` | Yes (unit deny test) |
| prohibited_providers | hard filter | Yes |
| preferred_providers | soft, non-Cost | Yes |
| model deny | `decideModelAccess` + org catalogue access | Catalogue block works; **system `model_access_rules` cannot store anthropic/google** due CHECK |

---

## 17. Provider health

- Model-scoped health always updated
- Provider-wide (`model_name=''`) opens only on `provider_unavailable` / `provider_timeout`
- Auth / 429 / invalid request do **not** open vendor circuit
- Provider-wide unavailable drops all vendor models before select
- Model unavailable rejects that model only

**Auth failure:** model failure counter increments; connection verification status is **not** auto-flipped to failed during routing; Anthropic is **not** globally marked down.

---

## 18. Cross-provider fallback

`moveToFallback` advances ranked list (may change provider), raises reservation to `billableActualUsd + next.estimatedCost`, audits with `fallback_from_provider`.

**Non-stream:** attempt ledger records each try; registry + credential re-resolved per attempt.  
**Stream open failure:** fallback occurs, but **`openStreamWithFallback` does not call `recordProviderAttempt`** — attempt ledger incomplete for stream pre-open failures.

Max attempts: `min(3, max(1, system.maxProviderAttempts))` (default 2).

**Live cross-provider fallback:** NOT TESTED. Mock acceptance proves same-provider mock model fallback and billable escalation accounting.

---

## 19. Attempt accounting

Table `request_provider_attempts` with RLS FORCE. Non-stream path records provider, model, status, tokens, costs, billable, error code.

Gaps: stream pre-open failures omit attempts; dashboard omits error_code / reason / tokens on attempt UI.

---

## 20. Budget integrity

Fallback raise shares V1.1 reservation path; rejection prevents next provider call. Acceptance proves organisation hard budget blocks expensive fallback after cheap failure (mock).

Cross-provider expensive Anthropic after failed Google: **logic supports** expected “not called”; not live-proven.

---

## 21. Knowledge integration

Knowledge retrieved once in `attachKnowledge`, prepended as system, then routing/fallback reuse `prepared.body.messages` — same grounded context across providers. Strict grounding short-circuits before provider calls.

---

## 22. Citations

`knowledgeExtension` / `selectCitedSources` operate on assembled answer text, not vendor envelopes — provider-neutral. Invented `[S99]` stripping remains in knowledge package behaviour (prior V1 semantics).

---

## 23. Streaming

| Provider | Parser | Mid-stream fallback | Concatenation risk |
|----------|--------|---------------------|--------------------|
| OpenAI | Forward vendor SSE | No (fallback only on open failure) | Low |
| Anthropic | Remap to OpenAI SSE | No after open | Low |
| Google | Remap to OpenAI SSE | No after open | Low |

Once bytes are visible to the client, Vhalcha does not switch vendors mid-stream (good).

---

## 24. Idempotency

- Non-billable total failure → `retryable_failed` → same key/fingerprint can retry
- Any `billableActualUsd > 0` → `terminal_failed`
- Preserves V1.1 semantics in code; cross-provider billable+fail path not live-tested

---

## 25. RLS / tenant isolation

`request_provider_attempts` ENABLE + FORCE RLS + tenant policy (`0006`).  
Dashboard/listAttempts scoped by org.  
Cross-tenant connection test/decrypt requires another org's session — blocked by oid scoping + RLS.

**Attack answers**

| Attack | Result |
|--------|--------|
| A reference B connection | No (oid + RLS) |
| A test B connection | No |
| A decrypt B key | No |
| A read B attempts | No |
| A read B health | No (org-scoped) |
| A use B budget | No |

---

## 26. Dashboard

**Providers page:** real DB fields — provider, name, status, verification label, credential source; connect OpenAI/Anthropic/Google; Test/Disable. No raw key/ciphertext.

**Critical:** Connect Anthropic/Google will fail at DB CHECK on migrated DBs.

**Request detail:** strategy, selected, estimates, savings, pricing_verified_at, fallback_from, knowledge, attempts (provider/model/status/cost/billable). Missing attempt error codes and initial-vs-final provider clarity beyond fallback_from model name.

No demo hardcoding found in providers page.

---

## 27. Observability

In-process counters (`routing_decisions`, `routing_fallbacks`, `provider_errors`, …) via `metrics.ts`.  
**No `/metrics` export**, no Prometheus/OTLP. Operators see DB audit + dashboard request detail only. In-memory counters are **not** production observability.

---

## 28. Mock test status

| Area | Result |
|------|--------|
| Provider unit tests (OpenAI/Anthropic/Gemini/verify/pricing/mock) | PASS (prior run) |
| Routing Cost/deny/preferred unit tests | PASS |
| Gateway pipeline + acceptance harness (mock) | PASS |
| Acceptance: `cross-provider cost selects cheapest vendor` | PASS |
| Acceptance: billable multi-attempt accounting | PASS |
| Smoke scripts | MISSING |

---

## 29. Live test status

| Provider | Adapter unit | Acceptance mock | Live auth | Live completion | Live stream | Live usage |
|----------|--------------|-----------------|-----------|-----------------|-------------|------------|
| OpenAI | PASS | PASS (via mock alias) | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED |
| Anthropic | PASS | PASS (selector only) | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED |
| Google | PASS | PASS (selector only) | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED |

---

## 30. Commercial claims

| Claim | Verdict | Explanation |
|-------|---------|-------------|
| A. Route across OpenAI, Anthropic, Google | **PARTIALLY SUPPORTED** | Registry + selector yes with platform keys; BYOK for non-OpenAI blocked by DB CHECK |
| B. Cost chooses cheapest across providers | **SUPPORTED** (algorithm + tests) | Live multi-vendor not proven |
| C. Fallback across providers | **PARTIALLY SUPPORTED** | Code path yes; stream attempt gaps; live not proven |
| D. Connect own OpenAI/Anthropic/Google keys | **PARTIALLY SUPPORTED** | OpenAI yes; Anthropic/Google UI yes but DB CHECK fails inserts |
| E. Credentials verified before routing | **PARTIALLY SUPPORTED** | Verified BYOK required; platform keys skip verification |
| F. Billable attempts across providers | **SUPPORTED** (non-stream code + mock tests) | Stream pre-open attempts incomplete |
| G. Hard budgets on cross-provider fallback | **SUPPORTED** (code + mock acceptance) | |
| H. Pricing reflects provider billing accurately | **PARTIALLY SUPPORTED** | Known tier/cache gaps |
| I. Estimated baseline benefit | **SUPPORTED** with freshness gate | Not realized savings |
| J. Proven real customer savings | **NOT SUPPORTED** | Explicitly absent |
| K. Semantic request difficulty | **NOT SUPPORTED** | Request size ≠ difficulty |

---

## 31. P0 findings

### P0-1 — `provider_connections.provider` CHECK still OpenAI-only

- **Evidence:** `0001_init.sql` `check (provider in ('openai'))`; never dropped in `0005`–`0007`. Dashboard offers anthropic/google connect.
- **Impact:** Organisation BYOK for Anthropic/Google cannot be stored. Claim D fails for real tenants on migrated DBs. Multi-provider design-partner onboarding blocked for BYOK.
- **Recommended fix:** Migration to drop/replace CHECK with `('openai','anthropic','google','mock')` (or remove CHECK). Add regression insert test.

### P0-2 — `model_access_rules.provider` CHECK excludes anthropic/google

- **Evidence:** `0005_routing.sql` CHECK `('openai','mock')` only.
- **Impact:** Per-AI-system allow/deny patterns cannot express Anthropic/Google; policy surface incomplete.
- **Recommended fix:** Widen CHECK; add tests inserting deny rules per vendor.

---

## 32. P1 findings

### P1-1 — No live authenticated validation for any vendor in this phase

- **Impact:** Cannot claim production adapter readiness beyond unit mocks.
- **Fix:** Add explicit smoke commands; run once per vendor with real keys in a controlled env.

### P1-2 — Platform credentials auto-eligible without org consent

- **Evidence:** `listEligibleProviders` adds every provider with a process env key.
- **Impact:** Org traffic may bill Vhalcha’s platform keys without connecting BYOK; commercial/legal ambiguity.
- **Fix:** Require explicit `platform_env` connection (or org policy opt-in) before eligibility.

### P1-3 — Gemini empty/blocked candidates treated as success

- **Evidence:** `gemini.ts` joins empty candidates to `''` and returns success; no `promptFeedback` / block handling.
- **Impact:** Silent empty answers; missed content-rejection signals; possible false success accounting.
- **Fix:** Map blocked/empty to normalized errors; do not finalize as successful completion without candidates when appropriate.

### P1-4 — Gemini 2.5 Pro >200k under-priced

- **Evidence:** Official $2.50/$15 vs catalogue $1.25/$10; migration text admits not modeled; context window allows >200k.
- **Impact:** Hard budgets and Cost estimates understate true invoice for large contexts.
- **Fix:** Dual-tier price model or refuse routing when estimate exceeds 200k until modeled.

### P1-5 — Stream fallback omits attempt ledger rows

- **Evidence:** `openStreamWithFallback` health+fallback without `recordProviderAttempt`.
- **Impact:** Operators lose cross-provider stream failure forensics; accounting asymmetry vs non-stream.
- **Fix:** Record failed stream-open attempts like `chatWithFallback`.

### P1-6 — Active failed BYOK vs platform key inconsistency

- **Evidence:** Provider remains eligible via platform key set, but `resolveProviderApiKey` throws on active failed org row.
- **Impact:** Confusing eligibility; fallback may burn attempts on a provider that cannot resolve.
- **Fix:** Exclude providers with active failed BYOK from eligibility unless policy explicitly allows platform override.

---

## 33. P2 findings

### P2-1 — OpenAI cached tokens not accounted  
### P2-2 — Anthropic cache creation tokens not accounted  
### P2-3 — Metrics not exported (in-memory only)  
### P2-4 — Mock registry still registers live Anthropic/Google  
### P2-5 — Dashboard attempt UI omits error codes / reasons / tokens  
### P2-6 — No `messages.test.ts` for translation edge cases  
### P2-7 — Auth failures during routing do not update connection verification status  
### P2-8 — No Retry-After handling for provider 429 (org rate-limit header only)  
### P2-9 — `provider_content_rejected` declared but never assigned  

---

## 34. P3 findings

### P3-1 — Anthropic/Gemini responses remapped to OpenAI chat.completion / SSE shapes (intentional compatibility; document)  
### P3-2 — TTFT may fire on usage-only Anthropic SSE events  
### P3-3 — Preferred-provider soft window (0.02) is opaque to operators  
### P3-4 — Models page omits cache rates / price provenance  

---

## 35. Design-partner readiness

**Verdict: READY FOR INTERNAL LIVE PROVIDER TESTING**

Not ready for controlled design-partner pilot until:

1. P0 CHECK migrations ship and BYOK connect is proven for all three providers  
2. At least one live completion + stream + usage path per vendor  
3. Platform credential consent semantics decided and documented  
4. Stream attempt ledger gap closed  

Mock acceptance alone is **insufficient** for design-partner readiness.

---

## 36. Production readiness

**Verdict: NOT PRODUCTION READY** for multi-provider commercial operation.

OpenAI path remains the most mature historically; Anthropic/Gemini adapters are **READY FOR LIVE VALIDATION**, not fully verified production behaviour.

---

## 37. Exact next phase

Suggested phase title: **V1.2.1 — Schema unblock + live provider validation**

1. Migrate CHECKs for `provider_connections` and `model_access_rules` to include anthropic/google/(mock).  
2. Add DB regression: insert active Anthropic + Google BYOK connections.  
3. Add `pnpm smoke:openai|anthropic|google` (auth + tiny completion + stream usage); run with secrets out of band.  
4. Decide and implement platform credential opt-in.  
5. Fix Gemini empty/blocked handling; model >200k Pro pricing or hard gate.  
6. Record stream-open attempts; show attempt error codes in dashboard.  
7. Re-run this audit’s commercial claim matrix after live evidence.

---

## Appendix A — Adapter readiness labels

| Adapter | Label |
|---------|-------|
| OpenAI | **READY FOR LIVE VALIDATION** (unit PASS; no live key in this audit) |
| Anthropic | **READY FOR LIVE VALIDATION** |
| Gemini | **READY FOR LIVE VALIDATION** (with P1 empty-candidate caveat) |

## Appendix B — Primary audit statement

> Vhalcha can route qualifying AI requests across approved providers, select the least-expensive qualifying model under Cost routing, and fail over to another approved provider when necessary.

| Fragment | Defensible today? |
|----------|-------------------|
| Route across approved providers | **Conditionally** — yes with platform keys + org model grants; BYOK multi-vendor blocked by P0 CHECK |
| Cost selects least-expensive qualifying | **Yes** in selector code + tests |
| Fail over to another provider | **Yes** in non-stream code path; mock-proven same-registry fallback; **not** live-proven |

Overall: **technically directionally true in software design; not operationally proven; blocked for BYOK design partners by schema P0.**
