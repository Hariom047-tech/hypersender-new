import type { Db } from '../database/transaction-runner.js';
import type { OpsRepository } from '../repositories/ops.repository.js';
import type { OutboundMessageService } from '../services/outbound-message.service.js';
import { findLinkCodes, hashOtpCode } from './otp-crypto.js';

/**
 * "Login by WhatsApp" (OTP links): runs inside the inbound message transaction. When a contact sends the code
 * of a pending link to this instance, the request is VERIFIED with the sender's phone, the contact gets the
 * success (or expired) reply, and OTP_VERIFIED is emitted for webhooks. Returns the matched request id so the
 * AI assistant does not also answer the login message.
 */
export async function verifyOtpLink(db: Db, deps: { ops: OpsRepository; outbound: OutboundMessageService }, m: {
  organizationId: string; businessId: string; instanceId: string; conversationId: string; messageId: string; fromPhoneE164: string | null; text: string | null | undefined;
}): Promise<string | null> {
  if (!m.text || m.text.length > 2000) return null;
  const codes = findLinkCodes(m.text);
  if (!codes.length) return null;
  const row = (await db.query(
    `SELECT id, expires_at, link_messages, app_name FROM app.otp_requests
      WHERE instance_id = $1 AND kind = 'LINK' AND status = 'PENDING' AND code_hash = ANY($2::bytea[])
      ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [m.instanceId, codes.map((c) => hashOtpCode(m.instanceId, c))])).rows[0];
  if (!row) return null;
  const messages = (row.link_messages ?? {}) as { success?: string; expired?: string };
  const expired = new Date(row.expires_at) <= new Date();
  if (expired) {
    await db.query(`UPDATE app.otp_requests SET status = 'FAILED' WHERE id = $1`, [row.id]);
  } else {
    await db.query(`UPDATE app.otp_requests SET status = 'VERIFIED', verified_at = now(), phone_e164 = $2 WHERE id = $1`, [row.id, m.fromPhoneE164]);
    await deps.ops.enqueueOutbox(db, {
      organizationId: m.organizationId, eventType: 'OTP_VERIFIED', aggregateType: 'OTP_REQUEST', aggregateId: row.id,
      payload: { otp_request_id: row.id, business_id: m.businessId, instance_id: m.instanceId, message_id: m.messageId },
      dedupeKey: `otp_verified:${row.id}`,
    });
  }
  const reply = expired ? messages.expired : messages.success;
  if (reply?.trim()) {
    await deps.outbound.enqueueTextInTx(db, { conversationId: m.conversationId, text: reply.replace(/\{name\}/g, row.app_name ?? ''),
      idempotencyKey: `otp-reply:${row.id}`, origin: 'SYSTEM' });
  }
  return row.id;
}
