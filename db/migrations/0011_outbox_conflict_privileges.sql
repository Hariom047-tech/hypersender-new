-- =============================================================================
-- 0011 FIX: INSERT ... ON CONFLICT (organization_id, dedupe_key) needs SELECT
-- privilege on the conflict-target columns. 0010 granted hs_app INSERT only on
-- outbox_events, so API-side outbox writes with a dedupe key failed with 42501.
-- Grant the two arbiter columns only (the API still cannot read payloads);
-- RLS continues to restrict visibility to the caller's own organization.
-- (Forward fix - applied migrations are never edited.)
-- =============================================================================
GRANT SELECT (organization_id, dedupe_key) ON app.outbox_events TO hs_app;
