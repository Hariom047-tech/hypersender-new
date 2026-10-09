import type { Db } from '../../../database/transaction-runner.js';
import { fail, ok, withDb, type AssistantTool, type ConfirmationPreview, type ToolDeps, type ToolExecutionContext, type ToolOutcome } from '../types.js';
import { addDays, localDate, localLabel } from './format.js';

/*
 * Booking capabilities. Business-level operations only: CREATE_BOOKING checks
 * availability itself (the model never has to run a CRUD sequence), RESCHEDULE
 * is one transaction (BookingService.rescheduleBooking), and the database
 * exclusion constraint remains the final guarantee against double booking.
 * The customer is ALWAYS ctx.contactId: a customer can only see or change their
 * own bookings.
 */

interface Cfg { bookingWindowDays: number; minNoticeMinutes: number; allowSameDay: boolean; slotIntervalMinutes: number; maxSlots: number; defaultDurationMinutes: number }
const cfg = (ctx: ToolExecutionContext): Cfg => ({
  bookingWindowDays: Number(ctx.config.bookingWindowDays ?? 30),
  minNoticeMinutes: Number(ctx.config.minNoticeMinutes ?? 120),
  allowSameDay: ctx.config.allowSameDay !== false,
  slotIntervalMinutes: Number(ctx.config.slotIntervalMinutes ?? 30),
  maxSlots: Number(ctx.config.maxSlots ?? 6),
  defaultDurationMinutes: Number(ctx.config.defaultDurationMinutes ?? 30),
});

interface Svc { id: string; name: string; durationMinutes: number | null }
async function loadService(db: Db, ctx: ToolExecutionContext, id?: string): Promise<Svc | null | 'NOT_FOUND'> {
  if (!id) return null;
  const r = await db.query(`SELECT id, name, duration_minutes FROM app.services WHERE id = $1 AND business_id = $2 AND active AND deleted_at IS NULL`,
    [id, ctx.businessId]);
  return r.rows[0] ? { id: r.rows[0].id, name: r.rows[0].name, durationMinutes: r.rows[0].duration_minutes } : 'NOT_FOUND';
}

interface Res { id: string; name: string; capacity: number }
/** Candidate resources; [] = none suitable; null entry = business-level slots (no bookable resources defined). */
async function candidates(db: Db, ctx: ToolExecutionContext, p: { serviceId?: string; resourceId?: string; partySize?: number }):
  Promise<{ list: Array<Res | null>; error?: string }> {
  if (p.resourceId) {
    const r = await db.query(
      `SELECT id, name, capacity,
              NOT EXISTS (SELECT 1 FROM app.resource_services rs WHERE rs.service_id = $3)
              OR EXISTS (SELECT 1 FROM app.resource_services rs WHERE rs.service_id = $3 AND rs.resource_id = r.id) AS provides
         FROM app.business_resources r WHERE r.id = $1 AND r.business_id = $2 AND r.active AND r.deleted_at IS NULL`,
      [p.resourceId, ctx.businessId, p.serviceId ?? null]);
    const x = r.rows[0];
    if (!x) return { list: [], error: 'RESOURCE_NOT_FOUND' };
    if (p.serviceId && !x.provides) return { list: [], error: 'RESOURCE_DOES_NOT_PROVIDE_SERVICE' };
    if (p.partySize && x.capacity < p.partySize) return { list: [], error: 'PARTY_TOO_LARGE' };
    return { list: [{ id: x.id, name: x.name, capacity: x.capacity }] };
  }
  const types = ctx.assistantDefaults.resourceTypes?.length ? ctx.assistantDefaults.resourceTypes : null;
  const r = await db.query(
    `SELECT r.id, r.name, r.capacity FROM app.business_resources r
      WHERE r.business_id = $1 AND r.active AND r.deleted_at IS NULL
        AND ($2::uuid IS NULL OR NOT EXISTS (SELECT 1 FROM app.resource_services rs WHERE rs.service_id = $2)
             OR EXISTS (SELECT 1 FROM app.resource_services rs WHERE rs.service_id = $2 AND rs.resource_id = r.id))
        AND ($3::text[] IS NULL OR r.resource_type = ANY($3))
      ORDER BY r.capacity, r.name LIMIT 50`, [ctx.businessId, p.serviceId ?? null, types]);
  if (r.rows.length === 0) {
    const any = await db.query('SELECT 1 FROM app.business_resources WHERE business_id = $1 AND active AND deleted_at IS NULL LIMIT 1', [ctx.businessId]);
    return any.rows.length ? { list: [], error: 'NO_MATCHING_RESOURCE' } : { list: [null] };
  }
  const fitting = r.rows.filter((x) => !p.partySize || x.capacity >= p.partySize);
  if (fitting.length === 0) return { list: [], error: 'PARTY_TOO_LARGE' };
  return { list: fitting.map((x) => ({ id: x.id, name: x.name, capacity: x.capacity })) };
}

