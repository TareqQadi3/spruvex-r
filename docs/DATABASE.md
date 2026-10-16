# SpruVex R — Database Overview

PostgreSQL 16, one shared schema, Row-Level Security for tenant isolation.
Schema source of truth: `apps/api/prisma/schema.prisma`. Migration history:
`apps/api/prisma/migrations/`.

## Roles

| Role | Login | RLS | Used by |
|---|---|---|---|
| `spruvex_admin` | yes | `BYPASSRLS` | migrations, seeds, `PlatformPrismaService` |
| `spruvex_app` | yes | `NOBYPASSRLS` | the API's normal runtime connection (`PrismaService`) |

`infra/postgres/init/01-roles.sql` creates both roles;
`infra/postgres/init/02-databases.sh` creates `spruvex_r` (and
`spruvex_r_test` for CI/local tests), grants `spruvex_app` baseline CRUD via
`ALTER DEFAULT PRIVILEGES`, so **every new table automatically grants CRUD to
`spruvex_app`** — `REVOKE` statements in migrations are what lock a table
down (append-only ledgers, read-only catalogs), not `GRANT`s.

## Conventions (every tenant-owned table)

- `id UUID` primary key, `tenant_id UUID` (+ `branch_id` where operational).
- `created_at` / `updated_at` / `created_by` / `updated_by`.
- Soft delete via `deleted_at` — **except** append-only tables (below), which
  are never updated or deleted at all.
- Money: `NUMERIC` halalas-equivalent (2-decimal SAR) for prices/totals, or
  4-decimal "cost units" for ingredient/recipe costing — never `float`.
- RLS: `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` + a
  `tenant_isolation` policy:
  ```sql
  CREATE POLICY tenant_isolation ON <table>
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
  ```
  `WITH CHECK` is what actually stops a cross-tenant write, even if
  application code forgets to scope a query.

## Append-only tables (no UPDATE/DELETE, ever)

`REVOKE UPDATE, DELETE ON <table> FROM spruvex_app` — corrections happen via
new compensating rows, never edits.

| Table | Why |
|---|---|
| `payments`, `receipts` | financial/ZATCA record — must not be edited after the fact |
| `stock_movements` | inventory ledger — `stock_levels` is the mutable projection, kept in sync transactionally |
| `subscription_invoices` | billing record |
| `audit_logs` | tamper-evident audit trail |

## Global (non-tenant) catalogs — read-only for `spruvex_app`

`REVOKE INSERT, UPDATE, DELETE ON <table> FROM spruvex_app` — seeded and
maintained only via migrations/seeds (`spruvex_admin`).

| Table | Seeded from |
|---|---|
| `permissions` | `@spruvex-r/types` `PERMISSIONS` catalog |
| `units_of_measure` | `@spruvex-r/types` `UNIT_CATALOG` |
| `plans` | `@spruvex-r/types` `PLAN_CATALOG` |

`platform_admins` is also global (no `tenant_id`/RLS) but is **not**
read-only — it's a normal CRUD table, just with no self-registration
endpoint (rows are created directly, e.g. via the seed's
`PLATFORM_ADMIN_EMAIL`/`PLATFORM_ADMIN_PASSWORD` bootstrap).

## Domain → tables

| Domain | Tables |
|---|---|
| Identity & Tenancy | `tenants`, `branches`, `users`, `refresh_tokens`, `otp_codes`, `roles`, `permissions`, `role_permissions`, `user_roles`, `pos_pins` |
| Catalog | `categories`, `products`, `product_branch_settings`, `modifier_groups`, `modifiers`, `product_modifier_groups` |
| Tables & Floors | `floors`, `tables`, `table_sessions` |
| Ordering | `orders`, `order_items`, `order_item_modifiers`, `order_status_history` |
| Shifts & Payments | `shifts`, `payments`, `receipts` |
| Inventory & Recipes | `units_of_measure`, `ingredients`, `stock_locations`, `stock_levels`, `stock_movements`, `recipe_items` |
| Billing | `plans`, `subscriptions`, `subscription_invoices` |
| Platform | `platform_admins` |
| Audit | `audit_logs` |

## Notable design points

- **Frozen snapshots**: `order_items`/`order_item_modifiers` store a JSONB
  snapshot of the product/modifier name+price at order time, plus (Phase 7)
  `unit_cost`/`line_cost` frozen from the recipe/ingredient cost at that
  moment. Editing the menu or a recipe later never changes historical orders.
- **Receipts are append-only and sequential**: `receipts.receipt_number` is a
  gapless per-branch sequence — required for ZATCA-style simplified invoices.
  `qr_payload` holds the Base64 TLV QR; `invoice_hash`/`previous_invoice_hash`/
  `zatca_status`/`zatca_response` are Phase-2-ready columns, unused until a
  ZATCA reporting integration is wired up.
