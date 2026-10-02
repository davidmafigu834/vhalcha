# Vhalcha Multi-Provider Routing V1.2.1 — Build Report

## 1. Executive summary

V1.2.1 is an operational-validation phase: remove schema and credential-consent blockers, close known adapter gaps (Gemini empty/blocked, Pro >200k pricing), fix stream attempt accounting, harden mock isolation, and add explicit live smoke commands. No Managed AI, wallets, Guard, semantic routing, or new providers.

**Outcome:** Multi-provider BYOK and model policies can persist for OpenAI, Anthropic, and Google. Platform environment keys no longer imply routing eligibility. Acceptance and unit tests prove behaviour with mocks only. Live provider verification was **not executed** in this build environment (no real API keys).

**Design-partner gate:** **READY FOR INTERNAL LIVE PROVIDER TESTING** — not **READY FOR CONTROLLED DESIGN-PARTNER PILOT** until each intended provider completes successful `pnpm smoke:*` completion + stream runs.

---

## 2. P0 schema fixes

Migration **`packages/database/migrations/0008_multi_provider_constraints.sql`** (applied via `pnpm db:migrate`):

- Discovers and drops legacy `provider_connections` provider CHECK (OpenAI-only).
- Replaces with: `openai`, `anthropic`, `google`, `mock`.
- Discovers and drops legacy `model_access_rules` provider CHECK.
- Replaces with: `openai`, `anthropic`, `google`, `mock`.

Additive only; no table rebuild; RLS, indexes, and FKs preserved.

---

## 3. Provider connection constraints

Database regression: `packages/database/src/multi-provider-constraints.test.ts`

- Inserts succeed for `openai`, `anthropic`, `google` (`platform_env` and BYOK round-trip).
- Insert fails for `totally_fake_vendor`.
- BYOK: encrypt → store → retrieve via `findActive`; list queries omit ciphertext; disable clears active row.

---

## 4. Model access constraints

Same test file:

- Rules persist for `openai`, `anthropic`, `google`, `mock`.
- Invalid provider rejected.

Acceptance: Anthropic and Google deny-model rules persist and selector excludes denied models.

---

## 5. Credential consent semantics

**Before (V1.2 audit P0):** Presence of `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GOOGLE_API_KEY` in Gateway env made providers eligible without organisation intent.

**After:** `listEligibleProviders` (`apps/gateway/src/route.ts`) includes a provider only when:

- Active connection with `credential_source = platform_env` **and** matching env key present, **or**
- Active organisation BYOK with `verification_status = verified`.

Bare platform keys alone → **not eligible**.

Dashboard: `enablePlatformProvider` (`apps/dashboard/src/server/routing-actions.ts`) and Providers UI copy for explicit “Vhalcha platform credential” opt-in with Available / Unavailable when key missing.

---

## 6. BYOK eligibility

`resolveProviderApiKey` requires an active connection row. No silent fallback to platform when:

- BYOK is `failed`, `unverified`, or `disabled`.
- Active org row exists but is not verified.

Organisation must explicitly switch to `platform_env` to use platform credentials.

Tests: `apps/gateway/src/eligibility.test.ts`; acceptance stages `failed BYOK excluded`, `platform key requires explicit organisation opt-in`.

---

## 7. Gemini content handling

`packages/providers/src/gemini.ts`:

- Handles missing/empty candidates, `promptFeedback` blocks, safety finish reasons, and no usable text.
- Maps policy/content refusal to **`provider_content_rejected`** (not `provider_unavailable`).
- Malformed success envelope without usable output → normalized provider error (not blank success).
- Stream path rejects empty final text.

Tests: `packages/providers/src/gemini.test.ts`. Acceptance: `Gemini blocked content normalized — provider_content_rejected`.

Gateway pipeline skips provider-wide health increments for `provider_content_rejected` (chat + stream).

---

## 8. Gemini large-context pricing

**Decision:** Hard-gate **`gemini-2.5-pro`** when estimated input tokens **> 200_000** with rejection code **`pricing_tier_unsupported`** (`packages/routing/src/select.ts`).

Catalogue still reflects ≤200k tier only; >200k requests are not priced at the lower tier.

Tests: `packages/routing/src/routing.test.ts`. Acceptance: `Gemini large-context pricing protected — pricing_tier_unsupported`.