interface Window { earliest: Date; latest: Date; today: string; lastDate: string }
async function bookingWindow(db: Db, ctx: ToolExecutionContext, c: Cfg): Promise<Window> {
  const today = localDate(ctx.now, ctx.timezone);
  const lastDate = addDays(today, c.bookingWindowDays);
  const r = await db.query(`SELECT (($1::date + 1)::timestamp AT TIME ZONE $2) AS tomorrow, (($3::date + 1)::timestamp AT TIME ZONE $2) AS end_at`,
    [today, ctx.timezone, lastDate]);
  const notice = new Date(ctx.now.getTime() + c.minNoticeMinutes * 60_000);
  const earliest = c.allowSameDay ? notice : new Date(Math.max(notice.getTime(), new Date(r.rows[0].tomorrow).getTime()));
  return { earliest, latest: new Date(r.rows[0].end_at), today, lastDate };
}

export interface Slot { startAt: string; local: string; localDate: string; localTime: string; resources: Array<{ id: string; name: string }> }

async function slotsFor(db: Db, ctx: ToolExecutionContext, deps: ToolDeps, p: { from: string; to: string; resources: Array<Res | null>;
  durationMinutes: number; c: Cfg; w: Window; excludeBookingId?: string }): Promise<Slot[]> {
  const raw = await deps.bookings.bookingsRepo.findFreeSlots(db, {
    businessId: ctx.businessId, resourceIds: p.resources.map((r) => r?.id ?? null), fromDate: p.from, toDate: p.to,
    durationMinutes: p.durationMinutes, stepMinutes: p.c.slotIntervalMinutes, earliest: p.w.earliest, latest: p.w.latest, limit: 2000,
    excludeBookingId: p.excludeBookingId,
  });
  const names = new Map(p.resources.filter(Boolean).map((r) => [r!.id, r!.name]));
  const byStart = new Map<string, Slot>();
  for (const s of raw) {
    const key = s.startAt.toISOString();
    const slot = byStart.get(key) ?? { startAt: key, local: localLabel(s.startAt, s.timezone), localDate: s.localDate, localTime: s.localTime, resources: [] };
    if (s.resourceId) slot.resources.push({ id: s.resourceId, name: names.get(s.resourceId) ?? 'Staff' });
    byStart.set(key, slot);
  }
  return [...byStart.values()];
}

const band = (t: string) => { const h = Number(t.slice(0, 2)); return h < 12 ? 'MORNING' : h < 17 ? 'AFTERNOON' : 'EVENING'; };
const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

type AvailabilityInput = { date_from: string; date_to?: string; service_id?: string; resource_id?: string; party_size?: number;
  time_of_day?: 'MORNING' | 'AFTERNOON' | 'EVENING' | 'ANY'; preferred_time?: string };

