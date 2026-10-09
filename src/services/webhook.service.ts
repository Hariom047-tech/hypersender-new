import { createHmac, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { uuidv7 } from '../common/uuid.js';
import type { TenantContext } from '../database/tenant-context.js';
import type { TransactionRunner } from '../database/transaction-runner.js';
import { OpsRepository } from '../repositories/ops.repository.js';
import { WebhookRepository } from '../repositories/webhook.repository.js';
import { aad, aesGcmDecrypt, aesGcmEncrypt } from '../security/crypto/aes-gcm.js';
import { KEY_PROVIDER, type KeyProvider } from '../security/crypto/key-provider.js';
import { WhatsAppError } from '../whatsapp/domain/whatsapp-errors.js';
import { EntitlementService } from './entitlement.service.js';

export interface HttpSender {
  post(url: string, body: string, headers: Record<string, string>): Promise<{ status: number; body: string }>;
}

function secretContext(organizationId: string, endpointId: string) {
  return { organization_id: organizationId, purpose: 'webhook_secret', resource_id: endpointId };
}
function authHeaderContext(organizationId: string, endpointId: string) {
  return { organization_id: organizationId, purpose: 'webhook_auth_header', resource_id: endpointId };
}

/**
 * WEBHOOK STRATEGY
 *  create     (API, hs_app): endpoint + subscriptions + audit in one tx; secret
 *             encrypted with a KMS-wrapped per-endpoint key, returned once.
 *  fan-out    (worker, tenant tx): outbox event -> webhook_events (idempotent) ->
 *             webhook_deliveries per resolved endpoint (idempotent).
 *  dispatch   (worker): claim due deliveries across tenants (SKIP LOCKED), then
 *             for each: tenant tx to read endpoint/payload -> HTTP POST with no tx
 *             open -> tenant tx to record the outcome (only if still the owner).
 */
@Injectable()
export class WebhookService {
  constructor(
    private readonly tx: TransactionRunner,
    private readonly webhooks: WebhookRepository,
    private readonly ops: OpsRepository,
    @Inject(KEY_PROVIDER) private readonly keys: KeyProvider,
  ) {}

  async createEndpoint(ctx: TenantContext, input: { name: string; url: string; businessId?: string; instanceId?: string; eventTypes: string[] }): Promise<{ id: string; secret: string }> {
    const id = uuidv7();
    const secret = `whsec_${randomBytes(32).toString('base64url')}`;
    const dek = await this.keys.generateDataKey(secretContext(ctx.organizationId, id));
    try {
      const ciphertext = aesGcmEncrypt(dek.plaintext, Buffer.from(secret, 'utf8'), aad('webhook-secret', 'v1', ctx.organizationId, id));
      await this.tx.inTenant(async (db) => {
        await new EntitlementService().assertCanAdd(db, 'WEBHOOKS');
        await this.webhooks.insertEndpoint(db, {
          id, organizationId: ctx.organizationId, businessId: input.businessId, instanceId: input.instanceId, name: input.name, url: input.url,
          secretCiphertext: ciphertext, secretWrappedKey: dek.wrapped, secretKeyReference: dek.keyReference, secretLast4: secret.slice(-4),
          createdByUserId: ctx.userId,
        });
        await this.webhooks.insertSubscriptions(db, ctx.organizationId, id, input.eventTypes);
        await this.ops.audit(db, { organizationId: ctx.organizationId, actorType: ctx.apiKeyId ? 'API_KEY' : 'USER', actorUserId: ctx.userId,
          actorApiKeyId: ctx.apiKeyId, action: 'WEBHOOK_CREATED', resourceType: 'WEBHOOK_ENDPOINT', resourceId: id,
          metadata: { url: input.url, event_types: input.eventTypes } });
      }, ctx);
    } finally {
      dek.plaintext.fill(0);
    }
    return { id, secret };
  }

  /**
   * Optional static Authorization header value sent with every delivery (for receivers that check a shared
   * token instead of the HMAC signature). Encrypted like the signing secret; null removes it.
   */
  async setAuthHeader(ctx: TenantContext, endpointId: string, value: string | null): Promise<void> {
    let enc: { ciphertext: Buffer; wrapped: Buffer; ref: string } | null = null;
    if (value) {
      const dek = await this.keys.generateDataKey(authHeaderContext(ctx.organizationId, endpointId));
      try {
        enc = { ciphertext: aesGcmEncrypt(dek.plaintext, Buffer.from(value, 'utf8'), aad('webhook-auth-header', 'v1', ctx.organizationId, endpointId)),
                wrapped: dek.wrapped, ref: dek.keyReference };
      } finally {
        dek.plaintext.fill(0);
      }
    }
    await this.tx.inTenant(async (db) => {
      const r = await db.query(
        `UPDATE app.webhook_endpoints SET auth_header_ciphertext = $2, auth_header_wrapped_key = $3, auth_header_key_reference = $4
          WHERE id = $1 AND deleted_at IS NULL`, [endpointId, enc?.ciphertext ?? null, enc?.wrapped ?? null, enc?.ref ?? null]);
      if (!r.rowCount) throw new WhatsAppError('NOT_FOUND');
      await this.ops.audit(db, { organizationId: ctx.organizationId, actorType: ctx.apiKeyId ? 'API_KEY' : 'USER', actorUserId: ctx.userId,
        actorApiKeyId: ctx.apiKeyId, action: 'WEBHOOK_UPDATED', resourceType: 'WEBHOOK_ENDPOINT', resourceId: endpointId,
        metadata: { fields: ['authorizationHeader'], set: Boolean(value) } });
    }, ctx);
  }

  async fanOut(organizationId: string, e: { eventType: string; businessId: string | null; instanceId: string | null; resourceType: string;
                                            resourceId: string | null; payload: object; idempotencyKey: string }): Promise<number> {
    return this.tx.inTenant(async (db) => {
      const eventId = await this.webhooks.insertEvent(db, { organizationId, ...e });
      if (!eventId) return 0; // already fanned out
      return this.webhooks.createDeliveriesForEvent(db, organizationId, eventId, e.eventType, e.businessId, e.instanceId);
    }, { organizationId });
  }

  /** Optional hook (worker): called when a delivery exhausts its retries. */
  onDead?: (organizationId: string, endpointId: string) => Promise<void>;

  async dispatchBatch(workerId: string, http: HttpSender, limit = 50): Promise<number> {
    const claimed = await this.tx.run({}, (db) => this.webhooks.claimDue(db, workerId, limit));
    for (const d of claimed) {
      const ctx = { organizationId: d.organizationId };
      const target = await this.tx.inTenant(async (db) => {
        const endpoint = await this.webhooks.getEndpointForDelivery(db, d.webhookEndpointId);
        const ev = await db.query('SELECT id, event_type, payload, created_at FROM app.webhook_events WHERE id = $1', [d.webhookEventId]);
        return endpoint && ev.rows[0] ? { endpoint, event: ev.rows[0] } : null;
      }, ctx);

      let outcome: { delivered: boolean; httpStatus?: number; responseBody?: string; error?: string; latencyMs?: number };
      if (!target || !target.endpoint.enabled) {
        outcome = { delivered: false, error: 'ENDPOINT_DISABLED' };
      } else {
        const dek = await this.keys.decryptDataKey(target.endpoint.secretWrappedKey, target.endpoint.secretKeyReference,
          secretContext(d.organizationId, d.webhookEndpointId));
        const secret = aesGcmDecrypt(dek, target.endpoint.secretCiphertext, aad('webhook-secret', 'v1', d.organizationId, d.webhookEndpointId));
        dek.fill(0);
        // Public envelope (docs/webhook-events.md). Signature scheme:
        //   X-Webhook-Signature: v1=<hex HMAC-SHA256(secret, "<X-Webhook-Id>.<X-Webhook-Timestamp>.<raw body>")>
        // where `secret` is the UTF-8 endpoint secret ("whsec_..."). Receivers must
        // compare in constant time and reject timestamps older than 5 minutes.
        const webhookId = `evt_${target.event.id}`;
        const body = JSON.stringify({ id: webhookId, type: target.event.event_type, createdAt: target.event.created_at, ...target.event.payload });
        const ts = Math.floor(Date.now() / 1000).toString();
        const signature = createHmac('sha256', secret).update(`${webhookId}.${ts}.${body}`).digest('hex');
        secret.fill(0);
        const headers: Record<string, string> = {
          'content-type': 'application/json', 'user-agent': 'HyperSender-Webhooks/1',
          'x-webhook-id': webhookId, 'x-webhook-timestamp': ts, 'x-webhook-signature': `v1=${signature}`,
        };
        const ah = target.endpoint.authHeader;
        if (ah) {
          const adek = await this.keys.decryptDataKey(ah.wrappedKey, ah.keyReference, authHeaderContext(d.organizationId, d.webhookEndpointId));
          const value = aesGcmDecrypt(adek, ah.ciphertext, aad('webhook-auth-header', 'v1', d.organizationId, d.webhookEndpointId));
          adek.fill(0);
          headers.authorization = value.toString('utf8');
          value.fill(0);
        }
        const started = performance.now();
        try {
          const res = await http.post(target.endpoint.url, body, headers);
          outcome = { delivered: res.status >= 200 && res.status < 300, httpStatus: res.status, responseBody: res.body.slice(0, 4096),
                      latencyMs: Math.round(performance.now() - started) };
        } catch (err) {
          outcome = { delivered: false, error: (err as Error).message, latencyMs: Math.round(performance.now() - started) };
        }
      }
      const final = await this.tx.inTenant((db) => this.webhooks.recordOutcome(db, { id: d.id, workerId, ...outcome }), ctx);
      if (final === 'DEAD' && this.onDead) await this.onDead(d.organizationId, d.webhookEndpointId).catch(() => undefined);
    }
    return claimed.length;
  }
}