Tiered band pricing across estimate / reservation / attempt cost was **not** implemented in this phase (acceptable per spec).

---

## 9. Stream attempt accounting

`openStreamWithFallback` (`apps/gateway/src/pipeline.ts`) records **`request_provider_attempts`** for failed pre-open attempts (timeout, unavailable, auth, etc.) with safe error codes, latency, billable flags—same ledger shape as non-stream fallback.

Acceptance:

- `stream-open failure recorded`
- `cross-provider stream fallback recorded`

---

## 10. Dashboard changes

- **Providers page:** Platform enable form; status for `platform_env`; consent messaging.
- **Gateway request detail:** Attempt rows show provider, model, status, reason, safe error code, tokens, billable, token-priced cost, latency (no raw vendor errors).

---

## 11. Message normalization tests

`packages/providers/src/messages.test.ts` covers:

- system + user; multi-turn; multiple system messages; consecutive user/assistant; assistant-first; empty message; knowledge + application system messages.
- Anthropic/Gemini conversion expectations asserted.

---

## 12. Mock-registry isolation

`createProviderRegistry` with `includeMock: true` maps **`openai`, `anthropic`, `google`, and `mock`** to **`MockModelProvider`** only (`packages/providers/src/registry.ts`).

Acceptance harness runs with mock mode; cannot call real Anthropic/Google/OpenAI endpoints unless an operator explicitly runs `pnpm smoke:*`.

Test: `packages/providers/src/registry.test.ts`.

---

## 13. Smoke commands

Root `package.json`:

| Script | Package entry |
|--------|----------------|
| `pnpm smoke:openai` | `gpt-4o-mini`, `OPENAI_API_KEY` |
| `pnpm smoke:anthropic` | `claude-haiku-4-5-20251001`, `ANTHROPIC_API_KEY` |
| `pnpm smoke:google` | `gemini-2.5-flash`, `GOOGLE_API_KEY` |

Implementation: `packages/providers/src/smoke.ts`, `smoke-cli.ts`.

Properties: refuses missing/placeholder keys; prints provider/model only; tiny completion + stream; usage logged when present; **not** wired to `test`, `acceptance`, CI, or `build`.

**Optional `pnpm smoke:gateway-multi`:** Not implemented (deferred; individual adapter smokes sufficient for this phase).

---

## 14. OpenAI live-test status

| Step | Status |
|------|--------|
| Smoke script exists | YES |
| Completion | **NOT RUN** — credential unavailable (placeholder/missing `OPENAI_API_KEY` in build env) |
| Stream | **NOT RUN** |

---

## 15. Anthropic live-test status

| Step | Status |
|------|--------|
| Smoke script exists | YES |
| Completion | **NOT RUN** — credential unavailable |
| Stream | **NOT RUN** |

---

## 16. Google live-test status

| Step | Status |
|------|--------|
| Smoke script exists | YES |
| Completion | **NOT RUN** — credential unavailable |
| Stream | **NOT RUN** |

---

## 17. Cross-provider live-test status

**NOT RUN** — no live keys and no automated multi-provider smoke command. Cross-provider behaviour remains proven via mocks (routing unit tests + acceptance `cross-provider cost selects cheapest vendor`, stream fallback stages).

---

## 18. Database / RLS tests

- Multi-provider CHECK inserts and BYOK round-trip (see §3–4).
- Tenant isolation: acceptance `tenant B cannot access tenant A provider connection`, `tenant B cannot see tenant A attempts`.
- Provider verification mock tests: `packages/providers/src/verify.test.ts` (401, 429, timeout, 5xx, malformed models — no vendor body to UI).

---

## 19. Acceptance

Executed: `pnpm acceptance` — **PASS** (mock/fake only).

New / reaffirmed stages include:

- Anthropic / Google connection and model rule persistence
- Platform opt-in required
- Failed BYOK excluded
- Gemini blocked + large-context pricing
- Stream pre-open and cross-provider stream fallback attempts
- Cost cross-provider routing, hard-budget fallback, knowledge strict grounding, fixed mode unchanged

Full stage list emitted by harness on success (50+ PASS lines).

---

## 20. Remaining pricing gaps

Documented (not invoice-perfect):