- **Idempotency**: `orders.idempotency_key` and the compound unique key on
  `stock_movements` (`tenant_id, type, reference_type, reference_id,
  ingredient_id`) make order creation and automatic stock deduction safe to
  retry/replay.
- **One subscription per tenant**: `subscriptions.tenant_id` is `@unique`.
- **`tenant_id` column `DEFAULT`**: tables added from Phase 7 onward also set
  a column default of
  `NULLIF(current_setting('app.current_tenant_id', true), '')::uuid` — a
  convenience so a query that forgets to set `tenant_id` explicitly still
  gets it filled in, on top of (not instead of) the RLS `WITH CHECK`
  enforcement. Every migration that touches one of these tables must
  re-apply this default at the end (Prisma's diff engine can't see a raw-SQL
  default and silently drops it) — see the `restore_tenant_id_defaults`
  migration for the pattern to copy.

## Migration workflow

- **Dev**: `pnpm db:migrate:dev` (`prisma migrate dev` against your local DB) —
  generates a new migration from schema changes and applies it immediately.
- **Deploy** (CI, staging, production): `pnpm db:migrate:deploy` — applies
  any migrations not yet recorded in `_prisma_migrations`, never generates
  new ones, never resets data.
- **Never edit a migration file after it has been applied anywhere** —
  Prisma checksums applied migrations against their file content; editing one
  makes `migrate deploy`/`migrate status` refuse to proceed ("modified after
  applied") and its only built-in recovery path is a full reset. If you need
  one more statement (a `REVOKE`, an RLS policy, a restored `DEFAULT`),
  create a new migration instead, even if it's a single line.
- **RLS/grants are hand-written SQL**, appended to the Prisma-generated
  `migration.sql` after `prisma migrate dev --create-only` — Prisma has no
  declarative way to express `ENABLE ROW LEVEL SECURITY`, policies, or
  `REVOKE`. Copy the `DO $$ ... FOREACH t IN ARRAY [...] ...` pattern from
  the most recent migration that added tenant tables.
- **Seeding**: `pnpm db:seed` runs `apps/api/prisma/seed.ts` — idempotent
  catalog syncs (permissions/units/plans) plus one demo tenant if none
  exists. Safe to re-run.

## Backup strategy

1. **Managed Postgres is preferred** once there's real customer data
   (RDS/Cloud SQL/Supabase-postgres or similar) — automated snapshots +
   point-in-time recovery come for free, matching the architecture plan's
   "start with Docker Compose, move to managed Postgres" decision (§8.2).
2. **If self-hosting Postgres** (the `docker-compose.prod.yml` path): backups
   run **automatically**, no host crontab needed — `docker-compose.prod.yml`
   includes a `backup` sidecar service (`postgres:16-alpine` + busybox
   `crond`) that connects to the `postgres` service directly over the
   compose network and runs `infra/scripts/backup-once.sh` on
   `BACKUP_SCHEDULE` (default `0 3 * * *`, i.e. daily at 03:00 UTC — set in
   `.env.production`). It fails loudly (non-zero exit, logged) on an
   empty/truncated dump instead of silently keeping a useless file, runs one
   backup immediately on container start (so a bad password/connection
   fails fast instead of silently on the first scheduled run), and prunes
   local dumps older than `RETENTION_DAYS` (default 14). The `pg_dump`/
   `pg_restore` round-trip has been verified in this repo (dump → restore
   into a scratch database → table count matches) — the sidecar service
   itself has not been build/run-verified end-to-end yet, since this
   repo's Docker builds are blocked in every sandbox available so far (see
   `docs/PILOT_LAUNCH_FINAL_REPORT.md`); smoke-test it (`docker compose
   -f docker-compose.prod.yml up -d backup && docker compose -f
   docker-compose.prod.yml logs -f backup`) on the real deployment host
   before relying on it. Dumps land in the `backups` named volume — copy
   them off the host yourself (S3 or similar); a backup that lives only on
   the machine it protects against isn't one. Enable WAL archiving too if
   you need point-in-time recovery rather than daily-granularity restore.

   For an ad hoc one-off dump (or if you'd rather drive backups from the
   host's own cron instead of the sidecar), `infra/scripts/backup-db.sh`
   still works the same way it always has, via `docker compose exec`:
   ```bash
   # cron, run from the directory containing docker-compose.prod.yml:
   0 3 * * * BACKUP_DIR=/var/backups/spruvex-r infra/scripts/backup-db.sh >> /var/log/spruvex-backup.log 2>&1
   ```
3. **Test restores periodically** — an untested backup is not a backup.
   Restore into a scratch database and run a smoke query (e.g. tenant/order
   counts) after every restore-process change.
4. **Secrets are not in the database** — `JWT_SECRET` and role passwords live
   in environment variables/secret managers, so a database restore alone
   doesn't leak them, but also doesn't recover them; keep them backed up
   separately (e.g. your deployment platform's secret store).
