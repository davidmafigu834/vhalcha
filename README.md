# Vhalcha

Vhalcha is the AI control plane for organisations. It sits between an organisation's AI applications and model providers so the organisation can control which systems run, which models they can call, how much they can spend, and what happened on every request.

The customer application uses a Vhalcha virtual API key. It never receives the provider credential.

Vhalcha is developed by DIVSTAR Technologies Inc. This repository is the V1 foundation: dashboard, gateway, worker, PostgreSQL, and Redis. It is not an agent builder.

## Repository structure

```text
apps/dashboard   Next.js console
apps/gateway     Fastify OpenAI-compatible gateway
apps/worker      Spend summaries and cleanup
packages/        Shared control-plane libraries and @vhalcha/sdk
docs/            Architecture, API, security, and operations
```

## Requirements

- Node.js 22 or newer
- pnpm 10.15.1 (`corepack pnpm`)
- PostgreSQL 16
- Redis 7
- An OpenAI API key when you want the gateway to call OpenAI

Automated tests do not need PostgreSQL, Redis, or OpenAI. They use an in-process database and a mocked provider.

## Setup

```bash
corepack pnpm install
copy .env.example .env
```

Set `OPENAI_API_KEY` and `SESSION_SECRET` in `.env`. Do not commit `.env`.

Start local PostgreSQL and Redis:

```bash
docker compose up -d
```

Apply the schema and load development data:

```bash
corepack pnpm db:migrate
corepack pnpm db:seed
```

The seed command creates Acme Corporation and prints virtual keys once. It also writes them to `.local/seed-keys.json`, which is gitignored. Seed refuses to run when `VHALCHA_ENV=production`.

Development sign-in:

```text
Email:    owner@acme.test
Password: ChangeMe-Dev-Only-1
```

Other seed accounts use the same password: `ai-admin@acme.test`, `developer@acme.test`, `security@acme.test`, `finance@acme.test`, and `viewer@acme.test`.

## Run

```bash
corepack pnpm dev
```

- Dashboard: http://localhost:3000
- Gateway: http://localhost:3001

`pnpm dev` starts the dashboard, gateway, and worker. If the dashboard or worker stops, the gateway continues to serve requests.

## First gateway request

Use the Customer Support AI key printed by the seed command. The development model is `gpt-4.1-mini`.

```bash
curl http://localhost:3001/v1/chat/completions \
  -H "Authorization: Bearer vh_test_xxx" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"gpt-4.1-mini\",\"messages\":[{\"role\":\"user\",\"content\":\"Explain our return policy.\"}],\"stream\":true}"
```

The request is recorded in Gateway, the cost is recorded in Spend, and an audit event is recorded in Audit Log. Prompts and model responses are not stored in PostgreSQL.

## Environment variables

See `.env.example`. Required at startup:

| Variable | Used by |
| --- | --- |
| `DATABASE_URL` | dashboard, gateway, worker |
| `REDIS_URL` | gateway, worker |
| `OPENAI_API_KEY` | gateway, except local tests |
| `SESSION_SECRET` | dashboard, at least 32 characters |
| `VHALCHA_GATEWAY_URL` | dashboard health and developer settings |

`memory://` is a single-process Redis substitute. The gateway refuses it when `VHALCHA_ENV=production`.

## Further reading

- [Local development](docs/local-development.md)
- [Architecture](docs/architecture.md)
- [Gateway API](docs/gateway-api.md)
- [Database model](docs/database-model.md)
- [Security model](docs/security-model.md)
- [Deployment](docs/deployment.md)
- [V1 scope](docs/v1-scope.md)