| Gap | Status |
|-----|--------|
| OpenAI cached input tokens in usage → cost | Not extracted in adapter accounting |
| Anthropic cache **creation** tokens | Not fully accounted |
| Gemini “thoughts” / thinking usage | Depends on provider semantics; not fully normalized |
| Gemini 2.5 Pro >200k tier | **Hard-gated**, not tier-priced |

Do not claim invoice-perfect FinOps (commercial claim **I** remains **PARTIALLY SUPPORTED**).

---

## 21. Remaining security risks

- Live BYOK verification still depends on operator-supplied keys; failed verification does not auto-disable row (unchanged; operators must fix or disable).
- Platform secrets remain in server env only (never copied to tenant rows) — by design.
- Smoke scripts require discipline: never commit real keys; smoke is opt-in only.
- Auth failures during routing do not automatically flip connection verification status (audit P2-7; unchanged).

---

## 22. Commercial claims matrix

| Claim | V1.2.1 assessment |
|-------|-------------------|
| A. Route across OpenAI, Anthropic, Google | **SUPPORTED** (software + mocks; live per-vendor reported separately) |
| B. BYOK for all three | **SUPPORTED** (schema + connect path; live verify **NOT RUN**) |
| C. Cost routing cheapest qualifying | **SUPPORTED** |
| D. Fail over across providers | **SUPPORTED** in tested paths; live failover **NOT RUN** |
| E. Platform usage requires org opt-in | **SUPPORTED** |
| F. BYOK verified before routing | **SUPPORTED** (verified status required) |
| G. Attempt accounting streaming + non-streaming | **SUPPORTED** |
| H. Hard budgets during fallback | **SUPPORTED** (acceptance unchanged) |
| I. Invoice-perfect pricing | **PARTIALLY SUPPORTED** |
| J. Measured customer savings | **NOT SUPPORTED** |

---

## 23. Design-partner readiness (§42 gate)

| Criterion | Result |
|-----------|--------|
| Schema allows all three BYOK providers | **YES** |
| Provider policy allows all three | **YES** |
| Explicit platform credential consent | **YES** |
| OpenAI live completion | **NOT TESTED** |
| OpenAI live stream | **NOT TESTED** |
| Anthropic live completion | **NOT TESTED** |
| Anthropic live stream | **NOT TESTED** |
| Google live completion | **NOT TESTED** |
| Google live stream | **NOT TESTED** |
| Cross-provider live request | **NOT TESTED** |

**Verdict:** **READY FOR INTERNAL LIVE PROVIDER TESTING**

Run `pnpm smoke:openai`, `pnpm smoke:anthropic`, and `pnpm smoke:google` with real developer keys, record PASS/FAIL, then re-evaluate for **READY FOR CONTROLLED DESIGN-PARTNER PILOT**.

---

## 24. Production readiness

Multi-provider routing is **technically unblocked** for internal live validation. **NOT PRODUCTION READY** for commercial multi-vendor operation until live smokes pass, pricing gaps are accepted or closed, and operational runbooks cover platform vs BYOK consent.

---

## 25. Recommended next phase

1. Execute live smokes (and optional small gateway-multi pilot) with secrets in a controlled environment; attach results to an addendum.
2. Either implement Gemini 2.5 Pro tiered pricing bands or keep hard-gate until catalogue has verified >200k rates.
3. Incremental cache-token accounting where adapters already expose fields.
4. Optional: `pnpm smoke:gateway-multi` through full Gateway with test org + explicit `platform_env` rows.
5. Re-run adversarial audit after live evidence.

---

## Verification (quality gate)

| Check | Result | Notes |
|-------|--------|-------|
| `pnpm db:migrate` (0008) | pass | Applied in dev |
| `pnpm lint` | pass | |
| `pnpm test --force` | pass | Includes DB constraints, eligibility, gemini, messages, registry, routing |
| `pnpm build` | pass | Dashboard: use `CI=1` if local Next build hangs without it |
| `pnpm acceptance` | pass | No real API calls |
| `pnpm smoke:*` | scripts present | **NOT RUN** (no keys) |

---

## Product rule (recap)

> Make the multi-provider path real enough to test with actual provider accounts. Fix schema, credential intent, known provider-response gaps, and safe explicit smoke tooling—then stop.

V1.2.1 stops here.
