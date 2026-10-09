import { decodeCursor, paginate } from '../common/cursor.js';
import type { TenantContext } from '../database/tenant-context.js';
import type { Db, TransactionRunner } from '../database/transaction-runner.js';
import { OpsRepository } from '../repositories/ops.repository.js';
import { WhatsAppError } from '../whatsapp/domain/whatsapp-errors.js';
import type { RealtimeBus } from '../whatsapp/realtime/realtime-bus.js';

export const WEBHOOK_EVENT_CHOICES = ['INSTANCE_CONNECTED', 'INSTANCE_DISCONNECTED', 'INSTANCE_STATUS_CHANGED', 'MESSAGE_RECEIVED', 'MESSAGE_SENT',
  'MESSAGE_DELIVERED', 'MESSAGE_READ', 'MESSAGE_FAILED', 'MESSAGE_REVOKED', 'MESSAGE_REACTION', 'OTP_VERIFIED'] as const;

const ENDPOINT_SQL = `
  SELECT e.id, e.name, e.url, e.business_id, e.instance_id, e.enabled, e.secret_last4, e.has_auth_header, e.consecutive_failures, e.disabled_reason, e.created_at,
         b.name AS business_name, i.instance_name,
         coalesce((SELECT array_agg(s.event_type ORDER BY s.event_type) FROM app.webhook_event_subscriptions s WHERE s.webhook_endpoint_id = e.id), '{}') AS events,
         (SELECT max(d.delivered_at) FROM app.webhook_deliveries d WHERE d.webhook_endpoint_id = e.id AND d.status = 'DELIVERED') AS last_success_at,
         (SELECT max(coalesce(d.last_attempt_at, d.created_at)) FROM app.webhook_deliveries d
           WHERE d.webhook_endpoint_id = e.id AND d.status IN ('RETRYING','FAILED','DEAD')) AS last_failure_at
    FROM app.webhook_endpoints e
    LEFT JOIN app.businesses b ON b.id = e.business_id
    LEFT JOIN app.whatsapp_instances i ON i.id = e.instance_id`;

function toEndpoint(x: Record<string, any>) {
  return {
    id: x.id, name: x.name, url: x.url, enabled: x.enabled, secretLast4: x.secret_last4, hasAuthHeader: x.has_auth_header,
    scope: x.instance_id ? 'INSTANCE' : x.business_id ? 'BUSINESS' : 'ORGANIZATION',
    businessId: x.business_id, businessName: x.business_name, instanceId: x.instance_id, instanceName: x.instance_name,
    events: x.events, consecutiveFailures: x.consecutive_failures, disabledReason: x.disabled_reason,
    lastSuccessAt: x.last_success_at, lastFailureAt: x.last_failure_at, createdAt: x.created_at,
  };
}

const LOG_STATUS = { SUCCESS: ['DELIVERED'], FAILED: ['FAILED', 'DEAD', 'RETRYING'], PENDING: ['PENDING', 'PROCESSING'] } as const;
const LOG_SQL = `
  SELECT d.id, d.status, d.attempt_number, d.http_status, d.latency_ms, d.response_body_truncated, d.error_message, d.created_at, d.last_attempt_at,
         d.delivered_at, d.next_retry_at, d.webhook_endpoint_id, e.name AS endpoint_name, e.url AS endpoint_url,
         ev.id AS event_id, ev.event_type, ev.payload, ev.instance_id, i.instance_name
    FROM app.webhook_deliveries d
    JOIN app.webhook_events ev ON ev.id = d.webhook_event_id
    JOIN app.webhook_endpoints e ON e.id = d.webhook_endpoint_id
    LEFT JOIN app.whatsapp_instances i ON i.id = ev.instance_id`;

function toLog(x: Record<string, any>, full: boolean) {
  return {
    id: x.id, eventId: `evt_${x.event_id}`, eventType: x.event_type, status: x.status, httpStatus: x.http_status, latencyMs: x.latency_ms,
    // attempt_number counts tries; "retries" is everything after the first one
    attempts: x.attempt_number, retries: Math.max(0, x.attempt_number - 1),
    endpoint: { id: x.webhook_endpoint_id, name: x.endpoint_name, url: x.endpoint_url }, instance: x.instance_id ? { id: x.instance_id, name: x.instance_name } : null,
    createdAt: x.created_at, lastAttemptAt: x.last_attempt_at, deliveredAt: x.delivered_at, nextRetryAt: x.next_retry_at,
    error: x.error_message, retryable: ['FAILED', 'DEAD'].includes(x.status),
    ...(full ? { payload: x.payload, responseBodySnippet: x.response_body_truncated } : {}),
  };
}

