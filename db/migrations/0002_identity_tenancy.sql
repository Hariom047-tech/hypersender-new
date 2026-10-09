-- =============================================================================
-- 0002 IDENTITY & TENANCY
-- users (platform identity) -> organizations (TENANT) -> organization_members
-- -> businesses -> business_locations
-- =============================================================================

-- -----------------------------------------------------------------------------
-- users: platform-level identity. NOT a tenant boundary. Tenant roles live on
-- organization_members, never on users.
-- -----------------------------------------------------------------------------
CREATE TABLE app.users (
  id                 uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  email              text        NOT NULL,
  email_normalized   text        GENERATED ALWAYS AS (lower(btrim(email))) STORED,
  -- NULL while INVITED (no password chosen yet). Only modern KDF hashes accepted:
  -- a plaintext password can never satisfy this CHECK.
  password_hash      text,
  first_name         text,
  last_name          text,
  phone_e164         text,
  email_verified_at  timestamptz,
  status             text        NOT NULL DEFAULT 'ACTIVE',
  last_login_at      timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  CONSTRAINT users_status_chk        CHECK (status IN ('ACTIVE','INVITED','SUSPENDED','DELETED')),
  CONSTRAINT users_email_format_chk  CHECK (length(email) <= 320 AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  CONSTRAINT users_password_hash_chk CHECK (password_hash IS NULL OR password_hash ~ '^\$(argon2id|scrypt)\$'),
  CONSTRAINT users_phone_chk         CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  CONSTRAINT users_names_len_chk     CHECK (coalesce(length(first_name),0) <= 100 AND coalesce(length(last_name),0) <= 100),
  CONSTRAINT users_deleted_chk       CHECK ((status = 'DELETED') = (deleted_at IS NOT NULL))
);
-- Case-insensitive uniqueness among live accounts.
CREATE UNIQUE INDEX users_email_normalized_uq ON app.users (email_normalized) WHERE deleted_at IS NULL;
SELECT app_admin.attach_updated_at_trigger('app.users');

-- -----------------------------------------------------------------------------
-- organizations: THE tenant. Every tenant-owned row carries organization_id.
-- Never hard-deleted while financial/audit records exist (FKs are RESTRICT);
-- "deletion" = soft delete + app_admin.purge_organization_data().
-- -----------------------------------------------------------------------------
CREATE TABLE app.organizations (
  id                  uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  name                text        NOT NULL,
  slug                text        NOT NULL,
  status              text        NOT NULL DEFAULT 'TRIAL',
  timezone            text        NOT NULL DEFAULT 'UTC',
  country_code        text,
  default_currency    text        NOT NULL DEFAULT 'INR',
  created_by_user_id  uuid        REFERENCES app.users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  CONSTRAINT organizations_name_chk     CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT organizations_slug_chk     CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) BETWEEN 2 AND 63),
  CONSTRAINT organizations_status_chk   CHECK (status IN ('TRIAL','ACTIVE','PAST_DUE','SUSPENDED','CANCELLED')),
  CONSTRAINT organizations_tz_chk       CHECK (app.is_valid_timezone(timezone)),
  CONSTRAINT organizations_country_chk  CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$'),
  CONSTRAINT organizations_currency_chk CHECK (default_currency ~ '^[A-Z]{3}$')
);
CREATE UNIQUE INDEX organizations_slug_uq ON app.organizations (slug) WHERE deleted_at IS NULL;
SELECT app_admin.attach_updated_at_trigger('app.organizations');

-- -----------------------------------------------------------------------------
-- organization_members: user <-> organization with a tenant-specific role.
-- -----------------------------------------------------------------------------
CREATE TABLE app.organization_members (
  id                  uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id     uuid        NOT NULL REFERENCES app.organizations(id) ON DELETE RESTRICT,
  -- Membership has no value without the user: CASCADE on (rare) user hard delete.
  user_id             uuid        NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  role                text        NOT NULL,
  status              text        NOT NULL DEFAULT 'ACTIVE',
  invited_by_user_id  uuid        REFERENCES app.users(id) ON DELETE SET NULL,
  joined_at           timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_members_org_user_uq UNIQUE (organization_id, user_id),
  CONSTRAINT organization_members_role_chk    CHECK (role IN ('OWNER','ADMIN','MANAGER','AGENT','VIEWER')),
  CONSTRAINT organization_members_status_chk  CHECK (status IN ('INVITED','ACTIVE','SUSPENDED','REMOVED')),
  CONSTRAINT organization_members_joined_chk  CHECK (status <> 'ACTIVE' OR joined_at IS NOT NULL)
);
-- "Which organizations do I belong to?" (org switcher)
CREATE INDEX organization_members_user_idx ON app.organization_members (user_id, status);
SELECT app_admin.attach_updated_at_trigger('app.organization_members');

