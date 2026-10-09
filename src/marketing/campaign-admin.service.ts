import { randomUUID } from 'node:crypto';
import type { TenantContext } from '../database/tenant-context.js';
import type { Db, TransactionRunner } from '../database/transaction-runner.js';
import type { ModelProviderRegistry } from '../ai/model/model-provider.js';
import { DEFAULT_MODEL_PROVIDER, defaultModelName } from '../ai/model/providers-from-env.js';
import { OpsRepository } from '../repositories/ops.repository.js';
import type { CountryCode } from 'libphonenumber-js/max';
import { e164ToUserJid, toE164 } from '../whatsapp/domain/phone.js';
import { WhatsAppError } from '../whatsapp/domain/whatsapp-errors.js';
import { scheduleTick } from './campaign-delivery.js';
import { eligibleContactsSql, type Audience } from './consent.js';

/*
 * Marketing campaigns from the dashboard (hs_app, tenant RLS).
 * Recipients are ONLY contacts who messaged the business or have a recorded
 * opt-in, never opted-out ones. An imported list (Excel/CSV) is accepted only
 * with a note saying how those customers agreed, and never re-adds anyone who
 * opted out.
 */
const bad = (m: string): never => { throw new WhatsAppError('VALIDATION_FAILED', m); };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MAX_SELECTED = 20_000;
const MAX_IMPORT = 5_000;