/** Webhook management for the dashboard (hs_app). The signing secret is never readable here. */
export class DeveloperService {
  private readonly ops = new OpsRepository();
  constructor(private readonly tx: TransactionRunner, private readonly bus: RealtimeBus) {}

  async listWebhooks(ctx: TenantContext) {
    return this.tx.inTenant(async (db) => (await db.query(`${ENDPOINT_SQL} WHERE e.deleted_at IS NULL ORDER BY e.created_at`)).rows.map(toEndpoint), ctx, { readOnly: true });
  }

  async getWebhook(ctx: TenantContext, id: string) {
    const r = await this.tx.inTenant((db) => this.loadEndpoint(db, id), ctx, { readOnly: true });
    return r;
  }

  private async loadEndpoint(db: Db, id: string) {
    const r = await db.query(`${ENDPOINT_SQL} WHERE e.id = $1 AND e.deleted_at IS NULL`, [id]);
    if (!r.rows[0]) throw new WhatsAppError('NOT_FOUND');
    return toEndpoint(r.rows[0]);
  }

  async updateWebhook(ctx: TenantContext, id: string, p: { name?: string; url?: string; enabled?: boolean; eventTypes?: string[] }) {
    return this.tx.inTenant(async (db) => {
      await this.loadEndpoint(db, id);
      await db.query(
        `UPDATE app.webhook_endpoints SET name = coalesce($2, name), url = coalesce($3, url), enabled = coalesce($4, enabled),
                consecutive_failures = CASE WHEN $4 IS TRUE THEN 0 ELSE consecutive_failures END,
                disabled_reason = CASE WHEN $4 IS NOT NULL THEN NULL ELSE disabled_reason END
          WHERE id = $1`, [id, p.name ?? null, p.url ?? null, p.enabled ?? null]);
      if (p.eventTypes) {
        await db.query('DELETE FROM app.webhook_event_subscriptions WHERE webhook_endpoint_id = $1', [id]);
        await db.query(`INSERT INTO app.webhook_event_subscriptions (organization_id, webhook_endpoint_id, event_type)
                        SELECT app.current_org_id(), $1, unnest($2::text[])`, [id, p.eventTypes]);
      }
      await this.ops.audit(db, { organizationId: ctx.organizationId, actorType: ctx.apiKeyId ? 'API_KEY' : 'USER', actorUserId: ctx.userId,
        actorApiKeyId: ctx.apiKeyId, action: 'WEBHOOK_UPDATED', resourceType: 'WEBHOOK_ENDPOINT', resourceId: id, requestId: ctx.requestId,
        metadata: { fields: Object.keys(p), enabled: p.enabled } });
      return this.loadEndpoint(db, id);
    }, ctx);
  }

  async deleteWebhook(ctx: TenantContext, id: string) {
    await this.tx.inTenant(async (db) => {
      await this.loadEndpoint(db, id);
      await db.query('UPDATE app.webhook_endpoints SET deleted_at = now(), enabled = false WHERE id = $1', [id]);
      await this.ops.audit(db, { organizationId: ctx.organizationId, actorType: ctx.apiKeyId ? 'API_KEY' : 'USER', actorUserId: ctx.userId,
        actorApiKeyId: ctx.apiKeyId, action: 'WEBHOOK_DELETED', resourceType: 'WEBHOOK_ENDPOINT', resourceId: id, requestId: ctx.requestId });
    }, ctx);
    return { deleted: true };
  }

  /** Enqueues a synthetic WEBHOOK_TEST event for THIS endpoint only (created by the worker, delivered like any event). */
  async sendTest(ctx: TenantContext, id: string) {
    await this.tx.inTenant(async (db) => {
      const ep = await this.loadEndpoint(db, id);
      if (!ep.enabled) throw new WhatsAppError('CONFLICT', 'Enable the webhook before sending a test event.');
      await this.ops.enqueueOutbox(db, { organizationId: ctx.organizationId, eventType: 'WEBHOOK_TEST_REQUESTED', aggregateType: 'WEBHOOK_ENDPOINT',
        aggregateId: id, payload: { endpoint_id: id } });
    }, ctx);
    await this.bus.wakeOutbox().catch(() => undefined);
    return { queued: true };
  }

