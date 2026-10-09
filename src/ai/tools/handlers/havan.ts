import type { CountryCode } from 'libphonenumber-js/max';
import type { Db } from '../../../database/transaction-runner.js';
import { cancelBookingReminders, reminderDueAt, scheduleReminder, type ScheduledReminder } from '../../../havan/reminders.js';
import { enqueueCalendarSync, withoutBusy, type BusyInterval } from '../../../integrations/google-calendar.js';
import { InvalidPhoneNumberError, toE164 } from '../../../whatsapp/domain/phone.js';
import { fail, ok, withDb, type AssistantTool, type ConfirmationPreview, type ToolDeps, type ToolExecutionContext, type ToolOutcome } from '../types.js';
import { cancelBooking, checkAvailability, createBooking, getBooking, rescheduleBooking } from './booking.js';
import { setHandoff } from './conversation.js';
import { addDays, clip, localDate, localLabel, searchWords } from './format.js';

/*
 * Havan booking capabilities (Pandit Ji / PanditSuggest, "Havan Booking
 * Assistant" template). Booking tools are thin wrappers over the generic
 * booking handlers: they only translate a havan tier into the Pandit's linked
 * service, keep the havan details (mode, gotra, sankalp) beside the booking and
 * schedule/cancel the "1 day before" reminders.
 *
 * DAKSHINA IS NEVER RETURNED BY ANY TOOL. Havan packages have no price column
 * and GET_DAKSHINA_POLICY only states the call-back policy, so the model cannot
 * quote an amount even by mistake.
 */

export type Tier = 'SAMANYA' | 'VISHESH' | 'MAHA_VISHESH';
export type Mode = 'NALKHEDA_IN_PERSON' | 'ONLINE_SANKALP';
export const TIER_LABEL: Record<string, string> = { SAMANYA: 'Samanya Havan', VISHESH: 'Vishesh Havan', MAHA_VISHESH: 'Maha Vishesh Havan', NOT_DECIDED: 'abhi tay nahi' };
export const MODE_LABEL: Record<string, string> = { NALKHEDA_IN_PERSON: 'Nalkheda mein swayam', ONLINE_SANKALP: 'Online (video call se sankalp)', NOT_DECIDED: 'abhi tay nahi' };
const DAKSHINA_NOTE = 'Dakshina is told ONLY by Pandit Ji on a phone call. Never quote, estimate or compare any amount in chat; offer a call-back instead.';

async function settings(db: Db, ctx: ToolExecutionContext) {
  return (await db.query(`SELECT * FROM app.havan_settings WHERE business_id = $1`, [ctx.businessId])).rows[0] ?? null;
}

/** How long a havan blocks Pandit Ji's calendar: the havan type's own duration (default 2 hours). */
const DEFAULT_HAVAN_MINUTES = 120;
const havanMinutes = (ctx: ToolExecutionContext, pkg: { duration_minutes?: number | null; service_duration?: number | null } | null) =>
  Number(pkg?.duration_minutes ?? pkg?.service_duration ?? ctx.config.defaultDurationMinutes ?? DEFAULT_HAVAN_MINUTES);

async function packageFor(db: Db, ctx: ToolExecutionContext, tier?: string) {
  if (!tier) return null;
  return (await db.query(
    `SELECT p.*, s.duration_minutes AS service_duration FROM app.havan_packages p
       LEFT JOIN app.services s ON s.id = p.service_id AND s.active AND s.deleted_at IS NULL
      WHERE p.business_id = $1 AND p.tier = $2 AND p.active AND p.deleted_at IS NULL`, [ctx.businessId, tier])).rows[0] ?? null;
}

async function customer(db: Db, ctx: ToolExecutionContext): Promise<{ name: string | null; phone: string | null }> {
  if (!ctx.contactId) return { name: ctx.sandboxCustomer?.name ?? null, phone: null };
  const r = await db.query(`SELECT coalesce(display_name, profile_name) AS name, phone_e164 FROM app.contacts WHERE id = $1 AND business_id = $2`,
    [ctx.contactId, ctx.businessId]);
  return { name: r.rows[0]?.name ?? null, phone: r.rows[0]?.phone_e164 ?? null };
}

const isOutcome = (x: unknown): x is ToolOutcome => typeof x === 'object' && x !== null && 'result' in x;

// ------------------------------------------------------------ knowledge ---

export const getTempleInformation: AssistantTool<{ topic?: 'LOCATION' | 'DARSHAN_TIMINGS' | 'HOW_TO_REACH' | 'RULES' | 'HISTORY' | 'ALL' }> = {
  handlerKey: 'havan.temple_info', isReadOnly: true, timeoutMs: 10_000,
  async execute(ctx, input, deps) {
    const topic = input.topic ?? 'ALL';
    return withDb(ctx, deps, async (db) => {
      const s = await settings(db, ctx);
      const pick = (t: string, v: unknown) => (topic === 'ALL' || topic === t ? v ?? undefined : undefined);
      const configured = s ? Object.fromEntries(Object.entries({
        templeName: s.temple_name, address: pick('LOCATION', s.temple_address), mapUrl: pick('LOCATION', s.temple_map_url),
        darshanTimings: pick('DARSHAN_TIMINGS', s.darshan_timings), howToReach: pick('HOW_TO_REACH', s.how_to_reach),
        rules: pick('RULES', s.temple_rules), notes: topic === 'ALL' || topic === 'HISTORY' ? s.temple_notes : undefined,
      }).filter(([, v]) => v)) : {};
      // History/legends and anything the Pandit did not fill in come from the business knowledge base.
      const words = searchWords(`Nalkheda mandir ${topic === 'ALL' ? 'itihaas darshan' : topic.replace(/_/g, ' ').toLowerCase()} ${s?.temple_name ?? ''}`);
      const scope = { organizationId: ctx.organizationId, businessId: ctx.businessId, aiAgentId: ctx.assistantId };
      const chunks = await deps.knowledge.searchLexical(db, { ...scope, words, limit: 3 });
      const fromKnowledge = chunks.map((c) => ({ source: c.title ?? 'Knowledge', text: clip(c.content, 900) }));
      if (Object.keys(configured).length <= 1 && fromKnowledge.length === 0) {
        return fail('NOT_CONFIGURED', 'The Pandit has not published this temple information. Say you will confirm it with Pandit Ji.');
      }
      return ok({ topic, temple: configured, fromKnowledge,
        note: 'Timings/rules can change: share them as given. Present legends as "mandir se judi paramparagat manyata ke anusaar", never as verified history.' });
    });
  },
};

