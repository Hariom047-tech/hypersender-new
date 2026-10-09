-- =============================================================================
-- 0003 WHATSAPP CONNECTION LAYER
-- whatsapp_workers (platform) / whatsapp_instances / whatsapp_auth_credentials /
-- whatsapp_signal_keys / whatsapp_instance_events
-- =============================================================================

-- -----------------------------------------------------------------------------
-- whatsapp_workers: gateway processes that host live provider sessions.
-- PLATFORM infrastructure, contains no tenant data => no RLS; only hs_worker
-- may touch it. Short-lived distributed locks live in Redis; this table is
-- the durable registry used for rebalancing and dead-worker detection.
-- -----------------------------------------------------------------------------
CREATE TABLE app.whatsapp_workers (
  id                 uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  hostname           text        NOT NULL,
  region             text,
  status             text        NOT NULL DEFAULT 'STARTING',
  capacity           integer,
  active_sessions    integer     NOT NULL DEFAULT 0,
  last_heartbeat_at  timestamptz NOT NULL DEFAULT now(),
  started_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT whatsapp_workers_status_chk   CHECK (status IN ('STARTING','ACTIVE','DRAINING','STOPPED','DEAD')),
  CONSTRAINT whatsapp_workers_capacity_chk CHECK (capacity IS NULL OR capacity > 0),
  CONSTRAINT whatsapp_workers_sessions_chk CHECK (active_sessions >= 0)
);
-- Placement: find live workers with spare capacity; reaper: find stale heartbeats.
CREATE INDEX whatsapp_workers_status_hb_idx ON app.whatsapp_workers (status, last_heartbeat_at);
SELECT app_admin.attach_updated_at_trigger('app.whatsapp_workers');

