import type { Logger } from 'pino';
import type { Db, TransactionRunner } from '../database/transaction-runner.js';
import type { ClaimedOutboxEvent, OpsRepository } from '../repositories/ops.repository.js';
import type { MessagingRepository } from '../repositories/messaging.repository.js';
import type { NotificationService } from '../services/notification.service.js';
import type { OutboundMessageService } from '../services/outbound-message.service.js';
import type { OutboxRelayService } from '../services/outbox-relay.service.js';
import type { RealtimeBus } from '../whatsapp/realtime/realtime-bus.js';

/*
 * Paced campaign delivery.
 *
 * A running campaign is a chain of CAMPAIGN_TICK outbox events. Each tick sends
 * at most ONE message and schedules the next tick `interval_seconds` later, so
 * a campaign never bursts. Before every message the tick checks, in order:
 *   1. health    - pause when many recipients reply STOP or many sends fail
 *   2. hours     - only inside the business's sending window (local time)
 *   3. number    - the WhatsApp number must be connected
 *   4. daily cap - plan limit, lowered for new numbers (warm-up)
 *   5. consent   - the recipient is re-checked (they may have replied STOP)
 * Ticks carry the campaign's tick_seq; pausing/resuming bumps it so an older
 * chain simply stops (no double sending after resume).
 */

export const CAMPAIGN_TICK = 'CAMPAIGN_TICK';
/** Added to every campaign message that does not already tell people how to stop. */
export const OPT_OUT_FOOTER = '';
const DEFAULT_DAILY_LIMIT = 100;

// ------------------------------------------------------------------ pure rules

