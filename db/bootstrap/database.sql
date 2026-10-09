-- =============================================================================
-- DATABASE BOOTSTRAP (superuser, connected to the target database).
-- Installs extensions (some are not "trusted" and need superuser) and locks
-- down default privileges. Idempotent.
-- =============================================================================

ALTER DATABASE :"db_name" OWNER TO hs_owner;
ALTER DATABASE :"db_name" SET timezone = 'UTC';
ALTER DATABASE :"db_name" SET search_path = app, extensions;

REVOKE ALL ON DATABASE :"db_name" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db_name" TO hs_owner, hs_app, hs_worker;
GRANT CREATE, TEMPORARY ON DATABASE :"db_name" TO hs_owner;

-- Nobody but the owner may create objects in public.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO hs_owner;

CREATE SCHEMA IF NOT EXISTS extensions AUTHORIZATION hs_owner;
REVOKE ALL ON SCHEMA extensions FROM PUBLIC;
GRANT USAGE ON SCHEMA extensions TO hs_app, hs_worker;

CREATE EXTENSION IF NOT EXISTS pgcrypto   WITH SCHEMA extensions;  -- gen_random_bytes, digest
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;  -- booking exclusion constraints
CREATE EXTENSION IF NOT EXISTS vector     WITH SCHEMA extensions;  -- pgvector
CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA extensions;
