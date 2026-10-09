import { Inject, Injectable } from '@nestjs/common';
import { recordKeywordPreference } from '../marketing/consent.js';
import { uuidv7 } from '../common/uuid.js';
import { TransactionRunner, WORKER_TX } from '../database/transaction-runner.js';
import { MessagingRepository, type MessageType } from '../repositories/messaging.repository.js';
import { OpsRepository } from '../repositories/ops.repository.js';
import { verifyOtpLink } from '../otp/otp-inbound.js';
import { OutboundMessageService } from './outbound-message.service.js';

/** Normalised, provider-agnostic message produced by the gateway (Baileys adapter). */
export interface InboundWhatsAppMessage {
  organizationId: string;   // from the instance row the worker holds the lease for - never from the payload
  businessId: string;
  instanceId: string;
  instanceJid: string;
  providerMessageId: string;
  /** The contact's JID (for fromMe messages: the RECIPIENT contact). */
  fromJid: string;
  fromLid?: string | null;
  fromPhoneE164?: string | null;
  pushName?: string | null;
  /** true = typed on the owner's phone / another linked device (stored OUTBOUND, never re-sent). */
  fromMe?: boolean;
  type: MessageType;
  text?: string | null;
  providerTimestamp: Date;
  quotedProviderMessageId?: string | null;
  reactionTargetProviderMessageId?: string | null;
  attachments?: Array<{ mediaType: string; mimeType: string; fileName?: string | null; fileSize?: number | null }>;
  rawMetadata?: object | null; // already stripped of media keys / secrets by the adapter
}

export interface IngestResult {
  status: 'CREATED' | 'DUPLICATE';
  messageId: string;
  conversationId: string;
  attachments: Array<{ id: string; storageKey: string }>;
}

@Injectable()
export class MessageIngestionService {
  constructor(
    @Inject(WORKER_TX) private readonly tx: TransactionRunner,
    @Inject(MessagingRepository) private readonly messaging: MessagingRepository,
    @Inject(OpsRepository) private readonly ops: OpsRepository,
  ) {}

  private readonly storageProvider = process.env.MEDIA_STORAGE_PROVIDER ?? 'S3';
  private get outbound(): OutboundMessageService { return new OutboundMessageService(this.tx, this.messaging, this.ops); }

