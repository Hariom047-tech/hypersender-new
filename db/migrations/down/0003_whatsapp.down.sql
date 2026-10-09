-- Rollback 0003. Destroys WhatsApp auth state.
DROP FUNCTION IF EXISTS app.destroy_whatsapp_auth(uuid, text);
DROP FUNCTION IF EXISTS app.assert_instance_lease(uuid, uuid, bigint);
DROP FUNCTION IF EXISTS app.release_instance_lease(uuid, uuid, bigint);
DROP FUNCTION IF EXISTS app.claim_instance_lease(uuid, uuid, integer);
DROP TABLE IF EXISTS app.whatsapp_instance_events, app.whatsapp_signal_keys, app.whatsapp_auth_credentials, app.whatsapp_instances, app.whatsapp_workers;
