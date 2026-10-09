-- =============================================================================
-- 0012 WHATSAPP GATEWAY (Phase 2) - additive only.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- messages.origin: who produced a message. Needed for AI/human coexistence:
-- a message typed on the owner's phone (LINKED_DEVICE) must be distinguishable
-- from one the platform sent (API / DASHBOARD / AI). NULL for pre-0012 rows.
-- Adding a nullable column without default is a catalog-only change.
-- -----------------------------------------------------------------------------
ALTER TABLE app.messages ADD COLUMN origin text;
ALTER TABLE app.messages ADD CONSTRAINT messages_origin_chk
  CHECK (origin IS NULL OR origin IN ('CONTACT','API','DASHBOARD','AI','LINKED_DEVICE','SYSTEM')) NOT VALID;
ALTER TABLE app.messages VALIDATE CONSTRAINT messages_origin_chk;

-- -----------------------------------------------------------------------------
-- whatsapp_instances: session health / data-minimisation fields.
--   linked_at          first successful pairing of the CURRENT linked device.
--                      Messages older than this are history and never imported.
--   reconnect_attempts consecutive failed reconnects (reset on CONNECTED).
--   last_reconnect_at  last reconnect attempt.
--   last_event_at      last provider event seen (liveness signal).
-- -----------------------------------------------------------------------------
ALTER TABLE app.whatsapp_instances
  ADD COLUMN linked_at          timestamptz,
  ADD COLUMN reconnect_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN last_reconnect_at  timestamptz,
  ADD COLUMN last_event_at      timestamptz;
ALTER TABLE app.whatsapp_instances
  ADD CONSTRAINT whatsapp_instances_reconnects_chk CHECK (reconnect_attempts >= 0);

GRANT UPDATE (linked_at, reconnect_attempts, last_reconnect_at, last_event_at)
  ON app.whatsapp_instances TO hs_worker;

-- Restore scan: sessions that should be live and whose lease is free/expired.
CREATE INDEX whatsapp_instances_restorable_idx ON app.whatsapp_instances (worker_lease_expires_at NULLS FIRST)
  WHERE deleted_at IS NULL AND status IN ('CONNECTED','RECONNECTING');

-- -----------------------------------------------------------------------------
-- outbox_events.target_instance_id: routes instance-bound work (commands,
-- sends) to the ONE worker that holds the instance lease.
-- -----------------------------------------------------------------------------
ALTER TABLE app.outbox_events ADD COLUMN target_instance_id uuid;
CREATE INDEX outbox_events_routed_due_idx ON app.outbox_events (target_instance_id, available_at)
  WHERE status IN ('PENDING','PROCESSING','FAILED') AND target_instance_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- Worker health for the tenant status endpoint: liveness columns only (no
-- hostnames / regions). whatsapp_workers holds no tenant data.
-- -----------------------------------------------------------------------------
GRANT SELECT (id, status, last_heartbeat_at) ON app.whatsapp_workers TO hs_app;

-- -----------------------------------------------------------------------------
-- Ops health: AGGREGATE counts only, no tenant identifiers. SECURITY DEFINER so
-- the API role can serve /internal/health/whatsapp (guarded by an ops token)
-- without gaining cross-tenant row access.
-- -----------------------------------------------------------------------------
CREATE SCHEMA app_ops;
REVOKE ALL ON SCHEMA app_ops FROM PUBLIC;
GRANT USAGE ON SCHEMA app_ops TO hs_app;

CREATE FUNCTION app_ops.whatsapp_health_summary(p_stale_after_seconds integer)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
  SELECT jsonb_build_object(
    'instances_by_status', coalesce((
        SELECT jsonb_object_agg(status, n) FROM (
          SELECT status, count(*) AS n FROM app.whatsapp_instances WHERE deleted_at IS NULL GROUP BY status) s), '{}'::jsonb),
    'instances_without_live_owner', (
        SELECT count(*) FROM app.whatsapp_instances
         WHERE deleted_at IS NULL AND status IN ('CONNECTED','RECONNECTING')
           AND (worker_id IS NULL OR worker_lease_expires_at <= now())),
    'workers_by_status', coalesce((
        SELECT jsonb_object_agg(status, n) FROM (
          SELECT status, count(*) AS n FROM app.whatsapp_workers GROUP BY status) w), '{}'::jsonb),
    'workers_stale', (
        SELECT count(*) FROM app.whatsapp_workers
         WHERE status IN ('STARTING','ACTIVE','DRAINING')
           AND last_heartbeat_at < now() - make_interval(secs => p_stale_after_seconds)),
    'active_sessions', (SELECT coalesce(sum(active_sessions), 0) FROM app.whatsapp_workers WHERE status = 'ACTIVE'),
    'outbox_backlog', (SELECT count(*) FROM app.outbox_events WHERE status IN ('PENDING','FAILED')),
    'webhook_backlog', (SELECT count(*) FROM app.webhook_deliveries WHERE status IN ('PENDING','RETRYING')),
    'generated_at', now())
$$;
REVOKE ALL ON FUNCTION app_ops.whatsapp_health_summary(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_ops.whatsapp_health_summary(integer) TO hs_app;