export const getHavanServiceDetails: AssistantTool<{ tier?: Tier }> = {
  handlerKey: 'havan.service_details', isReadOnly: true,
  async execute(ctx, input, deps) {
    return withDb(ctx, deps, async (db) => {
      const s = await settings(db, ctx);
      const r = await db.query(
        `SELECT p.*, s.duration_minutes AS service_duration FROM app.havan_packages p
           LEFT JOIN app.services s ON s.id = p.service_id AND s.active AND s.deleted_at IS NULL
          WHERE p.business_id = $1 AND p.active AND p.deleted_at IS NULL AND ($2::text IS NULL OR p.tier = $2)
          ORDER BY array_position(ARRAY['SAMANYA','VISHESH','MAHA_VISHESH'], p.tier)`, [ctx.businessId, input.tier ?? null]);
      if (r.rows.length === 0) {
        return fail(input.tier ? 'PACKAGE_NOT_OFFERED' : 'NO_PACKAGES', input.tier ? 'Pandit Ji does not list this havan type.' : 'No havan packages are configured yet.');
      }
      const onlineOffered = s?.online_havan_offered !== false;
      const packages = r.rows.map((p) => ({
        tier: p.tier, name: p.name, description: clip(p.description, 600),
        herbs: { count: p.herb_count, names: p.herbs.length ? p.herbs : null,
          note: p.herbs.length ? undefined : 'Individual herb names are not listed: say Pandit Ji will explain them on the call.' },
        samagri: clip(p.samagri_notes, 400), durationMinutes: havanMinutes(ctx, p), panditCount: p.pandit_count,
        modes: { nalkhedaInPerson: p.in_person_available, onlineSankalp: onlineOffered && p.online_available },
        online: onlineOffered && p.online_available ? { liveVideoCall: p.online_live_video, recording: p.online_recording, photos: p.online_photos,
          prasadCourier: p.prasad_courier, internationalCourier: p.international_courier } : null,
        yajmanPreparation: clip(p.yajman_preparation, 600),
      }));
      return ok({ packages, dakshina: 'CALL_ONLY', note: `Mention only online steps marked true. ${DAKSHINA_NOTE}` });
    });
  },
};

export const getDakshinaPolicy: AssistantTool = {
  handlerKey: 'havan.dakshina_policy', isReadOnly: true,
  async execute(ctx, _input, deps) {
    const s = await withDb(ctx, deps, (db) => settings(db, ctx));
    return ok({ policy: 'CALL_ONLY', canQuoteInChat: false, callbackAvailable: true, panditName: s?.pandit_display_name ?? 'Pandit Ji',
      instruction: `${DAKSHINA_NOTE} Ask for the customer's number (or offer "isi WhatsApp number par?") and use REQUEST_PANDIT_HANDOFF with type CALLBACK.` });
  },
};

export const getFestivalContext: AssistantTool<{ lookahead_days?: number }> = {
  handlerKey: 'havan.festival_context', isReadOnly: true,
  async execute(ctx, input, deps) {
    const today = localDate(ctx.now, ctx.timezone);
    const until = addDays(today, input.lookahead_days ?? 45);
    const since = addDays(today, -3);
    return withDb(ctx, deps, async (db) => {
      const rows = (await db.query(
        `SELECT name, kind, starts_on::text AS starts_on, ends_on::text AS ends_on, notes, 'PLATFORM' AS origin FROM app.festival_calendar
          WHERE ends_on >= $1::date AND starts_on <= $2::date
         UNION ALL
         SELECT name, 'PANDIT_SPECIAL', starts_on::text, ends_on::text, notes, 'PANDIT' FROM app.havan_special_dates
          WHERE business_id = $3 AND ends_on >= $1::date AND starts_on <= $2::date
         ORDER BY starts_on`, [since, until, ctx.businessId])).rows;
      const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
      const view = (f: any) => ({ name: f.name, kind: f.kind, from: f.starts_on, to: f.ends_on, notes: clip(f.notes, 200), setBy: f.origin });
      const active = rows.filter((f) => f.starts_on <= today && f.ends_on >= today).map((f) => ({ ...view(f), dayNumber: days(f.starts_on, today) + 1 }));
      const upcoming = rows.filter((f) => f.starts_on > today).map((f) => ({ ...view(f), startsInDays: days(today, f.starts_on) }));
      const ended = rows.filter((f) => f.ends_on < today).map((f) => ({ ...view(f), endedDaysAgo: days(f.ends_on, today) }));
      const navratriStatus = active.some((f) => f.kind === 'NAVRATRI') ? 'NAVRATRI_ACTIVE'
        : upcoming.some((f) => f.kind === 'NAVRATRI') ? 'BEFORE_NAVRATRI'
        : ended.some((f) => f.kind === 'NAVRATRI') ? 'AFTER_NAVRATRI' : 'NO_NAVRATRI_NEAR';
      const weekday = new Intl.DateTimeFormat('en-IN', { timeZone: ctx.timezone, weekday: 'long' }).format(ctx.now);
      return ok({ today, weekday, timezone: ctx.timezone, navratriStatus, active, upcoming, recentlyEnded: ended,
        note: 'Mention a festival only when relevant to the customer. Tithis can shift by region: for an exact muhurat, say Pandit Ji will confirm.' });
    });
  },
};

// ---------------------------------------------------------------- leads ---

type Stage = 'NEW' | 'INFORMATION_SEEKER' | 'EXPLORING' | 'INTERESTED' | 'HIGH_INTENT' | 'CALLBACK_REQUESTED' | 'READY_TO_BOOK'
  | 'BOOKING_IN_PROGRESS' | 'BOOKED' | 'FOLLOW_UP' | 'HUMAN_HANDOFF';
const QUALIFICATION: Record<Stage, 'UNQUALIFIED' | 'COLD' | 'WARM' | 'HOT'> = {
  NEW: 'UNQUALIFIED', INFORMATION_SEEKER: 'COLD', EXPLORING: 'WARM', INTERESTED: 'WARM', FOLLOW_UP: 'WARM', HUMAN_HANDOFF: 'WARM',
  HIGH_INTENT: 'HOT', CALLBACK_REQUESTED: 'HOT', READY_TO_BOOK: 'HOT', BOOKING_IN_PROGRESS: 'HOT', BOOKED: 'HOT',
};
type YajmanLeadInput = { lead_stage?: Stage; service_interest?: Tier | 'NOT_DECIDED'; participation_mode?: Mode | 'NOT_DECIDED'; preferred_date?: string;
  preferred_time?: string; city?: string; urgency?: 'LOW' | 'NORMAL' | 'HIGH'; sankalp_topic?: string; objection?: string; notes?: string };

const yajmanLeadView = (l: any) => l && ({
  id: l.id, status: l.status, stage: l.attributes?.lead_stage ?? null, serviceInterest: l.attributes?.service_interest ?? null,
  participationMode: l.attributes?.participation_mode ?? null, preferredDate: l.attributes?.preferred_date ?? null,
  preferredTime: l.attributes?.preferred_time ?? null, city: l.location, urgency: l.attributes?.urgency ?? null,
  sankalpTopic: l.attributes?.sankalp_topic ?? null, callbackRequested: Boolean(l.attributes?.callback_requested),
  callbackNumber: l.attributes?.callback_number ?? null, lastUpdated: l.updatedAt,
});

