import { Injectable } from '@nestjs/common';
import type { Db } from '../../database/transaction-runner.js';
import type { InstanceStatus } from '../domain/whatsapp-types.js';

export interface SessionInstanceRow {
  id: string;
  organizationId: string;
  businessId: string;
  status: InstanceStatus;
  linkedAt: Date | null;
  appearOnline: boolean;
  whatsappJid: string | null;
  phoneE164: string | null;
  deleted: boolean;
}

export interface RoutedOutboxEvent {
  id: string;
  organizationId: string;
  eventType: string;
  targetInstanceId: string;
  payload: Record<string, unknown>;
  attempts: number;
  createdAt: Date;
}

/** Worker-side SQL for session ownership, registry and routed work. */
@Injectable()
export class GatewayRepository {
  // ------------------------------------------------------------ worker registry
  async upsertWorker(db: Db, w: { id: string; hostname: string; capacity: number }): Promise<void> {
    await db.query(
      `INSERT INTO app.whatsapp_workers (id, hostname, status, capacity, active_sessions, last_heartbeat_at, started_at)
       VALUES ($1, $2, 'ACTIVE', $3, 0, now(), now())
       ON CONFLICT (id) DO UPDATE SET hostname = EXCLUDED.hostname, status = 'ACTIVE', capacity = EXCLUDED.capacity,
                                      active_sessions = 0, last_heartbeat_at = now(), started_at = now()`,
      [w.id, w.hostname, w.capacity]);
  }

  async heartbeat(db: Db, workerId: string, activeSessions: number, status: 'ACTIVE' | 'DRAINING' | 'STOPPED'): Promise<void> {
    await db.query(`UPDATE app.whatsapp_workers SET last_heartbeat_at = now(), active_sessions = $2, status = $3 WHERE id = $1`,
      [workerId, activeSessions, status]);
  }

  /** Marks workers with stale heartbeats DEAD (their leases expire independently). */
  async reapStaleWorkers(db: Db, staleSeconds: number): Promise<number> {
    const r = await db.query(
      `UPDATE app.whatsapp_workers SET status = 'DEAD', active_sessions = 0
        WHERE status IN ('STARTING','ACTIVE','DRAINING') AND last_heartbeat_at < now() - make_interval(secs => $1)`, [staleSeconds]);
    return r.rowCount ?? 0;
  }

  // --------------------------------------------------------------- ownership
  /**
   * Renews the leases of sessions this worker is actively running. Returns the
   * ids that were renewed; any missing id means ownership was lost (fenced) and
   * the local socket must be stopped immediately.
   */
  async renewLeases(db: Db, workerId: string, instanceIds: string[], ttlSeconds: number): Promise<Set<string>> {
    if (instanceIds.length === 0) return new Set();
    const r = await db.query(
      `UPDATE app.whatsapp_instances SET worker_lease_expires_at = now() + make_interval(secs => $3)
        WHERE id = ANY($2::uuid[]) AND worker_id = $1 RETURNING id`,
      [workerId, instanceIds, ttlSeconds]);
    return new Set(r.rows.map((x) => x.id as string));
  }

  /** Sessions that should be live and have no live owner (boot restore + orphan takeover). Cross-tenant scheduler read. */
  async listRestorable(db: Db, workerId: string, limit: number): Promise<Array<{ id: string; organizationId: string }>> {
    const r = await db.query(
      `SELECT id, organization_id FROM app.whatsapp_instances
        WHERE deleted_at IS NULL AND status IN ('CONNECTED','RECONNECTING')
          AND (worker_id IS NULL OR worker_lease_expires_at <= now() OR worker_id = $1)
        ORDER BY worker_lease_expires_at NULLS FIRST
        LIMIT $2`, [workerId, limit]);
    return r.rows.map((x) => ({ id: x.id, organizationId: x.organization_id }));
  }

  /** Tenant-scoped load of the instance a session is about to run. */
  async loadInstance(db: Db, instanceId: string): Promise<SessionInstanceRow | null> {
    const r = await db.query(
      `SELECT id, organization_id, business_id, status, linked_at, appear_online, whatsapp_jid, phone_e164, deleted_at IS NOT NULL AS deleted
         FROM app.whatsapp_instances WHERE id = $1`, [instanceId]);
    const x = r.rows[0];
    return x ? { id: x.id, organizationId: x.organization_id, businessId: x.business_id, status: x.status, linkedAt: x.linked_at,
                 appearOnline: x.appear_online, whatsappJid: x.whatsapp_jid, phoneE164: x.phone_e164, deleted: x.deleted } : null;
  }

  async hasCredentials(db: Db, instanceId: string): Promise<boolean> {
    const r = await db.query('SELECT 1 FROM app.whatsapp_auth_credentials WHERE instance_id = $1', [instanceId]);
    return (r.rowCount ?? 0) > 0;
  }

  // ------------------------------------------------------------ routed outbox
  /**
   * Claims instance-bound work for THIS worker (cross-tenant claim, then each
   * event is processed under its own organization's context):
   *   - anything targeting an instance whose live lease this worker holds;
   *   - INSTANCE_COMMANDs for instances nobody owns (connect/logout/...) when
   *     this worker has spare capacity;
   *   - sends whose instance stayed unreachable beyond the queue TTL (to fail them);
   *   - work for a deleted instance nobody owns (to settle it; a live owner
   *     handles its own deleted instance so it can log out on WhatsApp first).
   */
  async claimRouted(db: Db, workerId: string, limit: number, acceptCommands: boolean, sendTtlSeconds: number, visibilitySeconds = 60): Promise<RoutedOutboxEvent[]> {
    const r = await db.query(
      `WITH due AS (
         SELECT o.id FROM app.outbox_events o
           JOIN app.whatsapp_instances i ON i.id = o.target_instance_id
          WHERE o.target_instance_id IS NOT NULL
            AND o.status IN ('PENDING','PROCESSING','FAILED') AND o.available_at <= now()
            AND (   (i.worker_id = $1 AND i.worker_lease_expires_at > now())
                 OR ($3 AND o.event_type = 'INSTANCE_COMMAND' AND (i.worker_id IS NULL OR i.worker_lease_expires_at <= now()))
                 OR (o.event_type = 'MESSAGE_SEND_REQUESTED' AND o.created_at < now() - make_interval(secs => $4)
                     AND (i.worker_id IS NULL OR i.worker_lease_expires_at <= now()))
                 OR (i.deleted_at IS NOT NULL AND (i.worker_id IS NULL OR i.worker_lease_expires_at <= now())))
          ORDER BY o.available_at, o.id
          LIMIT $2
          FOR UPDATE OF o SKIP LOCKED)
       UPDATE app.outbox_events o
          SET status = 'PROCESSING', locked_by = $1::text, attempts = o.attempts + 1,
              available_at = now() + make_interval(secs => $5)
         FROM due WHERE o.id = due.id
       RETURNING o.id, o.organization_id, o.event_type, o.target_instance_id, o.payload, o.attempts, o.created_at`,
      [workerId, limit, acceptCommands, sendTtlSeconds, visibilitySeconds]);
    return r.rows.map((x) => ({ id: x.id, organizationId: x.organization_id, eventType: x.event_type, targetInstanceId: x.target_instance_id,
                                payload: x.payload, attempts: x.attempts, createdAt: x.created_at }));
  }
}
