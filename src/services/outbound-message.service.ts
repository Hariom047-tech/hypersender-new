import { Injectable } from '@nestjs/common';
import { uuidv7 } from '../common/uuid.js';
import type { DbContext } from '../database/tenant-context.js';
import type { Db, TransactionRunner } from '../database/transaction-runner.js';
import { MessagingRepository, type MessageType, type OutboundStatus } from '../repositories/messaging.repository.js';
import { OpsRepository } from '../repositories/ops.repository.js';

export interface EnqueueTextInput {
  conversationId: string;
  text: string;
  idempotencyKey: string;
  aiAgentId?: string | null;
  sentByUserId?: string | null;
  replyToMessageId?: string | null;
  origin?: 'API' | 'DASHBOARD' | 'AI' | 'SYSTEM';
}

export interface EnqueueMediaInput {
  conversationId: string;
  type: Extract<MessageType, 'IMAGE' | 'DOCUMENT' | 'AUDIO' | 'VIDEO'>;
  caption?: string | null;
  idempotencyKey: string;
  sentByUserId?: string | null;
  origin?: 'API' | 'DASHBOARD' | 'SYSTEM';
  /** Already uploaded to private media storage by the caller. */
  attachment: { id: string; storageProvider: string; storageKey: string; mimeType: string; fileName?: string | null; size: number; sha256: Buffer };
}

/**
 * OUTGOING MESSAGE STRATEGY (short transactions around the network call):
 *   T1 enqueue:   INSERT message QUEUED (dedup by idempotency key)
 *                 + outbox MESSAGE_SEND_REQUESTED routed to the instance's
 *                   lease-holding worker (target_instance_id)          COMMIT
 *   --- gateway worker (no tx open) ---
 *   T2 pre-assign provider message id (so the provider's own echo is recognised)
 *   send via provider
 *   T3 markSent: status SENT (never downgrades a raced receipt), status event,
 *                conversation touch, outbox MESSAGE_SENT, usage OUT   COMMIT
 * A crash after T2 retries with the SAME provider message id, so WhatsApp
 * de-duplicates and T3 is replayed idempotently.
 */
@Injectable()
export class OutboundMessageService {
  constructor(
    private readonly tx: TransactionRunner,
    private readonly messaging: MessagingRepository,
    private readonly ops: OpsRepository,
  ) {}

  async enqueueText(ctx: DbContext, input: EnqueueTextInput): Promise<{ messageId: string; duplicate: boolean }> {
    return this.tx.inTenant((db) => this.enqueueTextInTx(db, input), ctx);
  }

  /** Composable variant used inside other transactions (e.g. AI completion, API send). */
  async enqueueTextInTx(db: Db, input: EnqueueTextInput): Promise<{ messageId: string; duplicate: boolean }> {
    return this.enqueueInTx(db, input.conversationId, input.idempotencyKey, {
      type: 'TEXT', textBody: input.text, isAiGenerated: Boolean(input.aiAgentId), aiAgentId: input.aiAgentId,
      sentByUserId: input.sentByUserId, replyToMessageId: input.replyToMessageId, origin: input.origin,
    });
  }

  async enqueueMediaInTx(db: Db, input: EnqueueMediaInput): Promise<{ messageId: string; duplicate: boolean }> {
    return this.enqueueInTx(db, input.conversationId, input.idempotencyKey, {
      type: input.type, textBody: input.caption ?? null, isAiGenerated: false, sentByUserId: input.sentByUserId, origin: input.origin,
    }, input.attachment);
  }