function leadFields(i: YajmanLeadInput) {
  const attributes = Object.fromEntries(Object.entries({ lead_stage: i.lead_stage, service_interest: i.service_interest, participation_mode: i.participation_mode,
    preferred_date: i.preferred_date, preferred_time: i.preferred_time, urgency: i.urgency, sankalp_topic: i.sankalp_topic, last_objection: i.objection })
    .filter(([, v]) => v !== undefined));
  return {
    intent: 'ENQUIRY' as const, interest: i.service_interest ? `Maa Baglamukhi ${TIER_LABEL[i.service_interest]}` : undefined, location: i.city,
    timeline: i.preferred_date || i.preferred_time ? [i.preferred_date, i.preferred_time].filter(Boolean).join(' ') : undefined,
    qualification: i.lead_stage ? QUALIFICATION[i.lead_stage] : undefined, notes: i.notes, attributes,
  };
}

export const getYajmanLead: AssistantTool = {
  handlerKey: 'havan.lead_get', isReadOnly: true,
  async execute(ctx, _input, deps) {
    if (!ctx.contactId) return ok({ lead: null, note: 'Test chat: no stored enquiry.' });
    return withDb(ctx, deps, async (db) => {
      const lead = await deps.leads.getOpen(db, ctx.businessId, ctx.contactId!);
      const c = await customer(db, ctx);
      const upcoming = (await db.query(
        `SELECT count(*)::int AS n FROM app.bookings WHERE business_id = $1 AND contact_id = $2 AND status IN ('PENDING','CONFIRMED') AND start_at > now()`,
        [ctx.businessId, ctx.contactId])).rows[0].n;
      return ok({ customerName: c.name, whatsappNumberKnown: Boolean(c.phone), upcomingHavanBookings: upcoming, lead: yajmanLeadView(lead),
        note: 'Do not ask again for anything already stored here.' });
    });
  },
};

export const updateYajmanLead: AssistantTool<YajmanLeadInput> = {
  handlerKey: 'havan.lead_update', isReadOnly: false,
  async dryRun(_ctx, input) { return ok({ dryRun: true, wouldSave: leadFields(input) }); },
  async execute(ctx, input, deps) {
    if (!ctx.contactId) return fail('NO_CUSTOMER');
    const res = await deps.leads.upsert({ ...ctx.dbContext, organizationId: ctx.organizationId }, {
      businessId: ctx.businessId, contactId: ctx.contactId, conversationId: ctx.conversationId, aiAgentId: ctx.assistantId,
      source: 'AI_WHATSAPP', idempotencyKey: ctx.idempotencyKey, fields: leadFields(input) });
    if (!res.lead) return fail('NO_OPEN_LEAD');
    return ok({ saved: true, lead: yajmanLeadView(res.lead) }, { leadId: res.lead.id, wrote: true });
  },
};

// --------------------------------------------------------- availability ---

type SlotsInput = { date_from: string; date_to?: string; tier?: Tier; time_of_day?: 'MORNING' | 'AFTERNOON' | 'EVENING' | 'ANY'; preferred_time?: string };

/**
 * Busy time on Pandit Ji's Google Calendar. 'NONE' = no calendar connected;
 * 'UNAVAILABLE' = connected but Google could not be read right now.
 */
async function calendarBusy(ctx: ToolExecutionContext, deps: ToolDeps, from: Date, to: Date): Promise<BusyInterval[] | 'NONE' | 'UNAVAILABLE'> {
  if (!deps.calendar) return 'NONE';
  try {
    return (await deps.calendar.freeBusy(deps.tx, { ...ctx.dbContext, organizationId: ctx.organizationId }, ctx.businessId, from, to)) ?? 'NONE';
  } catch {
    return 'UNAVAILABLE';
  }
}
const CALENDAR_UNAVAILABLE_NOTE = "Pandit Ji's Google Calendar could not be checked right now: offer these slots as tentative and say Pandit Ji will confirm.";

async function slots(ctx: ToolExecutionContext, deps: ToolDeps, input: SlotsInput): Promise<ToolOutcome> {
  const pkg = input.tier ? await withDb(ctx, deps, (db) => packageFor(db, ctx, input.tier)) : null;
  if (input.tier && !pkg) return fail('PACKAGE_NOT_OFFERED', 'Pandit Ji does not list this havan type.');
  const maxSlots = Number(ctx.config.maxSlots ?? 6);
  const duration = havanMinutes(ctx, pkg);
  // The havan type's own duration decides the slot length. Ask for more candidates so slots hidden by
  // Google Calendar busy time still leave enough to offer.
  const wide = { ...ctx, config: { ...ctx.config, maxSlots: 20, defaultDurationMinutes: duration } };
  const out = await checkAvailability.execute(wide, { date_from: input.date_from, date_to: input.date_to,
    time_of_day: input.time_of_day, preferred_time: input.preferred_time }, deps);
  if (!out.result.success) return out;
  out.result.havanDurationMinutes = duration;
  let list = out.result.slots as Array<{ start_at: string }>;
  if (list.length) {
    const from = new Date(Math.min(...list.map((x) => Date.parse(x.start_at))));
    const to = new Date(Math.max(...list.map((x) => Date.parse(x.start_at))) + duration * 60_000);
    const busy = await calendarBusy(ctx, deps, from, to);
    if (busy === 'UNAVAILABLE') out.result.calendarNote = CALENDAR_UNAVAILABLE_NOTE;
    else if (busy !== 'NONE') { list = withoutBusy(list, busy, duration); out.result.googleCalendarChecked = true; }
  }
  if (list.length === 0) return fail('NO_AVAILABILITY', 'No free slots in that range (Pandit Ji is busy).');
  out.result.moreAvailable = Boolean(out.result.moreAvailable) || list.length > maxSlots;
  out.result.slots = list.slice(0, maxSlots);
  out.result.havan = input.tier ? TIER_LABEL[input.tier] : null;
  return out;
}

export const checkPanditAvailability: AssistantTool<{ date: string; preferred_time?: string; tier?: Tier }> = {
  handlerKey: 'havan.check_availability', isReadOnly: true, timeoutMs: 10_000,
  async execute(ctx, input, deps) {
    const out = await slots(ctx, deps, { date_from: input.date, date_to: input.date, tier: input.tier, preferred_time: input.preferred_time });
    if (out.result.success && input.preferred_time) {
      // Slots are sorted nearest-first to preferred_time; say explicitly whether that exact time is free.
      const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: ctx.timezone, hour: '2-digit', minute: '2-digit', hour12: false });
      out.result.requestedTimeFree = (out.result.slots as Array<{ start_at: string }>).some((s) =>
        localDate(new Date(s.start_at), ctx.timezone) === input.date && hhmm.format(new Date(s.start_at)) === input.preferred_time);
    }
    return out;
  },
};

export const getAvailableSlots: AssistantTool<SlotsInput> = {
  handlerKey: 'havan.available_slots', isReadOnly: true, timeoutMs: 10_000,
  execute: (ctx, input, deps) => slots(ctx, deps, input),
};

