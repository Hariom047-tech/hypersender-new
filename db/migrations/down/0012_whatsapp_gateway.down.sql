-- Rollback 0012.
DROP SCHEMA IF EXISTS app_ops CASCADE;
REVOKE SELECT (id, status, last_heartbeat_at) ON app.whatsapp_workers FROM hs_app;
DROP INDEX IF EXISTS app.outbox_events_routed_due_idx;
ALTER TABLE app.outbox_events DROP COLUMN IF EXISTS target_instance_id;
DROP INDEX IF EXISTS app.whatsapp_instances_restorable_idx;
ALTER TABLE app.whatsapp_instances DROP CONSTRAINT IF EXISTS whatsapp_instances_reconnects_chk;
ALTER TABLE app.whatsapp_instances
  DROP COLUMN IF EXISTS linked_at, DROP COLUMN IF EXISTS reconnect_attempts,
  DROP COLUMN IF EXISTS last_reconnect_at, DROP COLUMN IF EXISTS last_event_at;
ALTER TABLE app.messages DROP CONSTRAINT IF EXISTS messages_origin_chk;
ALTER TABLE app.messages DROP COLUMN IF EXISTS origin;
