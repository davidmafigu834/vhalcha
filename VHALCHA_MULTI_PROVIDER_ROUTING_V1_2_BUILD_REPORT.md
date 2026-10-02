# Vhalcha Multi-Provider Routing V1.2 — Build Report

## 1. Executive summary

V1.2 makes Intelligent Routing provider-neutral. OpenAI, Anthropic, and Google Gemini are real adapters behind a `ProviderRegistry`. Optimised routing discovers candidates across vendors, ranks them with the V1.1 Cost / Balanced / Quality / Latency rules, and can fall back across providers without a process-global `VHALCHA_PROVIDER_MODE=openai` lock.

This phase does **not** implement Managed AI billing, AI wallets, token resale, Guard, LLM-as-judge routing, or measured savings claims. Catalogue prices were re-verified against official provider documentation on 2026-09-29 and stamped with `price_source` / `price_effective_at` / `price_verified_at`.

## 2. Architecture

```
Application → Vhalcha Gateway → routing engine → selected provider + model → ProviderRegistry.get(provider)
```

- `VHALCHA_PROVIDER_MODE=mock` registers only the mock adapter (tests / local).
- `VHALCHA_PROVIDER_MODE=openai` enables real OpenAI, Anthropic, and Google adapters. It does **not** force every request onto OpenAI.
- Production path: `selectedProvider` / `selectedModel` from the routing decision, then `providers.get(selectedProvider)`.

## 3. Provider adapters

| Provider   | Adapter               | Auth                         | Cheap credential check      |
|-----------|------------------------|------------------------------|-----------------------------|
| OpenAI    | `OpenAIProvider`       | Bearer API key               | `GET /v1/models`            |
| Anthropic | `AnthropicProvider`    | `x-api-key` + API version    | `GET /v1/models`            |
| Google    | `GeminiProvider`       | `x-goog-api-key`             | `GET /v1beta/models`        |
| Mock      | `MockModelProvider`    | n/a                          | always verified             |

Normalized surface: chat completion, streaming, usage extraction, timeouts, abort signal, structured metadata, and `classifyProviderStatus` error codes. Vendor raw bodies are not returned to customers.

Message translation (`splitChatMessages`) lifts system text and preserves user/assistant order without leaking Vhalcha metadata.

Capabilities claimed only where the Vhalcha adapter implements them. Anthropic and Gemini catalogue rows do **not** claim tool or vision routing for V1.2 text adapters.

## 4. Credential paths and verification

Connections remain one active row per organisation / environment / provider.

States: `unverified` → `verified` | `failed` | `disabled`, with `verification_error_code`, `verified_at`, `last_checked_at`.

Connect flow: encrypt → store unverified → bounded models-list verification → mark verified or failed. API keys are never logged or placed in audit metadata.

Eligible providers for routing:

- Platform env keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`) when present.
- Organisation BYOK only when `verificationStatus === 'verified'`.
- `vhalcha_managed` remains future-only and fails closed.

Dashboard Providers page supports OpenAI / Anthropic / Google connect, Test connection, and safe labels (Verified / Authentication rejected / Timeout / Provider unavailable).

## 5. Catalogue and prices

Migration `0007_multi_provider.sql` adds:

- Claude Haiku 4.5 — $1 / $5 input/output per MTok, cache read $0.10
- Claude Sonnet 5 — $2 / $10, cache read $0.20
- Gemini 2.5 Flash — $0.30 / $2.50, cache $0.03
- Gemini 2.5 Pro — $1.25 / $10 (≤200k tier), cache $0.125

OpenAI gpt-4.1 / mini / 4o / 4o-mini rates were re-verified and UPDATEd (not left on stale conflict inserts).

`pnpm db:sync-prices` reads the reviewed `cataloguePriceUpdates` list for openai / anthropic / google / mock. Runtime never scrapes pricing pages.

`VHALCHA_MAX_PRICING_AGE_DAYS` still suppresses estimated optimisation benefit when prices are stale; routing may continue.

## 6. Cross-provider routing semantics

- **allowed_providers** — hard filter
- **prohibited_providers** — deny list (hard)
- **preferred_providers** — soft tie-break for Balanced / Quality / Latency when scores are close; **ignored by Cost**
- Model allow/deny rules still apply per provider + model pattern
- Candidate discovery is not locked to a single runtime provider (except mock mode → `['mock']`)

Cost proof: among OpenAI ~$0.006, Anthropic ~$0.012, Gemini ~$0.002 equivalents with equal eligibility, Cost selects Gemini. Covered by unit and acceptance stages.

## 7. Cross-provider fallback

Fallback walks the ranked list. Provider identity changes with the next candidate. All V1.1 guarantees remain: capability, policy, credentials, health, context, pricing, budget raise (actual so far + next estimate), attempt ledger, tenant isolation, audit, bounded attempts.

Attempt ledger records provider, model, status, safe error code, billable flag, tokens, token-priced cost, latency.

Provider-level health (`model_name = ''`) opens on repeated `provider_unavailable` / `provider_timeout` only. Authentication failures and 429s are not treated as a global vendor outage. Invalid requests are not outages.

## 8. Audit events

- `provider.verification.started` / `.succeeded` / `.failed`
- Existing `routing.fallback.*` events carry `fallback_from_provider` and target provider fields

## 9. Explicit non-goals (unchanged)

Managed AI billing, wallets, resale, Guard, LLM-as-judge, measured savings, speculative giant catalogues, automatic runtime price scraping.

## 10. Verification

Executed after migrate `0007`:

| Check | Result |
|-------|--------|
| `pnpm lint` | pass |
| `pnpm db:migrate` (includes 0007) | pass |
| `pnpm test --force` | pass |
| `pnpm build` (after `pnpm install` linked `@vhalcha/providers` into dashboard) | pass |
| `pnpm acceptance` | pass, including `cross-provider cost selects cheapest vendor — google/gemini-economy` |

Cross-provider Cost selection is proven in `packages/routing` unit tests and the acceptance stage without requiring live Anthropic/Google keys in CI. Live adapter behaviour is covered by OpenAI / Anthropic / Gemini / verify unit tests with injected `fetch`.