// -------------------------------------------------------------- booking ---

type HavanBookingInput = { start_at: string; participation_mode: Mode; yajman_name: string; city: string; tier?: Tier; gotra?: string; family_names?: string;
  sankalp?: string; prasad_address?: string; notes?: string };

interface Prepared { tierLabel: string; modeLabel: string; templeName: string | null; leadMinutes: number; durationMinutes: number }

async function prepareHavan(ctx: ToolExecutionContext, deps: ToolDeps, input: HavanBookingInput): Promise<Prepared | ToolOutcome> {
  return withDb(ctx, deps, async (db) => {
    const s = await settings(db, ctx);
    const pkg = await packageFor(db, ctx, input.tier);
    if (input.tier && !pkg) return fail('PACKAGE_NOT_OFFERED', 'Pandit Ji does not list this havan type.');
    if (input.participation_mode === 'ONLINE_SANKALP' && (s?.online_havan_offered === false || (pkg && !pkg.online_available))) {
      return fail('ONLINE_NOT_OFFERED', 'Online havan is not offered for this. Offer Nalkheda in person or a call with Pandit Ji.');
    }
    if (input.participation_mode === 'NALKHEDA_IN_PERSON' && pkg && !pkg.in_person_available) return fail('IN_PERSON_NOT_OFFERED');
    return { tierLabel: input.tier ? TIER_LABEL[input.tier] : 'Maa Baglamukhi Havan',
      modeLabel: MODE_LABEL[input.participation_mode], templeName: s?.temple_name ?? null, leadMinutes: s?.reminder_lead_minutes ?? 1440,
      durationMinutes: havanMinutes(ctx, pkg) };
  });
}

/** Refuses a start time that clashes with Pandit Ji's Google Calendar. */
async function calendarClash(ctx: ToolExecutionContext, deps: ToolDeps, startAt: string, durationMinutes: number): Promise<ToolOutcome | { note?: string }> {
  const start = new Date(startAt);
  const busy = await calendarBusy(ctx, deps, start, new Date(start.getTime() + durationMinutes * 60_000));
  if (busy === 'UNAVAILABLE') return { note: CALENDAR_UNAVAILABLE_NOTE };
  if (busy !== 'NONE' && withoutBusy([{ start_at: start.toISOString() }], busy, durationMinutes).length === 0) {
    return fail('SLOT_NOT_AVAILABLE', "Pandit Ji's own calendar is busy at that time. Offer other free slots.");
  }
  return {};
}

/** The booking blocks exactly the havan's duration. */
const sized = (ctx: ToolExecutionContext, p: Prepared): ToolExecutionContext => ({ ...ctx, config: { ...ctx.config, defaultDurationMinutes: p.durationMinutes } });

const bookingNotes = (i: HavanBookingInput, p: Prepared) =>
  clip([`${p.tierLabel} · ${p.modeLabel}`, 'Dakshina: call par tay hogi', i.notes].filter(Boolean).join(' · '), 1000) ?? undefined;

/** WhatsApp reminder texts, laid out for a phone screen (short lines, *bold*, one emoji per line). */
export function reminderTexts(p: { tierLabel: string; modeLabel: string; mode: Mode; local: string; templeName: string | null; yajman: string; phone: string | null;
  city?: string | null; gotra?: string | null; sankalp?: string | null; dakshina: string }) {
  const online = p.mode === 'ONLINE_SANKALP';
  const yajman = ['Jai Maa Baglamukhi 🙏', '', 'Aapke havan ki yaad dila rahe hain.', '',
    `🔥 *${p.tierLabel}*`, `📅 ${p.local}`, online ? '💻 Online – video call se sankalp' : `📍 ${p.templeName ?? 'Nalkheda mandir'}`, '',
    online ? 'Samay par shuddh hokar video call ke liye taiyar rahiye.' : 'Samay se thoda pehle pahunch jaiye.',
    'Koi sawal ho to yahin message kijiye.'].join('\n');
  const pandit = ['🔔 *Havan reminder*', '', `🔥 ${p.tierLabel}`, `📅 ${p.local}`, `🙏 ${p.yajman}${p.city ? `, ${p.city}` : ''}`,
    p.phone ? `📞 ${p.phone}` : null, online ? '💻 Online sankalp' : '📍 Nalkheda – yajman swayam aayenge',
    p.gotra ? `Gotra: ${p.gotra}` : null, p.sankalp ? `Sankalp: ${p.sankalp}` : null, '', `Dakshina: ${p.dakshina}`].filter((x) => x !== null).join('\n');
  return { yajman, pandit };
}

/** Immediate WhatsApp alert to Pandit Ji's personal number (booked / moved / cancelled). */
function bookingAlertText(kind: 'NEW' | 'MOVED' | 'CANCELLED', p: { tierLabel: string; local: string; previousLocal?: string; yajman: string; city?: string | null;
  phone: string | null; mode: Mode; gotra?: string | null; sankalp?: string | null }) {
  const head = kind === 'NEW' ? '🆕 *Nayi havan booking*' : kind === 'MOVED' ? '🔄 *Havan booking ka samay badla*' : '❌ *Havan booking cancel hui*';
  return [head, '', `🔥 ${p.tierLabel}`, kind === 'MOVED' && p.previousLocal ? `📅 ${p.previousLocal} ➜ *${p.local}*` : `📅 ${p.local}`,
    `🙏 ${p.yajman}${p.city ? `, ${p.city}` : ''}`, p.phone ? `📞 ${displayPhone(p.phone)}` : null,
    p.mode === 'ONLINE_SANKALP' ? '💻 Online sankalp' : '📍 Nalkheda – yajman swayam aayenge',
    kind === 'NEW' && p.gotra ? `Gotra: ${p.gotra}` : null, kind === 'NEW' && p.sankalp ? `Sankalp: ${p.sankalp}` : null,
    kind === 'CANCELLED' ? null : '', kind === 'NEW' ? 'Dakshina: yajman ko call karke tay karein' : kind === 'MOVED' ? 'Reminder naye samay ke hisab se set hai.' : null,
  ].filter((x) => x !== null).join('\n');
}

async function alertPandit(db: Db, ctx: ToolExecutionContext, deps: ToolDeps, bookingId: string | null, message: string, key: string) {
  await scheduleReminder(db, deps.ops, { organizationId: ctx.organizationId, businessId: ctx.businessId, audience: 'PANDIT', kind: 'BOOKING_ALERT',
    bookingId, contactId: ctx.contactId, conversationId: ctx.conversationId, dueAt: ctx.now, now: ctx.now, message, idempotencyKey: key, createdBy: 'SYSTEM' });
}

type ReminderReport = { audience: string; status: 'SCHEDULED' | 'NOT_SCHEDULED'; at?: string; local?: string; reason?: string };

