-- =============================================================================
-- 0001 FOUNDATION
-- Schemas, UUIDv7 generator, tenant-context accessors, shared trigger functions
-- and the helper used by every later migration to apply tenant RLS.
-- Runs as hs_owner.
-- =============================================================================

-- app       : all product tables + functions callable by runtime roles
-- app_auth  : SECURITY DEFINER functions used before a tenant context exists
--             (login lookup, API-key authentication). Tight EXECUTE grants.
-- app_admin : owner-only helpers (RLS application, purge procedures).
CREATE SCHEMA app;
CREATE SCHEMA app_auth;
CREATE SCHEMA app_admin;

REVOKE ALL ON SCHEMA app, app_auth, app_admin FROM PUBLIC;
GRANT USAGE ON SCHEMA app      TO hs_app, hs_worker;
GRANT USAGE ON SCHEMA app_auth TO hs_app, hs_worker;
-- app_admin: no grants to runtime roles.

-- Functions are EXECUTE-able by PUBLIC by default; flip that for every function
-- hs_owner creates from now on. Grants are made explicitly per function.
ALTER DEFAULT PRIVILEGES FOR ROLE hs_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- -----------------------------------------------------------------------------
-- UUIDv7 (time-ordered). PostgreSQL 18 ships uuidv7(); on 17 we generate it.
-- The application also generates UUIDv7 client-side; this is the DB default.
-- Time-ordered keys keep B-tree inserts append-mostly on high-volume tables and
-- allow future RANGE partitioning on id (see docs/architecture.md, "Scaling").
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.uuid_generate_v7() RETURNS uuid
LANGUAGE sql VOLATILE PARALLEL SAFE AS $$
  SELECT encode(
           set_bit(
             set_bit(
               overlay(uuid_send(gen_random_uuid())
                       PLACING substring(int8send((extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
                       FROM 1 FOR 6),
               52, 1),
             53, 1),
           'hex')::uuid;
$$;
GRANT EXECUTE ON FUNCTION app.uuid_generate_v7() TO hs_app, hs_worker;

-- -----------------------------------------------------------------------------
-- Tenant context accessors.
-- The application sets these with set_config(name, value, true) - i.e. LOCAL to
-- the current transaction - immediately after BEGIN. They are therefore never
-- leaked to the next borrower of a pooled connection.
-- An unset value yields NULL, and "organization_id = NULL" is never true:
-- default deny.
-- A malformed value raises an error (fail closed), never matches.
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.current_org_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT nullif(current_setting('app.current_organization_id', true), '')::uuid
$$;

CREATE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT nullif(current_setting('app.current_user_id', true), '')::uuid
$$;

CREATE FUNCTION app.current_api_key_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT nullif(current_setting('app.current_api_key_id', true), '')::uuid
$$;

GRANT EXECUTE ON FUNCTION app.current_org_id(), app.current_user_id(), app.current_api_key_id()
  TO hs_app, hs_worker;

-- -----------------------------------------------------------------------------
-- Generic triggers / validators
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;
GRANT EXECUTE ON FUNCTION app.set_updated_at() TO hs_app, hs_worker;

-- Declared IMMUTABLE so it can be used in CHECK constraints. The tz database
-- only changes with PostgreSQL minor upgrades; a zone is never removed, only
-- aliased, so previously valid rows stay valid.
CREATE FUNCTION app.is_valid_timezone(tz text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF tz IS NULL OR length(tz) > 64 THEN
    RETURN false;
  END IF;
  PERFORM now() AT TIME ZONE tz;
  RETURN true;
EXCEPTION WHEN invalid_parameter_value THEN
  RETURN false;
END $$;
GRANT EXECUTE ON FUNCTION app.is_valid_timezone(text) TO hs_app, hs_worker;

-- -----------------------------------------------------------------------------
-- app_admin.attach_updated_at_trigger(table)
-- -----------------------------------------------------------------------------
CREATE FUNCTION app_admin.attach_updated_at_trigger(p_table regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format(
    'CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION app.set_updated_at()',
    p_table);
END $$;

-- -----------------------------------------------------------------------------
-- app_admin.apply_tenant_rls(table)
--
-- Standard RLS for a tenant-owned table that has an organization_id column:
--   * ENABLE + FORCE row level security (FORCE: even the table owner is subject
--     to policies unless it has BYPASSRLS; only hs_owner has that).
--   * hs_app    : organization_id must equal the transaction's tenant AND the
--                 tenant context must be *valid* (the acting user is an ACTIVE
--                 member, or the acting API key is live) - see
--                 app.tenant_context_valid() defined in 0002.
--   * hs_worker : organization_id must equal the transaction's tenant.
--   * USING and WITH CHECK are identical: rows can neither be seen nor written
--     outside the tenant, and a row cannot be moved to another tenant.
-- No policy exists for PUBLIC => every other role is denied (default deny).
-- (SELECT fn()) wrappers make the planner evaluate the context once per
-- statement (InitPlan) instead of once per row.
-- -----------------------------------------------------------------------------
CREATE FUNCTION app_admin.apply_tenant_rls(p_table regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', p_table);
  EXECUTE format($p$
    CREATE POLICY tenant_isolation_app ON %s
      AS PERMISSIVE FOR ALL TO hs_app
      USING      (organization_id = (SELECT app.current_org_id()) AND (SELECT app.tenant_context_valid()))
      WITH CHECK (organization_id = (SELECT app.current_org_id()) AND (SELECT app.tenant_context_valid()))
  $p$, p_table);
  EXECUTE format($p$
    CREATE POLICY tenant_isolation_worker ON %s
      AS PERMISSIVE FOR ALL TO hs_worker
      USING      (organization_id = (SELECT app.current_org_id()))
      WITH CHECK (organization_id = (SELECT app.current_org_id()))
  $p$, p_table);
END $$;
