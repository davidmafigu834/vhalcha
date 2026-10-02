# Deployment

V1 runs as three Node.js processes plus PostgreSQL and Redis. It does not require Vercel, Render, or Kubernetes.

## Processes

| Process | Start | Notes |
| --- | --- | --- |
| Gateway | `pnpm --filter @vhalcha/gateway start` | Must stay available for AI traffic. |
| Dashboard | `pnpm --filter @vhalcha/dashboard start` | May be down without stopping the gateway. |
| Worker | `pnpm --filter @vhalcha/worker start` | May be down without stopping enforcement. |

Build with `pnpm build` first. The gateway and worker typecheck in place and run through `tsx` from TypeScript source. The dashboard produces a Next.js build.

## Configuration

Set `VHALCHA_ENV=production`.

Required:

- `DATABASE_URL`
- `REDIS_URL` as `redis://` or `rediss://`. `memory://` is rejected.
- `OPENAI_API_KEY` for platform-managed OpenAI connections.
- `SESSION_SECRET` of at least 32 characters.
- `VHALCHA_GATEWAY_URL` and `NEXT_PUBLIC_VHALCHA_APP_URL`
- `ALLOWED_ORIGINS` if a browser will call the gateway. An empty list denies browser origins.

Do not set `VHALCHA_CONFIRM_PRODUCTION_MIGRATE=yes` in the long-lived process environment. Set it only for the migration command.

Do not run `pnpm db:seed` in production. The seed command exits when `VHALCHA_ENV=production`.

## Migrations

Run `pnpm db:migrate` as a release step before starting the new gateway. The gateway does not migrate on startup.

## Health

- `GET /health` means the process is alive.
- `GET /ready` means PostgreSQL accepted a query and Redis answered ping.

Use `/ready` as the load-balancer check. Neither endpoint returns credentials or host details.

## Observability

Gateway logs are JSON and include `request_id`, `organisation_id`, `ai_system_id`, `provider`, `model`, `status`, and `latency_ms`. They do not include prompts, virtual keys, or provider keys.

`SENTRY_DSN` is optional. An empty value disables error tracking and does not prevent startup.

## What this layout does not include

V1 does not include multi-region active-active, Kubernetes manifests, a private model host, or a customer key management service. Customer-managed provider credentials stay disabled until a real KMS integration exists.
