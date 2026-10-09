-- Rollback 0010. Drops audit/outbox/retention data: development/staging only.
DROP FUNCTION IF EXISTS app_admin.purge_organization_data(uuid);
DROP FUNCTION IF EXISTS app.purge_conversation(uuid);
DROP FUNCTION IF EXISTS app.anonymize_contact(uuid);
DROP TABLE IF EXISTS app.data_retention_policies, app.outbox_events, app.notifications, app.audit_logs;
