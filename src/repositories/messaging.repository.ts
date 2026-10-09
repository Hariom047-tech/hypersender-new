import { Injectable } from '@nestjs/common';
import type { Db } from '../database/transaction-runner.js';

export type MessageType = 'TEXT' | 'IMAGE' | 'VIDEO' | 'AUDIO' | 'VOICE' | 'DOCUMENT' | 'LOCATION' | 'CONTACT' | 'REACTION' | 'POLL' | 'STICKER' | 'UNKNOWN';
export type OutboundStatus = 'SENT' | 'DELIVERED' | 'READ' | 'FAILED' | 'REVOKED';

@Injectable()
export class MessagingRepository {
  /** Idempotent contact upsert keyed by (business, JID). */
  async upsertContactByJid(db: Db, c: { organizationId: string; businessId: string; jid: string; phoneE164?: string | null; profileName?: string | null; seenAt: Date; source: string }): Promise<string> {
    const r = await db.query(
      `INSERT INTO app.contacts (organization_id, business_id, whatsapp_jid, phone_e164, profile_name, source, first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       ON CONFLICT (business_id, whatsapp_jid) WHERE deleted_at IS NULL
       DO UPDATE SET last_seen_at = greatest(app.contacts.last_seen_at, EXCLUDED.last_seen_at),
                     profile_name = coalesce(EXCLUDED.profile_name, app.contacts.profile_name),
                     phone_e164   = coalesce(app.contacts.phone_e164, EXCLUDED.phone_e164)
       RETURNING id`,
      [c.organizationId, c.businessId, c.jid, c.phoneE164 ?? null, c.profileName ?? null, c.source, c.seenAt]);
    return r.rows[0].id;
  }

  /**
   * Contact resolution that respects WhatsApp's two identities:
   *  - phone-number JID known  -> upsert by JID (and remember the LID);
   *  - only the privacy LID    -> reuse the contact already linked to that LID,
   *                               otherwise create a LID-addressed contact.
   * JID/LID contacts created separately are NOT merged later (documented limitation).
   */
  async resolveContact(db: Db, c: { organizationId: string; businessId: string; jid: string; lid: string | null; phoneE164?: string | null; profileName?: string | null; seenAt: Date; source: string }): Promise<string> {
    const lidOnly = c.jid.endsWith('@lid');
    if (lidOnly) {
      const r = await db.query(
        `UPDATE app.contacts SET last_seen_at = greatest(last_seen_at, $3), profile_name = coalesce($4, profile_name)
          WHERE business_id = $1 AND whatsapp_lid = $2 AND deleted_at IS NULL RETURNING id`,
        [c.businessId, c.jid, c.seenAt, c.profileName ?? null]);
      if (r.rows[0]) return r.rows[0].id;
    }
    const r = await db.query(
      `INSERT INTO app.contacts (organization_id, business_id, whatsapp_jid, whatsapp_lid, phone_e164, profile_name, source, first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
       ON CONFLICT (business_id, whatsapp_jid) WHERE deleted_at IS NULL
       DO UPDATE SET last_seen_at = greatest(app.contacts.last_seen_at, EXCLUDED.last_seen_at),
                     profile_name = coalesce(EXCLUDED.profile_name, app.contacts.profile_name),
                     phone_e164   = coalesce(app.contacts.phone_e164, EXCLUDED.phone_e164),
                     whatsapp_lid = coalesce(app.contacts.whatsapp_lid, EXCLUDED.whatsapp_lid)
       RETURNING id`,
      [c.organizationId, c.businessId, c.jid, lidOnly ? null : c.lid, c.phoneE164 ?? null, c.profileName ?? null, c.source, c.seenAt]);
    return r.rows[0].id;
  }

