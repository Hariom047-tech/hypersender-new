-- =============================================================================
-- 0026 DEVELOPER API: INSTANCE API KEYS, OTP SERVICE, WEBHOOK AUTH HEADER
--
-- Lets other products use a connected WhatsApp number as a service (like
-- PanditSuggest uses a gateway for login OTPs):
--   * Instance API key: an API key bound to ONE WhatsApp instance. It can only
--     call the instance API (/api/whatsapp/v1/{instance}/...) and the OTP API
--     (/api/otp/v1/{instance}/...) of that instance - never the dashboard API.
--     Shown once; rotating revokes the previous key of the instance.
--   * OTP requests: one-time codes sent on WhatsApp (request-code /
--     validate-code) and "login by WhatsApp" links where the user sends the
--     code to the business number (generate-link). Codes are stored as keyed
--     HMACs only; validation attempts are capped.
--   * Webhook endpoints may carry a static Authorization header value (in
--     addition to the HMAC signature), encrypted like the signing secret.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- api_keys.instance_id
-- -----------------------------------------------------------------------------
ALTER TABLE app.api_keys ADD COLUMN instance_id uuid;
ALTER TABLE app.api_keys ADD CONSTRAINT api_keys_instance_fk FOREIGN KEY (instance_id, organization_id, business_id)
  REFERENCES app.whatsapp_instances (id, organization_id, business_id) ON DELETE CASCADE;
ALTER TABLE app.api_keys ADD CONSTRAINT api_keys_instance_scope_chk CHECK (instance_id IS NULL OR business_id IS NOT NULL);
-- At most one live key per instance (rotation revokes the old one in the same transaction).
CREATE UNIQUE INDEX api_keys_one_live_per_instance_uq ON app.api_keys (instance_id) WHERE instance_id IS NOT NULL AND revoked_at IS NULL;

GRANT SELECT (instance_id) ON app.api_keys TO hs_app;
GRANT INSERT (instance_id) ON app.api_keys TO hs_app;

