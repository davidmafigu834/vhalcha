# V1 scope

V1 lets an organisation place one non-critical AI workload behind Vhalcha and see what it called, what it cost, and why a request was allowed or blocked.

## Included

- Organisation, users, environments, and AI systems
- Virtual API keys, shown once and stored as a hash
- OpenAI chat completions through `POST /v1/chat/completions`
- Streaming and non-streaming responses
- Model allow rules, per-system rate limits, and budget warn/block
- Request, usage, policy, and audit records
- Dashboard pages: Overview, AI Systems, Gateway, Spend, Audit Log, Settings
- Role checks on writes and on console page reads
- Owner-only role changes
- PostgreSQL budget reservations and row level security on tenant tables
- Metadata-only idempotency
- A mock provider that production refuses to start
- Development seed for Acme Corporation, including a fictional Product & Support knowledge space
- Minimal TypeScript SDK, `@vhalcha/sdk`
- Knowledge spaces, manual documents, versions, pgvector retrieval, AI-system grants, citations, and strict grounding

## Shown but not implemented

Guard, Registry, Trust, Policies, and Reports appear in navigation as "V1 later". Those pages state that they are outside this release and do not show invented data.

## Not in this repository

Agent builder, workflow builder, mobile app, marketplace, government portal, air-gapped deployment, Kubernetes, multi-region active-active, a Vhalcha model, Anthropic, Gemini, a separate vector database, Drive/SharePoint/Notion connectors, OCR, knowledge graphs, a data-loss engine, prompt-injection detection beyond the retrieval baseline, human approval, evaluations, billing, managed credits, and reseller accounts.

## Acceptance path

1. Sign in as `owner@acme.test`.
2. Confirm the seeded organisation and Development environment.
3. Open Customer Support AI, or register it with a $25 monthly budget, OpenAI model `gpt-4.1-mini`, and 60 requests per minute.
4. Generate a `vh_test_` key and copy it once.
5. Call the gateway with that key.
6. Confirm the streamed response, the Gateway request row, Spend, and an audit event.
7. Lower the budget below current usage.
8. Call the gateway again.
9. Confirm HTTP 402, no provider call, and a blocked request with an audit event.

`corepack pnpm acceptance` repeats that gateway path against local PostgreSQL and Redis with `VHALCHA_PROVIDER_MODE` forced to `mock`. It listens on an ephemeral port, sends real HTTP to that process, and does not call OpenAI. The same stages run in `apps/gateway/src/acceptance.test.ts`.