  /**
   * Conservative identity upgrade on a protocol-level LID<->PN mapping:
   * a contact known ONLY by its LID becomes phone-addressed, but only if no
   * phone-number contact exists for that business (never merges two rows,
   * never matches on display names). Returns true when upgraded.
   */
  async upgradeLidContact(db: Db, businessId: string, lidJid: string, pnJid: string): Promise<boolean> {
    const lid = `${lidJid.split(':')[0].split('@')[0]}@lid`;
    const pn = `${pnJid.split(':')[0].split('@')[0]}@s.whatsapp.net`;
    const phone = /^[1-9][0-9]{6,14}$/.test(pn.split('@')[0]) ? `+${pn.split('@')[0]}` : null;
    const r = await db.query(
      `UPDATE app.contacts c SET whatsapp_jid = $3, whatsapp_lid = $2, phone_e164 = coalesce(c.phone_e164, $4)
        WHERE c.business_id = $1 AND c.whatsapp_jid = $2 AND c.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM app.contacts p WHERE p.business_id = $1 AND p.deleted_at IS NULL
                            AND (p.whatsapp_jid = $3 OR p.whatsapp_lid = $2))`,
      [businessId, lid, pn, phone]);
    return (r.rowCount ?? 0) > 0;
  }

  /** Idempotent: the single non-closed thread of (instance, contact); RESOLVED threads reopen. */
  async upsertOpenConversation(db: Db, c: { organizationId: string; businessId: string; instanceId: string; contactId: string }): Promise<{ id: string; handlingMode: string; aiPausedUntil: Date | null }> {
    const r = await db.query(
      `INSERT INTO app.conversations (organization_id, business_id, whatsapp_instance_id, contact_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (whatsapp_instance_id, contact_id) WHERE status <> 'CLOSED'
       DO UPDATE SET status = CASE WHEN app.conversations.status = 'RESOLVED' THEN 'OPEN' ELSE app.conversations.status END
       RETURNING id, handling_mode, ai_paused_until`,
      [c.organizationId, c.businessId, c.instanceId, c.contactId]);
    return { id: r.rows[0].id, handlingMode: r.rows[0].handling_mode, aiPausedUntil: r.rows[0].ai_paused_until };
  }

  /**
   * Inbound insert, deduplicated by (instance, provider_message_id).
   * Returns null when the message already exists (duplicate delivery).
   */
  async insertInboundMessage(db: Db, m: {
    id: string; organizationId: string; businessId: string; instanceId: string; conversationId: string; contactId: string;
    providerMessageId: string; senderJid: string; recipientJid: string; type: MessageType; textBody: string | null;
    providerTimestamp: Date; rawMetadata?: object | null;
  }): Promise<string | null> {
    const r = await db.query(
      `INSERT INTO app.messages (id, organization_id, business_id, whatsapp_instance_id, conversation_id, contact_id,
                                 provider_message_id, direction, sender_jid, recipient_jid, message_type, text_body,
                                 provider_timestamp, status, from_me, raw_metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'INBOUND', $8, $9, $10, $11, $12, 'RECEIVED', false, $13)
       ON CONFLICT (whatsapp_instance_id, provider_message_id) DO NOTHING
       RETURNING id`,
      [m.id, m.organizationId, m.businessId, m.instanceId, m.conversationId, m.contactId, m.providerMessageId,
       m.senderJid, m.recipientJid, m.type, m.textBody, m.providerTimestamp, m.rawMetadata ? JSON.stringify(m.rawMetadata) : null]);
    return r.rows[0]?.id ?? null;
  }

  /**
   * Stores a message observed on the connection (contact message, or a fromMe
   * message typed on the owner's phone). Deduplicated by
   * (instance, provider_message_id): echoes of messages WE sent collide with the
   * pre-assigned provider id and return null.
   */
  async insertObservedMessage(db: Db, m: {
    id: string; organizationId: string; businessId: string; instanceId: string; conversationId: string; contactId: string;
    providerMessageId: string; direction: 'INBOUND' | 'OUTBOUND'; senderJid: string; recipientJid: string; type: MessageType;
    textBody: string | null; providerTimestamp: Date; replyToMessageId: string | null; origin: 'CONTACT' | 'LINKED_DEVICE';
    rawMetadata?: object | null;
  }): Promise<string | null> {
    const r = await db.query(
      `INSERT INTO app.messages (id, organization_id, business_id, whatsapp_instance_id, conversation_id, contact_id,
                                 provider_message_id, direction, sender_jid, recipient_jid, message_type, text_body,
                                 provider_timestamp, status, from_me, reply_to_message_id, origin, raw_metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text, $9, $10, $11, $12, $13,
               CASE WHEN $8::text = 'OUTBOUND' THEN 'SENT' ELSE 'RECEIVED' END, $8::text = 'OUTBOUND', $14, $15, $16)
       ON CONFLICT (whatsapp_instance_id, provider_message_id) DO NOTHING
       RETURNING id`,
      [m.id, m.organizationId, m.businessId, m.instanceId, m.conversationId, m.contactId, m.providerMessageId, m.direction,
       m.senderJid, m.recipientJid, m.type, m.textBody, m.providerTimestamp, m.replyToMessageId, m.origin,
       m.rawMetadata ? JSON.stringify(m.rawMetadata) : null]);
    return r.rows[0]?.id ?? null;
  }

