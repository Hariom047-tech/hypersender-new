import type { CountryCode } from 'libphonenumber-js/max';
import type { TenantContext } from '../database/tenant-context.js';
import type { Db, TransactionRunner } from '../database/transaction-runner.js';
import { CalendarError, type GoogleCalendarService } from '../integrations/google-calendar.js';
import { OpsRepository } from '../repositories/ops.repository.js';
import { WhatsAppError } from '../whatsapp/domain/whatsapp-errors.js';
import { InvalidPhoneNumberError, toE164 } from '../whatsapp/domain/phone.js';

/*
 * Pandit Ji's side (dashboard, hs_app, tenant RLS): temple/contact settings,
 * the three havan packages, special dates, the call-back list and the havan
 * details of bookings (e.g. marking dakshina as agreed after the call).
 * There is intentionally no price field anywhere: dakshina is only ever
 * discussed by Pandit Ji on a call.
 */
const bad = (m: string): never => { throw new WhatsAppError('VALIDATION_FAILED', m); };
const text = (v: unknown, f: string, max: number, required = false): string | null => {
  if (v === undefined || v === null || v === '') { if (required) bad(`${f} is required`); return null; }
  if (typeof v !== 'string' || v.trim().length === 0 || v.length > max) bad(`${f} must be 1-${max} characters`);
  return (v as string).trim();
};
const int = (v: unknown, f: string, min: number, max: number): number | null => {
  if (v === undefined || v === null || v === '') return null;
  if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) bad(`${f} must be ${min}-${max}`);
  return v as number;
};
const bool = (v: unknown, def: boolean) => (v === undefined || v === null ? def : Boolean(v));
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TIERS = ['SAMANYA', 'VISHESH', 'MAHA_VISHESH'] as const;
/** What each tier means for this Pandit (used as defaults when a package is first created). */
const TIER_DEFAULTS: Record<string, { name: string; herbCount: number | null; description: string }> = {
  SAMANYA: { name: 'Samanya Havan', herbCount: null, description: 'Samanya havan samagri se kiya jane wala havan.' },
  VISHESH: { name: 'Vishesh Havan', herbCount: 21, description: 'Samagri ke saath 21 prakar ki jadi-butiyon se kiya jane wala havan.' },
  MAHA_VISHESH: { name: 'Maha Vishesh Havan', herbCount: 31, description: 'Samagri ke saath 31 prakar ki jadi-butiyon se kiya jane wala havan.' },
};

export class HavanAdminService {
  private readonly ops = new OpsRepository();

  constructor(private readonly tx: TransactionRunner, private readonly calendar?: GoogleCalendarService) {}

  private async business(db: Db, ctx: TenantContext, businessId: string) {
    if (ctx.businessId && ctx.businessId !== businessId) throw new WhatsAppError('NOT_FOUND', 'business not found');
    const b = (await db.query('SELECT id, country_code FROM app.businesses WHERE id = $1 AND deleted_at IS NULL', [businessId])).rows[0];
    if (!b) throw new WhatsAppError('NOT_FOUND', 'business not found');
    return b as { id: string; country_code: string | null };
  }
  private audit(db: Db, ctx: TenantContext, action: string, type: string, id?: string, metadata: object = {}) {
    return this.ops.audit(db, { organizationId: ctx.organizationId, actorType: ctx.apiKeyId ? 'API_KEY' : 'USER', actorUserId: ctx.userId,
      actorApiKeyId: ctx.apiKeyId, action, resourceType: type, resourceId: id, requestId: ctx.requestId, metadata });
  }

  // ------------------------------------------------------------- settings ---
  getSettings(ctx: TenantContext, businessId: string) {
    return this.tx.inTenant(async (db) => {
      await this.business(db, ctx, businessId);
      const s = (await db.query(
        `SELECT pandit_display_name AS "panditDisplayName", pandit_whatsapp_e164 AS "panditWhatsapp", temple_name AS "templeName",
                temple_address AS "templeAddress", temple_map_url AS "templeMapUrl", darshan_timings AS "darshanTimings", how_to_reach AS "howToReach",
                temple_rules AS "templeRules", temple_notes AS "templeNotes", online_havan_offered AS "onlineHavanOffered",
                reminder_lead_minutes AS "reminderLeadMinutes"
           FROM app.havan_settings WHERE business_id = $1`, [businessId])).rows[0];
      return s ?? { configured: false, onlineHavanOffered: true, reminderLeadMinutes: 1440 };
    }, ctx, { readOnly: true });
  }

