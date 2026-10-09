-- migrate:no-transaction
-- 0017 Contacts page ordered by last_seen_at DESC (keyset). Evidence: bitmap scan + sort of
-- all tenant contacts on every page (~5 ms at 20k, linear growth).
CREATE INDEX CONCURRENTLY IF NOT EXISTS contacts_org_recent_idx
  ON app.contacts (organization_id, last_seen_at DESC, id DESC)
  WHERE deleted_at IS NULL;