  async findMessageIdByProviderId(db: Db, instanceId: string, providerMessageId: string): Promise<string | null> {
    const r = await db.query('SELECT id FROM app.messages WHERE whatsapp_instance_id = $1 AND provider_message_id = $2',
      [instanceId, providerMessageId]);
    return r.rows[0]?.id ?? null;
  }

  async touchConversationInbound(db: Db, conversationId: string, at: Date): Promise<void> {
    await db.query(
      `UPDATE app.conversations
          SET last_message_at = greatest(last_message_at, $2), last_inbound_at = greatest(coalesce(last_inbound_at, $2), $2),
              unread_count = unread_count + 1
        WHERE id = $1`, [conversationId, at]);
  }

  async touchConversationOutbound(db: Db, conversationId: string, at: Date): Promise<void> {
    await db.query(
      `UPDATE app.conversations
          SET last_message_at = greatest(last_message_at, $2), last_outbound_at = greatest(coalesce(last_outbound_at, $2), $2)
        WHERE id = $1`, [conversationId, at]);
  }

  async getConversationForSend(db: Db, conversationId: string): Promise<{ id: string; organizationId: string; businessId: string; instanceId: string; contactId: string; contactJid: string; instanceJid: string | null } | null> {
    const r = await db.query(
      `SELECT c.id, c.organization_id, c.business_id, c.whatsapp_instance_id, c.contact_id, ct.whatsapp_jid AS contact_jid, i.whatsapp_jid AS instance_jid
         FROM app.conversations c
         JOIN app.contacts ct ON ct.id = c.contact_id
         JOIN app.whatsapp_instances i ON i.id = c.whatsapp_instance_id
        WHERE c.id = $1`, [conversationId]);
    const row = r.rows[0];
    return row ? { id: row.id, organizationId: row.organization_id, businessId: row.business_id, instanceId: row.whatsapp_instance_id,
                   contactId: row.contact_id, contactJid: row.contact_jid, instanceJid: row.instance_jid } : null;
  }

