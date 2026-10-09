import type { TenantContext } from '../../database/tenant-context.js';
import type { Db, TransactionRunner } from '../../database/transaction-runner.js';
import { OpsRepository } from '../../repositories/ops.repository.js';
import { EntitlementService } from '../../services/entitlement.service.js';
import { assertBusinessScope, assertInstanceScope } from '../../api/auth/permissions.js';
import { toE164 } from '../domain/phone.js';
import { WhatsAppError } from '../domain/whatsapp-errors.js';
import type { InstanceStatus } from '../domain/whatsapp-types.js';
import type { QrCache } from '../realtime/qr-cache.js';
import type { RealtimeBus, RealtimeEvent } from '../realtime/realtime-bus.js';

export type InstanceCommand = 'CONNECT' | 'RESTART' | 'DISCONNECT' | 'LOGOUT' | 'DELETE';

export interface PublicInstance {
  id: string;
  businessId: string;
  name: string;
  description: string | null;
  provider: string;
  status: InstanceStatus;
  phoneNumber: string | null;
  displayName: string | null;
  connectedAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
}

const PUBLIC_COLS = `id, business_id, instance_name, description, provider, status, phone_e164, whatsapp_display_name,
                     connected_at, last_seen_at, created_at`;

function toPublic(x: Record<string, any>): PublicInstance {
  return {
    id: x.id, businessId: x.business_id, name: x.instance_name, description: x.description, provider: x.provider, status: x.status,
    phoneNumber: x.phone_e164, displayName: x.whatsapp_display_name,
    connectedAt: x.connected_at?.toISOString() ?? null, lastSeenAt: x.last_seen_at?.toISOString() ?? null, createdAt: x.created_at.toISOString(),
  };
}

/**
 * API-side instance lifecycle (hs_app, RLS-scoped). The API never touches
 * sockets: operational commands are written to the transactional outbox,
 * routed to the worker that owns (or may claim) the instance.
 */
export class WhatsAppInstanceService {
  private readonly entitlements = new EntitlementService();

  constructor(
    private readonly tx: TransactionRunner,
    private readonly ops: OpsRepository,
    private readonly bus: RealtimeBus,
    private readonly qr: QrCache,
    private readonly opts: { staleAfterMs: number; pairingCodeWaitMs: number },
  ) {}

  /** Creates an instance in status CREATED. Enforces the plan's MAX_WHATSAPP_INSTANCES race-free. */
  async create(ctx: TenantContext, input: { businessId: string; name: string; description?: string }): Promise<PublicInstance> {
    assertBusinessScope(ctx, input.businessId);
    return this.tx.inTenant(async (db) => {
      // Race-free plan limit (advisory lock per org+feature, count, compare) - see EntitlementService.
      await this.entitlements.assertCanAdd(db, 'MAX_WHATSAPP_INSTANCES');
      const r = await db.query(
        `INSERT INTO app.whatsapp_instances (organization_id, business_id, instance_name, description, created_by_user_id, status)
         VALUES ($1, $2, $3, $4, $5, 'CREATED') RETURNING ${PUBLIC_COLS}`,
        [ctx.organizationId, input.businessId, input.name, input.description ?? null, ctx.userId ?? null]);
      await this.ops.audit(db, { organizationId: ctx.organizationId, actorType: ctx.apiKeyId ? 'API_KEY' : 'USER', actorUserId: ctx.userId,
        actorApiKeyId: ctx.apiKeyId, action: 'WHATSAPP_INSTANCE_CREATED', resourceType: 'WHATSAPP_INSTANCE', resourceId: r.rows[0].id,
        requestId: ctx.requestId, metadata: { name: input.name, business_id: input.businessId } });
      return toPublic(r.rows[0]);
    }, ctx);
  }

  /** Rename / describe an instance (connection is untouched). */
  async update(ctx: TenantContext, instanceId: string, input: { name?: string; description?: string | null }): Promise<PublicInstance> {
    return this.tx.inTenant(async (db) => {
      await this.load(db, ctx, instanceId, true);
      const r = await db.query(
        `UPDATE app.whatsapp_instances SET instance_name = coalesce($2, instance_name),
                description = CASE WHEN $4 THEN $3 ELSE description END
          WHERE id = $1 RETURNING ${PUBLIC_COLS}`, [instanceId, input.name ?? null, input.description ?? null, input.description !== undefined]);
      await this.ops.audit(db, { organizationId: ctx.organizationId, actorType: ctx.apiKeyId ? 'API_KEY' : 'USER', actorUserId: ctx.userId,
        actorApiKeyId: ctx.apiKeyId, action: 'WHATSAPP_INSTANCE_UPDATED', resourceType: 'WHATSAPP_INSTANCE', resourceId: instanceId,
        requestId: ctx.requestId, metadata: { fields: Object.keys(input) } });
      return toPublic(r.rows[0]);
    }, ctx);
  }

  async list(ctx: TenantContext): Promise<PublicInstance[]> {
    return this.tx.inTenant(async (db) => {
      const r = await db.query(
        `SELECT ${PUBLIC_COLS} FROM app.whatsapp_instances
          WHERE deleted_at IS NULL AND ($1::uuid IS NULL OR business_id = $1) ORDER BY created_at`, [ctx.businessId ?? null]);
      return r.rows.map(toPublic);
    }, ctx, { readOnly: true });
  }

  /** 404 (not 403) for other tenants' instances: RLS makes them indistinguishable from non-existent ones. */
  async get(ctx: TenantContext, instanceId: string): Promise<PublicInstance> {
    return this.tx.inTenant((db) => this.load(db, ctx, instanceId), ctx, { readOnly: true });
  }