/** Schedules the Pandit + yajman "1 day before" reminders for a booking (inside the caller's tx). */
async function scheduleBookingReminders(db: Db, ctx: ToolExecutionContext, deps: ToolDeps, b: { id: string; startAt: Date; keyBase: string },
                                        texts: { yajman: string; pandit: string }, leadMinutes: number): Promise<ReminderReport[]> {
  const due = reminderDueAt(b.startAt, ctx.now, leadMinutes);
  if (!due) return ['PANDIT', 'YAJMAN'].map((audience) => ({ audience, status: 'NOT_SCHEDULED' as const, reason: 'The havan is too soon for a reminder.' }));
  const out: ReminderReport[] = [];
  for (const [audience, message] of [['PANDIT', texts.pandit], ['YAJMAN', texts.yajman]] as const) {
    const r: ScheduledReminder = await scheduleReminder(db, deps.ops, { organizationId: ctx.organizationId, businessId: ctx.businessId, audience, kind: 'BOOKING',
      bookingId: b.id, contactId: ctx.contactId, conversationId: ctx.conversationId, dueAt: due, message, now: ctx.now,
      idempotencyKey: `${b.keyBase}:reminder:${audience}`, createdBy: 'AI' });
    out.push({ audience, status: 'SCHEDULED', at: r.dueAt.toISOString(), local: localLabel(r.dueAt, ctx.timezone) });
  }
  return out;
}

export const createHavanBooking: AssistantTool<HavanBookingInput> = {
  handlerKey: 'havan.create_booking', isReadOnly: false, timeoutMs: 12_000,
  async preview(ctx, input, deps): Promise<ConfirmationPreview> {
    const p = await prepareHavan(ctx, deps, input);
    if (isOutcome(p)) return { ok: false, outcome: p };
    const clash = await calendarClash(ctx, deps, input.start_at, p.durationMinutes);
    if (isOutcome(clash)) return { ok: false, outcome: clash };
    const pv = await createBooking.preview!(sized(ctx, p), { start_at: input.start_at, customer_name: input.yajman_name }, deps);
    if (!pv.ok) return pv;
    return { ok: true, text: `${p.tierLabel} · ${String(pv.details.local)} · ${p.modeLabel} · Yajman: ${input.yajman_name}, ${input.city} · Dakshina: Pandit Ji call par batayenge`,
      details: { ...pv.details, havan: p.tierLabel, mode: p.modeLabel, city: input.city, dakshina: 'CALL_ONLY' } };
  },
  async dryRun(ctx, input, deps) {
    const p = await prepareHavan(ctx, deps, input);
    if (isOutcome(p)) return p;
    const r = await createBooking.dryRun!(sized(ctx, p), { start_at: input.start_at, customer_name: input.yajman_name, notes: bookingNotes(input, p) }, deps);
    if (!r.result.success) return r;
    return ok({ ...r.result, havan: p.tierLabel, mode: p.modeLabel, wouldScheduleReminders: ctx.config.autoReminders !== false ? ['PANDIT', 'YAJMAN'] : [] });
  },
  async execute(ctx, input, deps) {
    if (!ctx.contactId) return fail('NO_CUSTOMER');
    const p = await prepareHavan(ctx, deps, input);
    if (isOutcome(p)) return p;
    const clash = await calendarClash(ctx, deps, input.start_at, p.durationMinutes);
    if (isOutcome(clash)) return clash;
    const created = await createBooking.execute(sized(ctx, p), { start_at: input.start_at, customer_name: input.yajman_name, notes: bookingNotes(input, p) }, deps);
    if (!created.result.success) return created;
    const booking = created.result.booking as { id: string; start_at: string; local: string };
    const reminders = await withDb(ctx, deps, async (db) => {
      await db.query(
        `INSERT INTO app.havan_booking_details (booking_id, organization_id, business_id, contact_id, tier, participation_mode, yajman_name, city, gotra, family_names, sankalp, prasad_address)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT (booking_id) DO NOTHING`,
        [booking.id, ctx.organizationId, ctx.businessId, ctx.contactId, input.tier ?? null, input.participation_mode, input.yajman_name.trim(), clip(input.city.trim(), 100),
         clip(input.gotra, 80), clip(input.family_names, 500), clip(input.sankalp, 500), clip(input.prasad_address, 500)]);
      await enqueueCalendarSync(db, deps.ops, ctx.organizationId, ctx.businessId, booking.id, 'UPSERT', ctx.idempotencyKey);
      const c = await customer(db, ctx);
      await alertPandit(db, ctx, deps, booking.id, bookingAlertText('NEW', { tierLabel: p.tierLabel, local: booking.local, yajman: input.yajman_name, city: input.city,
        phone: c.phone, mode: input.participation_mode, gotra: input.gotra, sankalp: input.sankalp }), `${ctx.idempotencyKey}:alert`);
      if (ctx.config.autoReminders === false) return [];
      const texts = reminderTexts({ tierLabel: p.tierLabel, modeLabel: p.modeLabel, mode: input.participation_mode, local: booking.local, templeName: p.templeName,
        yajman: input.yajman_name, phone: c.phone, city: input.city, gotra: input.gotra, sankalp: input.sankalp, dakshina: 'call par tay honi hai' });
      return scheduleBookingReminders(db, ctx, deps, { id: booking.id, startAt: new Date(booking.start_at), keyBase: ctx.idempotencyKey }, texts, p.leadMinutes);
    }, false);
    return ok({ ...created.result, havan: p.tierLabel, mode: p.modeLabel, reminders, dakshina: 'CALL_ONLY', ...(clash.note ? { calendarNote: clash.note } : {}),
      note: 'Tell the customer only what is in "booking" and "reminders". Dakshina and preparation: Pandit Ji will tell on the call.' }, created.effects);
  },
};

async function havanDetails(db: Db, bookingIds: string[]) {
  if (bookingIds.length === 0) return new Map<string, any>();
  const r = await db.query(
    `SELECT d.booking_id, d.tier, d.participation_mode, d.yajman_name, d.dakshina_status,
            (SELECT json_agg(json_build_object('audience', x.audience, 'dueAt', x.due_at) ORDER BY x.audience) FROM app.scheduled_reminders x
              WHERE x.booking_id = d.booking_id AND x.status = 'PENDING') AS reminders
       FROM app.havan_booking_details d WHERE d.booking_id = ANY($1::uuid[])`, [bookingIds]);
  return new Map(r.rows.map((x) => [x.booking_id, x]));
}

export const getHavanBooking: AssistantTool<{ booking_id?: string }> = {
  handlerKey: 'havan.get_booking', isReadOnly: true,
  async execute(ctx, input, deps) {
    const out = await getBooking.execute(ctx, input, deps);
    if (!out.result.success || !Array.isArray(out.result.bookings)) return out;
    const list = out.result.bookings as Array<Record<string, any>>;
    const details = await withDb(ctx, deps, (db) => havanDetails(db, list.map((b) => b.id)));
    out.result.bookings = list.map((b) => {
      const d = details.get(b.id);
      return { ...b, havan: d?.tier ? TIER_LABEL[d.tier] : null, mode: d ? MODE_LABEL[d.participation_mode] : null, yajman: d?.yajman_name ?? null,
        dakshina: d?.dakshina_status === 'AGREED_ON_CALL' ? 'Pandit Ji se call par tay ho chuki' : 'Pandit Ji call par batayenge',
        reminders: (d?.reminders ?? []).map((r: any) => ({ audience: r.audience, local: localLabel(new Date(r.dueAt), ctx.timezone) })) };
    });
    return out;
  },
};

