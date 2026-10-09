import type { Logger } from 'pino';
import type { Db, TransactionRunner } from '../database/transaction-runner.js';
import type { ClaimedOutboxEvent, OpsRepository } from '../repositories/ops.repository.js';
import type { MessagingRepository } from '../repositories/messaging.repository.js';
import type { NotificationService } from '../services/notification.service.js';
import type { OutboundMessageService } from '../services/outbound-message.service.js';
import type { OutboxRelayService } from '../services/outbox-relay.service.js';
import { e164ToUserJid } from '../whatsapp/domain/phone.js';
import type { RealtimeBus } from '../whatsapp/realtime/realtime-bus.js';

/*
 * Scheduled reminders (Pandit Ji / yajman).
 *
 * Scheduling = one app.scheduled_reminders row + one outbox event REMINDER_DUE
 * whose available_at is the due time, written in the SAME transaction. The
 * general outbox relay (worker) claims it when it becomes due and calls
 * deliverReminder in the reminder's own tenant context. No extra cross-tenant
 * queue or policy is needed, and a crash simply redelivers the event: the row's
 * status (PENDING -> SENT/SKIPPED/CANCELLED) makes delivery idempotent.
 *
 * Moving or cancelling a booking marks its PENDING reminders CANCELLED; their
 * already-queued events then find a non-PENDING row and do nothing.
 */

export const REMINDER_EVENT = 'REMINDER_DUE';

export type ReminderAudience = 'YAJMAN' | 'PANDIT';
export type ReminderKind = 'BOOKING' | 'CALLBACK' | 'FOLLOW_UP' | 'CUSTOM' | 'BOOKING_ALERT';

export interface NewReminder {
  organizationId: string;
  businessId: string;
  audience: ReminderAudience;
  kind: ReminderKind;
  dueAt: Date;
  message: string;
  now: Date;
  bookingId?: string | null;
  callbackRequestId?: string | null;
  contactId?: string | null;
  conversationId?: string | null;
  idempotencyKey?: string | null;
  createdBy?: 'AI' | 'USER' | 'SYSTEM';
}

export interface ScheduledReminder { id: string; audience: ReminderAudience; dueAt: Date; replayed: boolean }

/** Inserts the reminder and its due-time outbox event (call inside the caller's tenant transaction). */
export async function scheduleReminder(db: Db, ops: OpsRepository, r: NewReminder): Promise<ScheduledReminder> {
  const ins = await db.query(
    `INSERT INTO app.scheduled_reminders (organization_id, business_id, audience, kind, booking_id, callback_request_id, contact_id, conversation_id,
                                          due_at, message, idempotency_key, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT DO NOTHING
     RETURNING id, due_at`,
    [r.organizationId, r.businessId, r.audience, r.kind, r.bookingId ?? null, r.callbackRequestId ?? null, r.contactId ?? null,
     r.conversationId ?? null, r.dueAt, r.message.slice(0, 1000), r.idempotencyKey ?? null, r.createdBy ?? 'AI']);
  if (!ins.rows[0]) {
    // Same idempotency key (retried run) or the booking already has a pending reminder for this audience.
    const ex = await db.query(
      `SELECT id, due_at FROM app.scheduled_reminders
        WHERE organization_id = $1 AND (($2::text IS NOT NULL AND idempotency_key = $2)
              OR ($3::uuid IS NOT NULL AND booking_id = $3 AND audience = $4 AND kind = 'BOOKING' AND status = 'PENDING'))
        ORDER BY created_at DESC LIMIT 1`,
      [r.organizationId, r.idempotencyKey ?? null, r.kind === 'BOOKING' ? r.bookingId ?? null : null, r.audience]);
    if (!ex.rows[0]) throw new Error('reminder conflict without an existing row');
    return { id: ex.rows[0].id, audience: r.audience, dueAt: ex.rows[0].due_at, replayed: true };
  }
  const id: string = ins.rows[0].id;
  await ops.enqueueOutbox(db, { organizationId: r.organizationId, eventType: REMINDER_EVENT, aggregateType: 'REMINDER', aggregateId: id,
    payload: { reminder_id: id }, dedupeKey: `reminder:${id}`, delaySeconds: Math.max(0, (r.dueAt.getTime() - r.now.getTime()) / 1000) });
  return { id, audience: r.audience, dueAt: ins.rows[0].due_at, replayed: false };
}

