-- Rollback 0026.
DELETE FROM app.webhook_event_subscriptions WHERE event_type = 'OTP_VERIFIED';
DELETE FROM app.webhook_event_types WHERE code = 'OTP_VERIFIED'
  AND NOT EXISTS (SELECT 1 FROM app.webhook_events WHERE event_type = 'OTP_VERIFIED');

ALTER TABLE app.webhook_endpoints DROP CONSTRAINT IF EXISTS webhook_endpoints_auth_header_chk;
ALTER TABLE app.webhook_endpoints DROP COLUMN IF EXISTS has_auth_header,
  DROP COLUMN IF EXISTS auth_header_ciphertext, DROP COLUMN IF EXISTS auth_header_wrapped_key, DROP COLUMN IF EXISTS auth_header_key_reference;

DROP TABLE IF EXISTS app.otp_requests;

DROP FUNCTION app_auth.authenticate_api_key(bytea);
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
REVOKE ALL ON FUNCTION app_auth.authenticate_api_key(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_auth.authenticate_api_key(bytea) TO hs_app;

DROP INDEX IF EXISTS app.api_keys_one_live_per_instance_uq;
ALTER TABLE app.api_keys DROP CONSTRAINT IF EXISTS api_keys_instance_scope_chk, DROP CONSTRAINT IF EXISTS api_keys_instance_fk;
ALTER TABLE app.api_keys DROP COLUMN IF EXISTS instance_id;