export const rescheduleHavanBooking: AssistantTool<{ booking_id: string; new_start_at: string }> = {
  handlerKey: 'havan.reschedule', isReadOnly: false, timeoutMs: 12_000,
  preview: (ctx, input, deps) => rescheduleBooking.preview!(ctx, input, deps),
  dryRun: (ctx, input, deps) => rescheduleBooking.dryRun!(ctx, input, deps),
  async execute(ctx, input, deps) {
    const moved = await rescheduleBooking.execute(ctx, input, deps);
    if (!moved.result.success) return moved;
    const b = moved.result.booking as { id: string; previousBookingId: string; start_at: string; local: string };
    const reminders = await withDb(ctx, deps, async (db) => {
      await cancelBookingReminders(db, b.previousBookingId);
      await enqueueCalendarSync(db, deps.ops, ctx.organizationId, ctx.businessId, b.previousBookingId, 'DELETE', ctx.idempotencyKey);
      await enqueueCalendarSync(db, deps.ops, ctx.organizationId, ctx.businessId, b.id, 'UPSERT', ctx.idempotencyKey);
      await db.query(
        `INSERT INTO app.havan_booking_details (booking_id, organization_id, business_id, contact_id, tier, participation_mode, yajman_name, city, gotra,
                                                family_names, sankalp, prasad_address, dakshina_status)
         SELECT $1, organization_id, business_id, contact_id, tier, participation_mode, yajman_name, city, gotra, family_names, sankalp, prasad_address, dakshina_status
           FROM app.havan_booking_details WHERE booking_id = $2
         ON CONFLICT (booking_id) DO NOTHING`, [b.id, b.previousBookingId]);
      const d = (await db.query(`SELECT * FROM app.havan_booking_details WHERE booking_id = $1`, [b.id])).rows[0];
      const s = await settings(db, ctx);
      const c = await customer(db, ctx);
      const mode: Mode = d?.participation_mode ?? 'NALKHEDA_IN_PERSON';
      const tierLabel = d?.tier ? TIER_LABEL[d.tier] : 'Maa Baglamukhi Havan';
      const prev = (await db.query('SELECT start_at, timezone FROM app.bookings WHERE id = $1', [b.previousBookingId])).rows[0];
      await alertPandit(db, ctx, deps, b.id, bookingAlertText('MOVED', { tierLabel, local: b.local, previousLocal: prev ? localLabel(prev.start_at, prev.timezone) : undefined,
        yajman: d?.yajman_name ?? c.name ?? 'Yajman', city: d?.city, phone: c.phone, mode }), `${ctx.idempotencyKey}:alert`);
      if (ctx.config.autoReminders === false) return [];
      const texts = reminderTexts({ tierLabel, modeLabel: MODE_LABEL[mode], mode, local: b.local, templeName: s?.temple_name ?? null, yajman: d?.yajman_name ?? c.name ?? 'Yajman',
        phone: c.phone, city: d?.city, gotra: d?.gotra, sankalp: d?.sankalp, dakshina: d?.dakshina_status === 'AGREED_ON_CALL' ? 'tay ho chuki' : 'call par tay honi hai' });
      return scheduleBookingReminders(db, ctx, deps, { id: b.id, startAt: new Date(b.start_at), keyBase: `${ctx.idempotencyKey}:moved` }, texts, s?.reminder_lead_minutes ?? 1440);
    }, false);
    return ok({ ...moved.result, reminders, note: 'Old reminders were cancelled; report only the reminders listed here.' }, moved.effects);
  },
};

export const cancelHavanBooking: AssistantTool<{ booking_id: string; reason?: string }> = {
  handlerKey: 'havan.cancel', isReadOnly: false,
  preview: (ctx, input, deps) => cancelBooking.preview!(ctx, input, deps),
  dryRun: (ctx, input, deps) => cancelBooking.dryRun!.call(cancelBooking, ctx, input, deps),
  async execute(ctx, input, deps) {
    const r = await cancelBooking.execute(ctx, input, deps);
    if (!r.result.success) return r;
    const cancelled = await withDb(ctx, deps, async (db) => {
      await enqueueCalendarSync(db, deps.ops, ctx.organizationId, ctx.businessId, input.booking_id, 'DELETE', ctx.idempotencyKey);
      const n = await cancelBookingReminders(db, input.booking_id);
      const bk = (await db.query('SELECT start_at, timezone FROM app.bookings WHERE id = $1', [input.booking_id])).rows[0];
      const d = (await db.query('SELECT tier, participation_mode, yajman_name, city FROM app.havan_booking_details WHERE booking_id = $1', [input.booking_id])).rows[0];
      const c = await customer(db, ctx);
      if (bk) {
        await alertPandit(db, ctx, deps, null, bookingAlertText('CANCELLED', { tierLabel: d?.tier ? TIER_LABEL[d.tier] : 'Maa Baglamukhi Havan',
          local: localLabel(bk.start_at, bk.timezone), yajman: d?.yajman_name ?? c.name ?? 'Yajman', city: d?.city, phone: c.phone,
          mode: d?.participation_mode ?? 'NALKHEDA_IN_PERSON' }) + (input.reason ? `\n\nKaran: ${clip(input.reason, 200)}` : ''), `${ctx.idempotencyKey}:alert`);
      }
      return n;
    }, false);
    return ok({ ...r.result, remindersCancelled: cancelled }, r.effects);
  },
};

// ------------------------------------------------------------ reminders ---

async function ownBookingId(db: Db, ctx: ToolExecutionContext, bookingId?: string): Promise<string | null | 'NOT_FOUND'> {
  if (!bookingId) return null;
  const r = await db.query(`SELECT id FROM app.bookings WHERE id = $1 AND business_id = $2 AND contact_id = $3`, [bookingId, ctx.businessId, ctx.contactId]);
  return r.rows[0]?.id ?? 'NOT_FOUND';
}

function checkWhen(ctx: ToolExecutionContext, at: Date, minLeadMinutes: number): ToolOutcome | null {
  if (at.getTime() < ctx.now.getTime() + minLeadMinutes * 60_000) return fail('TIME_TOO_SOON', `The reminder time must be at least ${minLeadMinutes} minutes from now.`);
  if (at.getTime() > ctx.now.getTime() + 60 * 86_400_000) return fail('TIME_TOO_FAR', 'Reminders can be set up to 60 days ahead.');
  return null;
}