-- -----------------------------------------------------------------------------
-- whatsapp_instances: one connected WhatsApp account (provider-agnostic).
-- -----------------------------------------------------------------------------
CREATE TABLE app.whatsapp_instances (
  id                            uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id               uuid        NOT NULL,
  business_id                   uuid        NOT NULL,
  instance_name                 text        NOT NULL,
  description                   text,
  provider                      text        NOT NULL DEFAULT 'BAILEYS',
  provider_instance_identifier  text,
  phone_e164                    text,
  whatsapp_jid                  text,
  whatsapp_display_name         text,
  account_type                  text,
  status                        text        NOT NULL DEFAULT 'CREATED',
  -- Raw transport state as reported by the provider (Baileys: open/connecting/close).
  connection_state              text        NOT NULL DEFAULT 'CLOSED',
  -- Session ownership. worker_id + worker_lease_expires_at form a lease that a
  -- worker renews while it holds the socket. worker_lease_token is a FENCING
  -- token incremented on every successful claim; credential writes are
  -- rejected unless they present the current token (see
  -- app.assert_instance_lease). This is what guarantees a session is never
  -- intentionally active on two workers, even if a Redis lock expires early.
  worker_id                     uuid        REFERENCES app.whatsapp_workers(id) ON DELETE SET NULL,
  worker_lease_token            bigint      NOT NULL DEFAULT 0,
  worker_lease_expires_at       timestamptz,
  proxy_enabled                 boolean     NOT NULL DEFAULT false,
  proxy_id                      uuid,       -- future app.proxies table; no FK yet
  appear_online                 boolean     NOT NULL DEFAULT false,
  connected_at                  timestamptz,
  disconnected_at               timestamptz,
  last_connected_at             timestamptz,
  last_seen_at                  timestamptz,
  disconnect_reason             text,
  last_error_code               text,
  last_error_message            text,
  created_by_user_id            uuid        REFERENCES app.users(id) ON DELETE SET NULL,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  deleted_at                    timestamptz,
  CONSTRAINT whatsapp_instances_business_fk FOREIGN KEY (business_id, organization_id)
    REFERENCES app.businesses (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT whatsapp_instances_id_org_uq     UNIQUE (id, organization_id),
  CONSTRAINT whatsapp_instances_id_org_biz_uq UNIQUE (id, organization_id, business_id),
  CONSTRAINT whatsapp_instances_name_chk      CHECK (length(btrim(instance_name)) BETWEEN 1 AND 100),
  CONSTRAINT whatsapp_instances_provider_chk  CHECK (provider IN ('BAILEYS','META_CLOUD','OTHER')),
  CONSTRAINT whatsapp_instances_phone_chk     CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  CONSTRAINT whatsapp_instances_jid_chk       CHECK (whatsapp_jid IS NULL OR whatsapp_jid ~ '^[^@\s]+@[a-z.]+$'),
  CONSTRAINT whatsapp_instances_acct_chk      CHECK (account_type IS NULL OR account_type IN ('PERSONAL','BUSINESS')),
  CONSTRAINT whatsapp_instances_status_chk    CHECK (status IN ('CREATED','WAITING_FOR_QR','PAIRING','CONNECTED','RECONNECTING',
                                                                 'DISCONNECTED','LOGGED_OUT','ERROR','SUSPENDED')),
  CONSTRAINT whatsapp_instances_conn_chk      CHECK (connection_state IN ('CLOSED','CONNECTING','OPEN')),
  CONSTRAINT whatsapp_instances_proxy_chk     CHECK (NOT proxy_enabled OR proxy_id IS NOT NULL),
  CONSTRAINT whatsapp_instances_lease_chk     CHECK ((worker_id IS NULL) = (worker_lease_expires_at IS NULL)),
  CONSTRAINT whatsapp_instances_errmsg_chk    CHECK (last_error_message IS NULL OR length(last_error_message) <= 2000)
);
-- Dashboard listing / status filters.
CREATE INDEX whatsapp_instances_org_biz_status_idx ON app.whatsapp_instances (organization_id, business_id, status)
  WHERE deleted_at IS NULL;
-- Unique display name per organization.
CREATE UNIQUE INDEX whatsapp_instances_org_name_uq ON app.whatsapp_instances (organization_id, lower(instance_name))
  WHERE deleted_at IS NULL;
-- One phone number => at most one live (not logged out / not deleted) instance
-- per organization. Different organizations are independent tenants.
CREATE UNIQUE INDEX whatsapp_instances_org_phone_live_uq ON app.whatsapp_instances (organization_id, phone_e164)
  WHERE deleted_at IS NULL AND phone_e164 IS NOT NULL AND status <> 'LOGGED_OUT';
-- Provider-side identifiers (e.g. Meta phone_number_id) are globally unique.
CREATE UNIQUE INDEX whatsapp_instances_provider_ident_uq ON app.whatsapp_instances (provider, provider_instance_identifier)
  WHERE provider_instance_identifier IS NOT NULL;
-- "Which sessions does worker X own?" (restart / drain / reaper).
CREATE INDEX whatsapp_instances_worker_idx ON app.whatsapp_instances (worker_id) WHERE worker_id IS NOT NULL;
-- Scheduler: find sessions whose lease is missing/expired.
CREATE INDEX whatsapp_instances_lease_idx ON app.whatsapp_instances (worker_lease_expires_at NULLS FIRST)
  WHERE deleted_at IS NULL AND status NOT IN ('LOGGED_OUT','SUSPENDED');
SELECT app_admin.attach_updated_at_trigger('app.whatsapp_instances');

-- -----------------------------------------------------------------------------
-- whatsapp_auth_credentials: Baileys AuthenticationCreds (one row per instance).
--
-- Envelope encryption (application side, never in SQL):
--   KMS master key (never in PostgreSQL)
--      -> wraps a per-instance 256-bit data key  => wrapped_data_key
--   data key -> AES-256-GCM(creds JSON, AAD = "wa-creds|v1|<org>|<instance>")
--      => encrypted_credentials = nonce(12) || ciphertext || tag(16)
-- The same per-instance data key encrypts the instance's signal keys.
-- Deleting this row (logout) cascades to every signal key of the instance.
-- QR codes are never stored anywhere in the database (Redis, short TTL).
-- -----------------------------------------------------------------------------
CREATE TABLE app.whatsapp_auth_credentials (
  id                     uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id        uuid        NOT NULL,
  instance_id            uuid        NOT NULL,
  encrypted_credentials  bytea       NOT NULL,
  wrapped_data_key       bytea       NOT NULL,
  encryption_version     smallint    NOT NULL DEFAULT 1,
  key_reference          text        NOT NULL,   -- KMS key id/ARN (or 'local-dev:<id>' outside production)
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  -- Credentials have no value without their instance.
  CONSTRAINT whatsapp_auth_credentials_instance_fk FOREIGN KEY (instance_id, organization_id)
    REFERENCES app.whatsapp_instances (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT whatsapp_auth_credentials_instance_uq     UNIQUE (instance_id),
  CONSTRAINT whatsapp_auth_credentials_inst_org_uq     UNIQUE (instance_id, organization_id),
  -- nonce(12) + tag(16) + >=1 byte: rejects empty/placeholder/plaintext-looking junk.
  CONSTRAINT whatsapp_auth_credentials_ct_len_chk      CHECK (octet_length(encrypted_credentials) >= 29),
  CONSTRAINT whatsapp_auth_credentials_dek_len_chk     CHECK (octet_length(wrapped_data_key) >= 32),
  CONSTRAINT whatsapp_auth_credentials_version_chk     CHECK (encryption_version >= 1),
  -- A JSON document can never be mistaken for ciphertext.
  CONSTRAINT whatsapp_auth_credentials_not_json_chk    CHECK (get_byte(encrypted_credentials, 0) <> 123 OR get_byte(encrypted_credentials, 1) <> 34)
);
SELECT app_admin.attach_updated_at_trigger('app.whatsapp_auth_credentials');

-- -----------------------------------------------------------------------------
-- whatsapp_signal_keys: Baileys SignalKeyStore (pre-key, session, sender-key,
-- app-state-sync-key, app-state-sync-version, sender-key-memory, lid-mapping,
-- ...). Hot table: batched get(type, ids[]) / set(...) on every message.
-- key_type is format-checked (not an enum) so a Baileys upgrade that adds a
-- new key family needs no schema change.
-- AES-256-GCM with the instance data key; AAD binds each ciphertext to
-- (org, instance, key_type, key_id) so rows cannot be swapped between
-- instances/tenants even by someone with write access to the table.
-- -----------------------------------------------------------------------------
CREATE TABLE app.whatsapp_signal_keys (
  id                  uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id     uuid        NOT NULL,
  instance_id         uuid        NOT NULL,
  key_type            text        NOT NULL,
  key_id              text        NOT NULL,
  encrypted_value     bytea       NOT NULL,
  encryption_version  smallint    NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- Keys cannot exist without the credential row that holds their data key;
  -- destroying credentials destroys every key.
  CONSTRAINT whatsapp_signal_keys_creds_fk FOREIGN KEY (instance_id, organization_id)
    REFERENCES app.whatsapp_auth_credentials (instance_id, organization_id) ON DELETE CASCADE,
  -- Primary access path: WHERE instance_id = $1 AND key_type = $2 AND key_id = ANY($3)
  -- and bulk delete by instance_id (prefix of this index).
  CONSTRAINT whatsapp_signal_keys_identity_uq UNIQUE (instance_id, key_type, key_id),
  CONSTRAINT whatsapp_signal_keys_type_chk    CHECK (key_type ~ '^[a-z][a-z0-9-]{0,63}$'),
  CONSTRAINT whatsapp_signal_keys_id_chk      CHECK (length(key_id) BETWEEN 1 AND 512),
  CONSTRAINT whatsapp_signal_keys_ct_len_chk  CHECK (octet_length(encrypted_value) >= 29),
  CONSTRAINT whatsapp_signal_keys_version_chk CHECK (encryption_version >= 1)
) WITH (fillfactor = 80);  -- leave room for HOT updates of encrypted_value
-- Keys are overwritten constantly; vacuum this table aggressively.
ALTER TABLE app.whatsapp_signal_keys SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.05);
SELECT app_admin.attach_updated_at_trigger('app.whatsapp_signal_keys');

-- -----------------------------------------------------------------------------
-- whatsapp_instance_events: append-only connection history.
-- -----------------------------------------------------------------------------
CREATE TABLE app.whatsapp_instance_events (
  id               uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id  uuid        NOT NULL,
  instance_id      uuid        NOT NULL,
  event_type       text        NOT NULL,
  previous_status  text,
  new_status       text,
  reason           text,
  metadata         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  worker_id        uuid,       -- historical; intentionally no FK (workers are pruned)
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- Connection history is meaningless without the instance (instances are
  -- soft-deleted; hard delete only happens in an organization purge).
  CONSTRAINT whatsapp_instance_events_instance_fk FOREIGN KEY (instance_id, organization_id)
    REFERENCES app.whatsapp_instances (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT whatsapp_instance_events_type_chk CHECK (event_type ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  CONSTRAINT whatsapp_instance_events_meta_chk CHECK (jsonb_typeof(metadata) = 'object')
);
CREATE INDEX whatsapp_instance_events_instance_idx ON app.whatsapp_instance_events (instance_id, created_at DESC);

-- =============================================================================
-- Session lease / fencing helpers (SECURITY INVOKER - RLS applies)
-- =============================================================================

-- Claim (or renew) a session for a worker. Succeeds only if the instance is
-- unowned, the previous lease expired, or the caller already owns it.
-- Atomic compare-and-set: two workers racing get exactly one winner.
-- Returns the fencing token the worker must present on every auth write.
CREATE FUNCTION app.claim_instance_lease(p_instance_id uuid, p_worker_id uuid, p_lease_seconds integer)
RETURNS bigint
LANGUAGE sql VOLATILE AS $$
  UPDATE app.whatsapp_instances
     SET worker_id               = p_worker_id,
         worker_lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         worker_lease_token      = CASE WHEN worker_id = p_worker_id
                                             AND worker_lease_expires_at > now()
                                        THEN worker_lease_token          -- renewal keeps token
                                        ELSE worker_lease_token + 1 END  -- new owner => new token
   WHERE id = p_instance_id
     AND deleted_at IS NULL
     AND status NOT IN ('LOGGED_OUT','SUSPENDED')
     AND (worker_id IS NULL OR worker_lease_expires_at <= now() OR worker_id = p_worker_id)
  RETURNING worker_lease_token
$$;
GRANT EXECUTE ON FUNCTION app.claim_instance_lease(uuid, uuid, integer) TO hs_worker;

CREATE FUNCTION app.release_instance_lease(p_instance_id uuid, p_worker_id uuid, p_token bigint)
RETURNS boolean
LANGUAGE sql VOLATILE AS $$
  WITH r AS (
    UPDATE app.whatsapp_instances
       SET worker_id = NULL, worker_lease_expires_at = NULL
     WHERE id = p_instance_id AND worker_id = p_worker_id AND worker_lease_token = p_token
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM r)
$$;
GRANT EXECUTE ON FUNCTION app.release_instance_lease(uuid, uuid, bigint) TO hs_worker;

-- Called inside every auth-state write transaction. Takes a FOR SHARE lock on
-- the instance row so a concurrent claim by another worker (which UPDATEs the
-- row) waits until this write commits, then bumps the token.
CREATE FUNCTION app.assert_instance_lease(p_instance_id uuid, p_worker_id uuid, p_token bigint)
RETURNS void
LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  PERFORM 1 FROM app.whatsapp_instances
   WHERE id = p_instance_id
     AND worker_id = p_worker_id
     AND worker_lease_token = p_token
     AND worker_lease_expires_at > now()
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'whatsapp session lease lost for instance %', p_instance_id
      USING ERRCODE = 'lock_not_available', HINT = 'HS_LEASE_LOST';
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION app.assert_instance_lease(uuid, uuid, bigint) TO hs_worker;

-- Secure hard delete of authentication material (logout / org deletion).
-- Deletes the credential row; FK cascade removes all signal keys. Clears the
-- lease so no worker keeps using the session, and records an event.
-- NOTE: PostgreSQL does not overwrite freed pages; old tuples remain in the
-- heap until VACUUM, and in WAL/backups until they age out. They are still
-- AES-GCM ciphertext under a KMS-wrapped key - see docs/architecture.md.
CREATE FUNCTION app.destroy_whatsapp_auth(p_instance_id uuid, p_reason text DEFAULT 'LOGGED_OUT')
RETURNS integer
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  v_org uuid;
  v_prev text;
  v_keys integer;
BEGIN
  SELECT organization_id, status INTO v_org, v_prev
    FROM app.whatsapp_instances WHERE id = p_instance_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'instance % not found', p_instance_id USING ERRCODE = 'no_data_found';
  END IF;

  SELECT count(*) INTO v_keys FROM app.whatsapp_signal_keys WHERE instance_id = p_instance_id;
  DELETE FROM app.whatsapp_auth_credentials WHERE instance_id = p_instance_id;

  UPDATE app.whatsapp_instances
     SET status = 'LOGGED_OUT', connection_state = 'CLOSED',
         worker_id = NULL, worker_lease_expires_at = NULL,
         disconnected_at = now(), disconnect_reason = p_reason
   WHERE id = p_instance_id;

  INSERT INTO app.whatsapp_instance_events (organization_id, instance_id, event_type, previous_status, new_status, reason, metadata)
  VALUES (v_org, p_instance_id, 'CREDENTIALS_DESTROYED', v_prev, 'LOGGED_OUT', p_reason,
          jsonb_build_object('signal_keys_deleted', v_keys));
  RETURN v_keys;
END $$;
GRANT EXECUTE ON FUNCTION app.destroy_whatsapp_auth(uuid, text) TO hs_app, hs_worker;

-- =============================================================================
-- RLS
-- =============================================================================
SELECT app_admin.apply_tenant_rls('app.whatsapp_instances');
SELECT app_admin.apply_tenant_rls('app.whatsapp_auth_credentials');
SELECT app_admin.apply_tenant_rls('app.whatsapp_signal_keys');
SELECT app_admin.apply_tenant_rls('app.whatsapp_instance_events');

-- Session scheduler (cross-tenant, hs_worker only): the gateway must discover
-- and claim sessions of every tenant. Column privileges below restrict what it
-- can change (never organization_id / business_id / names). Everything else a
-- worker does for an instance (auth state, messages) runs under that
-- instance's tenant context.
CREATE POLICY whatsapp_instances_scheduler_read ON app.whatsapp_instances
  FOR SELECT TO hs_worker USING (true);
CREATE POLICY whatsapp_instances_scheduler_update ON app.whatsapp_instances
  FOR UPDATE TO hs_worker USING (true) WITH CHECK (true);

-- =============================================================================
-- GRANTS
-- =============================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON app.whatsapp_workers TO hs_worker;

GRANT SELECT, INSERT ON app.whatsapp_instances TO hs_app;
GRANT UPDATE (instance_name, description, status, proxy_enabled, proxy_id, appear_online, deleted_at,
              connection_state, worker_id, worker_lease_expires_at, disconnected_at, disconnect_reason)
  ON app.whatsapp_instances TO hs_app;
GRANT SELECT ON app.whatsapp_instances TO hs_worker;
GRANT UPDATE (provider_instance_identifier, phone_e164, whatsapp_jid, whatsapp_display_name, account_type,
              status, connection_state, worker_id, worker_lease_token, worker_lease_expires_at,
              connected_at, disconnected_at, last_connected_at, last_seen_at,
              disconnect_reason, last_error_code, last_error_message)
  ON app.whatsapp_instances TO hs_worker;

-- API role never reads key material; it may only trigger destruction (logout).
GRANT SELECT (id, organization_id, instance_id, encryption_version, key_reference, created_at, updated_at)
  ON app.whatsapp_auth_credentials TO hs_app;
GRANT DELETE ON app.whatsapp_auth_credentials TO hs_app;
GRANT SELECT (id, organization_id, instance_id, key_type) ON app.whatsapp_signal_keys TO hs_app;
-- Gateway worker is the only reader/writer of auth state.
GRANT SELECT, INSERT, UPDATE, DELETE ON app.whatsapp_auth_credentials, app.whatsapp_signal_keys TO hs_worker;

GRANT SELECT, INSERT ON app.whatsapp_instance_events TO hs_app, hs_worker;