  async deliveries(ctx: TenantContext, id: string, q: { cursor?: string; limit: number }) {
    const c = decodeCursor(q.cursor);
    return this.tx.inTenant(async (db) => {
      await this.loadEndpoint(db, id);
      const r = await db.query(
        `SELECT d.id, d.status, d.attempt_number, d.http_status, d.response_body_truncated, d.error_message, d.created_at, d.last_attempt_at,
                d.delivered_at, d.next_retry_at, d.latency_ms, ev.id AS event_id, ev.event_type, ev.payload
           FROM app.webhook_deliveries d JOIN app.webhook_events ev ON ev.id = d.webhook_event_id
          WHERE d.webhook_endpoint_id = $1 AND ($2::timestamptz IS NULL OR (d.created_at, d.id) < ($2, $3::uuid))
          ORDER BY d.created_at DESC, d.id DESC LIMIT $4`, [id, c?.t ?? null, c?.id ?? null, q.limit + 1]);
      const items = r.rows.map((x) => ({
        id: x.id, eventId: `evt_${x.event_id}`, eventType: x.event_type, status: x.status, attempts: x.attempt_number, httpStatus: x.http_status,
        createdAt: x.created_at, lastAttemptAt: x.last_attempt_at, deliveredAt: x.delivered_at, nextRetryAt: x.next_retry_at,
        latencyMs: x.latency_ms, error: x.error_message, responseBodySnippet: x.response_body_truncated, payload: x.payload,
        retryable: ['FAILED', 'DEAD'].includes(x.status),
      }));
      return paginate(items, q.limit, (v) => ({ t: v.createdAt, id: v.id }));
    }, ctx, { readOnly: true });
  }

  /**
   * Webhook Logs: every delivery of the organization, newest first. status: SUCCESS (delivered), FAILED (failed,
   * retrying or given up), PENDING (queued / in flight). The payload is our public envelope (no secrets).
   */
  async webhookLogs(ctx: TenantContext, q: { status?: 'SUCCESS' | 'FAILED' | 'PENDING'; eventType?: string; endpointId?: string; instanceId?: string;
                                             httpStatus?: number; cursor?: string; limit: number }) {
    const c = decodeCursor(q.cursor);
    const statuses = q.status ? LOG_STATUS[q.status] : null;
    return this.tx.inTenant(async (db) => {
      const r = await db.query(
        `${LOG_SQL}
          WHERE ($1::text[] IS NULL OR d.status = ANY($1)) AND ($2::text IS NULL OR ev.event_type = $2) AND ($3::uuid IS NULL OR d.webhook_endpoint_id = $3)
            AND ($4::uuid IS NULL OR ev.instance_id = $4) AND ($5::int IS NULL OR d.http_status = $5)
            AND ($6::timestamptz IS NULL OR (d.created_at, d.id) < ($6, $7::uuid))
          ORDER BY d.created_at DESC, d.id DESC LIMIT $8`,
        [statuses, q.eventType ?? null, q.endpointId ?? null, q.instanceId ?? null, q.httpStatus ?? null, c?.t ?? null, c?.id ?? null, q.limit + 1]);
      return paginate(r.rows.map((x) => toLog(x, false)), q.limit, (v) => ({ t: v.createdAt, id: v.id }));
    }, ctx, { readOnly: true });
  }

  async webhookLog(ctx: TenantContext, id: string) {
    return this.tx.inTenant(async (db) => {
      const x = (await db.query(`${LOG_SQL} WHERE d.id = $1`, [id])).rows[0];
      if (!x) throw new WhatsAppError('NOT_FOUND');
      return toLog(x, true);
    }, ctx, { readOnly: true });
  }

  async retryLog(ctx: TenantContext, id: string) {
    const endpointId = await this.tx.inTenant(async (db) => (await db.query('SELECT webhook_endpoint_id FROM app.webhook_deliveries WHERE id = $1', [id])).rows[0]?.webhook_endpoint_id,
      ctx, { readOnly: true });
    if (!endpointId) throw new WhatsAppError('NOT_FOUND');
    return this.retryDelivery(ctx, endpointId, id);
  }

  /** Manual re-delivery of a failed delivery (uses hs_app's narrow UPDATE(status, next_retry_at) grant). */
  async retryDelivery(ctx: TenantContext, endpointId: string, deliveryId: string) {
    await this.tx.inTenant(async (db) => {
      await this.loadEndpoint(db, endpointId);
      const r = await db.query(
        `UPDATE app.webhook_deliveries SET status = 'RETRYING', next_retry_at = now()
          WHERE id = $1 AND webhook_endpoint_id = $2 AND status IN ('FAILED','DEAD')`, [deliveryId, endpointId]);
      if (!r.rowCount) throw new WhatsAppError('CONFLICT', 'Only failed deliveries can be retried.');
      await this.ops.audit(db, { organizationId: ctx.organizationId, actorType: 'USER', actorUserId: ctx.userId, action: 'WEBHOOK_DELIVERY_RETRIED',
        resourceType: 'WEBHOOK_ENDPOINT', resourceId: endpointId, requestId: ctx.requestId });
    }, ctx);
    return { queued: true };
  }
}