  /**
   * MESSAGE OBSERVATION TRANSACTION (single, short, no network I/O):
   *   1. resolve/create contact (by PN JID, or by LID when only the LID is known)
   *   2. resolve/create the open conversation
   *   3. insert message ON CONFLICT (instance, provider_message_id) DO NOTHING
   *        -> duplicate (redelivery, or the echo of a message WE sent): stop,
   *           return DUPLICATE - no counters, no events, no usage, no send
   *   4. conversation timestamps (+ unread for real inbound messages)
   *   5. attachment metadata rows (bytes are fetched after commit, best effort)
   *   6. outbox event: MESSAGE_RECEIVED | MESSAGE_SENT (fromMe) | MESSAGE_REACTION
   *   7. usage WHATSAPP_MESSAGE_IN for inbound contact messages
   * COMMIT. Webhooks / AI run asynchronously and can never block or roll back
   * ingestion. fromMe messages NEVER create a send job.
   */
  async ingest(m: InboundWhatsAppMessage): Promise<IngestResult> {
    const fromMe = Boolean(m.fromMe);
    const isReaction = m.type === 'REACTION';
    return this.tx.inTenant(async (db) => {
      const contactId = await this.messaging.resolveContact(db, {
        organizationId: m.organizationId, businessId: m.businessId, jid: m.fromJid, lid: m.fromLid ?? null,
        phoneE164: m.fromPhoneE164, profileName: fromMe ? null : m.pushName, seenAt: m.providerTimestamp,
        source: fromMe ? 'WHATSAPP_OUTBOUND' : 'WHATSAPP_INBOUND',
      });
      const conversation = await this.messaging.upsertOpenConversation(db, {
        organizationId: m.organizationId, businessId: m.businessId, instanceId: m.instanceId, contactId,
      });

      const referenced = m.reactionTargetProviderMessageId ?? m.quotedProviderMessageId ?? null;
      const replyToMessageId = referenced ? await this.messaging.findMessageIdByProviderId(db, m.instanceId, referenced) : null;

      const messageId = await this.messaging.insertObservedMessage(db, {
        id: uuidv7(), organizationId: m.organizationId, businessId: m.businessId, instanceId: m.instanceId,
        conversationId: conversation.id, contactId, providerMessageId: m.providerMessageId,
        direction: fromMe ? 'OUTBOUND' : 'INBOUND',
        senderJid: fromMe ? m.instanceJid : m.fromJid, recipientJid: fromMe ? m.fromJid : m.instanceJid,
        type: m.type, textBody: m.text ?? null, providerTimestamp: m.providerTimestamp,
        replyToMessageId, origin: fromMe ? 'LINKED_DEVICE' : 'CONTACT', rawMetadata: m.rawMetadata ?? null,
      });
      if (!messageId) {
        const existing = await this.messaging.findMessageIdByProviderId(db, m.instanceId, m.providerMessageId);
        return { status: 'DUPLICATE', messageId: existing!, conversationId: conversation.id, attachments: [] };
      }

      let otpRequestId: string | null = null;
      if (fromMe) {
        await this.messaging.touchConversationOutbound(db, conversation.id, m.providerTimestamp);
        await this.messaging.insertStatusEvent(db, { organizationId: m.organizationId, messageId, status: 'SENT', providerTimestamp: m.providerTimestamp });
      } else if (!isReaction) {
        await this.messaging.touchConversationInbound(db, conversation.id, m.providerTimestamp);
        // "STOP" / "START" replies change marketing consent.
        await recordKeywordPreference(db, { organizationId: m.organizationId, businessId: m.businessId, contactId, text: m.text });
        // "Login by WhatsApp": the contact sent the code of a pending OTP link.
        otpRequestId = await verifyOtpLink(db, { ops: this.ops, outbound: this.outbound }, {
          organizationId: m.organizationId, businessId: m.businessId, instanceId: m.instanceId, conversationId: conversation.id, messageId,
          fromPhoneE164: m.fromPhoneE164 ?? null, text: m.type === 'TEXT' ? m.text : null });
      }

      const attachments: IngestResult['attachments'] = [];
      for (const a of m.attachments ?? []) {
        const attachmentId = uuidv7();
        const storageKey = `org/${m.organizationId}/msg/${messageId}/${attachmentId}`;
        await this.messaging.insertAttachment(db, {
          id: attachmentId, organizationId: m.organizationId, messageId, mediaType: a.mediaType, mimeType: a.mimeType, fileName: a.fileName,
          fileSize: a.fileSize, storageProvider: this.storageProvider, storageKey,
        });
        attachments.push({ id: attachmentId, storageKey });
      }

      const eventType = isReaction ? 'MESSAGE_REACTION' : fromMe ? 'MESSAGE_SENT' : 'MESSAGE_RECEIVED';
      await this.ops.enqueueOutbox(db, {
        organizationId: m.organizationId, eventType, aggregateType: 'MESSAGE', aggregateId: messageId,
        // otp_request_id: the message was a WhatsApp login, already answered - the AI assistant skips it.
        payload: { message_id: messageId, conversation_id: conversation.id, business_id: m.businessId, instance_id: m.instanceId,
                   ...(otpRequestId ? { otp_request_id: otpRequestId } : {}) },
        dedupeKey: `${eventType.toLowerCase()}:${messageId}`,
      });
      if (!fromMe && !isReaction) {
        await this.ops.recordUsage(db, { organizationId: m.organizationId, businessId: m.businessId, eventType: 'WHATSAPP_MESSAGE_IN',
          quantity: 1, resourceType: 'MESSAGE', resourceId: messageId, idempotencyKey: `msg-in:${messageId}`, occurredAt: m.providerTimestamp });
      }
      return { status: 'CREATED', messageId, conversationId: conversation.id, attachments };
    }, { organizationId: m.organizationId }, { retries: 2 });
  }
}
