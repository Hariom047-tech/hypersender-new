-- =============================================================================
-- CLUSTER BOOTSTRAP (run ONCE per environment by a PostgreSQL superuser / the
-- managed-DB master user). NOT a migration: roles and extensions are cluster /
-- database level objects that the migration role must not be able to create.
--
-- Executed by scripts/bootstrap.ts, which substitutes the psql-style password
-- placeholders below with safely quoted literals (never string-concatenated).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Roles
--   hs_owner  : migration/admin role. Owns every schema object. BYPASSRLS so that
--               SECURITY DEFINER helper functions (login lookup, API-key auth,
--               purge procedures) can operate across tenants. NEVER used by the
--               running application or workers.
--   hs_app    : request-serving API role. Subject to RLS (NOBYPASSRLS).
--   hs_worker : background workers (Baileys gateway, outbox, webhooks, AI).
--               Subject to RLS (NOBYPASSRLS); cross-tenant only on queue tables.
-- None of them is SUPERUSER / CREATEROLE / CREATEDB.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hs_owner') THEN
    CREATE ROLE hs_owner LOGIN BYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hs_app') THEN
    CREATE ROLE hs_app LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hs_worker') THEN
    CREATE ROLE hs_worker LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END $$;

-- Re-assert attributes every run so drift is corrected.
ALTER ROLE hs_owner  LOGIN BYPASSRLS   NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'owner_password';
ALTER ROLE hs_app    LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'app_password';
ALTER ROLE hs_worker LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'worker_password';

-- Runtime guard rails for the request-serving and worker roles.
ALTER ROLE hs_app    SET statement_timeout = '15s';
ALTER ROLE hs_app    SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE hs_app    SET lock_timeout = '5s';
ALTER ROLE hs_worker SET statement_timeout = '60s';
ALTER ROLE hs_worker SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE hs_worker SET lock_timeout = '10s';
