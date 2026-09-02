-- Explicit RLS access for the admin (BYPASSRLS) role.
--
-- Every tenant table uses `FORCE ROW LEVEL SECURITY`, so even the schema
-- owner is subject to the tenant_isolation policy unless the connecting role
-- carries BYPASSRLS. Locally (docker-compose / infra/postgres/init/01-roles.sql)
-- spruvex_admin is created WITH BYPASSRLS, so this migration is a no-op in
-- effect there. On Render's managed Postgres there is no superuser access to
-- grant BYPASSRLS after the fact — the roles were created through the dashboard
-- query console without it — so the admin connection (PlatformPrismaService,
-- ADMIN_DATABASE_URL) was blocked by RLS and every tenant-provisioning write
-- failed ("Could not finish creating the trial restaurant").
--
-- Fix: give the admin role its own PERMISSIVE policy on every RLS table.
-- Permissive policies OR together, so:
--   - spruvex_admin (platform/provisioning/seed connections): full access,
--     exactly what BYPASSRLS would have granted, but expressible in SQL by a
--     table owner instead of requiring a superuser.
--   - spruvex_app (the app role): unchanged — still only what
--     tenant_isolation allows, RLS remains the last line of defense.
--
-- Discovers tables dynamically from pg_policies (everything carrying the
-- tenant_isolation policy — the single naming convention across all domains)
-- so future RLS tables are covered by a re-run, and creates the policy only
-- when missing (idempotent, safe on Postgres 14+ where CREATE POLICY has no
-- IF NOT EXISTS).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT schemaname, tablename
    FROM pg_policies
    WHERE policyname = 'tenant_isolation'
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = r.schemaname
        AND tablename = r.tablename
        AND policyname = 'admin_full_access'
    ) THEN
      EXECUTE format(
        'CREATE POLICY admin_full_access ON %I.%I TO spruvex_admin
           USING (true) WITH CHECK (true)',
        r.schemaname, r.tablename
      );
    END IF;
  END LOOP;
END
$$;