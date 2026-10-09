import { randomUUID } from 'node:crypto';
import { WindowRateLimiter } from '../../common/concurrency.js';
import { uuidv7 } from '../../common/uuid.js';
import type { TenantContext } from '../../database/tenant-context.js';
import type { Db, TransactionRunner } from '../../database/transaction-runner.js';
import { MessagingRepository } from '../../repositories/messaging.repository.js';
import { OutboundMessageService } from '../../services/outbound-message.service.js';
import { assertBusinessScope, assertInstanceScope } from '../../api/auth/permissions.js';
import { e164ToUserJid, toE164 } from '../domain/phone.js';
import { WhatsAppError } from '../domain/whatsapp-errors.js';
import type { MediaStorageService } from '../media/media-storage.service.js';
import type { RealtimeBus } from '../realtime/realtime-bus.js';
import { buildMessagePayload } from './whatsapp-webhook-bridge.js';
import { isUuid } from '../../common/uuid.js';
import { loadConversationView, loadMessageView, type MessageView } from '../../api/views.js';
import { REALTIME_TEXT_LIMIT } from './app-events-bridge.js';

const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const DOCUMENT_MIME = new Set(['application/pdf', 'text/plain', 'text/csv', 'application/zip',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation']);

export interface SendCommon { instanceId: string; to: string; idempotencyKey?: string }

/**
 * API-side messaging. Sends are QUEUED in one transaction (message row +
 * routed outbox event) and returned immediately (202); the owning gateway
 * worker delivers them. Status is observable via GET /messages/:id and webhooks.
 */
export class WhatsAppMessageService {
  private readonly limiter: WindowRateLimiter;

  constructor(
    private readonly tx: TransactionRunner,
    private readonly messaging: MessagingRepository,
    private readonly outbound: OutboundMessageService,
    private readonly media: MediaStorageService,
    private readonly bus: RealtimeBus,
    private readonly opts: { ratePerMinute: number; mediaMaxBytes: number },
  ) {
    this.limiter = new WindowRateLimiter(opts.ratePerMinute, 60_000);
  }

  private rateLimit(ctx: TenantContext): void {
    const key = ctx.apiKeyId ? `k:${ctx.apiKeyId}` : `u:${ctx.organizationId}:${ctx.userId}`;
    if (!this.limiter.tryAcquire(key)) throw new WhatsAppError('WHATSAPP_RATE_LIMITED');
  }

  /** Validates the instance (tenant, business scope, CONNECTED) and resolves recipient contact + conversation. */
  private async prepare(db: Db, ctx: TenantContext, input: SendCommon): Promise<{ conversationId: string }> {
    const r = await db.query(
      `SELECT i.id, i.business_id, i.status, i.whatsapp_jid, b.country_code
         FROM app.whatsapp_instances i JOIN app.businesses b ON b.id = i.business_id
        WHERE i.id = $1 AND i.deleted_at IS NULL FOR SHARE OF i`, [input.instanceId]);
    const inst = r.rows[0];
    if (!inst) throw new WhatsAppError('WHATSAPP_INSTANCE_NOT_FOUND');
    assertBusinessScope(ctx, inst.business_id);
    assertInstanceScope(ctx, inst.id);
    if (inst.status !== 'CONNECTED' || !inst.whatsapp_jid) throw new WhatsAppError('WHATSAPP_INSTANCE_NOT_CONNECTED');

    const e164 = toE164(input.to, inst.country_code ?? undefined);
    const jid = e164ToUserJid(e164);
    const contactId = await this.messaging.resolveContact(db, {
      organizationId: ctx.organizationId, businessId: inst.business_id, jid, lid: null, phoneE164: e164, seenAt: new Date(), source: 'API' });
    const conv = await this.messaging.upsertOpenConversation(db, {
      organizationId: ctx.organizationId, businessId: inst.business_id, instanceId: inst.id, contactId });
    return { conversationId: conv.id };
  }

  /** Publishes the (QUEUED) message + updated conversation to the org's realtime stream. */
  private async publishQueued(ctx: TenantContext, messageId: string): Promise<MessageView | null> {
    const loaded = await this.tx.inTenant(async (db) => {
      const message = await loadMessageView(db, messageId, REALTIME_TEXT_LIMIT);
      return message ? { message, conversation: await loadConversationView(db, message.conversationId) } : null;
    }, ctx, { readOnly: true });
    if (!loaded) return null;
    const base = { organizationId: ctx.organizationId, businessId: loaded.message.businessId, instanceId: loaded.message.instanceId, at: new Date().toISOString() };
    await this.bus.publish({ ...base, type: 'message.created', data: { message: loaded.message } }).catch(() => undefined);
    if (loaded.conversation) await this.bus.publish({ ...base, type: 'conversation.updated', data: { conversation: loaded.conversation } }).catch(() => undefined);
    return loaded.message;
  }

  /**
   * Inbox reply: sends to the conversation's own contact through the
   * conversation's own instance (works for LID-only contacts too).
   * `clientRequestId` (UUID generated by the browser per compose action) is the
   * idempotency key: double clicks / network retries return the same message.
   */
  async sendToConversation(ctx: TenantContext, conversationId: string, input: { text: string; clientRequestId: string }): Promise<{ message: MessageView; duplicate: boolean }> {
    if (!isUuid(input.clientRequestId)) throw new WhatsAppError('VALIDATION_FAILED', 'clientRequestId must be a UUID');
    this.rateLimit(ctx);
    const res = await this.tx.inTenant(async (db) => {
      const r = await db.query(
        `SELECT c.business_id, i.status, i.whatsapp_jid FROM app.conversations c JOIN app.whatsapp_instances i ON i.id = c.whatsapp_instance_id
          WHERE c.id = $1 AND i.deleted_at IS NULL FOR SHARE OF i`, [conversationId]);
      const x = r.rows[0];
      if (!x) throw new WhatsAppError('NOT_FOUND');
      assertBusinessScope(ctx, x.business_id);
      if (x.status !== 'CONNECTED' || !x.whatsapp_jid) throw new WhatsAppError('WHATSAPP_INSTANCE_NOT_CONNECTED');
      await db.query(`UPDATE app.conversations SET status = 'OPEN' WHERE id = $1 AND status = 'RESOLVED'`, [conversationId]);
      return this.outbound.enqueueTextInTx(db, { conversationId, text: input.text, idempotencyKey: `ui:${input.clientRequestId}`,
        sentByUserId: ctx.userId ?? null, origin: ctx.apiKeyId ? 'API' : 'DASHBOARD' });
    }, ctx);
    await this.bus.wakeOutbox().catch(() => undefined);
    const message = res.duplicate
      ? (await this.tx.inTenant((db) => loadMessageView(db, res.messageId), ctx, { readOnly: true }))!
      : (await this.publishQueued(ctx, res.messageId))!;
    return { message, duplicate: res.duplicate };
  }

  async sendText(ctx: TenantContext, input: SendCommon & { text: string }): Promise<{ messageId: string; status: 'QUEUED'; duplicate: boolean }> {
    this.rateLimit(ctx);
    const res = await this.tx.inTenant(async (db) => {
      const { conversationId } = await this.prepare(db, ctx, input);
      return this.outbound.enqueueTextInTx(db, {
        conversationId, text: input.text, idempotencyKey: input.idempotencyKey ?? `api:${randomUUID()}`,
        sentByUserId: ctx.userId ?? null, origin: ctx.apiKeyId ? 'API' : 'DASHBOARD',
      });
    }, ctx);
    await this.bus.wakeOutbox().catch(() => undefined);
    if (!res.duplicate) await this.publishQueued(ctx, res.messageId);
    return { messageId: res.messageId, status: 'QUEUED', duplicate: res.duplicate };
  }

  async sendMedia(ctx: TenantContext, type: 'IMAGE' | 'DOCUMENT',
                  input: SendCommon & { dataBase64: string; mimeType: string; fileName?: string; caption?: string }): Promise<{ messageId: string; status: 'QUEUED'; duplicate: boolean }> {
    this.rateLimit(ctx);
    const mime = input.mimeType.toLowerCase();
    if (!(type === 'IMAGE' ? IMAGE_MIME : DOCUMENT_MIME).has(mime)) throw new WhatsAppError('WHATSAPP_UNSUPPORTED_MESSAGE', `unsupported ${type.toLowerCase()} type`);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(input.dataBase64)) throw new WhatsAppError('VALIDATION_FAILED', 'dataBase64 is not valid base64');
    const data = Buffer.from(input.dataBase64, 'base64');
    if (data.length === 0) throw new WhatsAppError('VALIDATION_FAILED', 'empty media');
    if (data.length > this.opts.mediaMaxBytes) throw new WhatsAppError('WHATSAPP_MEDIA_TOO_LARGE');

    // Upload first (no DB tx held during I/O). Orphaned objects from a failed
    // enqueue are unreferenced and removed by storage lifecycle rules.
    const attachmentId = uuidv7();
    const stored = await this.media.put(`org/${ctx.organizationId}/out/${attachmentId}/${attachmentId}`, data, mime);
    const res = await this.tx.inTenant(async (db) => {
      const { conversationId } = await this.prepare(db, ctx, input);
      return this.outbound.enqueueMediaInTx(db, {
        conversationId, type, caption: input.caption ?? null, idempotencyKey: input.idempotencyKey ?? `api:${randomUUID()}`,
        sentByUserId: ctx.userId ?? null, origin: ctx.apiKeyId ? 'API' : 'DASHBOARD',
        attachment: { id: attachmentId, storageProvider: stored.storageProvider, storageKey: stored.storageKey, mimeType: mime,
                      fileName: input.fileName ?? null, size: stored.size, sha256: stored.sha256 },
      });
    }, ctx);
    await this.bus.wakeOutbox().catch(() => undefined);
    if (!res.duplicate) await this.publishQueued(ctx, res.messageId);
    return { messageId: res.messageId, status: 'QUEUED', duplicate: res.duplicate };
  }

  /** Normalised message view (same schema as webhook payloads). RLS => other tenants' ids are 404. */
  async get(ctx: TenantContext, messageId: string): Promise<Record<string, unknown>> {
    return this.tx.inTenant(async (db) => {
      const built = await buildMessagePayload(db, messageId);
      if (!built) throw new WhatsAppError('WHATSAPP_MESSAGE_NOT_FOUND');
      assertBusinessScope(ctx, built.businessId);
      assertInstanceScope(ctx, built.instanceId);
      return { businessId: built.businessId, ...built.body };
    }, ctx, { readOnly: true });
  }
}
