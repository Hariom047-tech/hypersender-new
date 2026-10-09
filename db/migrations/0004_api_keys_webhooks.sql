-- =============================================================================
-- 0004 API KEYS & WEBHOOKS
-- =============================================================================

-- -----------------------------------------------------------------------------
-- api_keys
-- Plaintext format:  hs_live_<8 char public id>_<43 char base64url secret>
-- Stored:            key_prefix = 'hs_live_<8 char public id>' (display only)
--                    key_hash   = HMAC-SHA256(pepper, full plaintext)  (32 bytes)
-- The plaintext is shown once at creation and never persisted. Because the key
-- carries 256 bits of entropy, a fast keyed hash is appropriate (a slow KDF is
-- only needed for low-entropy human passwords). The pepper lives in KMS /
-- Secrets Manager, so a DB dump alone cannot even brute-force-verify keys.
-- -----------------------------------------------------------------------------
CREATE TABLE app.api_keys (
  id                  uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id     uuid        NOT NULL REFERENCES app.organizations(id) ON DELETE RESTRICT,
  business_id         uuid,
  name                text        NOT NULL,
  key_prefix          text        NOT NULL,
  key_hash            bytea       NOT NULL,
  scopes              text[]      NOT NULL,
  last_used_at        timestamptz,
  expires_at          timestamptz,
  revoked_at          timestamptz,
  revoked_by_user_id  uuid        REFERENCES app.users(id) ON DELETE SET NULL,
  created_by_user_id  uuid        REFERENCES app.users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT api_keys_business_fk FOREIGN KEY (business_id, organization_id)
    REFERENCES app.businesses (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT api_keys_hash_uq       UNIQUE (key_hash),
  CONSTRAINT api_keys_name_chk      CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  CONSTRAINT api_keys_prefix_chk    CHECK (key_prefix ~ '^hs_(live|test)_[A-Za-z0-9]{8}$'),
  CONSTRAINT api_keys_hash_len_chk  CHECK (octet_length(key_hash) = 32),
  CONSTRAINT api_keys_scopes_chk    CHECK (cardinality(scopes) > 0 AND scopes <@ ARRAY[
      'instances:read','instances:write','messages:send','messages:read',
      'webhooks:manage','contacts:read','contacts:write','bookings:read','bookings:write']::text[]),
  CONSTRAINT api_keys_expiry_chk    CHECK (expires_at IS NULL OR expires_at > created_at)
);
CREATE INDEX api_keys_org_idx ON app.api_keys (organization_id, created_at DESC);

-- API-key authentication. Called before any tenant context exists, so it is
-- SECURITY DEFINER. Returns a row only for a live key of a live organization.
-- last_used_at is throttled to one write per minute per key.
CREATE FUNCTION app_auth.authenticate_api_key(p_key_hash bytea)
RETURNS TABLE (api_key_id uuid, organization_id uuid, business_id uuid, scopes text[])
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
DECLARE
  k app.api_keys%ROWTYPE;
BEGIN
  SELECT * INTO k FROM app.api_keys WHERE key_hash = p_key_hash;
  IF NOT FOUND
     OR k.revoked_at IS NOT NULL
     OR (k.expires_at IS NOT NULL AND k.expires_at <= now())
     OR NOT EXISTS (SELECT 1 FROM app.organizations o
                     WHERE o.id = k.organization_id AND o.deleted_at IS NULL
                       AND o.status NOT IN ('SUSPENDED','CANCELLED')) THEN
    RETURN;
  END IF;
  IF k.last_used_at IS NULL OR k.last_used_at < now() - interval '1 minute' THEN
    UPDATE app.api_keys SET last_used_at = now() WHERE id = k.id;
  END IF;
  api_key_id := k.id; organization_id := k.organization_id; business_id := k.business_id; scopes := k.scopes;
  RETURN NEXT;
END $$;
GRANT EXECUTE ON FUNCTION app_auth.authenticate_api_key(bytea) TO hs_app;

-- Tenant context is valid when backed by an active membership OR a live API key
-- of the same organization (re-checked on every statement, so revocation takes
-- effect immediately even for in-flight requests).
CREATE OR REPLACE FUNCTION app.tenant_context_valid() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
  SELECT app.current_org_id() IS NOT NULL
     AND EXISTS (SELECT 1 FROM app.organizations o
                  WHERE o.id = app.current_org_id() AND o.deleted_at IS NULL)
     AND (
           (app.current_user_id() IS NOT NULL
            AND EXISTS (SELECT 1 FROM app.organization_members m
                         WHERE m.organization_id = app.current_org_id()
                           AND m.user_id = app.current_user_id()
                           AND m.status = 'ACTIVE'))
        OR (app.current_api_key_id() IS NOT NULL
            AND EXISTS (SELECT 1 FROM app.api_keys k
                         WHERE k.id = app.current_api_key_id()
                           AND k.organization_id = app.current_org_id()
                           AND k.revoked_at IS NULL
                           AND (k.expires_at IS NULL OR k.expires_at > now())))
         )
$$;

-- -----------------------------------------------------------------------------
-- webhook_event_types: PLATFORM lookup. New event types = INSERT, not DDL.
-- -----------------------------------------------------------------------------
CREATE TABLE app.webhook_event_types (
  code         text        PRIMARY KEY,
  description  text        NOT NULL,
  active       boolean     NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT webhook_event_types_code_chk CHECK (code ~ '^[A-Z][A-Z0-9_]{1,63}$')
);

-- -----------------------------------------------------------------------------
-- webhook_endpoints
-- Scope: organization-wide (business_id NULL, instance_id NULL), one business
-- (business_id set), or one WhatsApp instance (both set).
--
-- PRECEDENCE (deterministic, implemented in app.resolve_webhook_targets):
--   1. Fan-out is ADDITIVE: an event for instance I of business B goes to every
--      enabled endpoint scoped to I, to B, or to the whole organization, that
--      subscribes to the event type.
--   2. De-duplication by URL: if the same URL is configured at several scopes,
--      it receives the event ONCE, via the MOST SPECIFIC endpoint
--      (instance > business > organization); ties broken by oldest endpoint.
--   3. Every (event, endpoint) pair gets exactly one delivery row.
--
-- Signing secret: must be recoverable (HMAC signing), so it is ENCRYPTED
-- (AES-256-GCM, KMS-wrapped per-endpoint data key), not hashed.
-- -----------------------------------------------------------------------------
CREATE TABLE app.webhook_endpoints (
  id                         uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id            uuid        NOT NULL REFERENCES app.organizations(id) ON DELETE RESTRICT,
  business_id                uuid,
  instance_id                uuid,
  name                       text        NOT NULL,
  url                        text        NOT NULL,
  secret_ciphertext          bytea       NOT NULL,
  secret_wrapped_key         bytea       NOT NULL,
  secret_key_reference       text        NOT NULL,
  secret_encryption_version  smallint    NOT NULL DEFAULT 1,
  secret_last4               text,       -- display hint only
  enabled                    boolean     NOT NULL DEFAULT true,
  consecutive_failures       integer     NOT NULL DEFAULT 0,
  disabled_reason            text,
  created_by_user_id         uuid        REFERENCES app.users(id) ON DELETE SET NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  deleted_at                 timestamptz,
  CONSTRAINT webhook_endpoints_business_fk FOREIGN KEY (business_id, organization_id)
    REFERENCES app.businesses (id, organization_id) ON DELETE RESTRICT,
  -- An instance-scoped endpoint must name the instance's own business.
  CONSTRAINT webhook_endpoints_instance_fk FOREIGN KEY (instance_id, organization_id, business_id)
    REFERENCES app.whatsapp_instances (id, organization_id, business_id) ON DELETE CASCADE,
  CONSTRAINT webhook_endpoints_id_org_uq    UNIQUE (id, organization_id),
  CONSTRAINT webhook_endpoints_scope_chk    CHECK (instance_id IS NULL OR business_id IS NOT NULL),
  CONSTRAINT webhook_endpoints_name_chk     CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  -- HTTPS only. SSRF protection (private IP ranges, redirects) is enforced in
  -- the delivery worker at connect time, not here.
  CONSTRAINT webhook_endpoints_url_chk      CHECK (url ~ '^https://[^\s/$.?#].[^\s]*$' AND length(url) <= 2048),
  CONSTRAINT webhook_endpoints_secret_chk   CHECK (octet_length(secret_ciphertext) >= 29 AND octet_length(secret_wrapped_key) >= 32),
  CONSTRAINT webhook_endpoints_last4_chk    CHECK (secret_last4 IS NULL OR length(secret_last4) = 4),
  CONSTRAINT webhook_endpoints_failures_chk CHECK (consecutive_failures >= 0)
);
CREATE INDEX webhook_endpoints_scope_idx ON app.webhook_endpoints (organization_id, business_id, instance_id)
  WHERE enabled AND deleted_at IS NULL;
SELECT app_admin.attach_updated_at_trigger('app.webhook_endpoints');

-- -----------------------------------------------------------------------------
-- webhook_event_subscriptions: normalized event selection per endpoint.
-- -----------------------------------------------------------------------------
CREATE TABLE app.webhook_event_subscriptions (
  id                   uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id      uuid        NOT NULL,
  webhook_endpoint_id  uuid        NOT NULL,
  event_type           text        NOT NULL REFERENCES app.webhook_event_types(code) ON DELETE RESTRICT,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT webhook_event_subscriptions_endpoint_fk FOREIGN KEY (webhook_endpoint_id, organization_id)
    REFERENCES app.webhook_endpoints (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT webhook_event_subscriptions_uq UNIQUE (webhook_endpoint_id, event_type)
);
-- Fan-out lookup: "which endpoints of this org want MESSAGE_RECEIVED?"
CREATE INDEX webhook_event_subscriptions_org_type_idx ON app.webhook_event_subscriptions (organization_id, event_type);

-- -----------------------------------------------------------------------------
-- webhook_events: the internal fact ("MESSAGE_RECEIVED for message X"), created
-- asynchronously from outbox_events. Independent from HTTP delivery.
-- -----------------------------------------------------------------------------
CREATE TABLE app.webhook_events (
  id               uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id  uuid        NOT NULL REFERENCES app.organizations(id) ON DELETE RESTRICT,
  business_id      uuid,
  instance_id      uuid,
  event_type       text        NOT NULL REFERENCES app.webhook_event_types(code) ON DELETE RESTRICT,
  resource_type    text        NOT NULL,
  resource_id      uuid,
  payload          jsonb       NOT NULL,
  -- Outbox re-processing must not create a second event (e.g. "outbox:<id>").
  idempotency_key  text        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT webhook_events_business_fk FOREIGN KEY (business_id, organization_id)
    REFERENCES app.businesses (id, organization_id) ON DELETE SET NULL (business_id),
  CONSTRAINT webhook_events_instance_fk FOREIGN KEY (instance_id, organization_id)
    REFERENCES app.whatsapp_instances (id, organization_id) ON DELETE SET NULL (instance_id),
  CONSTRAINT webhook_events_id_org_uq      UNIQUE (id, organization_id),
  CONSTRAINT webhook_events_idem_uq        UNIQUE (organization_id, idempotency_key),
  CONSTRAINT webhook_events_v7_chk         CHECK (uuid_extract_version(id) = 7),
  CONSTRAINT webhook_events_resource_chk   CHECK (resource_type ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  CONSTRAINT webhook_events_payload_chk    CHECK (jsonb_typeof(payload) = 'object')
);
CREATE INDEX webhook_events_org_created_idx ON app.webhook_events (organization_id, created_at DESC);
CREATE INDEX webhook_events_instance_idx ON app.webhook_events (instance_id) WHERE instance_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- webhook_deliveries: one row per (event, endpoint); attempt_number counts
-- HTTP attempts. Claimed with a visibility timeout: a worker sets
-- status=PROCESSING and pushes next_retry_at forward; if it dies, the row
-- becomes claimable again when next_retry_at passes.
-- -----------------------------------------------------------------------------
CREATE TABLE app.webhook_deliveries (
  id                       uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id          uuid        NOT NULL,
  webhook_event_id         uuid        NOT NULL,
  webhook_endpoint_id      uuid        NOT NULL,
  attempt_number           integer     NOT NULL DEFAULT 0,
  status                   text        NOT NULL DEFAULT 'PENDING',
  http_status              smallint,
  response_body_truncated  text,
  error_message            text,
  locked_by                text,
  last_attempt_at          timestamptz,
  next_retry_at            timestamptz DEFAULT now(),
  delivered_at             timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT webhook_deliveries_event_fk FOREIGN KEY (webhook_event_id, organization_id)
    REFERENCES app.webhook_events (id, organization_id) ON DELETE CASCADE,
  -- Delivery logs have no value without their endpoint.
  CONSTRAINT webhook_deliveries_endpoint_fk FOREIGN KEY (webhook_endpoint_id, organization_id)
    REFERENCES app.webhook_endpoints (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT webhook_deliveries_pair_uq       UNIQUE (webhook_event_id, webhook_endpoint_id),
  CONSTRAINT webhook_deliveries_v7_chk        CHECK (uuid_extract_version(id) = 7),
  CONSTRAINT webhook_deliveries_status_chk    CHECK (status IN ('PENDING','PROCESSING','DELIVERED','RETRYING','FAILED','DEAD')),
  CONSTRAINT webhook_deliveries_attempt_chk   CHECK (attempt_number >= 0),
  CONSTRAINT webhook_deliveries_http_chk      CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  CONSTRAINT webhook_deliveries_body_chk      CHECK (response_body_truncated IS NULL OR length(response_body_truncated) <= 4096),
  CONSTRAINT webhook_deliveries_delivered_chk CHECK (status <> 'DELIVERED' OR delivered_at IS NOT NULL),
  CONSTRAINT webhook_deliveries_sched_chk     CHECK (status NOT IN ('PENDING','RETRYING','PROCESSING') OR next_retry_at IS NOT NULL)
);
-- Dispatcher hot path: due work only (partial => tiny even with millions of rows).
CREATE INDEX webhook_deliveries_due_idx ON app.webhook_deliveries (next_retry_at)
  WHERE status IN ('PENDING','RETRYING','PROCESSING');
-- Delivery log per endpoint (dashboard) + FK support for endpoint deletion.
CREATE INDEX webhook_deliveries_endpoint_idx ON app.webhook_deliveries (webhook_endpoint_id, created_at DESC);
SELECT app_admin.attach_updated_at_trigger('app.webhook_deliveries');

-- -----------------------------------------------------------------------------
-- Deterministic target resolution (see precedence rules above). Invoker rights:
-- runs under the caller's tenant context and RLS.
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.resolve_webhook_targets(p_event_type text, p_business_id uuid, p_instance_id uuid)
RETURNS TABLE (webhook_endpoint_id uuid, url text, specificity integer)
LANGUAGE sql STABLE AS $$
  SELECT DISTINCT ON (e.url) e.id, e.url,
         CASE WHEN e.instance_id IS NOT NULL THEN 3
              WHEN e.business_id IS NOT NULL THEN 2
              ELSE 1 END AS specificity
    FROM app.webhook_endpoints e
    JOIN app.webhook_event_subscriptions s
      ON s.webhook_endpoint_id = e.id AND s.event_type = p_event_type
   WHERE e.organization_id = app.current_org_id()
     AND e.enabled AND e.deleted_at IS NULL
     AND (   (e.business_id IS NULL AND e.instance_id IS NULL)
          OR (e.business_id = p_business_id AND e.instance_id IS NULL)
          OR (p_instance_id IS NOT NULL AND e.instance_id = p_instance_id))
   ORDER BY e.url, specificity DESC, e.created_at, e.id
$$;
GRANT EXECUTE ON FUNCTION app.resolve_webhook_targets(text, uuid, uuid) TO hs_app, hs_worker;

-- =============================================================================
-- RLS
-- =============================================================================
SELECT app_admin.apply_tenant_rls('app.api_keys');
SELECT app_admin.apply_tenant_rls('app.webhook_endpoints');
SELECT app_admin.apply_tenant_rls('app.webhook_event_subscriptions');
SELECT app_admin.apply_tenant_rls('app.webhook_events');
SELECT app_admin.apply_tenant_rls('app.webhook_deliveries');

-- Delivery dispatcher claims due deliveries across tenants, then processes each
-- one under the delivery's organization context (endpoint secret, payload).
CREATE POLICY webhook_deliveries_dispatcher_read ON app.webhook_deliveries
  FOR SELECT TO hs_worker USING (true);
CREATE POLICY webhook_deliveries_dispatcher_update ON app.webhook_deliveries
  FOR UPDATE TO hs_worker USING (true) WITH CHECK (true);

-- =============================================================================
-- GRANTS
-- =============================================================================
-- key_hash is write-only for the API role: it can create keys but never read hashes back.
GRANT SELECT (id, organization_id, business_id, name, key_prefix, scopes, last_used_at, expires_at,
              revoked_at, revoked_by_user_id, created_by_user_id, created_at)
  ON app.api_keys TO hs_app;
GRANT INSERT (id, organization_id, business_id, name, key_prefix, key_hash, scopes, expires_at, created_by_user_id)
  ON app.api_keys TO hs_app;
GRANT UPDATE (name, revoked_at, revoked_by_user_id) ON app.api_keys TO hs_app;

GRANT SELECT ON app.webhook_event_types TO hs_app, hs_worker;

-- API role manages endpoints but cannot read the encrypted secret back
-- (it is shown once at creation; rotation writes a new one).
GRANT SELECT (id, organization_id, business_id, instance_id, name, url, secret_key_reference,
              secret_encryption_version, secret_last4, enabled, consecutive_failures, disabled_reason,
              created_by_user_id, created_at, updated_at, deleted_at)
  ON app.webhook_endpoints TO hs_app;
GRANT INSERT ON app.webhook_endpoints TO hs_app;
GRANT UPDATE (name, url, secret_ciphertext, secret_wrapped_key, secret_key_reference, secret_encryption_version,
              secret_last4, enabled, disabled_reason, consecutive_failures, deleted_at)
  ON app.webhook_endpoints TO hs_app;
GRANT SELECT ON app.webhook_endpoints TO hs_worker;
GRANT UPDATE (enabled, consecutive_failures, disabled_reason) ON app.webhook_endpoints TO hs_worker;

GRANT SELECT, INSERT, DELETE ON app.webhook_event_subscriptions TO hs_app;
GRANT SELECT ON app.webhook_event_subscriptions TO hs_worker;

GRANT SELECT ON app.webhook_events, app.webhook_deliveries TO hs_app;
GRANT SELECT, INSERT ON app.webhook_events TO hs_worker;
GRANT SELECT, INSERT ON app.webhook_deliveries TO hs_worker;
GRANT UPDATE (attempt_number, status, http_status, response_body_truncated, error_message, locked_by,
              last_attempt_at, next_retry_at, delivered_at)
  ON app.webhook_deliveries TO hs_worker;
-- Manual "redeliver" button in the dashboard.
GRANT UPDATE (status, next_retry_at) ON app.webhook_deliveries TO hs_app;