/** Cancels every still-pending reminder of a booking (reschedule / cancellation). */
export async function cancelBookingReminders(db: Db, bookingId: string): Promise<number> {
  const r = await db.query(`UPDATE app.scheduled_reminders SET status = 'CANCELLED' WHERE booking_id = $1 AND status = 'PENDING'`, [bookingId]);
  return r.rowCount ?? 0;
}

/**
 * When a "1 day before" reminder should go out. Too late for the full lead
 * time -> 2 hours before; too late for that as well -> no reminder (null).
 */
export function reminderDueAt(startAt: Date, now: Date, leadMinutes: number): Date | null {
  const preferred = new Date(startAt.getTime() - leadMinutes * 60_000);
  if (preferred.getTime() > now.getTime() + 60_000) return preferred;
  const late = new Date(startAt.getTime() - 120 * 60_000);
  return late.getTime() > now.getTime() + 60_000 ? late : null;
}

// ------------------------------------------------------------- delivery ---

export interface ReminderDeliveryDeps {
  tx: TransactionRunner;
  ops: OpsRepository;
  messaging: MessagingRepository;
  outbound: OutboundMessageService;
  notifications: NotificationService;
  bus: RealtimeBus;
  logger?: Logger;
}

type Outcome = { status: 'SENT' | 'SKIPPED' | 'NOOP'; reason?: string; notify?: { title: string; body: string; data: Record<string, unknown> }; wake?: boolean };

/** Worker: registers the REMINDER_DUE handler on the general outbox relay. */
export function registerReminderDelivery(relay: OutboxRelayService, d: ReminderDeliveryDeps): void {
  relay.on(REMINDER_EVENT, (e) => deliverReminder(d, e));
}

export async function deliverReminder(d: ReminderDeliveryDeps, e: ClaimedOutboxEvent): Promise<void> {
  const organizationId = e.organizationId;
  if (!organizationId) return;
  const reminderId = String((e.payload as Record<string, unknown>)?.reminder_id ?? e.aggregateId);
  const outcome = await d.tx.inTenant(async (db): Promise<Outcome> => {
    const r = (await db.query(
      `SELECT r.id, r.business_id, r.audience, r.kind, r.booking_id, r.contact_id, r.conversation_id, r.message, r.status,
              r.due_at > now() + interval '30 seconds' AS early, b.status AS booking_status, b.start_at <= now() AS booking_started
         FROM app.scheduled_reminders r LEFT JOIN app.bookings b ON b.id = r.booking_id
        WHERE r.id = $1 FOR UPDATE OF r`, [reminderId])).rows[0];
    if (!r || r.status !== 'PENDING' || r.early) return { status: 'NOOP' };
    const skip = async (reason: string): Promise<Outcome> => {
      await db.query(`UPDATE app.scheduled_reminders SET status = 'SKIPPED', last_error = $2, attempts = attempts + 1 WHERE id = $1`, [r.id, reason]);
      return { status: 'SKIPPED', reason };
    };
    if (r.booking_id && (!['PENDING', 'CONFIRMED'].includes(r.booking_status) || r.booking_started)) return skip('booking no longer upcoming');

    let wake = false;
    let notify: Outcome['notify'];
    if (r.audience === 'YAJMAN') {
      const conv = (await db.query(
        `SELECT id FROM app.conversations WHERE business_id = $1 AND contact_id = $2 AND ($3::uuid IS NULL OR id = $3) AND status <> 'CLOSED'
          ORDER BY (id = $3) DESC NULLS LAST, last_message_at DESC NULLS LAST LIMIT 1`, [r.business_id, r.contact_id, r.conversation_id])).rows[0];
      if (!conv) return skip('no open WhatsApp chat with the yajman');
      await d.outbound.enqueueTextInTx(db, { conversationId: conv.id, text: r.message, idempotencyKey: `reminder:${r.id}`, origin: 'SYSTEM' });
      wake = true;
    } else {
      notify = { title: r.kind === 'CALLBACK' ? 'Call-back request' : r.kind === 'BOOKING_ALERT' ? 'Havan booking' : 'Reminder', body: r.message.slice(0, 180),
        data: { reminder_id: r.id, booking_id: r.booking_id, conversation_id: r.conversation_id } };
      wake = await sendToPandit(d, db, organizationId, r);
    }
    await db.query(`UPDATE app.scheduled_reminders SET status = 'SENT', sent_at = now(), attempts = attempts + 1, last_error = NULL WHERE id = $1`, [r.id]);
    return { status: 'SENT', notify, wake };
  }, { organizationId });

  if (outcome.notify) {
    await d.notifications.notifyAdmins(organizationId, { type: outcome.notify.title === 'Call-back request' ? 'PANDIT_CALLBACK' : 'PANDIT_REMINDER',
      dedupeKey: `reminder:${reminderId}`, title: outcome.notify.title, body: outcome.notify.body, data: outcome.notify.data }).catch(() => undefined);
  }
  if (outcome.wake) await d.bus.wakeOutbox().catch(() => undefined);
  d.logger?.info({ event_name: 'havan.reminder_delivered', reminder_id: reminderId, status: outcome.status, reason: outcome.reason });
}

