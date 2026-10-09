import type { Db } from '../database/transaction-runner.js';

/**
 * Normalised read models shared by REST responses AND realtime events, so the
 * browser receives the exact same shape from both (merging by stable ids).
 * Never includes provider objects, raw JIDs beyond the contact identity,
 * credentials, hashes or storage keys.
 */
export interface AttachmentView { id: string; mediaType: string; mimeType: string; fileName: string | null; fileSize: number | null; status: string }

export interface MessageView {
  id: string;
  conversationId: string;
  instanceId: string;
  businessId: string;
  direction: 'INBOUND' | 'OUTBOUND';
  origin: string | null;
  fromMe: boolean;
  type: string;
  text: string | null;
  textTruncated?: boolean;
  status: string;
  timestamp: string;
  errorCode: string | null;
  isAiGenerated: boolean;
  replyTo: { id: string; providerMessageId: string | null; preview: string | null } | null;
  attachments: AttachmentView[];
}

export interface ConversationView {
  id: string;
  status: string;
  unreadCount: number;
  lastMessageAt: string;
  businessId: string;
  businessName: string;
  instanceId: string;
  instanceName: string;
  contact: { id: string; name: string | null; phone: string | null; identity: string; identityType: 'PHONE' | 'LID' };
  lastMessage: { id: string; direction: string; type: string; preview: string | null; status: string; origin: string | null; timestamp: string } | null;
  /** Who answers: AI assistant or a human (takeover/handoff). */
  handlingMode: 'AI' | 'HUMAN' | 'HYBRID' | 'PAUSED';
  aiPausedUntil: string | null;
  assistant: { id: string; name: string } | null;
}

export const MESSAGE_VIEW_SQL = `
  SELECT m.id, m.conversation_id, m.whatsapp_instance_id, m.business_id, m.direction, m.origin, m.from_me, m.message_type,
         m.text_body, m.status, m.message_timestamp, m.error_code, m.is_ai_generated,
         r.id AS reply_id, r.provider_message_id AS reply_provider_id, left(r.text_body, 120) AS reply_preview,
         coalesce((SELECT jsonb_agg(jsonb_build_object('id', a.id, 'mediaType', a.media_type, 'mimeType', a.mime_type,
                     'fileName', a.file_name, 'fileSize', a.file_size, 'status', a.status) ORDER BY a.created_at)
                     FROM app.message_attachments a WHERE a.message_id = m.id), '[]'::jsonb) AS attachments
    FROM app.messages m
    LEFT JOIN app.messages r ON r.id = m.reply_to_message_id`;

export function toMessageView(x: Record<string, any>, maxText?: number): MessageView {
  const text: string | null = x.text_body;
  const truncated = maxText !== undefined && text !== null && text.length > maxText;
  return {
    id: x.id, conversationId: x.conversation_id, instanceId: x.whatsapp_instance_id, businessId: x.business_id,
    direction: x.direction, origin: x.origin, fromMe: x.from_me, type: x.message_type,
    text: truncated ? text!.slice(0, maxText) : text, ...(truncated ? { textTruncated: true } : {}),
    status: x.status, timestamp: new Date(x.message_timestamp).toISOString(), errorCode: x.error_code, isAiGenerated: x.is_ai_generated,
    replyTo: x.reply_id ? { id: x.reply_id, providerMessageId: x.reply_provider_id, preview: x.reply_preview } : null,
    attachments: x.attachments ?? [],
  };
}

export async function loadMessageView(db: Db, messageId: string, maxText?: number): Promise<MessageView | null> {
  const r = await db.query(`${MESSAGE_VIEW_SQL} WHERE m.id = $1`, [messageId]);
  return r.rows[0] ? toMessageView(r.rows[0], maxText) : null;
}

export const CONVERSATION_VIEW_SQL = `
  SELECT c.id, c.status, c.unread_count, c.last_message_at, c.business_id, b.name AS business_name,
         c.whatsapp_instance_id, i.instance_name, c.handling_mode, c.ai_paused_until, ag.id AS ai_id, ag.name AS ai_name,
         ct.id AS contact_id, coalesce(ct.display_name, ct.profile_name) AS contact_name, ct.phone_e164, ct.whatsapp_jid,
         lm.id AS lm_id, lm.direction AS lm_direction, lm.message_type AS lm_type, left(lm.text_body, 160) AS lm_preview,
         lm.status AS lm_status, lm.origin AS lm_origin, lm.message_timestamp AS lm_ts
    FROM app.conversations c
    JOIN app.contacts ct ON ct.id = c.contact_id
    JOIN app.whatsapp_instances i ON i.id = c.whatsapp_instance_id
    JOIN app.businesses b ON b.id = c.business_id
    LEFT JOIN LATERAL (
      SELECT a.id, a.name FROM app.ai_agent_channels ch JOIN app.ai_agents a ON a.id = ch.ai_agent_id
       WHERE ch.whatsapp_instance_id = c.whatsapp_instance_id AND ch.enabled AND ch.is_primary AND a.status = 'ACTIVE' AND a.deleted_at IS NULL
       LIMIT 1) ag ON true
    LEFT JOIN LATERAL (
      SELECT m.id, m.direction, m.message_type, m.text_body, m.status, m.origin, m.message_timestamp
        FROM app.messages m
       WHERE m.conversation_id = c.id AND m.message_type <> 'REACTION'
       ORDER BY m.message_timestamp DESC, m.id DESC LIMIT 1) lm ON true`;

export function toConversationView(x: Record<string, any>): ConversationView {
  const isLid = String(x.whatsapp_jid).endsWith('@lid');
  return {
    id: x.id, status: x.status, unreadCount: x.unread_count, lastMessageAt: new Date(x.last_message_at).toISOString(),
    businessId: x.business_id, businessName: x.business_name, instanceId: x.whatsapp_instance_id, instanceName: x.instance_name,
    contact: { id: x.contact_id, name: x.contact_name, phone: x.phone_e164, identity: x.phone_e164 ?? String(x.whatsapp_jid).split('@')[0],
               identityType: isLid ? 'LID' : 'PHONE' },
    lastMessage: x.lm_id ? { id: x.lm_id, direction: x.lm_direction, type: x.lm_type, preview: x.lm_preview, status: x.lm_status,
                             origin: x.lm_origin, timestamp: new Date(x.lm_ts).toISOString() } : null,
    handlingMode: x.handling_mode, aiPausedUntil: x.ai_paused_until ? new Date(x.ai_paused_until).toISOString() : null,
    assistant: x.ai_id ? { id: x.ai_id, name: x.ai_name } : null,
  };
}

export async function loadConversationView(db: Db, conversationId: string): Promise<ConversationView | null> {
  const r = await db.query(`${CONVERSATION_VIEW_SQL} WHERE c.id = $1`, [conversationId]);
  return r.rows[0] ? toConversationView(r.rows[0]) : null;
}
