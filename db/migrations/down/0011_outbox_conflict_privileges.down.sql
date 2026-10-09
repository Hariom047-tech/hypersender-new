-- Rollback 0011.
REVOKE SELECT (organization_id, dedupe_key) ON app.outbox_events FROM hs_app;