export const createYajmanReminder: AssistantTool<{ remind_at: string; message: string; booking_id?: string }> = {
  handlerKey: 'havan.yajman_reminder', isReadOnly: false,
  async dryRun(ctx, input) {
    return checkWhen(ctx, new Date(input.remind_at), 5) ?? ok({ dryRun: true, status: 'WOULD_SCHEDULE_REMINDER', local: localLabel(new Date(input.remind_at), ctx.timezone) });
  },
  async execute(ctx, input, deps) {
    if (!ctx.contactId || !ctx.conversationId) return fail('NO_CUSTOMER');
    const at = new Date(input.remind_at);
    const bad = checkWhen(ctx, at, 5);
    if (bad) return bad;
    return withDb(ctx, deps, async (db) => {
      const bookingId = await ownBookingId(db, ctx, input.booking_id);
      if (bookingId === 'NOT_FOUND') return fail('NOT_FOUND', 'No such booking for this customer.');
      const pending = (await db.query(
        `SELECT count(*)::int AS n FROM app.scheduled_reminders WHERE business_id = $1 AND contact_id = $2 AND audience = 'YAJMAN' AND kind <> 'BOOKING' AND status = 'PENDING'`,
        [ctx.businessId, ctx.contactId])).rows[0].n;
      if (pending >= 5) return fail('TOO_MANY_REMINDERS', 'This customer already has 5 pending reminders.');
      const r = await scheduleReminder(db, deps.ops, { organizationId: ctx.organizationId, businessId: ctx.businessId, audience: 'YAJMAN', kind: 'CUSTOM',
        bookingId, contactId: ctx.contactId, conversationId: ctx.conversationId, dueAt: at, message: `Jai Maa Baglamukhi 🙏\n${input.message.trim()}`,
        now: ctx.now, idempotencyKey: ctx.idempotencyKey, createdBy: 'AI' });
      return ok({ status: 'REMINDER_SCHEDULED', reminder: { id: r.id, local: localLabel(r.dueAt, ctx.timezone) } }, { wrote: true });
    }, false);
  },
};

export const createPanditReminder: AssistantTool<{ message: string; remind_at?: string; booking_id?: string }> = {
  handlerKey: 'havan.pandit_reminder', isReadOnly: false,
  async dryRun(ctx, input) {
    const bad = input.remind_at ? checkWhen(ctx, new Date(input.remind_at), 0) : null;
    return bad ?? ok({ dryRun: true, status: 'WOULD_REMIND_PANDIT', local: localLabel(input.remind_at ? new Date(input.remind_at) : ctx.now, ctx.timezone) });
  },
  async execute(ctx, input, deps) {
    if (!ctx.contactId) return fail('NO_CUSTOMER');
    const at = input.remind_at ? new Date(input.remind_at) : ctx.now;
    const bad = input.remind_at ? checkWhen(ctx, at, 0) : null;
    if (bad) return bad;
    return withDb(ctx, deps, async (db) => {
      const bookingId = await ownBookingId(db, ctx, input.booking_id);
      if (bookingId === 'NOT_FOUND') return fail('NOT_FOUND', 'No such booking for this customer.');
      const pending = (await db.query(
        `SELECT count(*)::int AS n FROM app.scheduled_reminders WHERE business_id = $1 AND contact_id = $2 AND audience = 'PANDIT' AND status = 'PENDING'`,
        [ctx.businessId, ctx.contactId])).rows[0].n;
      if (pending >= 10) return fail('TOO_MANY_REMINDERS', 'Pandit Ji already has 10 pending reminders about this customer.');
      const c = await customer(db, ctx);
      const r = await scheduleReminder(db, deps.ops, { organizationId: ctx.organizationId, businessId: ctx.businessId, audience: 'PANDIT', kind: 'FOLLOW_UP',
        bookingId, contactId: ctx.contactId, conversationId: ctx.conversationId, dueAt: at,
        message: `🔔 ${input.message.trim()}\n\n🙏 ${c.name ?? 'WhatsApp yajman'}${c.phone ? `\n📞 ${displayPhone(c.phone)}` : ''}`, now: ctx.now, idempotencyKey: ctx.idempotencyKey });
      return ok({ status: 'PANDIT_REMINDER_SCHEDULED', reminder: { id: r.id, local: localLabel(r.dueAt, ctx.timezone), immediate: !input.remind_at } }, { wrote: true });
    }, false);
  },
};

// -------------------------------------------------------------- handoff ---

type HandoffInput = { type: 'CALLBACK' | 'CHAT_HANDOFF'; reason: 'DAKSHINA' | 'HAVAN_TYPE' | 'BOOKING' | 'GUIDANCE' | 'MANTRA_OR_TANTRA' | 'COMPLAINT' | 'PAYMENT'
  | 'NOT_UNDERSTOOD' | 'OTHER'; summary: string; callback_number?: string; use_whatsapp_number?: boolean; preferred_call_time?: string;
  tier?: Tier | 'NOT_DECIDED'; participation_mode?: Mode | 'NOT_DECIDED' };
const CALLBACK_REASON: Record<string, string> = { DAKSHINA: 'DAKSHINA', HAVAN_TYPE: 'HAVAN_TYPE', BOOKING: 'BOOKING', GUIDANCE: 'GUIDANCE', MANTRA_OR_TANTRA: 'GUIDANCE' };
const REASON_LABEL: Record<string, string> = { DAKSHINA: 'Dakshina jaanni hai', HAVAN_TYPE: 'Havan ka prakar chunna hai', BOOKING: 'Booking / date',
  GUIDANCE: 'Guidance chahiye', MANTRA_OR_TANTRA: 'Mantra / vishesh vidhi', COMPLAINT: 'Shikayat', PAYMENT: 'Payment', NOT_UNDERSTOOD: 'Assistant samajh nahi paya', OTHER: 'Anya' };

async function callbackNumber(db: Db, ctx: ToolExecutionContext, input: HandoffInput): Promise<string | ToolOutcome> {
  if (input.use_whatsapp_number || !input.callback_number) {
    if (!input.use_whatsapp_number) return fail('CALLBACK_NUMBER_REQUIRED', 'Ask for the number, or offer "isi WhatsApp number par call karein?".');
    const c = await customer(db, ctx);
    if (!c.phone) return fail('WHATSAPP_NUMBER_UNKNOWN', 'This chat has no phone number on file: ask the customer to type their number.');
    return c.phone;
  }
  const country = (await db.query(`SELECT country_code FROM app.businesses WHERE id = $1`, [ctx.businessId])).rows[0]?.country_code ?? 'IN';
  try {
    return toE164(input.callback_number, country as CountryCode);
  } catch (err) {
    if (err instanceof InvalidPhoneNumberError) return fail('INVALID_PHONE_NUMBER', 'The number looks incomplete. Ask the customer to check it once (10 digits for India).');
    throw err;
  }
}

function displayPhone(e164: string): string {
  return e164.startsWith('+91') && e164.length === 13 ? `+91 ${e164.slice(3, 8)} ${e164.slice(8)}` : e164;
}

