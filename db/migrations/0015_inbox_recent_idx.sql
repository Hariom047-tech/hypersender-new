-- migrate:no-transaction
-- 0015 Inbox "All" view: ordered keyset scan (organization, last_message_at DESC, id DESC).
-- Evidence (scripts/explain-queries.ts, 20k conversations): status = ANY(...) could not use
-- conversations_inbox_idx for ordering -> bitmap scan + sort of every conversation (~94 ms).
CREATE INDEX CONCURRENTLY IF NOT EXISTS conversations_org_recent_idx
  ON app.conversations (organization_id, last_message_at DESC, id DESC);