export const checkAvailability: AssistantTool<AvailabilityInput> = {
  handlerKey: 'booking.check_availability', isReadOnly: true, timeoutMs: 10_000,
  async execute(ctx, input, deps) {
    const c = cfg(ctx);
    if (ctx.assistantDefaults.requiresPartySize && !input.party_size) return fail('PARTY_SIZE_REQUIRED', 'Ask how many guests.');
    return withDb(ctx, deps, async (db) => {
      const w = await bookingWindow(db, ctx, c);
      const from = input.date_from < w.today ? w.today : input.date_from;
      if (input.date_from < w.today && (input.date_to ?? input.date_from) < w.today) return fail('DATE_IN_PAST', 'That date has passed.');
      if (from > w.lastDate) return fail('OUTSIDE_BOOKING_WINDOW', `Bookings are open up to ${c.bookingWindowDays} days ahead.`, { lastBookableDate: w.lastDate });
      if (!c.allowSameDay && from === w.today && (input.date_to ?? from) === w.today) return fail('SAME_DAY_NOT_ALLOWED', 'Same-day bookings are not available.');
      let to = input.date_to && input.date_to > from ? input.date_to : from;
      if (to > addDays(from, 6)) to = addDays(from, 6);
      if (to > w.lastDate) to = w.lastDate;
      const svc = await loadService(db, ctx, input.service_id);
      if (svc === 'NOT_FOUND') return fail('SERVICE_NOT_FOUND', 'No such service.');
      const cand = await candidates(db, ctx, { serviceId: svc?.id, resourceId: input.resource_id, partySize: input.party_size });
      if (cand.error) return fail(cand.error);
      const duration = svc?.durationMinutes ?? c.defaultDurationMinutes;
      let slots = await slotsFor(db, ctx, deps, { from, to, resources: cand.list, durationMinutes: duration, c, w });
      if (input.time_of_day && input.time_of_day !== 'ANY') slots = slots.filter((s) => band(s.localTime) === input.time_of_day);
      if (input.preferred_time) {
        const target = minutes(input.preferred_time);
        slots = [...slots].sort((a, b) => (a.localDate === b.localDate ? Math.abs(minutes(a.localTime) - target) - Math.abs(minutes(b.localTime) - target) : a.localDate < b.localDate ? -1 : 1));
      }
      if (slots.length === 0) return fail('NO_AVAILABILITY', 'No free slots in that range.', { searched: { from, to } });
      return ok({ timezone: ctx.timezone, service: svc ? { id: svc.id, name: svc.name, durationMinutes: duration } : null,
        slots: slots.slice(0, c.maxSlots).map((s) => ({ start_at: s.startAt, local: s.local, with: s.resources.slice(0, 3) })),
        moreAvailable: slots.length > c.maxSlots });
    });
  },
};

// ---------------------------------------------------------------- create ---
type CreateInput = { start_at: string; service_id?: string; resource_id?: string; customer_name?: string; party_size?: number; notes?: string };
interface PreparedBooking { startAt: Date; endAt: Date; timezone: string; serviceId: string | null; serviceName: string | null;
  resourceId: string | null; resourceName: string | null; customerName: string; customerPhone: string | null; partySize: number | null; local: string }