export const requestPanditHandoff: AssistantTool<HandoffInput> = {
  handlerKey: 'havan.request_pandit', isReadOnly: false,
  async dryRun(ctx, input, deps) {
    if (input.type === 'CHAT_HANDOFF') return ok({ dryRun: true, status: 'WOULD_HAND_OFF', handlingMode: 'HUMAN' });
    if (!ctx.contactId && input.use_whatsapp_number) return ok({ dryRun: true, status: 'WOULD_REQUEST_CALLBACK', callbackNumber: 'this WhatsApp number' });
    const n = await withDb(ctx, deps, (db) => callbackNumber(db, ctx, input));
    return isOutcome(n) ? n : ok({ dryRun: true, status: 'WOULD_REQUEST_CALLBACK', callbackNumber: displayPhone(n) });
  },
  async execute(ctx, input, deps) {
    if (!ctx.contactId || !ctx.conversationId) return fail('NO_CUSTOMER');
    const summary = input.summary.trim();
    if (input.type === 'CHAT_HANDOFF') {
      await withDb(ctx, deps, async (db) => {
        await setHandoff(db, { organizationId: ctx.organizationId, businessId: ctx.businessId, conversationId: ctx.conversationId!, assistantId: ctx.assistantId },
          { reason: `${REASON_LABEL[input.reason]}: ${summary}`, priority: input.reason === 'COMPLAINT' ? 'HIGH' : 'NORMAL', summary });
        await deps.ops.recordUsage(db, { organizationId: ctx.organizationId, businessId: ctx.businessId, eventType: 'AI_HANDOFF', quantity: 1,
          resourceType: 'CONVERSATION', resourceId: ctx.conversationId!, idempotencyKey: `handoff:${ctx.idempotencyKey}` });
        const c = await customer(db, ctx);
        await scheduleReminder(db, deps.ops, { organizationId: ctx.organizationId, businessId: ctx.businessId, audience: 'PANDIT', kind: 'FOLLOW_UP',
          contactId: ctx.contactId, conversationId: ctx.conversationId, dueAt: ctx.now, now: ctx.now, idempotencyKey: `${ctx.idempotencyKey}:handoff`,
          message: `💬 *Yajman ki chat aapko saupi gayi*\n\n🙏 ${c.name ?? 'WhatsApp yajman'}${c.phone ? `\n📞 ${displayPhone(c.phone)}` : ''}\nKaran: ${REASON_LABEL[input.reason]}\n\n📝 ${summary}` });
      }, false);
      return ok({ status: 'HANDED_OFF', handlingMode: 'HUMAN', note: 'Tell the customer Pandit Ji has been informed and will reply here. Do not continue in this chat.' },
        { handoff: true, wrote: true });
    }

    const result = await withDb(ctx, deps, async (db) => {
      const phone = await callbackNumber(db, ctx, input);
      if (isOutcome(phone)) return phone;
      const reason = CALLBACK_REASON[input.reason] ?? 'OTHER';
      const fields = [phone, clip(input.preferred_call_time, 100), reason, input.tier ?? null, input.participation_mode ?? null, clip(summary, 500)];
      const upd = await db.query(
        `UPDATE app.havan_callback_requests SET callback_phone_e164 = $3, preferred_call_time = coalesce($4, preferred_call_time), reason = $5,
                tier = coalesce($6, tier), participation_mode = coalesce($7, participation_mode), summary = $8, conversation_id = $9
          WHERE business_id = $1 AND contact_id = $2 AND status = 'NEW' RETURNING id`, [ctx.businessId, ctx.contactId, ...fields, ctx.conversationId]);
      let id: string = upd.rows[0]?.id;
      const updated = Boolean(id);
      if (!id) {
        const ins = await db.query(
          `INSERT INTO app.havan_callback_requests (organization_id, business_id, contact_id, conversation_id, callback_phone_e164, preferred_call_time, reason,
                                                    tier, participation_mode, summary, idempotency_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO UPDATE SET updated_at = now() RETURNING id`,
          [ctx.organizationId, ctx.businessId, ctx.contactId, ctx.conversationId, ...fields, ctx.idempotencyKey]);
        id = ins.rows[0].id;
      }
      const c = await customer(db, ctx);
      await scheduleReminder(db, deps.ops, { organizationId: ctx.organizationId, businessId: ctx.businessId, audience: 'PANDIT', kind: 'CALLBACK',
        callbackRequestId: id, contactId: ctx.contactId, conversationId: ctx.conversationId, dueAt: ctx.now, now: ctx.now,
        idempotencyKey: `${ctx.idempotencyKey}:callback`,
        message: [`📞 *Call-back request${updated ? ' (update)' : ''}*`, '', `🙏 ${c.name ?? 'WhatsApp yajman'}`, `📞 ${displayPhone(phone)}`,
          `Karan: ${REASON_LABEL[input.reason]}`, input.tier && input.tier !== 'NOT_DECIDED' ? `Havan: ${TIER_LABEL[input.tier]}` : null,
          input.participation_mode && input.participation_mode !== 'NOT_DECIDED' ? `Kahan: ${MODE_LABEL[input.participation_mode]}` : null,
          input.preferred_call_time ? `Call ka samay: ${input.preferred_call_time}` : null, '', `📝 ${summary}`].filter((x) => x !== null).join('\n') });
      return { id, phone, updated };
    }, false);
    if (isOutcome(result)) return result;
    const lead = await deps.leads.upsert({ ...ctx.dbContext, organizationId: ctx.organizationId }, {
      businessId: ctx.businessId, contactId: ctx.contactId, conversationId: ctx.conversationId, aiAgentId: ctx.assistantId, source: 'AI_WHATSAPP',
      idempotencyKey: `${ctx.idempotencyKey}:lead`, fields: { ...leadFields({ lead_stage: 'CALLBACK_REQUESTED', service_interest: input.tier, participation_mode: input.participation_mode }),
        attributes: { lead_stage: 'CALLBACK_REQUESTED', callback_requested: true, callback_number: result.phone,
          ...(input.tier ? { service_interest: input.tier } : {}), ...(input.participation_mode ? { participation_mode: input.participation_mode } : {}) } } });
    return ok({ status: result.updated ? 'CALLBACK_REQUEST_UPDATED' : 'CALLBACK_REQUESTED', callbackNumber: displayPhone(result.phone),
      note: 'Pandit Ji has been sent the request. Say Pandit Ji will call back when free. NEVER promise an exact call time. Keep helping in this chat.' },
      { wrote: true, leadId: lead.lead?.id });
  },
};

export const HAVAN_TOOLS: AssistantTool<any>[] = [getTempleInformation, getHavanServiceDetails, getDakshinaPolicy, getFestivalContext, getYajmanLead, updateYajmanLead,
  checkPanditAvailability, getAvailableSlots, createHavanBooking, getHavanBooking, rescheduleHavanBooking, cancelHavanBooking, createYajmanReminder,
  createPanditReminder, requestPanditHandoff];