  private async load(db: Db, ctx: TenantContext, instanceId: string, lock = false): Promise<PublicInstance> {
    const r = await db.query(`SELECT ${PUBLIC_COLS} FROM app.whatsapp_instances WHERE id = $1 AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`, [instanceId]);
    if (!r.rows[0]) throw new WhatsAppError('WHATSAPP_INSTANCE_NOT_FOUND');
    assertBusinessScope(ctx, r.rows[0].business_id);
    assertInstanceScope(ctx, instanceId);
    return toPublic(r.rows[0]);
  }

  async status(ctx: TenantContext, instanceId: string) {
    return this.tx.inTenant(async (db) => {
      const inst = await this.load(db, ctx, instanceId);
      const w = await db.query(
        `SELECT (w.status = 'ACTIVE' AND w.last_heartbeat_at > now() - make_interval(secs => $2)
                 AND i.worker_lease_expires_at > now()) AS healthy
           FROM app.whatsapp_instances i LEFT JOIN app.whatsapp_workers w ON w.id = i.worker_id
          WHERE i.id = $1`, [instanceId, Math.ceil(this.opts.staleAfterMs / 1000)]);
      return {
        instanceId: inst.id, status: inst.status, phoneNumber: inst.phoneNumber, displayName: inst.displayName,
        connectedAt: inst.connectedAt, lastSeenAt: inst.lastSeenAt,
        qrAvailable: this.qr.get(ctx.organizationId, instanceId) !== null,
        worker: { assigned: w.rows[0]?.healthy !== null, healthy: Boolean(w.rows[0]?.healthy) },
      };
    }, ctx, { readOnly: true });
  }

  /** Current QR (API memory only). 404 if none/expired or not this tenant's instance. */
  async getQr(ctx: TenantContext, instanceId: string): Promise<{ qr: string; expiresAt: string }> {
    await this.get(ctx, instanceId); // RLS ownership check first
    const q = this.qr.get(ctx.organizationId, instanceId);
    if (!q) throw new WhatsAppError('WHATSAPP_QR_NOT_AVAILABLE');
    return { qr: q.qr, expiresAt: q.expiresAt.toISOString() };
  }

  /** Validates the command against the current state, then enqueues it for the owning worker. */
  async command(ctx: TenantContext, instanceId: string, command: InstanceCommand, extra: { pairingPhone?: string } = {}): Promise<{ instanceId: string; command: InstanceCommand; accepted: true; status: InstanceStatus }> {
    const pairingPhoneE164 = extra.pairingPhone ? toE164(extra.pairingPhone) : undefined;
    const result = await this.tx.inTenant(async (db) => {
      const inst = await this.load(db, ctx, instanceId, true);
      if (command === 'CONNECT') {
        await this.entitlements.assertSubscriptionActive(db);
        if (inst.status === 'SUSPENDED') throw new WhatsAppError('WHATSAPP_INSTANCE_SUSPENDED');
        if (inst.status === 'CONNECTED') throw new WhatsAppError('WHATSAPP_INSTANCE_ALREADY_CONNECTED');
      }
      if (command === 'RESTART') {
        const creds = await db.query('SELECT 1 FROM app.whatsapp_auth_credentials WHERE instance_id = $1', [instanceId]);
        if (!creds.rowCount) throw new WhatsAppError('WHATSAPP_LOGGED_OUT', 'no linked session; connect and scan a QR code');
      }
      if (command === 'DELETE') {
        await db.query('UPDATE app.whatsapp_instances SET deleted_at = now() WHERE id = $1', [instanceId]);
      }
      await this.ops.enqueueOutbox(db, {
        organizationId: ctx.organizationId, eventType: 'INSTANCE_COMMAND', aggregateType: 'WHATSAPP_INSTANCE', aggregateId: instanceId,
        targetInstanceId: instanceId, payload: { command, instance_id: instanceId, ...(pairingPhoneE164 ? { pairing_phone_e164: pairingPhoneE164 } : {}) },
      });
      await this.ops.audit(db, { organizationId: ctx.organizationId, actorType: ctx.apiKeyId ? 'API_KEY' : 'USER', actorUserId: ctx.userId,
        actorApiKeyId: ctx.apiKeyId, action: `WHATSAPP_INSTANCE_${command}_REQUESTED`, resourceType: 'WHATSAPP_INSTANCE', resourceId: instanceId,
        requestId: ctx.requestId, metadata: { method: pairingPhoneE164 ? 'PAIRING_CODE' : undefined } });
      return { instanceId, command, accepted: true as const, status: inst.status };
    }, ctx);
    await this.bus.wakeOutbox().catch(() => undefined);
    return result;
  }

  /**
   * Pairing-code linking: enqueue CONNECT with the phone, then wait (bounded)
   * for the worker to publish the code on the realtime bus. The code is
   * returned to this caller only and never stored or logged.
   */
  async requestPairingCode(ctx: TenantContext, instanceId: string, phone: string): Promise<{ pairingCode: string; expiresInSeconds: number }> {
    let unsubscribe: () => void = () => undefined;
    const code = new Promise<string>((resolve) => {
      unsubscribe = this.bus.subscribe((e: RealtimeEvent) => {
        if (e.type === 'whatsapp.instance.pairing_code' && e.instanceId === instanceId && e.organizationId === ctx.organizationId) {
          resolve(String(e.data.pairingCode));
        }
      });
    });
    try {
      await this.command(ctx, instanceId, 'CONNECT', { pairingPhone: phone });
      const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new WhatsAppError('WHATSAPP_PAIRING_CODE_UNAVAILABLE')), this.opts.pairingCodeWaitMs));
      return { pairingCode: await Promise.race([code, timeout]), expiresInSeconds: 60 };
    } finally {
      unsubscribe();
    }
  }

}