  private async enqueueInTx(db: Db, conversationId: string, idempotencyKey: string,
                            body: { type: MessageType; textBody: string | null; isAiGenerated: boolean; aiAgentId?: string | null;
                                    sentByUserId?: string | null; replyToMessageId?: string | null; origin?: EnqueueTextInput['origin'] },
                            attachment?: EnqueueMediaInput['attachment']): Promise<{ messageId: string; duplicate: boolean }> {
    const conv = await this.messaging.getConversationForSend(db, conversationId);
    if (!conv) throw new Error('conversation not found'); // RLS makes other tenants' conversations invisible
    if (!conv.instanceJid) throw new Error('WhatsApp instance is not paired yet');

    const id = await this.messaging.insertQueuedOutbound(db, {
      id: uuidv7(), organizationId: conv.organizationId, businessId: conv.businessId, instanceId: conv.instanceId,
      conversationId: conv.id, contactId: conv.contactId, senderJid: conv.instanceJid, recipientJid: conv.contactJid,
      type: body.type, textBody: body.textBody, idempotencyKey, isAiGenerated: body.isAiGenerated,
      aiAgentId: body.aiAgentId, sentByUserId: body.sentByUserId, replyToMessageId: body.replyToMessageId, origin: body.origin,
    });
    if (!id) {
      return { messageId: (await this.messaging.findByIdempotencyKey(db, idempotencyKey))!, duplicate: true };
    }
    if (attachment) {
      await db.query(
        `INSERT INTO app.message_attachments (id, organization_id, message_id, media_type, mime_type, file_name, file_size,
                                              storage_provider, storage_key, sha256, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'STORED')`,
        [attachment.id, conv.organizationId, id, body.type, attachment.mimeType, attachment.fileName ?? null, attachment.size,
         attachment.storageProvider, attachment.storageKey, attachment.sha256]);
    }
    await this.ops.enqueueOutbox(db, {
      organizationId: conv.organizationId, eventType: 'MESSAGE_SEND_REQUESTED', aggregateType: 'MESSAGE', aggregateId: id,
      payload: { message_id: id, instance_id: conv.instanceId }, dedupeKey: `send:${id}`, targetInstanceId: conv.instanceId,
    });
    return { messageId: id, duplicate: false };
  }

  async markSent(organizationId: string, messageId: string, providerMessageId: string, providerTimestamp: Date): Promise<boolean> {
    return this.tx.inTenant(async (db) => {
      const res = await this.messaging.markSent(db, messageId, providerMessageId, providerTimestamp);
      if (!res) return false; // already recorded (replay) or FAILED
      await this.messaging.insertStatusEvent(db, { organizationId, messageId, status: 'SENT', providerTimestamp });
      await this.messaging.touchConversationOutbound(db, res.conversationId, providerTimestamp);
      await this.ops.enqueueOutbox(db, { organizationId, eventType: 'MESSAGE_SENT', aggregateType: 'MESSAGE', aggregateId: messageId,
        payload: { message_id: messageId }, dedupeKey: `msg-sent:${messageId}` });
      await this.ops.recordUsage(db, { organizationId, businessId: res.businessId, eventType: 'WHATSAPP_MESSAGE_OUT', quantity: 1, resourceType: 'MESSAGE',
        resourceId: messageId, idempotencyKey: `msg-out:${messageId}` });
      return true;
    }, { organizationId });
  }

  /** QUEUED -> FAILED (once) + status event + outbox MESSAGE_FAILED. */
  async markFailed(organizationId: string, messageId: string, errorCode: string, errorMessage: string): Promise<boolean> {
    return this.tx.inTenant(async (db) => {
      if (!(await this.messaging.markFailed(db, messageId, errorCode, errorMessage))) return false;
      await this.messaging.insertStatusEvent(db, { organizationId, messageId, status: 'FAILED', providerTimestamp: null });
      await this.ops.enqueueOutbox(db, { organizationId, eventType: 'MESSAGE_FAILED', aggregateType: 'MESSAGE', aggregateId: messageId,
        payload: { message_id: messageId, error_code: errorCode }, dedupeKey: `msg-failed:${messageId}` });
      return true;
    }, { organizationId });
  }

  /** Delivery/read/revoke receipts: forward-only, duplicate-safe. */
  async applyReceipt(organizationId: string, instanceId: string, providerMessageId: string, status: OutboundStatus, at: Date): Promise<boolean> {
    return this.tx.inTenant(async (db) => {
      const msg = await this.messaging.advanceStatusByProviderId(db, instanceId, providerMessageId, status);
      if (!msg) return false;
      await this.messaging.insertStatusEvent(db, { organizationId, messageId: msg.id, status, providerTimestamp: at });
      await this.ops.enqueueOutbox(db, { organizationId, eventType: `MESSAGE_${status}`, aggregateType: 'MESSAGE', aggregateId: msg.id,
        payload: { message_id: msg.id }, dedupeKey: `msg-${status.toLowerCase()}:${msg.id}` });
      return true;
    }, { organizationId });
  }
}
