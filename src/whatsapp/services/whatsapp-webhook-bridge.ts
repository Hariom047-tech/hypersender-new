import type { Db, TransactionRunner } from '../../database/transaction-runner.js';
import type { ClaimedOutboxEvent } from '../../repositories/ops.repository.js';
import type { OutboxRelayService } from '../../services/outbox-relay.service.js';
import type { WebhookService } from '../../services/webhook.service.js';
import { userJidToE164 } from '../domain/phone.js';

export const MESSAGE_WEBHOOK_EVENTS = ['MESSAGE_RECEIVED', 'MESSAGE_SENT', 'MESSAGE_DELIVERED', 'MESSAGE_READ', 'MESSAGE_FAILED', 'MESSAGE_REVOKED', 'MESSAGE_REACTION'] as const;
export const INSTANCE_WEBHOOK_EVENTS = ['INSTANCE_CONNECTED', 'INSTANCE_DISCONNECTED', 'INSTANCE_STATUS_CHANGED'] as const;
export const OTP_WEBHOOK_EVENTS = ['OTP_VERIFIED'] as const;

/**
 * Normalised webhook payloads (the PUBLIC contract, see docs/webhook-events.md).
 * Built from our own tables under the event's tenant context. Never contains
 * provider objects, credentials, key material, hashes or encryption metadata.
 */
export async function buildMessagePayload(db: Db, messageId: string): Promise<{ businessId: string; instanceId: string; body: Record<string, unknown> } | null> {
  const r = await db.query(
    `SELECT m.id, m.provider_message_id, m.direction, m.message_type, m.text_body, m.status, m.from_me, m.origin,
            m.message_timestamp, m.sender_jid, m.recipient_jid, m.business_id, m.conversation_id, m.error_code,
            rm.provider_message_id AS reply_to_provider_id,
            i.id AS instance_id, i.phone_e164 AS instance_phone,
            c.id AS contact_id, c.phone_e164 AS contact_phone, c.display_name, c.profile_name,
            (SELECT jsonb_agg(jsonb_build_object('id', a.id, 'mediaType', a.media_type, 'mimeType', a.mime_type,
                                                 'fileName', a.file_name, 'fileSize', a.file_size, 'status', a.status))
               FROM app.message_attachments a WHERE a.message_id = m.id) AS attachments
       FROM app.messages m
       JOIN app.whatsapp_instances i ON i.id = m.whatsapp_instance_id
       LEFT JOIN app.contacts c ON c.id = m.contact_id
       LEFT JOIN app.messages rm ON rm.id = m.reply_to_message_id
      WHERE m.id = $1`, [messageId]);
  const x = r.rows[0];
  if (!x) return null;
  const contactPhone = x.contact_phone ?? userJidToE164(x.direction === 'INBOUND' ? x.sender_jid : x.recipient_jid);
  return {
    businessId: x.business_id,
    instanceId: x.instance_id,
    body: {
      instance: { id: x.instance_id, phone: x.instance_phone },
      conversation: { id: x.conversation_id },
      contact: { id: x.contact_id, phone: contactPhone, name: x.display_name ?? x.profile_name ?? null },
      message: {
        id: x.id,
        providerMessageId: x.provider_message_id,
        direction: x.direction,
        origin: x.origin,
        fromMe: x.from_me,
        from: x.direction === 'INBOUND' ? contactPhone : x.instance_phone,
        to: x.direction === 'INBOUND' ? x.instance_phone : contactPhone,
        type: x.message_type,
        text: x.text_body,
        status: x.status,
        timestamp: x.message_timestamp,
        replyToProviderMessageId: x.reply_to_provider_id,
        attachments: x.attachments ?? [],
        errorCode: x.error_code,
      },
    },
  };
}

/** Registers outbox -> webhook fan-out handlers on the general relay. */
export function registerWebhookBridge(relay: OutboxRelayService, tx: TransactionRunner, webhooks: WebhookService): void {
  const handle = async (e: ClaimedOutboxEvent) => {
    if (!e.organizationId) return;
    const organizationId = e.organizationId;
    let businessId: string | null = null;
    let instanceId: string | null = null;
    let body: Record<string, unknown>;
    let resourceType: string;
    if (e.eventType.startsWith('MESSAGE_')) {
      const built = await tx.inTenant((db) => buildMessagePayload(db, e.aggregateId), { organizationId });
      if (!built) return; // message purged meanwhile
      ({ businessId, instanceId, body } = built);
      resourceType = 'MESSAGE';
    } else if (e.eventType === 'OTP_VERIFIED') {
      const r = await tx.inTenant((db) => db.query(
        `SELECT o.id, o.kind, o.status, o.phone_e164, o.app_name, o.verified_at, o.business_id, o.instance_id, i.phone_e164 AS instance_phone
           FROM app.otp_requests o JOIN app.whatsapp_instances i ON i.id = o.instance_id WHERE o.id = $1`, [e.aggregateId]), { organizationId });
      const o = r.rows[0];
      if (!o) return;
      businessId = o.business_id;
      instanceId = o.instance_id;
      body = { instance: { id: o.instance_id, phone: o.instance_phone },
               otp: { id: o.id, kind: o.kind, status: o.status, phone: o.phone_e164, name: o.app_name, verifiedAt: o.verified_at },
               message: { id: (e.payload as { message_id?: string }).message_id ?? null } };
      resourceType = 'OTP_REQUEST';
    } else {
      const p = e.payload as { instance_id: string; business_id: string; previous_status: string; status: string; reason: string | null };
      const inst = await tx.inTenant((db) => db.query('SELECT phone_e164 FROM app.whatsapp_instances WHERE id = $1', [p.instance_id]), { organizationId });
      businessId = p.business_id;
      instanceId = p.instance_id;
      body = { instance: { id: p.instance_id, phone: inst.rows[0]?.phone_e164 ?? null, status: p.status, previousStatus: p.previous_status, reason: p.reason } };
      resourceType = 'WHATSAPP_INSTANCE';
    }
    await webhooks.fanOut(organizationId, {
      eventType: e.eventType, businessId, instanceId, resourceType, resourceId: e.aggregateId,
      payload: { organizationId, businessId, ...body }, idempotencyKey: `outbox:${e.id}`,
    });
  };
  for (const t of [...MESSAGE_WEBHOOK_EVENTS, ...INSTANCE_WEBHOOK_EVENTS, ...OTP_WEBHOOK_EVENTS]) relay.on(t, handle);
}