async function prepareBooking(db: Db, ctx: ToolExecutionContext, deps: ToolDeps, input: CreateInput): Promise<PreparedBooking | ToolOutcome> {
  const c = cfg(ctx);
  const startAt = new Date(input.start_at);
  if (ctx.assistantDefaults.requiresPartySize && !input.party_size) return fail('PARTY_SIZE_REQUIRED', 'Ask how many guests.');
  let contact: { name: string | null; phone: string | null } = { name: ctx.sandboxCustomer?.name ?? null, phone: null };
  if (ctx.contactId) {
    const r = await db.query(`SELECT coalesce(display_name, profile_name) AS name, phone_e164 FROM app.contacts WHERE id = $1 AND business_id = $2`,
      [ctx.contactId, ctx.businessId]);
    if (!r.rows[0]) return fail('NO_CUSTOMER');
    contact = { name: r.rows[0].name, phone: r.rows[0].phone_e164 };
  } else if (ctx.mode === 'LIVE') {
    return fail('NO_CUSTOMER');
  }
  const customerName = input.customer_name?.trim() || contact.name;
  if (!customerName && ctx.config.requireCustomerName !== false) return fail('CUSTOMER_NAME_REQUIRED', "Ask for the customer's name first.");
  if (ctx.mode === 'LIVE' && !contact.phone) return fail('CUSTOMER_PHONE_UNKNOWN', 'This chat has no phone number on file; hand over to the team.');

  const svc = await loadService(db, ctx, input.service_id);
  if (svc === 'NOT_FOUND') return fail('SERVICE_NOT_FOUND', 'No such service.');
  const w = await bookingWindow(db, ctx, c);
  if (startAt.getTime() < ctx.now.getTime()) return fail('TIME_IN_PAST', 'That time has passed.');
  if (startAt < w.earliest) return fail(c.allowSameDay ? 'TOO_SOON' : 'SAME_DAY_NOT_ALLOWED', `Bookings need at least ${c.minNoticeMinutes} minutes notice.`);
  if (startAt >= w.latest) return fail('OUTSIDE_BOOKING_WINDOW', `Bookings are open up to ${c.bookingWindowDays} days ahead.`);
  const cand = await candidates(db, ctx, { serviceId: svc?.id, resourceId: input.resource_id, partySize: input.party_size });
  if (cand.error) return fail(cand.error);
  const duration = svc?.durationMinutes ?? c.defaultDurationMinutes;
  const day = localDate(startAt, ctx.timezone);
  const slots = await slotsFor(db, ctx, deps, { from: day, to: addDays(day, 1), resources: cand.list, durationMinutes: duration, c, w });
  const exact = slots.find((s) => s.startAt === startAt.toISOString());
  if (!exact) {
    const later = await slotsFor(db, ctx, deps, { from: day, to: addDays(day, 3), resources: cand.list, durationMinutes: duration, c, w });
    const near = later.sort((a, b) => Math.abs(Date.parse(a.startAt) - startAt.getTime()) - Math.abs(Date.parse(b.startAt) - startAt.getTime())).slice(0, 4);
    return fail('SLOT_NOT_AVAILABLE', 'That time is not free.', { alternatives: near.map((s) => ({ start_at: s.startAt, local: s.local })) });
  }
  const resource = exact.resources.find((r) => r.id === input.resource_id) ?? exact.resources[0] ?? null;
  return { startAt, endAt: new Date(startAt.getTime() + duration * 60_000), timezone: ctx.timezone, serviceId: svc?.id ?? null, serviceName: svc?.name ?? null,
    resourceId: resource?.id ?? null, resourceName: resource?.name ?? null, customerName: customerName ?? 'Customer', customerPhone: contact.phone,
    partySize: input.party_size ?? null, local: exact.local };
}

const bookingView = (p: PreparedBooking, extra: Record<string, unknown> = {}) => ({
  start_at: p.startAt.toISOString(), local: p.local, service: p.serviceName, with: p.resourceName, customerName: p.customerName,
  partySize: p.partySize, ...extra });

const isOutcome = (x: unknown): x is ToolOutcome => typeof x === 'object' && x !== null && 'result' in x;