  saveSettings(ctx: TenantContext, businessId: string, b: Record<string, unknown>) {
    return this.tx.inTenant(async (db) => {
      const biz = await this.business(db, ctx, businessId);
      let phone: string | null = null;
      if (b.panditWhatsapp !== undefined && b.panditWhatsapp !== null && b.panditWhatsapp !== '') {
        try { phone = toE164(String(b.panditWhatsapp), (biz.country_code ?? 'IN') as CountryCode); } catch (e) {
          if (e instanceof InvalidPhoneNumberError) bad('panditWhatsapp is not a valid phone number');
          throw e;
        }
      }
      const url = text(b.templeMapUrl, 'templeMapUrl', 500);
      if (url && !/^https:\/\//.test(url)) bad('templeMapUrl must start with https://');
      const lead = int(b.reminderLeadMinutes, 'reminderLeadMinutes', 30, 4320) ?? 1440;
      await db.query(
        `INSERT INTO app.havan_settings (business_id, organization_id, pandit_display_name, pandit_whatsapp_e164, temple_name, temple_address, temple_map_url,
                                         darshan_timings, how_to_reach, temple_rules, temple_notes, online_havan_offered, reminder_lead_minutes)
         VALUES ($1, app.current_org_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (business_id) DO UPDATE SET pandit_display_name = EXCLUDED.pandit_display_name, pandit_whatsapp_e164 = EXCLUDED.pandit_whatsapp_e164,
           temple_name = EXCLUDED.temple_name, temple_address = EXCLUDED.temple_address, temple_map_url = EXCLUDED.temple_map_url,
           darshan_timings = EXCLUDED.darshan_timings, how_to_reach = EXCLUDED.how_to_reach, temple_rules = EXCLUDED.temple_rules,
           temple_notes = EXCLUDED.temple_notes, online_havan_offered = EXCLUDED.online_havan_offered, reminder_lead_minutes = EXCLUDED.reminder_lead_minutes`,
        [businessId, text(b.panditDisplayName, 'panditDisplayName', 100), phone, text(b.templeName, 'templeName', 150), text(b.templeAddress, 'templeAddress', 500),
         url, text(b.darshanTimings, 'darshanTimings', 1000), text(b.howToReach, 'howToReach', 2000), text(b.templeRules, 'templeRules', 2000),
         text(b.templeNotes, 'templeNotes', 2000), bool(b.onlineHavanOffered, true), lead]);
      await this.audit(db, ctx, 'HAVAN_SETTINGS_UPDATED', 'BUSINESS', businessId, { panditWhatsappSet: String(Boolean(phone)) });
      return { saved: true, panditWhatsapp: phone };
    }, ctx);
  }

  // ------------------------------------------------------------- packages ---
  listPackages(ctx: TenantContext, businessId: string) {
    return this.tx.inTenant(async (db) => {
      await this.business(db, ctx, businessId);
      return (await db.query(
        `SELECT p.id, p.tier, p.name, p.description, p.herb_count AS "herbCount", p.herbs, p.samagri_notes AS "samagriNotes", p.service_id AS "serviceId",
                s.name AS "serviceName", p.duration_minutes AS "durationMinutes", p.pandit_count AS "panditCount", p.in_person_available AS "inPersonAvailable",
                p.online_available AS "onlineAvailable", p.online_live_video AS "onlineLiveVideo", p.online_recording AS "onlineRecording",
                p.online_photos AS "onlinePhotos", p.prasad_courier AS "prasadCourier", p.international_courier AS "internationalCourier",
                p.yajman_preparation AS "yajmanPreparation", p.active
           FROM app.havan_packages p LEFT JOIN app.services s ON s.id = p.service_id
          WHERE p.business_id = $1 AND p.deleted_at IS NULL ORDER BY array_position(ARRAY['SAMANYA','VISHESH','MAHA_VISHESH'], p.tier)`, [businessId])).rows;
    }, ctx, { readOnly: true });
  }

  /** Create or update the package of one tier (there is at most one per tier). */
  savePackage(ctx: TenantContext, businessId: string, tier: string, b: Record<string, unknown>) {
    if (!(TIERS as readonly string[]).includes(tier)) bad('tier must be SAMANYA, VISHESH or MAHA_VISHESH');
    const d = TIER_DEFAULTS[tier];
    const herbs = b.herbs === undefined || b.herbs === null ? [] : b.herbs;
    if (!Array.isArray(herbs) || herbs.length > 108 || !herbs.every((h) => typeof h === 'string' && h.trim().length > 0 && h.length <= 60)) bad('herbs must be a list of names');
    const inPerson = bool(b.inPersonAvailable, true);
    const online = bool(b.onlineAvailable, true);
    if (!inPerson && !online) bad('offer at least Nalkheda in person or online');
    return this.tx.inTenant(async (db) => {
      await this.business(db, ctx, businessId);
      // Optional legacy link to a business service; a havan type is bookable on its own (duration below).
      let serviceId: string | null = null;
      if (b.serviceId) {
        const s = (await db.query('SELECT id FROM app.services WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL', [b.serviceId, businessId])).rows[0];
        if (!s) bad('serviceId must be one of your services');
        serviceId = s.id;
      }
      const v = [text(b.name, 'name', 120) ?? d.name, text(b.description, 'description', 2000) ?? d.description,
        int(b.herbCount, 'herbCount', 1, 108) ?? d.herbCount, (herbs as string[]).map((h) => h.trim()), text(b.samagriNotes, 'samagriNotes', 2000), serviceId,
        int(b.durationMinutes, 'durationMinutes', 15, 1440) ?? 120, int(b.panditCount, 'panditCount', 1, 51), inPerson, online,
        bool(b.onlineLiveVideo, false), bool(b.onlineRecording, false), bool(b.onlinePhotos, false), bool(b.prasadCourier, false),
        bool(b.internationalCourier, false), text(b.yajmanPreparation, 'yajmanPreparation', 2000), bool(b.active, true)];
      const r = await db.query(
        `INSERT INTO app.havan_packages (organization_id, business_id, tier, name, description, herb_count, herbs, samagri_notes, service_id, duration_minutes,
                                         pandit_count, in_person_available, online_available, online_live_video, online_recording, online_photos,
                                         prasad_courier, international_courier, yajman_preparation, active)
         VALUES (app.current_org_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
         ON CONFLICT (business_id, tier) WHERE deleted_at IS NULL DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description,
           herb_count = EXCLUDED.herb_count, herbs = EXCLUDED.herbs, samagri_notes = EXCLUDED.samagri_notes, service_id = EXCLUDED.service_id,
           duration_minutes = EXCLUDED.duration_minutes, pandit_count = EXCLUDED.pandit_count, in_person_available = EXCLUDED.in_person_available,
           online_available = EXCLUDED.online_available, online_live_video = EXCLUDED.online_live_video, online_recording = EXCLUDED.online_recording,
           online_photos = EXCLUDED.online_photos, prasad_courier = EXCLUDED.prasad_courier, international_courier = EXCLUDED.international_courier,
           yajman_preparation = EXCLUDED.yajman_preparation, active = EXCLUDED.active
         RETURNING id`, [businessId, tier, ...v]);
      await this.audit(db, ctx, 'HAVAN_PACKAGE_SAVED', 'HAVAN_PACKAGE', r.rows[0].id, { tier });
      return { id: r.rows[0].id, tier };
    }, ctx);
  }

  deletePackage(ctx: TenantContext, businessId: string, tier: string) {
    return this.tx.inTenant(async (db) => {
      await this.business(db, ctx, businessId);
      const r = await db.query(`UPDATE app.havan_packages SET deleted_at = now(), active = false WHERE business_id = $1 AND tier = $2 AND deleted_at IS NULL RETURNING id`,
        [businessId, tier]);
      if (!r.rows[0]) throw new WhatsAppError('NOT_FOUND', 'package not found');
      await this.audit(db, ctx, 'HAVAN_PACKAGE_DELETED', 'HAVAN_PACKAGE', r.rows[0].id, { tier });
      return { deleted: true };
    }, ctx);
  }

  // -------------------------------------------------------- special dates ---
  listSpecialDates(ctx: TenantContext, businessId: string) {
    return this.tx.inTenant(async (db) => {
      await this.business(db, ctx, businessId);
      const own = (await db.query(
        `SELECT id, name, starts_on::text AS "startsOn", ends_on::text AS "endsOn", notes FROM app.havan_special_dates
          WHERE business_id = $1 AND ends_on >= current_date - 30 ORDER BY starts_on`, [businessId])).rows;
      const platform = (await db.query(
        `SELECT name, kind, starts_on::text AS "startsOn", ends_on::text AS "endsOn", notes FROM app.festival_calendar
          WHERE ends_on >= current_date - 30 ORDER BY starts_on LIMIT 30`)).rows;
      return { specialDates: own, festivals: platform };
    }, ctx, { readOnly: true });
  }

  addSpecialDate(ctx: TenantContext, businessId: string, b: Record<string, unknown>) {
    const name = text(b.name, 'name', 120, true);
    const from = String(b.startsOn ?? '');
    const to = String(b.endsOn ?? b.startsOn ?? '');
    if (!DATE_RE.test(from) || !DATE_RE.test(to) || to < from) bad('startsOn/endsOn must be dates (YYYY-MM-DD), endsOn not before startsOn');
    return this.tx.inTenant(async (db) => {
      await this.business(db, ctx, businessId);
      const r = await db.query(`INSERT INTO app.havan_special_dates (organization_id, business_id, name, starts_on, ends_on, notes)
                                VALUES (app.current_org_id(), $1, $2, $3, $4, $5) RETURNING id`, [businessId, name, from, to, text(b.notes, 'notes', 500)]);
      return { id: r.rows[0].id };
    }, ctx);
  }

  deleteSpecialDate(ctx: TenantContext, businessId: string, id: string) {
    return this.tx.inTenant(async (db) => {
      await this.business(db, ctx, businessId);
      const r = await db.query('DELETE FROM app.havan_special_dates WHERE id = $1 AND business_id = $2', [id, businessId]);
      if (!r.rowCount) throw new WhatsAppError('NOT_FOUND', 'special date not found');
      return { deleted: true };
    }, ctx);
  }

  // ------------------------------------------------------------ call-backs ---
  listCallbacks(ctx: TenantContext, businessId: string, status: 'NEW' | 'CALLED' | 'CLOSED' | 'ALL') {
    return this.tx.inTenant(async (db) => {
      await this.business(db, ctx, businessId);
      return (await db.query(
        `SELECT r.id, r.status, r.callback_phone_e164 AS "phone", r.preferred_call_time AS "preferredCallTime", r.reason, r.tier,
                r.participation_mode AS "participationMode", r.summary, r.conversation_id AS "conversationId", r.created_at AS "createdAt",
                r.updated_at AS "updatedAt", r.called_at AS "calledAt", coalesce(c.display_name, c.profile_name) AS "customerName"
           FROM app.havan_callback_requests r JOIN app.contacts c ON c.id = r.contact_id
          WHERE r.business_id = $1 AND ($2 = 'ALL' OR r.status = $2) ORDER BY r.created_at DESC LIMIT 200`, [businessId, status])).rows;
    }, ctx, { readOnly: true });
  }

  setCallbackStatus(ctx: TenantContext, businessId: string, id: string, status: 'CALLED' | 'CLOSED') {
    return this.tx.inTenant(async (db) => {
      await this.business(db, ctx, businessId);
      const r = await db.query(
        `UPDATE app.havan_callback_requests SET status = $3, called_at = CASE WHEN $3 = 'CALLED' THEN coalesce(called_at, now()) ELSE called_at END
          WHERE id = $1 AND business_id = $2 RETURNING id, status`, [id, businessId, status]);
      if (!r.rows[0]) throw new WhatsAppError('NOT_FOUND', 'call-back not found');
      await this.audit(db, ctx, 'HAVAN_CALLBACK_STATUS', 'HAVAN_CALLBACK', id, { status });
      return r.rows[0];
    }, ctx);
  }

  // ------------------------------------------------------- google calendar ---
  calendarStatus(ctx: TenantContext, businessId: string) {
    return this.tx.inTenant(async (db) => {
      await this.business(db, ctx, businessId);
      if (!this.calendar) return { configured: false, connected: false };
      return this.calendar.status(db, businessId);
    }, ctx, { readOnly: true });
  }

  /** Google consent URL for the signed-in owner (the browser is sent there). */
  async connectCalendar(ctx: TenantContext, businessId: string) {
    await this.tx.inTenant((db) => this.business(db, ctx, businessId), ctx, { readOnly: true });
    if (!ctx.userId) throw new WhatsAppError('FORBIDDEN', 'Connect the calendar from the dashboard while signed in.');
    if (!this.calendar?.configured) throw new WhatsAppError('CONFLICT', 'Google Calendar is not set up on this server yet (administrator: add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET).');
    return { authUrl: this.calendar.authorizationUrl({ organizationId: ctx.organizationId, businessId, userId: ctx.userId }) };
  }

  async disconnectCalendar(ctx: TenantContext, businessId: string) {
    await this.tx.inTenant((db) => this.business(db, ctx, businessId), ctx, { readOnly: true });
    const removed = this.calendar ? await this.calendar.disconnect(this.tx, ctx, businessId) : false;
    if (removed) await this.tx.inTenant((db) => this.audit(db, ctx, 'GOOGLE_CALENDAR_DISCONNECTED', 'BUSINESS', businessId), ctx);
    return { disconnected: removed };
  }

  /** OAuth callback (public route, the signed state names the org/user). Returns where to send the browser. */
  async completeCalendar(code: string | undefined, state: string | undefined, error: string | undefined): Promise<string> {
    const base = this.calendar?.webAppUrl ?? 'http://localhost:3200';
    if (error || !code || !state || !this.calendar) return `${base}/havan/settings?calendar=${encodeURIComponent(error === 'access_denied' ? 'denied' : 'failed')}`;
    try {
      const r = await this.calendar.completeConnection(this.tx, code, state);
      const s = this.calendar.verifyState(state);
      await this.tx.inTenant((db) => this.audit(db, { organizationId: s.organizationId, userId: s.userId } as TenantContext, 'GOOGLE_CALENDAR_CONNECTED', 'BUSINESS', r.businessId,
        { email: String(Boolean(r.email)) }), { organizationId: s.organizationId, userId: s.userId });
      return `${base}/havan/settings?calendar=connected`;
    } catch (err) {
      const reason = err instanceof CalendarError ? (err.code === 'NO_REFRESH_TOKEN' ? 'reconsent' : err.code === 'BAD_STATE' ? 'expired' : 'failed') : 'failed';
      return `${base}/havan/settings?calendar=${reason}`;
    }
  }

  // -------------------------------------------------------------- bookings ---
  listBookings(ctx: TenantContext, businessId: string) {
    return this.tx.inTenant(async (db) => {
      await this.business(db, ctx, businessId);
      return (await db.query(
        `SELECT b.id, b.status, b.start_at AS "startAt", b.end_at AS "endAt", b.customer_name AS "customerName", b.customer_phone AS "customerPhone",
                d.tier, d.participation_mode AS "participationMode", d.yajman_name AS "yajmanName", d.city, d.gotra, d.family_names AS "familyNames",
                d.sankalp, d.prasad_address AS "prasadAddress", d.dakshina_status AS "dakshinaStatus",
                (SELECT json_agg(json_build_object('audience', x.audience, 'dueAt', x.due_at, 'status', x.status) ORDER BY x.due_at)
                   FROM app.scheduled_reminders x WHERE x.booking_id = b.id) AS reminders
           FROM app.bookings b JOIN app.havan_booking_details d ON d.booking_id = b.id
          WHERE b.business_id = $1 AND b.end_at > now() - interval '1 day' ORDER BY b.start_at LIMIT 200`, [businessId])).rows;
    }, ctx, { readOnly: true });
  }

  /** After the call: dakshina agreed (the amount itself is never stored). */
  setDakshinaStatus(ctx: TenantContext, businessId: string, bookingId: string, status: 'TO_BE_DISCUSSED_ON_CALL' | 'AGREED_ON_CALL') {
    return this.tx.inTenant(async (db) => {
      await this.business(db, ctx, businessId);
      const r = await db.query(`UPDATE app.havan_booking_details SET dakshina_status = $3 WHERE booking_id = $1 AND business_id = $2 RETURNING booking_id`,
        [bookingId, businessId, status]);
      if (!r.rows[0]) throw new WhatsAppError('NOT_FOUND', 'havan booking not found');
      await this.audit(db, ctx, 'HAVAN_DAKSHINA_STATUS', 'BOOKING', bookingId, { status });
      return { bookingId, dakshinaStatus: status };
    }, ctx);
  }
}