  /** Outbound insert (QUEUED), deduplicated by (organization, idempotency_key). Null = already queued. */
  async insertQueuedOutbound(db: Db, m: {
    id: string; organizationId: string; businessId: string; instanceId: string; conversationId: string; contactId: string;
    senderJid: string; recipientJid: string; type: MessageType; textBody: string | null; idempotencyKey: string;
    isAiGenerated: boolean; aiAgentId?: string | null; sentByUserId?: string | null; replyToMessageId?: string | null;
    origin?: 'API' | 'DASHBOARD' | 'AI' | 'SYSTEM'; rawMetadata?: object | null;
  }): Promise<string | null> {
    const r = await db.query(
      `INSERT INTO app.messages (id, organization_id, business_id, whatsapp_instance_id, conversation_id, contact_id,
                                 idempotency_key, direction, sender_jid, recipient_jid, message_type, text_body,
                                 status, from_me, is_ai_generated, ai_agent_id, sent_by_user_id, reply_to_message_id, origin, raw_metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'OUTBOUND', $8, $9, $10, $11, 'QUEUED', true, $12, $13, $14, $15, $16, $17)
       ON CONFLICT (organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [m.id, m.organizationId, m.businessId, m.instanceId, m.conversationId, m.contactId, m.idempotencyKey,
       m.senderJid, m.recipientJid, m.type, m.textBody, m.isAiGenerated, m.aiAgentId ?? null, m.sentByUserId ?? null,
       m.replyToMessageId ?? null, m.origin ?? (m.isAiGenerated ? 'AI' : m.sentByUserId ? 'DASHBOARD' : 'API'),
       m.rawMetadata ? JSON.stringify(m.rawMetadata) : null]);
    return r.rows[0]?.id ?? null;
  }

  async findByIdempotencyKey(db: Db, idempotencyKey: string): Promise<string | null> {
    const r = await db.query(
      'SELECT id FROM app.messages WHERE organization_id = app.current_org_id() AND idempotency_key = $1', [idempotencyKey]);
    return r.rows[0]?.id ?? null;
  }

  /**
   * Records the successful send exactly once (provider_timestamp is set only
   * here, so retries are no-ops). A delivery receipt that raced ahead of this
   * write keeps its higher status - status never moves backwards.
   */
  async markSent(db: Db, messageId: string, providerMessageId: string, providerTimestamp: Date): Promise<{ conversationId: string; businessId: string } | null> {
    const r = await db.query(
      `UPDATE app.messages
          SET status = CASE WHEN app.message_status_rank(status) < app.message_status_rank('SENT') THEN 'SENT' ELSE status END,
              provider_message_id = coalesce(provider_message_id, $2), provider_timestamp = $3, status_updated_at = now()
        WHERE id = $1 AND direction = 'OUTBOUND' AND provider_timestamp IS NULL AND status NOT IN ('FAILED','REVOKED')
        RETURNING conversation_id, business_id`,
      [messageId, providerMessageId, providerTimestamp]);
    return r.rows[0] ? { conversationId: r.rows[0].conversation_id, businessId: r.rows[0].business_id } : null;
  }

  async markFailed(db: Db, messageId: string, errorCode: string, errorMessage: string): Promise<boolean> {
    const r = await db.query(
      `UPDATE app.messages SET status = 'FAILED', error_code = $2, error_message = left($3, 2000), status_updated_at = now()
        WHERE id = $1 AND status = 'QUEUED'`, [messageId, errorCode, errorMessage]);
    return (r.rowCount ?? 0) > 0;
  }

  /** Forward-only status transition for receipts (duplicates / out-of-order receipts are no-ops). */
  async advanceStatusByProviderId(db: Db, instanceId: string, providerMessageId: string, status: OutboundStatus): Promise<{ id: string; organizationId: string } | null> {
    const r = await db.query(
      `UPDATE app.messages SET status = $3, status_updated_at = now()
        WHERE whatsapp_instance_id = $1 AND provider_message_id = $2
          AND app.message_status_rank(status) < app.message_status_rank($3)
          AND (direction = 'OUTBOUND' OR $3 IN ('READ','REVOKED'))
       RETURNING id, organization_id`, [instanceId, providerMessageId, status]);
    return r.rows[0] ? { id: r.rows[0].id, organizationId: r.rows[0].organization_id } : null;
  }

  async insertStatusEvent(db: Db, e: { organizationId: string; messageId: string; status: string; providerTimestamp?: Date | null }): Promise<boolean> {
    const r = await db.query(
      `INSERT INTO app.message_status_events (organization_id, message_id, status, provider_timestamp)
       VALUES ($1, $2, $3, $4) ON CONFLICT (message_id, status) DO NOTHING`,
      [e.organizationId, e.messageId, e.status, e.providerTimestamp ?? null]);
    return (r.rowCount ?? 0) > 0;
  }

  async insertAttachment(db: Db, a: { id?: string; organizationId: string; messageId: string; mediaType: string; mimeType: string; fileName?: string | null; fileSize?: number | null; storageProvider: string; storageKey: string }): Promise<string> {
    const r = await db.query(
      `INSERT INTO app.message_attachments (id, organization_id, message_id, media_type, mime_type, file_name, file_size, storage_provider, storage_key)
       VALUES (coalesce($9::uuid, app.uuid_generate_v7()), $1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [a.organizationId, a.messageId, a.mediaType, a.mimeType, a.fileName ?? null, a.fileSize ?? null, a.storageProvider, a.storageKey, a.id ?? null]);
    return r.rows[0].id;
  }

  /** Keyset pagination for the thread view. */
  async listThread(db: Db, conversationId: string, limit = 50, before?: { ts: Date; id: string }): Promise<Array<Record<string, unknown>>> {
    const r = await db.query(
      `SELECT id, direction, message_type, text_body, status, message_timestamp, is_ai_generated
         FROM app.messages
        WHERE conversation_id = $1
          AND ($2::timestamptz IS NULL OR (message_timestamp, id) < ($2, $3::uuid))
        ORDER BY message_timestamp DESC, id DESC
        LIMIT $4`, [conversationId, before?.ts ?? null, before?.id ?? null, Math.min(limit, 200)]);
    return r.rows;
  }
}
