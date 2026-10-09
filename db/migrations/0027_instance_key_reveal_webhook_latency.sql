-- =============================================================================
-- 0027 INSTANCE API KEY IS RECOVERABLE + WEBHOOK DELIVERY LATENCY
--
--  * Instance API keys are created automatically with the instance and can be
--    copied again later from the instance page (gateway convention: "Api Key
--    (Bearer Token)" with a copy button). Authentication still uses the
--    peppered HMAC only; the plaintext is additionally kept ENCRYPTED
--    (AES-256-GCM with a KMS-wrapped per-key data key, like webhook secrets),
--    readable only through the OWNER/ADMIN "reveal" endpoint, which is audited.
--    Organization API keys are unchanged: shown once, never recoverable.
--  * webhook_deliveries.latency_ms: response time of the last attempt, for the
--    Webhook Logs page.
-- =============================================================================
ALTER TABLE app.api_keys
  ADD COLUMN secret_ciphertext     bytea,
  ADD COLUMN secret_wrapped_key    bytea,
  ADD COLUMN secret_key_reference  text;
ALTER TABLE app.api_keys ADD CONSTRAINT api_keys_secret_chk CHECK (
  (secret_ciphertext IS NULL AND secret_wrapped_key IS NULL AND secret_key_reference IS NULL)
  OR (instance_id IS NOT NULL AND secret_ciphertext IS NOT NULL AND secret_wrapped_key IS NOT NULL AND secret_key_reference IS NOT NULL));
GRANT INSERT (secret_ciphertext, secret_wrapped_key, secret_key_reference) ON app.api_keys TO hs_app;
GRANT SELECT (secret_ciphertext, secret_wrapped_key, secret_key_reference) ON app.api_keys TO hs_app;

ALTER TABLE app.webhook_deliveries ADD COLUMN latency_ms integer;
ALTER TABLE app.webhook_deliveries ADD CONSTRAINT webhook_deliveries_latency_chk CHECK (latency_ms IS NULL OR latency_ms >= 0);
GRANT UPDATE (latency_ms) ON app.webhook_deliveries TO hs_worker;
-- Webhook Logs: newest deliveries of the whole organization.
CREATE INDEX webhook_deliveries_org_recent_idx ON app.webhook_deliveries (organization_id, created_at DESC, id DESC);