export const createBooking: AssistantTool<CreateInput> = {
  handlerKey: 'booking.create', isReadOnly: false, timeoutMs: 10_000,
  async preview(ctx, input, deps): Promise<ConfirmationPreview> {
    const p = await withDb(ctx, deps, (db) => prepareBooking(db, ctx, deps, input));
    if (isOutcome(p)) return { ok: false, outcome: p };
    const what = [p.serviceName, p.resourceName ? `with ${p.resourceName}` : null, p.partySize ? `for ${p.partySize} guests` : null].filter(Boolean).join(' ');
    return { ok: true, text: `Book ${what || 'an appointment'} on ${p.local} under the name ${p.customerName}`, details: bookingView(p) };
  },
  async dryRun(ctx, input, deps) {
    const p = await withDb(ctx, deps, (db) => prepareBooking(db, ctx, deps, input));
    if (isOutcome(p)) return p;
    return ok({ dryRun: true, status: 'WOULD_CREATE_BOOKING', wouldCreate: bookingView(p) });
  },
  async execute(ctx, input, deps) {
    // Idempotent replay FIRST: a retried run must get its original booking back, not a "slot taken" by itself.
    const replay = await withDb(ctx, deps, async (db) => {
      const b = await deps.bookings.bookingsRepo.findByIdempotencyKey(db, ctx.idempotencyKey);
      if (!b) return null;
      const r = (await db.query(
        `SELECT b.id, b.status, b.start_at, b.timezone, b.customer_name, b.party_size, s.name AS service, r.name AS resource FROM app.bookings b
           LEFT JOIN app.services s ON s.id = b.service_id LEFT JOIN app.business_resources r ON r.id = b.resource_id WHERE b.id = $1`, [b.id])).rows[0];
      return r;
    });
    if (replay) {
      return ok({ status: 'BOOKING_CREATED', replayed: true, booking: { id: replay.id, status: replay.status, start_at: replay.start_at.toISOString(),
        local: localLabel(replay.start_at, replay.timezone), service: replay.service, with: replay.resource, customerName: replay.customer_name,
        partySize: replay.party_size } }, { bookingId: replay.id });
    }
    const p = await withDb(ctx, deps, (db) => prepareBooking(db, ctx, deps, input));
    if (isOutcome(p)) return p;
    const res = await deps.bookings.createBooking({ ...ctx.dbContext, organizationId: ctx.organizationId }, {
      businessId: ctx.businessId, contactId: ctx.contactId!, serviceId: p.serviceId, resourceId: p.resourceId, conversationId: ctx.conversationId,
      aiAgentId: ctx.assistantId, bookingType: ctx.assistantDefaults.bookingType ?? 'APPOINTMENT', startAt: p.startAt, endAt: p.endAt,
      timezone: p.timezone, customerName: p.customerName, customerPhone: p.customerPhone!, partySize: p.partySize,
      notes: input.notes ?? null, source: 'AI_WHATSAPP', createdByType: 'AI', idempotencyKey: ctx.idempotencyKey,
      confirm: ctx.config.autoConfirm !== false,
    });
    if (!res.ok) {
      const code = res.reason === 'SLOT_UNAVAILABLE' || res.reason === 'OUTSIDE_AVAILABILITY' ? 'SLOT_NOT_AVAILABLE' : res.reason;
      return fail(code, 'The booking was not created.');
    }
    const status = (await withDb(ctx, deps, (db) => db.query('SELECT status FROM app.bookings WHERE id = $1', [res.bookingId]))).rows[0]?.status;
    return ok({ status: 'BOOKING_CREATED', booking: { id: res.bookingId, status, ...bookingView(p) } }, { bookingId: res.bookingId, wrote: true });
  },
};

// ------------------------------------------------------ get / cancel / move ---
async function customerBookings(db: Db, ctx: ToolExecutionContext, bookingId?: string) {
  const r = await db.query(
    `SELECT b.id, b.status, b.start_at, b.end_at, b.timezone, b.party_size, s.name AS service, r.name AS resource
       FROM app.bookings b LEFT JOIN app.services s ON s.id = b.service_id LEFT JOIN app.business_resources r ON r.id = b.resource_id
      WHERE b.business_id = $1 AND b.contact_id = $2
        AND ($3::uuid IS NOT NULL AND b.id = $3 OR $3::uuid IS NULL AND b.status IN ('PENDING','CONFIRMED') AND b.end_at > now())
      ORDER BY b.start_at LIMIT 10`, [ctx.businessId, ctx.contactId, bookingId ?? null]);
  return r.rows.map((b) => ({ id: b.id, status: b.status, start_at: b.start_at.toISOString(), local: localLabel(b.start_at, b.timezone),
    service: b.service, with: b.resource, partySize: b.party_size }));
}