-- Return type changes (adds instance_id), so the function is recreated.
DROP FUNCTION app_auth.authenticate_api_key(bytea);
CREATE FUNCTION app_auth.authenticate_api_key(p_key_hash bytea)
RETURNS TABLE (api_key_id uuid, organization_id uuid, business_id uuid, scopes text[], instance_id uuid)
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
                       AND o.status NOT IN ('SUSPENDED','CANCELLED'))
     OR (k.instance_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.whatsapp_instances i
                                                    WHERE i.id = k.instance_id AND i.deleted_at IS NULL)) THEN
    RETURN;
  END IF;
  IF k.last_used_at IS NULL OR k.last_used_at < now() - interval '1 minute' THEN
    UPDATE app.api_keys SET last_used_at = now() WHERE id = k.id;
  END IF;
  api_key_id := k.id; organization_id := k.organization_id; business_id := k.business_id; scopes := k.scopes; instance_id := k.instance_id;
  RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION app_auth.authenticate_api_key(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_auth.authenticate_api_key(bytea) TO hs_app;

-- -----------------------------------------------------------------------------
-- otp_requests
--   kind CODE: we generate a code and send it to `phone_e164` on WhatsApp; the
--              caller later validates what the user typed.
--   kind LINK: we generate a code and a wa.me link; the user sends the code TO
--              the instance number; the inbound message verifies it and the
--              sender's phone is recorded (phone_e164 is NULL until then).
-- -----------------------------------------------------------------------------
CREATE TABLE app.otp_requests (
  id                  uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id     uuid        NOT NULL,
  business_id         uuid        NOT NULL,
  instance_id         uuid        NOT NULL,
  api_key_id          uuid        REFERENCES app.api_keys(id) ON DELETE SET NULL,
  kind                text        NOT NULL,
  phone_e164          text,
  code_hash           bytea       NOT NULL,
  status              text        NOT NULL DEFAULT 'PENDING',
  attempts            smallint    NOT NULL DEFAULT 0,
  max_attempts        smallint    NOT NULL DEFAULT 5,
  app_name            text,
  link_messages       jsonb,
  message_id          uuid,
  expires_at          timestamptz NOT NULL,
  verified_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT otp_requests_instance_fk FOREIGN KEY (instance_id, organization_id, business_id)
    REFERENCES app.whatsapp_instances (id, organization_id, business_id) ON DELETE CASCADE,
  CONSTRAINT otp_requests_v7_chk        CHECK (uuid_extract_version(id) = 7),
  CONSTRAINT otp_requests_kind_chk      CHECK (kind IN ('CODE','LINK')),
  CONSTRAINT otp_requests_status_chk    CHECK (status IN ('PENDING','VERIFIED','FAILED','CANCELLED')),
  CONSTRAINT otp_requests_phone_chk     CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  CONSTRAINT otp_requests_code_chk      CHECK (kind = 'LINK' OR phone_e164 IS NOT NULL),
  CONSTRAINT otp_requests_hash_chk      CHECK (octet_length(code_hash) = 32),
  CONSTRAINT otp_requests_attempts_chk  CHECK (attempts >= 0 AND max_attempts BETWEEN 1 AND 10),
  CONSTRAINT otp_requests_name_chk      CHECK (app_name IS NULL OR length(btrim(app_name)) BETWEEN 1 AND 60),
  CONSTRAINT otp_requests_links_chk     CHECK (link_messages IS NULL OR jsonb_typeof(link_messages) = 'object'),
  CONSTRAINT otp_requests_verified_chk  CHECK (status <> 'VERIFIED' OR verified_at IS NOT NULL)
);
-- validate-code: newest pending code for (instance, phone).
CREATE INDEX otp_requests_code_lookup_idx ON app.otp_requests (instance_id, phone_e164, created_at DESC) WHERE kind = 'CODE' AND status = 'PENDING';
-- inbound link verification: pending link by its code hash.
CREATE INDEX otp_requests_link_lookup_idx ON app.otp_requests (instance_id, code_hash) WHERE kind = 'LINK' AND status = 'PENDING';
-- per-recipient rate limit.
CREATE INDEX otp_requests_rate_idx ON app.otp_requests (instance_id, phone_e164, created_at DESC);
SELECT app_admin.attach_updated_at_trigger('app.otp_requests');
SELECT app_admin.apply_tenant_rls('app.otp_requests'::regclass);

GRANT SELECT, INSERT, UPDATE ON app.otp_requests TO hs_app;
-- Worker: inbound "login by WhatsApp" messages verify LINK requests.
GRANT SELECT, UPDATE ON app.otp_requests TO hs_worker;

-- -----------------------------------------------------------------------------
-- webhook_endpoints: optional static Authorization header (encrypted)
-- -----------------------------------------------------------------------------
ALTER TABLE app.webhook_endpoints
  ADD COLUMN auth_header_ciphertext  bytea,
  ADD COLUMN auth_header_wrapped_key bytea,
  ADD COLUMN auth_header_key_reference text;
ALTER TABLE app.webhook_endpoints ADD CONSTRAINT webhook_endpoints_auth_header_chk CHECK (
  (auth_header_ciphertext IS NULL AND auth_header_wrapped_key IS NULL AND auth_header_key_reference IS NULL)
  OR (auth_header_ciphertext IS NOT NULL AND auth_header_wrapped_key IS NOT NULL AND auth_header_key_reference IS NOT NULL));
ALTER TABLE app.webhook_endpoints ADD COLUMN has_auth_header boolean GENERATED ALWAYS AS (auth_header_ciphertext IS NOT NULL) STORED;
-- The API role writes it but never reads it back (same as the signing secret);
-- it only learns whether one is set.
GRANT UPDATE (auth_header_ciphertext, auth_header_wrapped_key, auth_header_key_reference) ON app.webhook_endpoints TO hs_app;
GRANT SELECT (has_auth_header) ON app.webhook_endpoints TO hs_app;

-- -----------------------------------------------------------------------------
-- Webhook event type for "login by WhatsApp" links.
-- -----------------------------------------------------------------------------
INSERT INTO app.webhook_event_types (code, description) VALUES
  ('OTP_VERIFIED', 'A user sent the code of a "login by WhatsApp" link to the instance number')
ON CONFLICT (code) DO NOTHING;
