import { isLeaseLost, isPgError, LeaseLostError, PgCode } from '../../database/errors.js';
import type { Db, TransactionRunner } from '../../database/transaction-runner.js';
import { OpsRepository } from '../../repositories/ops.repository.js';
import { WhatsAppRepository } from '../../repositories/whatsapp.repository.js';
import type { InstanceStatus, TransportState } from '../domain/whatsapp-types.js';

export interface SessionRef {
  organizationId: string;
  businessId: string;
  instanceId: string;
  workerId: string;
  leaseToken: number;
}

export interface TransitionInput {
  status?: InstanceStatus | null;
  connectionState?: TransportState;
  eventType: string;
  reason?: string | null;
  metadata?: Record<string, unknown>;
  /** Set on 'open'. */
  profile?: { jid: string; phoneE164: string | null; displayName: string | null };
  connected?: boolean;
  disconnected?: boolean;
  reconnectAttempts?: number;
  releaseLease?: boolean;
  errorCode?: string | null;
}

export class DuplicatePhoneError extends Error {
  constructor() { super('phone number already linked to another live instance of this organization'); }
}

/**
 * Persists instance state transitions (worker role, tenant context, FENCED).
 * One transaction: lease assert -> status update -> whatsapp_instance_events
 * row -> outbox INSTANCE_STATUS_CHANGED (+ INSTANCE_CONNECTED/DISCONNECTED).
 * A worker that lost the lease cannot write anything (LeaseLostError).
 * Never stores QR / pairing codes (they are not even passed in).
 */
export class WhatsAppConnectionService {
  constructor(private readonly tx: TransactionRunner, private readonly whatsapp: WhatsAppRepository, private readonly ops: OpsRepository) {}

  async transition(ref: SessionRef, t: TransitionInput): Promise<{ previousStatus: InstanceStatus; status: InstanceStatus }> {
    try {
      return await this.tx.inTenant(async (db) => {
        await this.whatsapp.assertLease(db, ref.instanceId, ref.workerId, ref.leaseToken);
        return this.apply(db, ref, t);
      }, { organizationId: ref.organizationId });
    } catch (err) {
      if (isLeaseLost(err)) throw new LeaseLostError(ref.instanceId);
      if (isPgError(err, PgCode.UNIQUE_VIOLATION) && (err as { constraint?: string }).constraint === 'whatsapp_instances_org_phone_live_uq') {
        throw new DuplicatePhoneError();
      }
      throw err;
    }
  }

  private async apply(db: Db, ref: SessionRef, t: TransitionInput): Promise<{ previousStatus: InstanceStatus; status: InstanceStatus }> {
    const cur = await db.query('SELECT status FROM app.whatsapp_instances WHERE id = $1 FOR UPDATE', [ref.instanceId]);
    const previousStatus = cur.rows[0].status as InstanceStatus;
    const status = (t.status ?? previousStatus) as InstanceStatus;
    await db.query(
      `UPDATE app.whatsapp_instances SET
          status = $2,
          connection_state = coalesce($3, connection_state),
          whatsapp_jid = coalesce($4, whatsapp_jid),
          phone_e164 = coalesce($5, phone_e164),
          whatsapp_display_name = coalesce($6, whatsapp_display_name),
          connected_at = CASE WHEN $7 THEN now() ELSE connected_at END,
          last_connected_at = CASE WHEN $7 THEN now() ELSE last_connected_at END,
          linked_at = CASE WHEN $7 THEN coalesce(linked_at, now()) ELSE linked_at END,
          disconnected_at = CASE WHEN $8 THEN now() ELSE disconnected_at END,
          disconnect_reason = CASE WHEN $8 THEN $9 ELSE disconnect_reason END,
          reconnect_attempts = coalesce($10, reconnect_attempts),
          last_reconnect_at = CASE WHEN $10 IS NOT NULL AND $10 > 0 THEN now() ELSE last_reconnect_at END,
          last_error_code = CASE WHEN $2 = 'ERROR' THEN $11 WHEN $7 THEN NULL ELSE last_error_code END,
          last_error_message = CASE WHEN $7 THEN NULL ELSE last_error_message END,
          last_event_at = now(),
          last_seen_at = now(),
          worker_id = CASE WHEN $12 THEN NULL ELSE worker_id END,
          worker_lease_expires_at = CASE WHEN $12 THEN NULL ELSE worker_lease_expires_at END
        WHERE id = $1`,
      [ref.instanceId, status, t.connectionState ?? null, t.profile?.jid || null, t.profile?.phoneE164 ?? null,
       t.profile?.displayName ?? null, Boolean(t.connected), Boolean(t.disconnected), t.reason ?? null,
       t.reconnectAttempts ?? null, t.errorCode ?? t.reason ?? null, Boolean(t.releaseLease)]);

    await this.whatsapp.recordEvent(db, {
      organizationId: ref.organizationId, instanceId: ref.instanceId, eventType: t.eventType, previousStatus,
      newStatus: status, reason: t.reason ?? undefined, workerId: ref.workerId, metadata: t.metadata,
    });
    await this.emitStatusEvents(db, ref, previousStatus, status, t.reason ?? null);
    return { previousStatus, status };
  }

