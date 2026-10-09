-- Rollback 0027.
DROP INDEX IF EXISTS app.webhook_deliveries_org_recent_idx;
ALTER TABLE app.webhook_deliveries DROP CONSTRAINT IF EXISTS webhook_deliveries_latency_chk;
ALTER TABLE app.webhook_deliveries DROP COLUMN IF EXISTS latency_ms;
ALTER TABLE app.api_keys DROP CONSTRAINT IF EXISTS api_keys_secret_chk;
ALTER TABLE app.api_keys DROP COLUMN IF EXISTS secret_ciphertext, DROP COLUMN IF EXISTS secret_wrapped_key, DROP COLUMN IF EXISTS secret_key_reference;