export const getBooking: AssistantTool<{ booking_id?: string }> = {
  handlerKey: 'booking.get', isReadOnly: true,
  async execute(ctx, input, deps) {
    if (!ctx.contactId) return ok({ bookings: [], note: 'Test chat: no real customer bookings.' });
    const bookings = await withDb(ctx, deps, (db) => customerBookings(db, ctx, input.booking_id));
    if (input.booking_id && bookings.length === 0) return fail('NOT_FOUND', 'No such booking for this customer.');
    return ok({ bookings });
  },
};

async function ownBooking(ctx: ToolExecutionContext, deps: ToolDeps, id: string) {
  if (!ctx.contactId) return null;
  const [b] = await withDb(ctx, deps, (db) => customerBookings(db, ctx, id));
  return b ?? null;
}

export const cancelBooking: AssistantTool<{ booking_id: string; reason?: string }> = {
  handlerKey: 'booking.cancel', isReadOnly: false,
  async preview(ctx, input, deps) {
    const b = await ownBooking(ctx, deps, input.booking_id);
    if (!b) return { ok: false, outcome: fail('NOT_FOUND', 'No such booking for this customer.') };
    if (!['PENDING', 'CONFIRMED'].includes(b.status)) return { ok: false, outcome: fail('NOT_CANCELLABLE', `Booking is ${b.status.toLowerCase()}.`) };
    return { ok: true, text: `Cancel ${b.service ?? 'the booking'}${b.with ? ` with ${b.with}` : ''} on ${b.local}`, details: b };
  },
  async dryRun(ctx, input, deps) {
    if (!ctx.contactId) return ok({ dryRun: true, status: 'WOULD_CANCEL', note: 'Test chat has no real bookings.' });
    const pv = await this.preview!(ctx, input, deps);
    return pv.ok ? ok({ dryRun: true, status: 'WOULD_CANCEL', booking: pv.details }) : pv.outcome;
  },
  async execute(ctx, input, deps) {
    if (!ctx.contactId) return fail('NO_CUSTOMER');
    const r = await deps.bookings.cancelBooking({ ...ctx.dbContext, organizationId: ctx.organizationId }, { bookingId: input.booking_id,
      businessId: ctx.businessId, contactId: ctx.contactId, reason: input.reason, performedByType: 'AI', minNoticeMinutes: Number(ctx.config.minNoticeMinutes ?? 0), now: ctx.now });
    if (!r.ok) return fail(r.reason === 'TOO_LATE' ? 'TOO_LATE_TO_CANCEL' : r.reason);
    return ok({ status: r.alreadyCancelled ? 'ALREADY_CANCELLED' : 'BOOKING_CANCELLED', booking: { id: r.bookingId, start_at: r.startAt.toISOString(),
      local: localLabel(r.startAt, ctx.timezone) } }, { bookingId: r.bookingId, wrote: true });
  },
};