  async emitStatusEvents(db: Db, ref: Pick<SessionRef, 'organizationId' | 'businessId' | 'instanceId'>, previous: InstanceStatus, status: InstanceStatus, reason: string | null): Promise<void> {
    if (previous === status) return;
    const payload = { instance_id: ref.instanceId, business_id: ref.businessId, previous_status: previous, status, reason };
    const base = { organizationId: ref.organizationId, aggregateType: 'WHATSAPP_INSTANCE', aggregateId: ref.instanceId, payload };
    await this.ops.enqueueOutbox(db, { ...base, eventType: 'INSTANCE_STATUS_CHANGED' });
    if (status === 'CONNECTED') await this.ops.enqueueOutbox(db, { ...base, eventType: 'INSTANCE_CONNECTED' });
    if (previous === 'CONNECTED') await this.ops.enqueueOutbox(db, { ...base, eventType: 'INSTANCE_DISCONNECTED' });
    if (previous === 'CONNECTED' && status === 'RECONNECTING') {
      // Grace period: only alert humans if the instance is STILL not connected later.
      await this.ops.enqueueOutbox(db, { ...base, eventType: 'INSTANCE_RECONNECT_CHECK',
        delaySeconds: Number(process.env.WHATSAPP_RECONNECT_ALERT_GRACE_SECONDS ?? 300) });
    }
  }

  /**
   * Logged out / invalid credentials: hard-delete auth material (FK cascade to
   * all signal keys), status LOGGED_OUT, lease released - via the existing
   * app.destroy_whatsapp_auth(). Not fenced on purpose: once WhatsApp has
   * revoked the device the credentials are worthless, and destroying them is
   * always safe (idempotent).
   */
  async destroyAuth(ref: Pick<SessionRef, 'organizationId' | 'businessId' | 'instanceId'>, reason: string): Promise<{ previousStatus: InstanceStatus; keysDestroyed: number }> {
    return this.tx.inTenant(async (db) => {
      const cur = await db.query('SELECT status FROM app.whatsapp_instances WHERE id = $1', [ref.instanceId]);
      const previousStatus = cur.rows[0].status as InstanceStatus;
      const r = await db.query('SELECT app.destroy_whatsapp_auth($1, $2) AS n', [ref.instanceId, reason]);
      await this.whatsapp.recordEvent(db, { organizationId: ref.organizationId, instanceId: ref.instanceId, eventType: 'LOGGED_OUT',
        previousStatus, newStatus: 'LOGGED_OUT', reason });
      await this.emitStatusEvents(db, ref, previousStatus, 'LOGGED_OUT', reason);
      return { previousStatus, keysDestroyed: Number(r.rows[0].n) };
    }, { organizationId: ref.organizationId });
  }
}