/** Personalises {name} and makes sure the opt-out line is there. */
export function renderCampaignMessage(template: string, customerName: string | null | undefined): string {
  const first = (customerName ?? '').trim().split(/\s+/)[0]?.replace(/[^\p{L}\p{M}'.-]/gu, '') ?? '';
  let text = first ? template.replace(/\{name\}/g, first) : template.replace(/[ \t]*\{name\}/g, '');
  text = text.replace(/[ \t]{2,}/g, ' ').trim();
  if (!/\bstop\b|स्टॉप/i.test(text)) text = `${text}\n\n${OPT_OUT_FOOTER}`;
  return text;
}

/** Daily messages allowed from one number: the plan limit, lowered while the number is new. */
export function dailyCap(planLimit: number | null, numberAgeDays: number): number {
  const warmUp = numberAgeDays < 7 ? 50 : numberAgeDays < 30 ? 250 : Number.POSITIVE_INFINITY;
  return Math.min(planLimit ?? DEFAULT_DAILY_LIMIT, warmUp);
}

export type Slot = 'OPEN' | 'BEFORE' | 'AFTER';
export function sendingSlot(nowMinute: number, startMinute: number, endMinute: number): Slot {
  if (nowMinute < startMinute) return 'BEFORE';
  return nowMinute >= endMinute ? 'AFTER' : 'OPEN';
}

/** Why a campaign must stop now, or null. Opt-outs are the clearest sign customers do not want it. */
export function healthProblem(h: { queued: number; failed: number; optedOut: number }): string | null {
  if (h.queued >= 20 && h.optedOut / h.queued > 0.03) return 'Paused: more than 3% of customers replied STOP. Review the message and who it goes to before resuming.';
  if (h.queued >= 10 && h.failed / h.queued > 0.2) return 'Paused: many messages failed. Check that the WhatsApp number is connected and working.';
  return null;
}

// ------------------------------------------------------------------ scheduling

/** Starts a new tick chain (bumps tick_seq so older chains end). Call inside a tenant tx. */
export async function scheduleTick(db: Db, ops: OpsRepository, organizationId: string, campaignId: string, delaySeconds: number): Promise<void> {
  const seq: number = (await db.query(`UPDATE app.marketing_campaigns SET tick_seq = tick_seq + 1 WHERE id = $1 RETURNING tick_seq`, [campaignId])).rows[0].tick_seq;
  await ops.enqueueOutbox(db, { organizationId, eventType: CAMPAIGN_TICK, aggregateType: 'CAMPAIGN', aggregateId: campaignId,
    payload: { campaign_id: campaignId, seq }, dedupeKey: `campaign:${campaignId}:${seq}`, delaySeconds: Math.max(0, delaySeconds) });
}

// ------------------------------------------------------------------ delivery

export interface CampaignDeliveryDeps {
  tx: TransactionRunner;
  ops: OpsRepository;
  messaging: MessagingRepository;
  outbound: OutboundMessageService;
  notifications: NotificationService;
  bus: RealtimeBus;
  logger?: Logger;
}

type TickOutcome = { wake?: boolean; notify?: { type: 'CAMPAIGN_PAUSED' | 'CAMPAIGN_COMPLETED'; title: string; body: string; campaignId: string } };

export function registerCampaignDelivery(relay: OutboxRelayService, d: CampaignDeliveryDeps): void {
  relay.on(CAMPAIGN_TICK, (e) => runCampaignTick(d, e));
}

export async function runCampaignTick(d: CampaignDeliveryDeps, e: ClaimedOutboxEvent): Promise<void> {
  const organizationId = e.organizationId;
  if (!organizationId) return;
  const payload = (e.payload ?? {}) as Record<string, unknown>;
  const campaignId = String(payload.campaign_id ?? e.aggregateId);
  const seq = Number(payload.seq);

  const out = await d.tx.inTenant(async (db): Promise<TickOutcome> => {
    const c = (await db.query(
      `SELECT c.id, c.business_id, c.whatsapp_instance_id, c.name, c.message, c.status, c.scheduled_at > now() AS early, c.tick_seq,
              c.window_start_minute, c.window_end_minute, c.interval_seconds, b.timezone,
              i.status AS instance_status, extract(epoch FROM now() - i.created_at) / 86400 AS number_age_days,
              (extract(hour FROM now() AT TIME ZONE b.timezone) * 60 + extract(minute FROM now() AT TIME ZONE b.timezone))::int AS now_minute,
              (date_trunc('day', now() AT TIME ZONE b.timezone) AT TIME ZONE b.timezone) AS day_begin,
              ((date_trunc('day', now() AT TIME ZONE b.timezone) + make_interval(mins => c.window_start_minute)) AT TIME ZONE b.timezone) AS window_open
         FROM app.marketing_campaigns c
         JOIN app.businesses b ON b.id = c.business_id
         JOIN app.whatsapp_instances i ON i.id = c.whatsapp_instance_id
        WHERE c.id = $1 FOR UPDATE OF c`, [campaignId])).rows[0];
    if (!c || c.tick_seq !== seq) return {};
    if (c.status === 'SCHEDULED') {
      if (c.early) return {};
      await db.query(`UPDATE app.marketing_campaigns SET status = 'SENDING', started_at = coalesce(started_at, now()) WHERE id = $1`, [c.id]);
      c.status = 'SENDING';
    }
    if (c.status !== 'SENDING') return {};

    const wait = async (reason: string, delaySeconds: number): Promise<TickOutcome> => {
      await db.query(`UPDATE app.marketing_campaigns SET waiting_reason = $2 WHERE id = $1`, [c.id, reason]);
      await scheduleTick(db, d.ops, organizationId, c.id, delaySeconds);
      return {};
    };
    const secondsUntil = (at: Date, plusDays = 0) => (new Date(at).getTime() + plusDays * 86_400_000 - Date.now()) / 1000;

    // 1. health
    const h = (await db.query(
      `SELECT count(*) FILTER (WHERE r.status = 'QUEUED')::int AS queued,
              count(*) FILTER (WHERE r.status = 'QUEUED' AND m.status = 'FAILED')::int AS failed,
              count(*) FILTER (WHERE r.status = 'QUEUED' AND p.status = 'OPTED_OUT' AND p.changed_at >= r.queued_at)::int AS opted_out
         FROM app.marketing_campaign_recipients r
         LEFT JOIN app.messages m ON m.id = r.message_id
         LEFT JOIN app.marketing_contact_prefs p ON p.contact_id = r.contact_id
        WHERE r.campaign_id = $1`, [c.id])).rows[0];
    const problem = healthProblem({ queued: h.queued, failed: h.failed, optedOut: h.opted_out });
    if (problem) {
      await db.query(`UPDATE app.marketing_campaigns SET status = 'PAUSED', pause_reason = $2, waiting_reason = NULL WHERE id = $1`, [c.id, problem]);
      return { notify: { type: 'CAMPAIGN_PAUSED', title: 'Campaign paused', body: `${c.name}: ${problem}`.slice(0, 180), campaignId: c.id } };
    }

    // 2. sending hours
    const slot = sendingSlot(c.now_minute, c.window_start_minute, c.window_end_minute);
    if (slot === 'BEFORE') return wait('OUTSIDE_HOURS', secondsUntil(c.window_open));
    if (slot === 'AFTER') return wait('OUTSIDE_HOURS', secondsUntil(c.window_open, 1));

    // 3. number connected
    if (c.instance_status !== 'CONNECTED') return wait('NUMBER_OFFLINE', 300);

    // 4. daily cap for this number
    const ent = (await db.query(`SELECT enabled, limit_value FROM app.current_entitlement('MARKETING_DAILY_CONTACTS')`)).rows[0];
    if (ent && !ent.enabled) {
      const why = 'Paused: marketing campaigns are not included in the current plan.';
      await db.query(`UPDATE app.marketing_campaigns SET status = 'PAUSED', pause_reason = $2, waiting_reason = NULL WHERE id = $1`, [c.id, why]);
      return { notify: { type: 'CAMPAIGN_PAUSED', title: 'Campaign paused', body: `${c.name}: ${why}`, campaignId: c.id } };
    }
    const cap = dailyCap(ent?.limit_value == null ? (ent ? null : DEFAULT_DAILY_LIMIT) : Number(ent.limit_value), Number(c.number_age_days));
    const sentToday: number = (await db.query(
      `SELECT count(*)::int AS n FROM app.marketing_campaign_recipients r JOIN app.marketing_campaigns x ON x.id = r.campaign_id
        WHERE x.whatsapp_instance_id = $1 AND r.status = 'QUEUED' AND r.queued_at >= $2`, [c.whatsapp_instance_id, c.day_begin])).rows[0].n;
    if (sentToday >= cap) return wait('DAILY_LIMIT', secondsUntil(c.window_open, 1));

    // 5. next recipient, consent re-checked
    const r = (await db.query(
      `SELECT r.id, r.contact_id, ct.display_name, ct.profile_name, ct.status AS contact_status, ct.deleted_at IS NOT NULL AS deleted, p.status AS pref
         FROM app.marketing_campaign_recipients r
         JOIN app.contacts ct ON ct.id = r.contact_id
         LEFT JOIN app.marketing_contact_prefs p ON p.contact_id = r.contact_id
        WHERE r.campaign_id = $1 AND r.status = 'PENDING'
        ORDER BY r.id LIMIT 1 FOR UPDATE OF r SKIP LOCKED`, [c.id])).rows[0];
    if (!r) {
      await db.query(`UPDATE app.marketing_campaigns SET status = 'COMPLETED', completed_at = now(), waiting_reason = NULL WHERE id = $1`, [c.id]);
      return { notify: { type: 'CAMPAIGN_COMPLETED', title: 'Campaign completed', body: `${c.name}: all messages have been sent.`, campaignId: c.id } };
    }
    const skipReason = r.pref === 'OPTED_OUT' ? 'OPTED_OUT' : r.deleted || r.contact_status !== 'ACTIVE' ? 'CONTACT_UNAVAILABLE' : null;
    if (skipReason) {
      await db.query(`UPDATE app.marketing_campaign_recipients SET status = 'SKIPPED', skip_reason = $2 WHERE id = $1`, [r.id, skipReason]);
      await scheduleTick(db, d.ops, organizationId, c.id, 0);
      return {};
    }

    const conv = await d.messaging.upsertOpenConversation(db, { organizationId, businessId: c.business_id, instanceId: c.whatsapp_instance_id, contactId: r.contact_id });
    const text = renderCampaignMessage(c.message, r.display_name ?? r.profile_name);
    const sent = await d.outbound.enqueueTextInTx(db, { conversationId: conv.id, text, idempotencyKey: `campaign:${r.id}`, origin: 'SYSTEM' });
    await db.query(`UPDATE app.marketing_campaign_recipients SET status = 'QUEUED', conversation_id = $2, message_id = $3, queued_at = now() WHERE id = $1`,
      [r.id, conv.id, sent.messageId]);
    await db.query(`UPDATE app.marketing_campaigns SET waiting_reason = NULL WHERE id = $1`, [c.id]);
    await scheduleTick(db, d.ops, organizationId, c.id, c.interval_seconds);
    return { wake: true };
  }, { organizationId });

  if (out.notify) {
    await d.notifications.notifyAdmins(organizationId, { type: out.notify.type, title: out.notify.title, body: out.notify.body,
      dedupeKey: `campaign:${out.notify.campaignId}:${out.notify.type}`, data: { campaign_id: out.notify.campaignId } }).catch(() => undefined);
  }
  if (out.wake) await d.bus.wakeOutbox().catch(() => undefined);
}