/**
 * WhatsApp copy to the Pandit's own number (havan_settings.pandit_whatsapp_e164),
 * sent from the business's WhatsApp number. That chat is set to HUMAN so the
 * assistant never answers the Pandit. Returns whether a message was queued.
 */
async function sendToPandit(d: ReminderDeliveryDeps, db: Db, organizationId: string,
                            r: { id: string; business_id: string; contact_id: string | null; conversation_id: string | null; message: string }): Promise<boolean> {
  const s = (await db.query('SELECT pandit_whatsapp_e164 FROM app.havan_settings WHERE business_id = $1', [r.business_id])).rows[0];
  if (!s?.pandit_whatsapp_e164) return false;
  const inst = (await db.query(
    `SELECT i.id, i.phone_e164 FROM app.whatsapp_instances i
      WHERE i.business_id = $1 AND i.deleted_at IS NULL AND i.status = 'CONNECTED'
      ORDER BY (i.id = (SELECT c.whatsapp_instance_id FROM app.conversations c WHERE c.id = $2)) DESC NULLS LAST, i.created_at LIMIT 1`,
    [r.business_id, r.conversation_id])).rows[0];
  if (!inst || inst.phone_e164 === s.pandit_whatsapp_e164) return false; // not connected, or the Pandit IS the business number
  const contactId = await d.messaging.resolveContact(db, { organizationId, businessId: r.business_id, jid: e164ToUserJid(s.pandit_whatsapp_e164), lid: null,
    phoneE164: s.pandit_whatsapp_e164, profileName: 'Pandit Ji', seenAt: new Date(), source: 'MANUAL' });
  const conv = await d.messaging.upsertOpenConversation(db, { organizationId, businessId: r.business_id, instanceId: inst.id, contactId });
  // Pandit Ji's own chat is for notes only: the assistant must not answer it. Exception: the same number is also
  // the yajman of this note (Pandit Ji testing as a customer) - then that chat stays with the assistant.
  if (conv.handlingMode !== 'HUMAN' && contactId !== r.contact_id) {
    await db.query(`UPDATE app.conversations SET handling_mode = 'HUMAN', ai_paused_until = NULL WHERE id = $1`, [conv.id]);
  }
  await d.outbound.enqueueTextInTx(db, { conversationId: conv.id, text: r.message, idempotencyKey: `reminder-pandit:${r.id}`, origin: 'SYSTEM' });
  return true;
}