function parseAudience(v: unknown): Audience {
  if (v === undefined || v === null) return { type: 'ALL' };
  if (typeof v !== 'object') bad('audience must be an object');
  const a = v as Record<string, unknown>;
  if (a.type === 'ALL') return { type: 'ALL' };
  if (a.type === 'RECENT') {
    if (!Number.isInteger(a.days) || (a.days as number) < 1 || (a.days as number) > 365) bad('audience.days must be 1-365');
    return { type: 'RECENT', days: a.days as number };
  }
  if (a.type === 'SELECTED') {
    const ids = a.contactIds;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_SELECTED || ids.some((x) => typeof x !== 'string' || !UUID_RE.test(x))) {
      bad(`audience.contactIds must be 1-${MAX_SELECTED} contact ids`);
    }
    return { type: 'SELECTED', contactIds: [...new Set(ids as string[])] };
  }
  return bad('audience.type must be ALL, RECENT or SELECTED');
}
const minutes = (v: unknown, f: string, def: number): number => {
  if (v === undefined || v === null || v === '') return def;
  const m = typeof v === 'string' ? TIME_RE.exec(v) : null;
  if (!m) bad(`${f} must be HH:MM`);
  return Number(m![1]) * 60 + Number(m![2]);
};
const hhmm = (n: number) => `${String(Math.floor(n / 60) % 24).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;

export interface CampaignInput {
  name: string; message: string; whatsappInstanceId: string; audience: Audience;
  windowStartMinute: number; windowEndMinute: number; intervalSeconds: number;
}

function parseCampaign(b: Record<string, unknown>): CampaignInput {
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (name.length < 1 || name.length > 120) bad('name must be 1-120 characters');
  const message = typeof b.message === 'string' ? b.message.trim() : '';
  if (message.length < 5 || message.length > 1500) bad('message must be 5-1500 characters');
  if (typeof b.whatsappInstanceId !== 'string' || !UUID_RE.test(b.whatsappInstanceId)) bad('whatsappInstanceId is required');
  const windowStartMinute = minutes(b.sendFrom, 'sendFrom', 9 * 60);
  const windowEndMinute = b.sendUntil === '24:00' ? 1440 : minutes(b.sendUntil, 'sendUntil', 20 * 60);
  if (windowEndMinute - windowStartMinute < 60) bad('sending hours must be at least one hour long');
  const intervalSeconds = b.intervalSeconds === undefined ? 30 : Number(b.intervalSeconds);
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 15 || intervalSeconds > 3600) bad('intervalSeconds must be 15-3600');
  return { name, message, whatsappInstanceId: b.whatsappInstanceId as string, audience: parseAudience(b.audience), windowStartMinute, windowEndMinute, intervalSeconds };
}

const CAMPAIGN_COLS = `c.id, c.name, c.message, c.audience, c.status, c.scheduled_at AS "scheduledAt", c.window_start_minute, c.window_end_minute,
  c.interval_seconds AS "intervalSeconds", c.waiting_reason AS "waitingReason", c.pause_reason AS "pauseReason", c.recipient_count AS "recipientCount",
  c.whatsapp_instance_id AS "whatsappInstanceId", i.instance_name AS "whatsappName", i.phone_e164 AS "whatsappPhone",
  c.started_at AS "startedAt", c.completed_at AS "completedAt", c.created_at AS "createdAt"`;

const STATS_SQL = `
  SELECT count(*)::int AS total,
         count(*) FILTER (WHERE r.status = 'PENDING')::int AS pending,
         count(*) FILTER (WHERE r.status = 'SKIPPED')::int AS skipped,
         count(*) FILTER (WHERE r.status = 'QUEUED')::int AS sent,
         count(*) FILTER (WHERE m.status IN ('DELIVERED','READ'))::int AS delivered,
         count(*) FILTER (WHERE m.status = 'READ')::int AS read,
         count(*) FILTER (WHERE m.status = 'FAILED')::int AS failed,
         count(*) FILTER (WHERE r.status = 'QUEUED' AND EXISTS (
           SELECT 1 FROM app.messages x WHERE x.conversation_id = r.conversation_id AND x.direction = 'INBOUND' AND x.created_at > r.queued_at))::int AS replied,
         count(*) FILTER (WHERE r.status = 'QUEUED' AND p.status = 'OPTED_OUT' AND p.changed_at >= r.queued_at)::int AS "optedOut"
    FROM app.marketing_campaign_recipients r
    LEFT JOIN app.messages m ON m.id = r.message_id
    LEFT JOIN app.marketing_contact_prefs p ON p.contact_id = r.contact_id
   WHERE r.campaign_id = $1`;

export class CampaignAdminService {
  private readonly ops = new OpsRepository();

  constructor(private readonly tx: TransactionRunner, private readonly models?: ModelProviderRegistry) {}

  private async business(db: Db, ctx: TenantContext, businessId: string) {
    if (ctx.businessId && ctx.businessId !== businessId) throw new WhatsAppError('NOT_FOUND', 'business not found');
    const b = (await db.query('SELECT id, name FROM app.businesses WHERE id = $1 AND deleted_at IS NULL', [businessId])).rows[0];
    if (!b) throw new WhatsAppError('NOT_FOUND', 'business not found');
    return b as { id: string; name: string };
  }
  private audit(db: Db, ctx: TenantContext, action: string, id: string, metadata: object = {}) {
    return this.ops.audit(db, { organizationId: ctx.organizationId, actorType: ctx.apiKeyId ? 'API_KEY' : 'USER', actorUserId: ctx.userId,
      actorApiKeyId: ctx.apiKeyId, action, resourceType: 'MARKETING_CAMPAIGN', resourceId: id, requestId: ctx.requestId, metadata });
  }
  private async campaign(db: Db, businessId: string, id: string, lock = false) {
    const c = (await db.query(`SELECT ${CAMPAIGN_COLS} FROM app.marketing_campaigns c JOIN app.whatsapp_instances i ON i.id = c.whatsapp_instance_id
                                WHERE c.id = $1 AND c.business_id = $2 ${lock ? 'FOR UPDATE OF c' : ''}`, [id, businessId])).rows[0];
    if (!c) throw new WhatsAppError('NOT_FOUND', 'campaign not found');
    return c;
  }
  private view(c: Record<string, any>) {
    const { window_start_minute: s, window_end_minute: e, ...rest } = c;
    return { ...rest, sendFrom: hhmm(s), sendUntil: e === 1440 ? '24:00' : hhmm(e) };
  }

  // ------------------------------------------------------------- audience ---
  /** Who a campaign would reach, and who is left out and why. */
  audience(ctx: TenantContext, businessId: string, rawAudience: unknown) {
    const a = parseAudience(rawAudience);
    return this.tx.inTenant(async (db) => {
      await this.business(db, ctx, businessId);
      const el = eligibleContactsSql(a);
      const eligible = (await db.query(`SELECT count(*)::int AS n FROM app.contacts c LEFT JOIN app.marketing_contact_prefs p ON p.contact_id = c.id WHERE ${el.where}`,
        [businessId, ...el.params])).rows[0].n as number;
      const all = (await db.query(
        `SELECT count(*) FILTER (WHERE p.status = 'OPTED_OUT')::int AS "optedOut",
                count(*) FILTER (WHERE coalesce(p.status, '') <> 'OPTED_OUT' AND coalesce(p.status, '') <> 'OPTED_IN'
                  AND NOT EXISTS (SELECT 1 FROM app.messages m WHERE m.contact_id = c.id AND m.direction = 'INBOUND'))::int AS "noConsent"
           FROM app.contacts c LEFT JOIN app.marketing_contact_prefs p ON p.contact_id = c.id
          WHERE c.business_id = $1 AND c.deleted_at IS NULL AND c.status = 'ACTIVE' AND c.whatsapp_jid NOT LIKE '%@g.us'`, [businessId])).rows[0];
      const ent = (await db.query(`SELECT enabled, limit_value FROM app.current_entitlement('MARKETING_DAILY_CONTACTS')`)).rows[0];
      return { eligible, optedOut: all.optedOut, noConsent: all.noConsent, dailyLimit: ent ? (ent.enabled ? (ent.limit_value === null ? null : Number(ent.limit_value)) : 0) : 50 };
    });
  }

  /** Contacts with their marketing status, for the consent list. */
  contacts(ctx: TenantContext, businessId: string, o: { q?: string; status?: string }) {
    const status = o.status ?? 'ALL';
    if (!['ALL', 'ELIGIBLE', 'OPTED_OUT', 'NO_CONSENT'].includes(status)) bad('invalid status');
    const q = (o.q ?? '').trim().slice(0, 60);
    return this.tx.inTenant(async (db) => {
      await this.business(db, ctx, businessId);
      const r = await db.query(
        `SELECT * FROM (
           SELECT c.id, coalesce(c.display_name, c.profile_name) AS name, c.phone_e164 AS phone, c.last_seen_at AS "lastSeenAt",
                  p.status AS pref, p.source AS "prefSource", p.note AS "prefNote", p.changed_at AS "prefChangedAt",
                  EXISTS (SELECT 1 FROM app.messages m WHERE m.contact_id = c.id AND m.direction = 'INBOUND') AS chatted
             FROM app.contacts c LEFT JOIN app.marketing_contact_prefs p ON p.contact_id = c.id
            WHERE c.business_id = $1 AND c.deleted_at IS NULL AND c.status = 'ACTIVE' AND c.whatsapp_jid NOT LIKE '%@g.us'
              AND ($2 = '' OR coalesce(c.display_name, c.profile_name, '') ILIKE '%' || $2 || '%' OR coalesce(c.phone_e164, '') LIKE '%' || $2 || '%')) x
          WHERE $3 = 'ALL'
             OR ($3 = 'OPTED_OUT' AND x.pref = 'OPTED_OUT')
             OR ($3 = 'ELIGIBLE' AND coalesce(x.pref, '') <> 'OPTED_OUT' AND (x.pref = 'OPTED_IN' OR x.chatted))
             OR ($3 = 'NO_CONSENT' AND x.pref IS NULL AND NOT x.chatted)
          ORDER BY x."lastSeenAt" DESC LIMIT 200`, [businessId, q, status]);
      return r.rows.map((x) => ({ ...x, marketing: x.pref === 'OPTED_OUT' ? 'OPTED_OUT' : x.pref === 'OPTED_IN' ? 'OPTED_IN' : x.chatted ? 'CHATTED' : 'NO_CONSENT' }));
    });
  }

  /** Owner records that a customer agreed (with how), or removes them from marketing. */
  setPreference(ctx: TenantContext, businessId: string, contactId: string, b: Record<string, unknown>) {
    const status = b.status;
    if (status !== 'OPTED_IN' && status !== 'OPTED_OUT') bad('status must be OPTED_IN or OPTED_OUT');
    const note = typeof b.note === 'string' ? b.note.trim().slice(0, 300) : '';
    if (status === 'OPTED_IN' && note.length < 3) bad('say how the customer agreed to receive offers (note)');
    return this.tx.inTenant(async (db) => {
      await this.business(db, ctx, businessId);
      const c = (await db.query(`SELECT id FROM app.contacts WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL`, [contactId, businessId])).rows[0];
      if (!c) throw new WhatsAppError('NOT_FOUND', 'contact not found');
      const cur = (await db.query(`SELECT status, source FROM app.marketing_contact_prefs WHERE contact_id = $1`, [contactId])).rows[0];
      // A customer's own STOP can only be undone by the customer (START), never by the business.
      if (status === 'OPTED_IN' && cur?.status === 'OPTED_OUT' && cur.source === 'KEYWORD') {
        throw new WhatsAppError('CONFLICT', 'this customer replied STOP; only they can opt back in by sending START');
      }
      await db.query(
        `INSERT INTO app.marketing_contact_prefs (organization_id, business_id, contact_id, status, source, note, changed_by_user_id, changed_at)
         VALUES ($1, $2, $3, $4, 'MANUAL', $5, $6, now())
         ON CONFLICT (contact_id) DO UPDATE SET status = EXCLUDED.status, source = 'MANUAL', note = EXCLUDED.note,
           changed_by_user_id = EXCLUDED.changed_by_user_id, changed_at = now()`,
        [ctx.organizationId, businessId, contactId, status, note || null, ctx.userId ?? null]);
      await this.audit(db, ctx, status === 'OPTED_IN' ? 'MARKETING_OPT_IN' : 'MARKETING_OPT_OUT', contactId, { note });
      return { contactId, status };
    });
  }

  /**
   * Imports customers from a spreadsheet the owner uploaded: creates/updates the
   * contacts, records their opt-in with the owner's note, and returns the ids to
   * use as a SELECTED audience. Opted-out customers are counted, never re-added.
   */
  importContacts(ctx: TenantContext, businessId: string, b: Record<string, unknown>) {
    const note = typeof b.note === 'string' ? b.note.trim().slice(0, 300) : '';
    if (note.length < 3) bad('say how these customers agreed to receive offers (note)');
    const rows = b.rows as unknown[];
    if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_IMPORT) bad(`rows must be 1-${MAX_IMPORT} customers`);
    return this.tx.inTenant(async (db) => {
      await this.business(db, ctx, businessId);
      const country = ((await db.query('SELECT country_code FROM app.businesses WHERE id = $1', [businessId])).rows[0]?.country_code ?? 'IN') as CountryCode;
      const invalid: { row: number; phone: string }[] = [];
      const byPhone = new Map<string, string | null>();
      rows.forEach((x, i) => {
        const r = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
        const raw = String(r.phone ?? '').trim();
        const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 120) : null;
        try { const e = toE164(raw, country); byPhone.set(e, name ?? byPhone.get(e) ?? null); }
        catch { invalid.push({ row: i + 1, phone: raw.slice(0, 40) }); }
      });
      const contactIds: string[] = [];
      let created = 0; let optedOut = 0;
      for (const [phone, name] of byPhone) {
        const c = (await db.query(
          `INSERT INTO app.contacts (organization_id, business_id, whatsapp_jid, phone_e164, display_name, source)
           VALUES ($1, $2, $3, $4, $5, 'IMPORT')
           ON CONFLICT (business_id, whatsapp_jid) WHERE deleted_at IS NULL
           DO UPDATE SET display_name = coalesce(app.contacts.display_name, EXCLUDED.display_name),
                         phone_e164 = coalesce(app.contacts.phone_e164, EXCLUDED.phone_e164)
           RETURNING id, (xmax = 0) AS inserted`,
          [ctx.organizationId, businessId, e164ToUserJid(phone), phone, name])).rows[0];
        if (c.inserted) created++;
        const cur = (await db.query(`SELECT status FROM app.marketing_contact_prefs WHERE contact_id = $1`, [c.id])).rows[0];
        // Anyone who opted out (STOP, or removed by the business) stays out.
        if (cur?.status === 'OPTED_OUT') { optedOut++; continue; }
        if (!cur) {
          await db.query(
            `INSERT INTO app.marketing_contact_prefs (organization_id, business_id, contact_id, status, source, note, changed_by_user_id, changed_at)
             VALUES ($1, $2, $3, 'OPTED_IN', 'MANUAL', $4, $5, now()) ON CONFLICT (contact_id) DO NOTHING`,
            [ctx.organizationId, businessId, c.id, note, ctx.userId ?? null]);
        }
        contactIds.push(c.id);
      }
      await this.audit(db, ctx, 'MARKETING_CONTACTS_IMPORTED', businessId, { rows: rows.length, added: contactIds.length, created, optedOut, invalid: invalid.length, note });
      return { contactIds, added: contactIds.length, created, optedOut, invalidCount: invalid.length, invalid: invalid.slice(0, 50) };
    });
  }

  // ------------------------------------------------------------- campaigns ---
  list(ctx: TenantContext, businessId: string) {
    return this.tx.inTenant(async (db) => {
      await this.business(db, ctx, businessId);
      const rows = (await db.query(`SELECT ${CAMPAIGN_COLS} FROM app.marketing_campaigns c JOIN app.whatsapp_instances i ON i.id = c.whatsapp_instance_id
                                     WHERE c.business_id = $1 ORDER BY c.created_at DESC LIMIT 100`, [businessId])).rows;
      const out = [];
      for (const c of rows) out.push({ ...this.view(c), stats: (await db.query(STATS_SQL, [c.id])).rows[0] });
      return out;
    });
  }

  get(ctx: TenantContext, businessId: string, id: string) {
    return this.tx.inTenant(async (db) => {
      await this.business(db, ctx, businessId);
      const c = await this.campaign(db, businessId, id);
      return { ...this.view(c), stats: (await db.query(STATS_SQL, [id])).rows[0] };
    });
  }

  create(ctx: TenantContext, businessId: string, b: Record<string, unknown>) {
    const input = parseCampaign(b);
    return this.tx.inTenant(async (db) => {
      await this.business(db, ctx, businessId);
      const inst = (await db.query(`SELECT id FROM app.whatsapp_instances WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL`, [input.whatsappInstanceId, businessId])).rows[0];
      if (!inst) bad('choose a WhatsApp number of this business');
      const id: string = (await db.query(
        `INSERT INTO app.marketing_campaigns (organization_id, business_id, whatsapp_instance_id, name, message, audience, window_start_minute, window_end_minute,
                                              interval_seconds, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [ctx.organizationId, businessId, input.whatsappInstanceId, input.name, input.message, JSON.stringify(input.audience), input.windowStartMinute,
         input.windowEndMinute, input.intervalSeconds, ctx.userId ?? null])).rows[0].id;
      await this.audit(db, ctx, 'CAMPAIGN_CREATED', id, { name: input.name });
      return this.view(await this.campaign(db, businessId, id));
    });
  }

  update(ctx: TenantContext, businessId: string, id: string, b: Record<string, unknown>) {
    const input = parseCampaign(b);
    return this.tx.inTenant(async (db) => {
      await this.business(db, ctx, businessId);
      const c = await this.campaign(db, businessId, id, true);
      if (c.status !== 'DRAFT') throw new WhatsAppError('CONFLICT', 'only a draft campaign can be edited');
      const inst = (await db.query(`SELECT id FROM app.whatsapp_instances WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL`, [input.whatsappInstanceId, businessId])).rows[0];
      if (!inst) bad('choose a WhatsApp number of this business');
      await db.query(
        `UPDATE app.marketing_campaigns SET name = $2, message = $3, audience = $4, whatsapp_instance_id = $5, window_start_minute = $6,
                window_end_minute = $7, interval_seconds = $8 WHERE id = $1`,
        [id, input.name, input.message, JSON.stringify(input.audience), input.whatsappInstanceId, input.windowStartMinute, input.windowEndMinute, input.intervalSeconds]);
      return this.view(await this.campaign(db, businessId, id));
    });
  }

  /** Takes the audience snapshot and starts (or schedules) paced sending. */
  start(ctx: TenantContext, businessId: string, id: string, b: Record<string, unknown>) {
    let at: Date | null = null;
    if (b.scheduledAt !== undefined && b.scheduledAt !== null && b.scheduledAt !== '') {
      at = new Date(String(b.scheduledAt));
      if (Number.isNaN(at.getTime())) bad('scheduledAt must be a date-time');
      if (at.getTime() > Date.now() + 90 * 86_400_000) bad('scheduledAt must be within 90 days');
      if (at.getTime() <= Date.now()) at = null;
    }
    return this.tx.inTenant(async (db) => {
      await this.business(db, ctx, businessId);
      const c = await this.campaign(db, businessId, id, true);
      if (c.status !== 'DRAFT') throw new WhatsAppError('CONFLICT', 'this campaign has already been started');
      const ent = (await db.query(`SELECT enabled FROM app.current_entitlement('MARKETING_DAILY_CONTACTS')`)).rows[0];
      if (ent && !ent.enabled) throw new WhatsAppError('FEATURE_NOT_IN_PLAN', 'marketing campaigns are not included in the current plan');
      const el = eligibleContactsSql(c.audience as Audience);
      const n = (await db.query(
        `INSERT INTO app.marketing_campaign_recipients (organization_id, campaign_id, business_id, contact_id)
         SELECT c.organization_id, $${el.params.length + 2}::uuid, c.business_id, c.id
           FROM app.contacts c LEFT JOIN app.marketing_contact_prefs p ON p.contact_id = c.id
          WHERE ${el.where}
          ORDER BY c.last_seen_at DESC
         ON CONFLICT DO NOTHING`, [businessId, ...el.params, id])).rowCount ?? 0;
      if (n === 0) bad('no customer can receive this campaign yet: only people who messaged you or agreed to receive offers are included');
      await db.query(
        `UPDATE app.marketing_campaigns SET status = $2, scheduled_at = $3, recipient_count = $4, started_at = CASE WHEN $2 = 'SENDING' THEN now() END,
                pause_reason = NULL WHERE id = $1`, [id, at ? 'SCHEDULED' : 'SENDING', at, n]);
      await scheduleTick(db, this.ops, ctx.organizationId, id, at ? (at.getTime() - Date.now()) / 1000 : 0);
      await this.audit(db, ctx, 'CAMPAIGN_STARTED', id, { recipients: n, scheduledAt: at });
      return this.view(await this.campaign(db, businessId, id));
    });
  }

  pause(ctx: TenantContext, businessId: string, id: string) {
    return this.transition(ctx, businessId, id, ['SENDING', 'SCHEDULED'], 'PAUSED', false, 'CAMPAIGN_PAUSED');
  }
  resume(ctx: TenantContext, businessId: string, id: string) {
    return this.transition(ctx, businessId, id, ['PAUSED'], 'SENDING', true, 'CAMPAIGN_RESUMED');
  }
  cancel(ctx: TenantContext, businessId: string, id: string) {
    return this.transition(ctx, businessId, id, ['DRAFT', 'SCHEDULED', 'SENDING', 'PAUSED'], 'CANCELLED', false, 'CAMPAIGN_CANCELLED');
  }

  private transition(ctx: TenantContext, businessId: string, id: string, from: string[], to: string, tick: boolean, action: string) {
    return this.tx.inTenant(async (db) => {
      await this.business(db, ctx, businessId);
      const c = await this.campaign(db, businessId, id, true);
      if (!from.includes(c.status)) throw new WhatsAppError('CONFLICT', 'this campaign cannot be changed in its current state');
      await db.query(
        `UPDATE app.marketing_campaigns SET status = $2, waiting_reason = NULL,
                pause_reason = CASE WHEN $2 = 'PAUSED' THEN 'Paused by you.' WHEN $2 = 'SENDING' THEN NULL ELSE pause_reason END,
                started_at = CASE WHEN $2 = 'SENDING' THEN coalesce(started_at, now()) ELSE started_at END,
                tick_seq = tick_seq + 1 WHERE id = $1`, [id, to]);
      if (tick) await scheduleTick(db, this.ops, ctx.organizationId, id, 0);
      await this.audit(db, ctx, action, id);
      return this.view(await this.campaign(db, businessId, id));
    });
  }

  // ------------------------------------------------------------- AI draft ---
  /** Three message options written by AI from the owner's short brief; the owner picks and edits one. */
  async aiDraft(ctx: TenantContext, businessId: string, b: Record<string, unknown>): Promise<{ options: string[] }> {
    const brief = typeof b.brief === 'string' ? b.brief.trim() : '';
    if (brief.length < 5 || brief.length > 600) bad('brief must be 5-600 characters');
    const language = ['HINGLISH', 'HINDI', 'ENGLISH'].includes(String(b.language)) ? String(b.language) : 'HINGLISH';
    const biz = await this.tx.inTenant((db) => this.business(db, ctx, businessId));
    const provider = this.models?.get(DEFAULT_MODEL_PROVIDER);
    if (!provider?.configured) throw new WhatsAppError('CONFLICT', 'AI writing is not available right now');
    const lang = language === 'HINDI' ? 'simple Hindi in Devanagari script' : language === 'ENGLISH' ? 'simple English' : 'Hinglish (Hindi written in Roman letters)';
    const res = await provider.generate({
      model: defaultModelName(),
      instructions: `You write short WhatsApp marketing messages for "${biz.name}", an Indian business, to send to its existing customers.
Write 3 different options in ${lang}. Each option: 2-5 short lines, friendly and respectful, at most 3 emojis, WhatsApp *bold* for the key offer,
start with "Namaste {name} ji" (keep {name} exactly; it is replaced with the customer's name), one clear next step (e.g. "reply karein"),
Never invent prices, discounts, dates or claims that are not in the brief. No links unless the brief gives one.
Reply with ONLY a JSON array of 3 strings.`,
      items: [{ kind: 'user', text: brief }],
      tools: [],
      reasoningEffort: 'minimal',
      maxOutputTokens: 1_200,
      timeoutMs: 30_000,
      requestId: randomUUID(),
    });
    try {
      const raw = (res.text ?? '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
      const arr = JSON.parse(raw);
      const options = Array.isArray(arr) ? arr.filter((x) => typeof x === 'string' && x.trim().length >= 5).map((x: string) => x.trim().slice(0, 1500)).slice(0, 3) : [];
      if (!options.length) throw new Error('empty');
      return { options };
    } catch {
      throw new WhatsAppError('CONFLICT', 'AI could not write the message this time, please try again');
    }
  }
}
