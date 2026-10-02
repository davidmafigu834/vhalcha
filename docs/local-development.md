# Local development

## Services

Docker Compose starts PostgreSQL 16 and Redis 7:

```bash
docker compose up -d
```

The published URLs match `.env.example`:

```text
DATABASE_URL=postgres://vhalcha:vhalcha@localhost:5432/vhalcha
REDIS_URL=redis://localhost:6379
```

If Docker is not available, install PostgreSQL and Redis locally and point those variables at them. Tests do not use those services. They use PGlite and apply every migration, including row level security.

The Docker user `vhalcha` is a superuser. Migrations and seed use `DATABASE_ADMIN_URL`. Gateway, dashboard, and acceptance use `vhalcha_app` through `DATABASE_URL`. The worker uses `vhalcha_worker` through `WORKER_DATABASE_URL`. After `pnpm db:migrate`, run `pnpm db:roles` so those roles can log in without bypassing row level security. Production still rejects the `postgres` and `vhalcha` usernames, mock providers, and local knowledge storage.

## Commands

```bash
corepack pnpm install
copy .env.example .env
corepack pnpm db:migrate
corepack pnpm db:seed
corepack pnpm dev
```

On Windows, if `pnpm` is not on `PATH`, use `corepack pnpm`. Turbo needs a `pnpm` executable. This repository includes a gitignored `.tools/pnpm.cmd` shim that calls `corepack pnpm` when a global pnpm install is not possible.

`pnpm db:migrate` applies SQL files in `packages/database/migrations`, including `0003_tenant_rls.sql`. It refuses to run against `VHALCHA_ENV=production` unless `VHALCHA_CONFIRM_PRODUCTION_MIGRATE=yes`. `0002_budget_reservations.sql` is additive. If it reports duplicate `usage_events.request_id` values, fix those rows manually and run the migration again. Do not delete them from the migration. `0003` creates database roles without passwords. Set those passwords outside the migration.

`pnpm acceptance` runs the mock-provider gateway flow. It needs `DATABASE_URL` and `REDIS_URL`. It does not spend OpenAI credit. Set `VHALCHA_PROVIDER_MODE=mock` only for local development. Production startup rejects that value.

`pnpm db:seed` creates Acme Corporation only when that slug is absent. It prints each virtual key once.

## Development accounts

Password for every seed user: `ChangeMe-Dev-Only-1`

| Email | Role |
| --- | --- |
| owner@acme.test | owner |
| ai-admin@acme.test | ai_admin |
| developer@acme.test | developer |
| security@acme.test | security_admin |
| finance@acme.test | finance_manager |
| viewer@acme.test | viewer |

Password reset in development writes the reset path to the dashboard log. Production logs only that a reset was issued.

## Checks

```bash
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test
corepack pnpm build
```

Gateway tests mock OpenAI. They must not be pointed at a real key.

## Ports

| Process | Port |
| --- | --- |
| Dashboard | 3000 |
| Gateway | 3001 |
| PostgreSQL | 5432 |
| Redis | 6379 |