type MoveInput = { booking_id: string; new_start_at: string };
async function prepareMove(ctx: ToolExecutionContext, deps: ToolDeps, input: MoveInput): Promise<{ from: any; to: { start_at: string; local: string } } | ToolOutcome> {
  const b = await ownBooking(ctx, deps, input.booking_id);
  if (!b) return fail('NOT_FOUND', 'No such booking for this customer.');
  if (!['PENDING', 'CONFIRMED'].includes(b.status)) return fail('NOT_RESCHEDULABLE', `Booking is ${b.status.toLowerCase()}.`);
  const newStart = new Date(input.new_start_at);
  const c = { ...cfg(ctx), minNoticeMinutes: Number(ctx.config.minNoticeMinutes ?? 120) };
  return withDb(ctx, deps, async (db) => {
    const full = await deps.bookings.bookingsRepo.findForContact(db, b.id, ctx.businessId, ctx.contactId!);
    const duration = Math.round((full!.endAt.getTime() - full!.startAt.getTime()) / 60_000);
    const w = await bookingWindow(db, ctx, c);
    if (newStart < w.earliest) return fail('TOO_SOON', `Needs at least ${c.minNoticeMinutes} minutes notice.`);
    if (newStart >= w.latest) return fail('OUTSIDE_BOOKING_WINDOW');
    const day = localDate(newStart, ctx.timezone);
    const res = full!.resourceId ? [{ id: full!.resourceId, name: b.with ?? 'Staff', capacity: 1 }] : [null];
    const slots = await slotsFor(db, ctx, deps, { from: day, to: addDays(day, 1), resources: res, durationMinutes: duration, c, w, excludeBookingId: b.id });
    const exact = slots.find((s) => s.startAt === newStart.toISOString());
    if (!exact) {
      const near = slots.sort((x, y) => Math.abs(Date.parse(x.startAt) - newStart.getTime()) - Math.abs(Date.parse(y.startAt) - newStart.getTime())).slice(0, 4);
      return fail('SLOT_NOT_AVAILABLE', 'That time is not free.', { alternatives: near.map((s) => ({ start_at: s.startAt, local: s.local })) });
    }
    return { from: b, to: { start_at: exact.startAt, local: exact.local } };
  });
}

export const rescheduleBooking: AssistantTool<MoveInput> = {
  handlerKey: 'booking.reschedule', isReadOnly: false, timeoutMs: 10_000,
  async preview(ctx, input, deps) {
    if (!ctx.contactId) return { ok: true, text: `Move the booking to ${localLabel(new Date(input.new_start_at), ctx.timezone)}`, details: { new_start_at: input.new_start_at } };
    const p = await prepareMove(ctx, deps, input);
    if (isOutcome(p)) return { ok: false, outcome: p };
    return { ok: true, text: `Move ${p.from.service ?? 'your booking'} from ${p.from.local} to ${p.to.local}`, details: { from: p.from, to: p.to } };
  },
  async dryRun(ctx, input, deps) {
    if (!ctx.contactId) return ok({ dryRun: true, status: 'WOULD_RESCHEDULE', note: 'Test chat has no real bookings.' });
    const p = await prepareMove(ctx, deps, input);
    return isOutcome(p) ? p : ok({ dryRun: true, status: 'WOULD_RESCHEDULE', from: p.from, to: p.to });
  },
  async execute(ctx, input, deps) {
    if (!ctx.contactId) return fail('NO_CUSTOMER');
    const p = await prepareMove(ctx, deps, input);
    if (isOutcome(p)) return p;
    const r = await deps.bookings.rescheduleBooking({ ...ctx.dbContext, organizationId: ctx.organizationId }, {
      bookingId: input.booking_id, businessId: ctx.businessId, contactId: ctx.contactId, newStartAt: new Date(input.new_start_at),
      idempotencyKey: ctx.idempotencyKey, performedByType: 'AI', aiAgentId: ctx.assistantId, conversationId: ctx.conversationId,
      minNoticeMinutes: Number(ctx.config.minNoticeMinutes ?? 120), now: ctx.now });
    if (!r.ok) return fail(r.reason === 'SLOT_UNAVAILABLE' || r.reason === 'OUTSIDE_AVAILABILITY' ? 'SLOT_NOT_AVAILABLE' : r.reason);
    return ok({ status: 'BOOKING_RESCHEDULED', booking: { id: r.bookingId, previousBookingId: r.previousBookingId, start_at: r.startAt.toISOString(),
      local: localLabel(r.startAt, ctx.timezone) } }, { bookingId: r.bookingId, wrote: true });
  },
};