-- -----------------------------------------------------------------------------
-- Tenant-context validation (defence in depth).
--
-- Setting app.current_organization_id alone is NOT enough for hs_app: the
-- context must also be backed by
--   * an ACTIVE membership of app.current_user_id in that organization, or
--   * a live (not revoked / not expired) API key of that organization.
-- So a middleware bug that trusts an attacker-supplied X-Organization-Id header
-- still yields zero rows. SECURITY DEFINER (owner has BYPASSRLS) avoids policy
-- recursion; evaluated once per statement via (SELECT ...) in policies.
-- The api_keys branch is added in 0004 via CREATE OR REPLACE.
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.tenant_context_valid() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
  SELECT app.current_org_id() IS NOT NULL
     AND EXISTS (SELECT 1 FROM app.organizations o
                  WHERE o.id = app.current_org_id() AND o.deleted_at IS NULL)
     AND app.current_user_id() IS NOT NULL
     AND EXISTS (SELECT 1 FROM app.organization_members m
                  WHERE m.organization_id = app.current_org_id()
                    AND m.user_id = app.current_user_id()
                    AND m.status = 'ACTIVE')
$$;
GRANT EXECUTE ON FUNCTION app.tenant_context_valid() TO hs_app, hs_worker;

-- Is the current user an ACTIVE OWNER/ADMIN of the org?
CREATE FUNCTION app.is_org_admin(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
  SELECT EXISTS (SELECT 1 FROM app.organization_members m
                  WHERE m.organization_id = p_org
                    AND m.user_id = app.current_user_id()
                    AND m.status = 'ACTIVE'
                    AND m.role IN ('OWNER','ADMIN'))
$$;
GRANT EXECUTE ON FUNCTION app.is_org_admin(uuid) TO hs_app;

-- Bootstrap case: the org was created by the current user and has no members yet
-- (sign-up / "create workspace" transaction).
CREATE FUNCTION app.is_org_bootstrap(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
  SELECT EXISTS (SELECT 1 FROM app.organizations o
                  WHERE o.id = p_org AND o.created_by_user_id = app.current_user_id())
     AND NOT EXISTS (SELECT 1 FROM app.organization_members m WHERE m.organization_id = p_org)
$$;
GRANT EXECUTE ON FUNCTION app.is_org_bootstrap(uuid) TO hs_app;

-- An organization must always keep at least one ACTIVE OWNER.
CREATE FUNCTION app.ensure_org_keeps_owner() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app AS $$
BEGIN
  IF OLD.role = 'OWNER' AND OLD.status = 'ACTIVE'
     AND NOT EXISTS (SELECT 1 FROM app.organization_members
                      WHERE organization_id = OLD.organization_id
                        AND role = 'OWNER' AND status = 'ACTIVE')
     AND EXISTS (SELECT 1 FROM app.organizations WHERE id = OLD.organization_id AND deleted_at IS NULL)
  THEN
    RAISE EXCEPTION 'organization % must keep at least one active OWNER', OLD.organization_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_org_keeps_owner
  AFTER UPDATE OR DELETE ON app.organization_members
  FOR EACH ROW EXECUTE FUNCTION app.ensure_org_keeps_owner();

-- -----------------------------------------------------------------------------
-- businesses: operational unit inside an organization (ABC Dental, ABC Pharmacy)
-- -----------------------------------------------------------------------------
CREATE TABLE app.businesses (
  id               uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id  uuid        NOT NULL REFERENCES app.organizations(id) ON DELETE RESTRICT,
  name             text        NOT NULL,
  legal_name       text,
  industry         text,
  description      text,
  phone_e164       text,
  email            text,
  website          text,
  timezone         text        NOT NULL DEFAULT 'UTC',
  currency         text        NOT NULL DEFAULT 'INR',
  country_code     text,
  address          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  business_hours   jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status           text        NOT NULL DEFAULT 'ACTIVE',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  -- Composite key targets: children reference (id, organization_id) so a row
  -- can never point at a business of another tenant (FK checks bypass RLS, so
  -- a plain FK on id alone would NOT stop that).
  CONSTRAINT businesses_id_org_uq     UNIQUE (id, organization_id),
  CONSTRAINT businesses_name_chk      CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT businesses_industry_chk  CHECK (industry IS NULL OR industry ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  CONSTRAINT businesses_phone_chk     CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  CONSTRAINT businesses_email_chk     CHECK (email IS NULL OR email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  CONSTRAINT businesses_website_chk   CHECK (website IS NULL OR website ~ '^https?://'),
  CONSTRAINT businesses_tz_chk        CHECK (app.is_valid_timezone(timezone)),
  CONSTRAINT businesses_currency_chk  CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT businesses_country_chk   CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$'),
  CONSTRAINT businesses_address_chk   CHECK (jsonb_typeof(address) = 'object'),
  CONSTRAINT businesses_hours_chk     CHECK (jsonb_typeof(business_hours) = 'object'),
  CONSTRAINT businesses_status_chk    CHECK (status IN ('ACTIVE','INACTIVE','SUSPENDED','ARCHIVED'))
);
CREATE INDEX businesses_org_idx ON app.businesses (organization_id) WHERE deleted_at IS NULL;
SELECT app_admin.attach_updated_at_trigger('app.businesses');

-- -----------------------------------------------------------------------------
-- business_locations
-- -----------------------------------------------------------------------------
CREATE TABLE app.business_locations (
  id               uuid         PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id  uuid         NOT NULL,
  business_id      uuid         NOT NULL,
  name             text         NOT NULL,
  address          jsonb        NOT NULL DEFAULT '{}'::jsonb,
  timezone         text         NOT NULL DEFAULT 'UTC',
  phone_e164       text,
  latitude         numeric(9,6),
  longitude        numeric(9,6),
  is_primary       boolean      NOT NULL DEFAULT false,
  status           text         NOT NULL DEFAULT 'ACTIVE',
  created_at       timestamptz  NOT NULL DEFAULT now(),
  updated_at       timestamptz  NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  CONSTRAINT business_locations_business_fk FOREIGN KEY (business_id, organization_id)
    REFERENCES app.businesses (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT business_locations_id_org_uq     UNIQUE (id, organization_id),
  CONSTRAINT business_locations_id_org_biz_uq UNIQUE (id, organization_id, business_id),
  CONSTRAINT business_locations_name_chk   CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT business_locations_tz_chk     CHECK (app.is_valid_timezone(timezone)),
  CONSTRAINT business_locations_phone_chk  CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  CONSTRAINT business_locations_lat_chk    CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  CONSTRAINT business_locations_lng_chk    CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
  CONSTRAINT business_locations_addr_chk   CHECK (jsonb_typeof(address) = 'object'),
  CONSTRAINT business_locations_status_chk CHECK (status IN ('ACTIVE','INACTIVE','ARCHIVED'))
);
CREATE INDEX business_locations_business_idx ON app.business_locations (organization_id, business_id) WHERE deleted_at IS NULL;
-- At most one primary location per business.
CREATE UNIQUE INDEX business_locations_one_primary_uq ON app.business_locations (business_id)
  WHERE is_primary AND deleted_at IS NULL;
SELECT app_admin.attach_updated_at_trigger('app.business_locations');

-- =============================================================================
-- RLS
-- =============================================================================

-- users: a user sees/edits their own row; members of the current org can see
-- each other's profile columns. password_hash is not even SELECT-able by hs_app
-- (column privileges) - only app_auth.get_login_candidate() reads it.
ALTER TABLE app.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_self ON app.users FOR ALL TO hs_app
  USING (id = (SELECT app.current_user_id()))
  WITH CHECK (id = (SELECT app.current_user_id()));
CREATE POLICY users_co_members_read ON app.users FOR SELECT TO hs_app, hs_worker
  USING (EXISTS (SELECT 1 FROM app.organization_members m
                  WHERE m.user_id = users.id
                    AND m.organization_id = (SELECT app.current_org_id())));

-- organizations: the tenant row itself.
ALTER TABLE app.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY organizations_tenant_app ON app.organizations FOR SELECT TO hs_app
  USING (id = (SELECT app.current_org_id()) AND (SELECT app.tenant_context_valid()));
CREATE POLICY organizations_member_read ON app.organizations FOR SELECT TO hs_app
  USING (deleted_at IS NULL AND EXISTS (
          SELECT 1 FROM app.organization_members m
           WHERE m.organization_id = organizations.id
             AND m.user_id = (SELECT app.current_user_id())
             AND m.status = 'ACTIVE'));
-- Create workspace: id must equal the context the app just set and the creator
-- must be the acting user. (Membership does not exist yet.)
CREATE POLICY organizations_create ON app.organizations FOR INSERT TO hs_app
  WITH CHECK (id = (SELECT app.current_org_id())
              AND created_by_user_id = (SELECT app.current_user_id()));
-- INSERT ... RETURNING during bootstrap needs visibility of the new row.
CREATE POLICY organizations_creator_read ON app.organizations FOR SELECT TO hs_app
  USING (id = (SELECT app.current_org_id())
         AND created_by_user_id = (SELECT app.current_user_id()));
CREATE POLICY organizations_update_admin ON app.organizations FOR UPDATE TO hs_app
  USING (id = (SELECT app.current_org_id()) AND (SELECT app.is_org_admin(app.current_org_id())))
  WITH CHECK (id = (SELECT app.current_org_id()));
CREATE POLICY organizations_tenant_worker ON app.organizations FOR ALL TO hs_worker
  USING (id = (SELECT app.current_org_id()))
  WITH CHECK (id = (SELECT app.current_org_id()));

-- organization_members: split per command to block privilege escalation even if
-- the app sets a foreign organization id in its context.
ALTER TABLE app.organization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.organization_members FORCE ROW LEVEL SECURITY;
CREATE POLICY members_select ON app.organization_members FOR SELECT TO hs_app, hs_worker
  USING (organization_id = (SELECT app.current_org_id())
         OR user_id = (SELECT app.current_user_id()));
CREATE POLICY members_insert ON app.organization_members FOR INSERT TO hs_app
  WITH CHECK (organization_id = (SELECT app.current_org_id())
              AND ( app.is_org_admin(organization_id)
                    OR (user_id = (SELECT app.current_user_id())
                        AND role = 'OWNER'
                        AND app.is_org_bootstrap(organization_id))));
CREATE POLICY members_update ON app.organization_members FOR UPDATE TO hs_app
  USING (organization_id = (SELECT app.current_org_id()) AND app.is_org_admin(organization_id))
  WITH CHECK (organization_id = (SELECT app.current_org_id()));
-- Admins remove members; any member may leave.
CREATE POLICY members_delete ON app.organization_members FOR DELETE TO hs_app
  USING (organization_id = (SELECT app.current_org_id())
         AND (app.is_org_admin(organization_id) OR user_id = (SELECT app.current_user_id())));

SELECT app_admin.apply_tenant_rls('app.businesses');
SELECT app_admin.apply_tenant_rls('app.business_locations');

-- =============================================================================
-- GRANTS (explicit, least privilege)
-- =============================================================================
GRANT SELECT (id, email, email_normalized, first_name, last_name, phone_e164, email_verified_at,
              status, last_login_at, created_at, updated_at, deleted_at)
  ON app.users TO hs_app;
GRANT INSERT (id, email, password_hash, first_name, last_name, phone_e164, status) ON app.users TO hs_app;
GRANT UPDATE (email, password_hash, first_name, last_name, phone_e164, email_verified_at, status,
              last_login_at, deleted_at)
  ON app.users TO hs_app;
GRANT SELECT (id, email, first_name, last_name, status) ON app.users TO hs_worker;

GRANT SELECT, INSERT ON app.organizations TO hs_app;
GRANT UPDATE (name, slug, timezone, country_code, default_currency, deleted_at) ON app.organizations TO hs_app;
GRANT SELECT ON app.organizations TO hs_worker;
GRANT UPDATE (status) ON app.organizations TO hs_worker;  -- billing state transitions

GRANT SELECT, INSERT, DELETE ON app.organization_members TO hs_app;
GRANT UPDATE (role, status, joined_at) ON app.organization_members TO hs_app;
GRANT SELECT ON app.organization_members TO hs_worker;

GRANT SELECT, INSERT, UPDATE ON app.businesses, app.business_locations TO hs_app;
GRANT SELECT ON app.businesses, app.business_locations TO hs_worker;

-- =============================================================================
-- Pre-tenant auth helpers (SECURITY DEFINER, owner has BYPASSRLS)
-- =============================================================================

-- Login: the only path through which a password hash leaves the database.
CREATE FUNCTION app_auth.get_login_candidate(p_email text)
RETURNS TABLE (user_id uuid, password_hash text, status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
  SELECT u.id, u.password_hash, u.status
    FROM app.users u
   WHERE u.email_normalized = lower(btrim(p_email))
     AND u.deleted_at IS NULL
$$;
GRANT EXECUTE ON FUNCTION app_auth.get_login_candidate(text) TO hs_app;

-- Invite flow: resolve an email to a user id (creating an INVITED user when
-- needed). Only callable by an OWNER/ADMIN with a valid tenant context, so it
-- cannot be used as an anonymous email-enumeration oracle.
CREATE FUNCTION app_auth.find_or_create_invited_user(p_email text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT app.tenant_context_valid() OR NOT app.is_org_admin(app.current_org_id()) THEN
    RAISE EXCEPTION 'insufficient privilege to invite users' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT id INTO v_id FROM app.users
   WHERE email_normalized = lower(btrim(p_email)) AND deleted_at IS NULL;
  IF v_id IS NULL THEN
    INSERT INTO app.users (email, status) VALUES (btrim(p_email), 'INVITED')
    ON CONFLICT (email_normalized) WHERE deleted_at IS NULL DO NOTHING
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN  -- lost a race with a concurrent sign-up
      SELECT id INTO v_id FROM app.users
       WHERE email_normalized = lower(btrim(p_email)) AND deleted_at IS NULL;
    END IF;
  END IF;
  RETURN v_id;
END $$;
GRANT EXECUTE ON FUNCTION app_auth.find_or_create_invited_user(text) TO hs_app;
