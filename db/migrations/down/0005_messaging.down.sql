-- Rollback 0005.
DROP FUNCTION IF EXISTS app.message_status_rank(text);
DROP TABLE IF EXISTS app.message_attachments, app.message_status_events, app.messages, app.conversations, app.contacts;
