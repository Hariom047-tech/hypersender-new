import { Injectable } from '@nestjs/common';
import type { Db } from '../database/transaction-runner.js';
import { redact } from '../security/redact.js';

export interface ClaimedOutboxEvent {
  id: string;
  organizationId: string | null;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  attempts: number;
}


/** Event types consumed by dedicated workers (not the general relay): assistant turns can take seconds. */
export const DEDICATED_QUEUE_TYPES = ['AI_TURN_DUE'];

@Injectable()
export class OpsRepository {
  /**
   * Transactional outbox write: call inside the same transaction as the business change.
   * `targetInstanceId` routes instance-bound work (commands, sends) to the worker
   * holding that instance's lease; such events are never claimed by the general relay.
   */
  async enqueueOutbox(db: Db, e: { organizationId: string; eventType: string; aggregateType: string; aggregateId: string; payload?: object; dedupeKey?: string; targetInstanceId?: string; delaySeconds?: number }): Promise<void> {
    await db.query(
      `INSERT INTO app.outbox_events (organization_id, event_type, aggregate_type, aggregate_id, payload, dedupe_key, target_instance_id, available_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(secs => coalesce($8::double precision, 0)))
       ON CONFLICT (organization_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
      [e.organizationId, e.eventType, e.aggregateType, e.aggregateId, JSON.stringify(e.payload ?? {}), e.dedupeKey ?? null, e.targetInstanceId ?? null, e.delaySeconds ?? null]);
  }

  /**
   * Cross-tenant claim (hs_worker, no tenant context). SKIP LOCKED lets many
   * relays run concurrently without ever claiming the same row; the visibility
   * timeout re-exposes events of a crashed relay.
   */
  async claimOutbox(db: Db, workerId: string, limit: number, visibilitySeconds = 60,
                    filter: { onlyTypes?: string[]; excludeTypes?: string[] } = { excludeTypes: DEDICATED_QUEUE_TYPES }): Promise<ClaimedOutboxEvent[]> {
    const r = await db.query(
      `WITH due AS (
         SELECT id FROM app.outbox_events
          WHERE status IN ('PENDING','PROCESSING','FAILED') AND available_at <= now() AND target_instance_id IS NULL
            AND ($4::text[] IS NULL OR event_type = ANY($4))
            AND ($5::text[] IS NULL OR NOT (event_type = ANY($5)))
          ORDER BY available_at
          LIMIT $2
          FOR UPDATE SKIP LOCKED)
       UPDATE app.outbox_events o
          SET status = 'PROCESSING', locked_by = $1, attempts = o.attempts + 1,
              available_at = now() + make_interval(secs => $3)
         FROM due WHERE o.id = due.id
       RETURNING o.id, o.organization_id, o.event_type, o.aggregate_type, o.aggregate_id, o.payload, o.attempts`,
      [workerId, limit, visibilitySeconds, filter.onlyTypes ?? null, filter.excludeTypes ?? null]);
    return r.rows.map((row) => ({ id: row.id, organizationId: row.organization_id, eventType: row.event_type,
      aggregateType: row.aggregate_type, aggregateId: row.aggregate_id, payload: row.payload, attempts: row.attempts }));
  }

  async completeOutbox(db: Db, id: string, workerId: string): Promise<boolean> {
    const r = await db.query(
      `UPDATE app.outbox_events SET status = 'PROCESSED', processed_at = now(), locked_by = NULL
        WHERE id = $1 AND locked_by = $2 AND status = 'PROCESSING'`, [id, workerId]);
    return (r.rowCount ?? 0) > 0;
  }

  async failOutbox(db: Db, id: string, workerId: string, error: string, maxAttempts = 10): Promise<void> {
    await db.query(
      `UPDATE app.outbox_events
          SET status = CASE WHEN attempts >= $4 THEN 'DEAD' ELSE 'FAILED' END,
              last_error = left($3, 2000), locked_by = NULL,
              available_at = now() + make_interval(secs => least(3600, (2 ^ attempts)::int))
        WHERE id = $1 AND locked_by = $2`, [id, workerId, error, maxAttempts]);
  }

  /** Put a claimed event back for a short while without counting it as a failure (e.g. conversation busy). */
  async deferOutbox(db: Db, id: string, workerId: string, delaySeconds: number): Promise<void> {
    await db.query(
      `UPDATE app.outbox_events SET status = 'PENDING', locked_by = NULL, attempts = greatest(attempts - 1, 0),
              available_at = now() + make_interval(secs => $3)
        WHERE id = $1 AND locked_by = $2`, [id, workerId, delaySeconds]);
  }

  /** Exactly-once metering via (organization_id, idempotency_key). */
  async recordUsage(db: Db, u: { organizationId: string; businessId?: string | null; eventType: string; quantity: number; resourceType?: string; resourceId?: string; idempotencyKey: string; occurredAt?: Date }): Promise<boolean> {
    if (!Number.isSafeInteger(u.quantity) || u.quantity <= 0) return false;
    const r = await db.query(
      `INSERT INTO app.usage_events (organization_id, business_id, event_type, quantity, resource_type, resource_id, idempotency_key, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, coalesce($8, now()))
       ON CONFLICT (organization_id, idempotency_key) DO NOTHING`,
      [u.organizationId, u.businessId ?? null, u.eventType, u.quantity, u.resourceType ?? null, u.resourceId ?? null,
       u.idempotencyKey, u.occurredAt ?? null]);
    return (r.rowCount ?? 0) > 0;
  }

  async usageInPeriod(db: Db, eventType: string, from: Date, to: Date): Promise<number> {
    const r = await db.query(
      `SELECT coalesce(sum(quantity), 0) AS total FROM app.usage_events
        WHERE organization_id = app.current_org_id() AND event_type = $1 AND occurred_at >= $2 AND occurred_at < $3`,
      [eventType, from, to]);
    return Number(r.rows[0].total);
  }

  /** Audit entry; metadata is always redacted before it reaches the database. */
  async audit(db: Db, a: { organizationId: string; actorType: string; actorUserId?: string; actorApiKeyId?: string; action: string; resourceType: string; resourceId?: string; ip?: string; userAgent?: string; requestId?: string; metadata?: object }): Promise<void> {
    await db.query(
      `INSERT INTO app.audit_logs (organization_id, actor_type, actor_user_id, actor_api_key_id, action, resource_type, resource_id,
                                   ip_address, user_agent, request_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, left($9, 512), $10, $11)`,
      [a.organizationId, a.actorType, a.actorUserId ?? null, a.actorApiKeyId ?? null, a.action, a.resourceType, a.resourceId ?? null,
       a.ip ?? null, a.userAgent ?? null, a.requestId ?? null, JSON.stringify(redact(a.metadata ?? {}))]);
  }
}
