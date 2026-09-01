# SpruVex R — Environment Setup

## Prerequisites

- Node.js ≥ 20 (22 recommended — matches CI and the production Dockerfiles)
- pnpm 10 (`corepack enable` picks up the version pinned in `package.json`)
- PostgreSQL 16 and Redis 7 — via `docker compose up -d` (dev) or installed
  natively

## Local development

```bash
pnpm install
docker compose up -d              # Postgres 16 + Redis; creates roles & DBs
cp .env.example .env               # fill in values (defaults work out of the box locally)
pnpm --filter @spruvex-r/api prisma:generate
pnpm db:migrate:deploy
pnpm db:seed
pnpm dev                           # turbo: runs every app's dev server
```

Each frontend's Vite/Next dev server proxies `/api` (and `/socket.io` for
KDS/POS) to `http://localhost:3000` — see each app's `vite.config.ts` /
`next.config.ts`. Default ports:

| App | Port |
|---|---|
| api | 3000 |
| dashboard | 5173 |
| ordering | 3002 |
| kds | 5175 |
| pos | 5176 |
| platform | 5177 |

## Environment variables (`apps/api`)

Full reference lives in `.env.example` at the repo root (dev defaults) and
`.env.production.example` (production, `docker-compose.prod.yml`). Summary:

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | `spruvex_app` connection — RLS always enforced |
| `ADMIN_DATABASE_URL` | yes | `spruvex_admin` connection — migrations/seed/platform module |
| `JWT_SECRET` | yes | HMAC secret for **both** tenant access tokens and platform admin tokens — generate a long random value per environment, never reuse across environments |
| `SPRUVEX_SITE_API_KEY` | yes | shared secret spruvex-site sends as `x-spruvex-site-key` when calling `POST /public/trial-signup` — must match the value configured on spruvex-site exactly; generate with `openssl rand -hex 32` |
| `JWT_ACCESS_TTL_SECONDS` | no (default 900) | tenant access token lifetime |
| `REFRESH_TOKEN_TTL_DAYS` | no (default 30) | tenant refresh token lifetime |
| `REDIS_URL` | no | Socket.io fan-out + health check; degrades gracefully (in-memory adapter) if unset/unreachable — fine for one instance, not for multiple |
| `ORDERING_BASE_URL` | yes for QR codes to resolve correctly | base URL encoded into table QR codes and shown in tenant settings |
| `CORS_ORIGINS` | yes | comma-separated list of exact origins allowed — **no wildcards**; an empty value blocks all cross-origin requests (fails closed) |
| `PORT` | no (default 3000) | |
| `NODE_ENV` | no | `production` in deployed environments |
| `PLATFORM_ADMIN_EMAIL` / `PLATFORM_ADMIN_PASSWORD` | no | if both set, `pnpm db:seed` bootstraps this platform admin account when none exists yet — the only way to get the first `/platform` login. Safe to unset after first use. |

`apps/ordering` also reads two server-side variables — see `.env.example`
for local dev, `.env.production.example` for production:
- `API_ORIGIN`: where SSR pages fetch the API from. In
  `docker-compose.prod.yml` this is hardcoded to the internal
  `http://api:3000` (the compose network address).
- `PUBLIC_API_ORIGIN`: the API's real public HTTPS origin. Read at request
  time server-side and handed to the client as a prop for the
  order-tracking realtime socket (`app/order/[orderId]/page.tsx`) — **not**
  a `NEXT_PUBLIC_*` build-time variable, deliberately: those get inlined
  into the client bundle at build time, which most container platforms
  (including plain `docker compose build`, and hosts like Render that don't
  support custom Docker build args at all) can't easily pass in without a
  registry round-trip. This way the same built image is configured purely
  by its runtime environment, on any platform.

## Secrets management

- **Never commit** `.env`, `.env.production`, or any file with real
  credentials — `.gitignore`/`.dockerignore` already exclude `.env*` except
  the `.example` files.
- `JWT_SECRET` must be a long random value (32+ bytes), unique per
  environment. Rotating it invalidates every issued token immediately (all
  users and platform admins are signed out) — acceptable for an incident
  response, disruptive otherwise.
- Database role passwords (`spruvex_app`, `spruvex_admin`) are set in
  `infra/postgres/init/01-roles.sql` for local/CI convenience (hardcoded dev
  values). **For production, change them** — either edit that file before
  the container's first boot, or `ALTER ROLE ... PASSWORD '...'` once
  against a running instance and update `DATABASE_URL`/`ADMIN_DATABASE_URL`
  to match.
- Use your platform's secret manager in production (e.g. Docker/Kubernetes
  secrets, your cloud provider's secret store) rather than plain environment
  variables in a compose file where avoidable — `docker-compose.prod.yml`
  reads from `--env-file` for this repo's default path, but swap in secret
  injection if your platform supports it.
- `PLATFORM_ADMIN_PASSWORD` is only read once (at seed time, to hash and
  store it) — unset it from the environment after the first successful
  bootstrap.

## Running tests

```bash
pnpm test          # turbo: every package's test suite
```

The API's tests run against a dedicated `spruvex_r_test` database (created
by `infra/postgres/init/02-databases.sh`); `apps/api/test/global-setup.ts`
applies migrations automatically before the suite runs. No manual DB setup
needed beyond `docker compose up -d`.
