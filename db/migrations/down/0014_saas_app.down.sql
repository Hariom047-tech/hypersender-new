-- Rollback 0014.
DELETE FROM app.webhook_event_types WHERE code = 'WEBHOOK_TEST'
  AND NOT EXISTS (SELECT 1 FROM app.webhook_events WHERE event_type = 'WEBHOOK_TEST');
DROP FUNCTION IF EXISTS app_auth.decline_invitation(uuid);
DROP FUNCTION IF EXISTS app_auth.accept_invitation(uuid);
DROP FUNCTION IF EXISTS app_auth.my_pending_invitations();
DROP FUNCTION IF EXISTS app_auth.find_active_user_for_invite(text);
