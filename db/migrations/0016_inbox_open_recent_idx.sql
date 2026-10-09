-- migrate:no-transaction
-- 0016 Inbox default view (Open/Unread = OPEN + WAITING): partial ordered index so the
-- first page is an index-ordered LIMIT scan instead of sorting all open conversations.
CREATE INDEX CONCURRENTLY IF NOT EXISTS conversations_org_open_recent_idx
  ON app.conversations (organization_id, last_message_at DESC, id DESC)
  WHERE status IN ('OPEN','WAITING');
