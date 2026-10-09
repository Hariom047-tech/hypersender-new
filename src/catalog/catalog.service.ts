import type { TenantContext } from '../database/tenant-context.js';
import type { Db, TransactionRunner } from '../database/transaction-runner.js';
import { isPgError, PgCode } from '../database/errors.js';
import { OpsRepository } from '../repositories/ops.repository.js';
import { WhatsAppError } from '../whatsapp/domain/whatsapp-errors.js';

/*
 * Owner-managed business catalog (dashboard, hs_app, tenant RLS):
 * services & prices, bookable resources (tables with seats, doctors, stylists,
 * rooms), weekly availability, holidays/time off, branches/locations and the
 * bookings created by the assistant or staff. Everything the AI tools read.
 */
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekly = Partial<Record<(typeof DAYS)[number], Array<[string, string]>>>;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;
export const RESOURCE_TYPES = ['TABLE', 'DOCTOR', 'DENTIST', 'STYLIST', 'THERAPIST', 'ROOM', 'STAFF', 'AGENT', 'EQUIPMENT'] as const;

const bad = (m: string): never => { throw new WhatsAppError('VALIDATION_FAILED', m); };
const optText = (v: unknown, field: string, max: number): string | null => {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || v.length > max) bad(`${field} must be text up to ${max} characters`);
  return (v as string).trim() || null;
};
const reqText = (v: unknown, field: string, max: number): string => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) bad(`${field} is required (max ${max} characters)`);
  return (v as string).trim();
};
const optInt = (v: unknown, field: string, min: number, max: number): number | null => {
  if (v === undefined || v === null || v === '') return null;
  if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) bad(`${field} must be a whole number ${min}-${max}`);
  return v as number;
};
const uuidList = (v: unknown, field: string): string[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 200 || !v.every((x) => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x))) bad(`${field} must be a list of ids`);
  return Array.from(new Set(v as string[]));
};

export function validateWeekly(w: unknown): Weekly {
  if (!w || typeof w !== 'object' || Array.isArray(w)) return bad('hours must be an object of days');
  const out: Weekly = {};
  for (const [k, v] of Object.entries(w as Record<string, unknown>)) {
    if (!DAYS.includes(k as never)) bad(`unknown day ${k}`);
    if (!Array.isArray(v) || v.length > 4) bad(`${k}: up to 4 time ranges`);
    const ranges = (v as unknown[]).map((r) => {
      if (!Array.isArray(r) || r.length !== 2 || !r.every((t) => typeof t === 'string' && TIME_RE.test(t))) bad(`${k}: ranges must be ["HH:MM","HH:MM"]`);
      const [a, b] = r as [string, string];
      if (a >= b) bad(`${k}: ${a} must be before ${b}`);
      return [a, b] as [string, string];
    }).sort((x, y) => x[0].localeCompare(y[0]));
    for (let i = 1; i < ranges.length; i++) if (ranges[i][0] < ranges[i - 1][1]) bad(`${k}: time ranges overlap`);
    if (ranges.length) out[k as (typeof DAYS)[number]] = ranges;
  }
  return out;
}

export class CatalogService {
  private readonly ops = new OpsRepository();
  constructor(private readonly tx: TransactionRunner) {}

  private async business(db: Db, ctx: TenantContext, businessId: string): Promise<{ id: string; currency: string; timezone: string }> {
    if (ctx.businessId && ctx.businessId !== businessId) throw new WhatsAppError('NOT_FOUND', 'business not found');
    const b = (await db.query('SELECT id, currency, timezone FROM app.businesses WHERE id = $1 AND deleted_at IS NULL', [businessId])).rows[0];
    if (!b) throw new WhatsAppError('NOT_FOUND', 'business not found');
    return b;
  }
  private audit(db: Db, ctx: TenantContext, action: string, resourceType: string, id: string | undefined, metadata: object = {}) {
    return this.ops.audit(db, { organizationId: ctx.organizationId, actorType: ctx.apiKeyId ? 'API_KEY' : 'USER', actorUserId: ctx.userId,
      actorApiKeyId: ctx.apiKeyId, action, resourceType, resourceId: id, requestId: ctx.requestId, metadata });
  }

  // ------------------------------------------------------------- services ---
  listServices(ctx: TenantContext, businessId: string) {
    return this.tx.inTenant(async (db) => {
      await this.business(db, ctx, businessId);
      return (await db.query(
        `SELECT s.id, s.name, s.description, s.duration_minutes AS "durationMinutes", s.price_minor_units AS "priceMinor", s.currency, s.active,
                coalesce((SELECT array_agg(rs.resource_id) FROM app.resource_services rs WHERE rs.service_id = s.id), '{}') AS "resourceIds"
           FROM app.services s WHERE s.business_id = $1 AND s.deleted_at IS NULL ORDER BY s.name`, [businessId])).rows
        .map((r) => ({ ...r, priceMinor: r.priceMinor === null ? null : Number(r.priceMinor) }));
    }, ctx, { readOnly: true });
  }

  saveService(ctx: TenantContext, businessId: string, id: string | null, b: Record<string, unknown>) {
    const name = reqText(b.name, 'name', 200);
    const description = optText(b.description, 'description', 1000);
    const duration = optInt(b.durationMinutes, 'durationMinutes', 1, 1440);
    const price = b.priceMinor === undefined || b.priceMinor === null || b.priceMinor === '' ? null : optInt(b.priceMinor, 'priceMinor', 0, 10_000_000_00);
    const active = b.active === undefined ? true : Boolean(b.active);
    const resourceIds = b.resourceIds === undefined ? null : uuidList(b.resourceIds, 'resourceIds');
    return this.tx.inTenant(async (db) => {
      const biz = await this.business(db, ctx, businessId);
      let sid = id;
      if (sid) {
        const r = await db.query(`UPDATE app.services SET name = $2, description = $3, duration_minutes = $4, price_minor_units = $5, active = $6
                                   WHERE id = $1 AND business_id = $7 AND deleted_at IS NULL RETURNING id`, [sid, name, description, duration, price, active, businessId]);
        if (!r.rowCount) throw new WhatsAppError('NOT_FOUND', 'service not found');
      } else {
        sid = (await db.query(`INSERT INTO app.services (organization_id, business_id, name, description, duration_minutes, price_minor_units, currency, active)
                                VALUES (app.current_org_id(), $1, $2, $3, $4, $5, $6, $7) RETURNING id`, [businessId, name, description, duration, price, biz.currency, active])).rows[0].id;
      }
      if (resourceIds) {
        await db.query('DELETE FROM app.resource_services WHERE service_id = $1', [sid]);
        if (resourceIds.length) {
          const ok = await db.query('SELECT count(*)::int AS n FROM app.business_resources WHERE id = ANY($1::uuid[]) AND business_id = $2 AND deleted_at IS NULL', [resourceIds, businessId]);
          if (ok.rows[0].n !== resourceIds.length) bad('some staff/resources do not belong to this business');
          await db.query(`INSERT INTO app.resource_services (organization_id, business_id, resource_id, service_id)
                          SELECT app.current_org_id(), $1, r, $2 FROM unnest($3::uuid[]) r`, [businessId, sid, resourceIds]);
        }
      }
      await this.audit(db, ctx, id ? 'SERVICE_UPDATED' : 'SERVICE_CREATED', 'SERVICE', sid!);
      return { id: sid };
    }, ctx);
  }

  deleteService(ctx: TenantContext, businessId: string, id: string) {
    return this.tx.inTenant(async (db) => {
      await this.business(db, ctx, businessId);
      const r = await db.query('UPDATE app.services SET deleted_at = now(), active = false WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL', [id, businessId]);
      if (!r.rowCount) throw new WhatsAppError('NOT_FOUND', 'service not found');
      await db.query('DELETE FROM app.resource_services WHERE service_id = $1', [id]);
      await this.audit(db, ctx, 'SERVICE_DELETED', 'SERVICE', id);
      return { deleted: true };
    }, ctx);
  }

  // ------------------------------------------------------------ resources ---
  listResources(ctx: TenantContext, businessId: string) {
    return this.tx.inTenant(async (db) => {
      await this.business(db, ctx, businessId);
      return (await db.query(
        `SELECT r.id, r.resource_type AS "resourceType", r.name, r.description, r.capacity, r.active,
                coalesce((SELECT array_agg(rs.service_id) FROM app.resource_services rs WHERE rs.resource_id = r.id), '{}') AS "serviceIds",
                EXISTS (SELECT 1 FROM app.availability_rules a WHERE a.resource_id = r.id) AS "hasOwnHours"
           FROM app.business_resources r WHERE r.business_id = $1 AND r.deleted_at IS NULL ORDER BY r.resource_type, r.name`, [businessId])).rows;
    }, ctx, { readOnly: true });
  }

  saveResource(ctx: TenantContext, businessId: string, id: string | null, b: Record<string, unknown>) {
    const type = String(b.resourceType ?? '').toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(type)) bad('resourceType is required (e.g. TABLE, DOCTOR, STYLIST)');
    const name = reqText(b.name, 'name', 200);
    const description = optText(b.description, 'description', 1000);
    const capacity = optInt(b.capacity ?? 1, 'capacity', 1, 1000)!;
    const active = b.active === undefined ? true : Boolean(b.active);
    const serviceIds = b.serviceIds === undefined ? null : uuidList(b.serviceIds, 'serviceIds');
    return this.tx.inTenant(async (db) => {
      await this.business(db, ctx, businessId);
      let rid = id;
      if (rid) {
        const r = await db.query(`UPDATE app.business_resources SET resource_type = $2, name = $3, description = $4, capacity = $5, active = $6
                                   WHERE id = $1 AND business_id = $7 AND deleted_at IS NULL RETURNING id`, [rid, type, name, description, capacity, active, businessId]);
        if (!r.rowCount) throw new WhatsAppError('NOT_FOUND', 'resource not found');
      } else {
        rid = (await db.query(`INSERT INTO app.business_resources (organization_id, business_id, resource_type, name, description, capacity, active)
                                VALUES (app.current_org_id(), $1, $2, $3, $4, $5, $6) RETURNING id`, [businessId, type, name, description, capacity, active])).rows[0].id;
      }
      if (serviceIds) {
        await db.query('DELETE FROM app.resource_services WHERE resource_id = $1', [rid]);
        if (serviceIds.length) {
          const ok = await db.query('SELECT count(*)::int AS n FROM app.services WHERE id = ANY($1::uuid[]) AND business_id = $2 AND deleted_at IS NULL', [serviceIds, businessId]);
          if (ok.rows[0].n !== serviceIds.length) bad('some services do not belong to this business');
          await db.query(`INSERT INTO app.resource_services (organization_id, business_id, resource_id, service_id)
                          SELECT app.current_org_id(), $1, $2, s FROM unnest($3::uuid[]) s`, [businessId, rid, serviceIds]);
        }
      }
      await this.audit(db, ctx, id ? 'RESOURCE_UPDATED' : 'RESOURCE_CREATED', 'RESOURCE', rid!);
      return { id: rid };
    }, ctx);
  }

  deleteResource(ctx: TenantContext, businessId: string, id: string) {
    return this.tx.inTenant(async (db) => {
      await this.business(db, ctx, businessId);
      const future = await db.query(`SELECT count(*)::int AS n FROM app.bookings WHERE resource_id = $1 AND status IN ('PENDING','CONFIRMED') AND start_at > now()`, [id]);
      if (future.rows[0].n > 0) throw new WhatsAppError('CONFLICT', `This has ${future.rows[0].n} upcoming booking(s). Cancel or move them first, or mark it inactive.`);
      const r = await db.query('UPDATE app.business_resources SET deleted_at = now(), active = false WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL', [id, businessId]);
      if (!r.rowCount) throw new WhatsAppError('NOT_FOUND', 'resource not found');
      await db.query('DELETE FROM app.resource_services WHERE resource_id = $1', [id]);
      await db.query('DELETE FROM app.availability_rules WHERE resource_id = $1', [id]);
      await this.audit(db, ctx, 'RESOURCE_DELETED', 'RESOURCE', id);
      return { deleted: true };
    }, ctx);
  }

  // --------------------------------------------------------- availability ---
  /** Weekly bookable hours: business-wide (resourceId null) or for one resource (overrides business-wide). */
  getAvailability(ctx: TenantContext, businessId: string, resourceId: string | null) {
    return this.tx.inTenant(async (db) => {
      const biz = await this.business(db, ctx, businessId);
      const r = await db.query(
        `SELECT day_of_week, to_char(start_time, 'HH24:MI') AS s, CASE WHEN end_time = '24:00' THEN '24:00' ELSE to_char(end_time, 'HH24:MI') END AS e, timezone
           FROM app.availability_rules WHERE business_id = $1 AND resource_id IS NOT DISTINCT FROM $2::uuid ORDER BY day_of_week, start_time`, [businessId, resourceId]);
      const weekly: Weekly = {};
      for (const x of r.rows) (weekly[DAYS[x.day_of_week - 1]] ??= []).push([x.s, x.e]);
      return { resourceId, timezone: r.rows[0]?.timezone ?? biz.timezone, weekly, configured: r.rows.length > 0 };
    }, ctx, { readOnly: true });
  }

  setAvailability(ctx: TenantContext, businessId: string, resourceId: string | null, weeklyRaw: unknown) {
    const weekly = validateWeekly(weeklyRaw);
    return this.tx.inTenant(async (db) => {
      const biz = await this.business(db, ctx, businessId);
      if (resourceId) {
        const ok = await db.query('SELECT 1 FROM app.business_resources WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL', [resourceId, businessId]);
        if (!ok.rowCount) throw new WhatsAppError('NOT_FOUND', 'resource not found');
      }
      await db.query('DELETE FROM app.availability_rules WHERE business_id = $1 AND resource_id IS NOT DISTINCT FROM $2::uuid', [businessId, resourceId]);
      for (const [i, day] of DAYS.entries()) {
        for (const [s, e] of weekly[day] ?? []) {
          await db.query(`INSERT INTO app.availability_rules (organization_id, business_id, resource_id, day_of_week, start_time, end_time, timezone)
                          VALUES (app.current_org_id(), $1, $2, $3, $4, $5, $6)`, [businessId, resourceId, i + 1, s, e, biz.timezone]);
        }
      }
      await this.audit(db, ctx, 'AVAILABILITY_UPDATED', resourceId ? 'RESOURCE' : 'BUSINESS', resourceId ?? businessId);
      return { saved: true };
    }, ctx);
  }

  listExceptions(ctx: TenantContext, businessId: string) {
    return this.tx.inTenant(async (db) => {
      await this.business(db, ctx, businessId);
      return (await db.query(
        `SELECT e.id, e.resource_id AS "resourceId", r.name AS "resourceName", e.start_at AS "startAt", e.end_at AS "endAt", e.type, e.reason
           FROM app.availability_exceptions e LEFT JOIN app.business_resources r ON r.id = e.resource_id
          WHERE e.business_id = $1 AND e.end_at > now() - interval '1 day' ORDER BY e.start_at LIMIT 200`, [businessId])).rows;
    }, ctx, { readOnly: true });
  }

  addException(ctx: TenantContext, businessId: string, b: Record<string, unknown>) {
    const type = String(b.type ?? 'HOLIDAY');
    if (!['HOLIDAY', 'LEAVE', 'BLOCKED', 'SPECIAL_OPENING'].includes(type)) bad('type must be HOLIDAY, LEAVE, BLOCKED or SPECIAL_OPENING');
    const start = new Date(String(b.startAt));
    const end = new Date(String(b.endAt));
    if (Number.isNaN(+start) || Number.isNaN(+end) || start >= end) bad('startAt must be before endAt');
    if (+end - +start > 366 * 86_400_000) bad('an exception can cover at most one year');
    const reason = optText(b.reason, 'reason', 300);
    const resourceId = b.resourceId ? String(b.resourceId) : null;
    return this.tx.inTenant(async (db) => {
      await this.business(db, ctx, businessId);
      try {
        const r = await db.query(`INSERT INTO app.availability_exceptions (organization_id, business_id, resource_id, start_at, end_at, type, reason)
                                  VALUES (app.current_org_id(), $1, $2, $3, $4, $5, $6) RETURNING id`, [businessId, resourceId, start, end, type, reason]);
        await this.audit(db, ctx, 'AVAILABILITY_EXCEPTION_ADDED', 'BUSINESS', businessId, { type });
        return { id: r.rows[0].id };
      } catch (err) {
        if (isPgError(err, PgCode.FOREIGN_KEY_VIOLATION)) throw new WhatsAppError('NOT_FOUND', 'resource not found');
        throw err;
      }
    }, ctx);
  }

  deleteException(ctx: TenantContext, businessId: string, id: string) {
    return this.tx.inTenant(async (db) => {
      await this.business(db, ctx, businessId);
      const r = await db.query('DELETE FROM app.availability_exceptions WHERE id = $1 AND business_id = $2', [id, businessId]);
      if (!r.rowCount) throw new WhatsAppError('NOT_FOUND', 'not found');
      return { deleted: true };
    }, ctx);
  }

  // ------------------------------------------------------------ locations ---
  listLocations(ctx: TenantContext, businessId: string) {
    return this.tx.inTenant(async (db) => {
      await this.business(db, ctx, businessId);
      return (await db.query(
        `SELECT id, name, address, phone_e164 AS phone, latitude, longitude, is_primary AS "isPrimary", status
           FROM app.business_locations WHERE business_id = $1 AND deleted_at IS NULL ORDER BY is_primary DESC, name`, [businessId])).rows
        .map((l) => ({ ...l, latitude: l.latitude === null ? null : Number(l.latitude), longitude: l.longitude === null ? null : Number(l.longitude) }));
    }, ctx, { readOnly: true });
  }

  saveLocation(ctx: TenantContext, businessId: string, id: string | null, b: Record<string, unknown>) {
    const name = reqText(b.name, 'name', 200);
    const a = (b.address && typeof b.address === 'object' && !Array.isArray(b.address) ? b.address : {}) as Record<string, unknown>;
    const address: Record<string, string> = {};
    for (const k of ['line1', 'line2', 'landmark', 'city', 'state', 'postalCode', 'country']) {
      const v = optText(a[k], `address.${k}`, 200);
      if (v) address[k] = v;
    }
    if (!address.line1 && !address.city) bad('address needs at least a street line or city');
    if (address.postalCode && !/^[0-9A-Za-z -]{3,10}$/.test(address.postalCode)) bad('invalid postal code');
    const phone = optText(b.phone, 'phone', 20);
    if (phone && !/^\+[1-9][0-9]{6,14}$/.test(phone)) bad('phone must be in international format, e.g. +919812345678');
    const lat = b.latitude === undefined || b.latitude === null || b.latitude === '' ? null : Number(b.latitude);
    const lng = b.longitude === undefined || b.longitude === null || b.longitude === '' ? null : Number(b.longitude);
    if ((lat === null) !== (lng === null)) bad('provide both latitude and longitude');
    if (lat !== null && (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng!) || lng! < -180 || lng! > 180)) bad('invalid coordinates');
    const isPrimary = Boolean(b.isPrimary);
    return this.tx.inTenant(async (db) => {
      const biz = await this.business(db, ctx, businessId);
      if (isPrimary) await db.query('UPDATE app.business_locations SET is_primary = false WHERE business_id = $1 AND is_primary AND id IS DISTINCT FROM $2::uuid', [businessId, id]);
      let lid = id;
      if (lid) {
        const r = await db.query(`UPDATE app.business_locations SET name = $2, address = $3, phone_e164 = $4, latitude = $5, longitude = $6, is_primary = $7
                                   WHERE id = $1 AND business_id = $8 AND deleted_at IS NULL RETURNING id`,
          [lid, name, JSON.stringify(address), phone, lat, lng, isPrimary, businessId]);
        if (!r.rowCount) throw new WhatsAppError('NOT_FOUND', 'location not found');
      } else {
        const first = (await db.query('SELECT count(*)::int AS n FROM app.business_locations WHERE business_id = $1 AND deleted_at IS NULL', [businessId])).rows[0].n === 0;
        lid = (await db.query(`INSERT INTO app.business_locations (organization_id, business_id, name, address, timezone, phone_e164, latitude, longitude, is_primary)
                                VALUES (app.current_org_id(), $1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [businessId, name, JSON.stringify(address), biz.timezone, phone, lat, lng, isPrimary || first])).rows[0].id;
      }
      await this.audit(db, ctx, id ? 'LOCATION_UPDATED' : 'LOCATION_CREATED', 'LOCATION', lid!);
      return { id: lid };
    }, ctx);
  }

  deleteLocation(ctx: TenantContext, businessId: string, id: string) {
    return this.tx.inTenant(async (db) => {
      await this.business(db, ctx, businessId);
      const r = await db.query('UPDATE app.business_locations SET deleted_at = now(), is_primary = false WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL', [id, businessId]);
      if (!r.rowCount) throw new WhatsAppError('NOT_FOUND', 'location not found');
      await this.audit(db, ctx, 'LOCATION_DELETED', 'LOCATION', id);
      return { deleted: true };
    }, ctx);
  }

  // ------------------------------------------------------------- bookings ---
  listBookings(ctx: TenantContext, q: { businessId?: string; from: Date; to: Date; status?: string }) {
    return this.tx.inTenant(async (db) => {
      const business = ctx.businessId ?? q.businessId ?? null;
      return (await db.query(
        `SELECT b.id, b.status, b.start_at AS "startAt", b.end_at AS "endAt", b.timezone, b.booking_type AS "bookingType", b.party_size AS "partySize",
                b.customer_name AS "customerName", b.customer_phone AS "customerPhone", b.notes, b.source, b.created_by_type AS "createdBy",
                s.name AS "serviceName", r.name AS "resourceName", r.resource_type AS "resourceType", bz.name AS "businessName", b.business_id AS "businessId",
                b.conversation_id AS "conversationId", a.name AS "assistantName", b.created_at AS "createdAt"
           FROM app.bookings b JOIN app.businesses bz ON bz.id = b.business_id
           LEFT JOIN app.services s ON s.id = b.service_id LEFT JOIN app.business_resources r ON r.id = b.resource_id
           LEFT JOIN app.ai_agents a ON a.id = b.ai_agent_id
          WHERE ($1::uuid IS NULL OR b.business_id = $1) AND b.start_at < $3 AND b.end_at > $2 AND ($4::text IS NULL OR b.status = $4)
          ORDER BY b.start_at LIMIT 500`, [business, q.from, q.to, q.status ?? null])).rows;
    }, ctx, { readOnly: true });
  }

  setBookingStatus(ctx: TenantContext, id: string, status: 'CONFIRMED' | 'COMPLETED' | 'NO_SHOW' | 'CANCELLED', reason?: string) {
    const allowed: Record<string, string[]> = { CONFIRMED: ['PENDING'], COMPLETED: ['PENDING', 'CONFIRMED'], NO_SHOW: ['PENDING', 'CONFIRMED'], CANCELLED: ['PENDING', 'CONFIRMED'] };
    return this.tx.inTenant(async (db) => {
      const b = (await db.query('SELECT id, status, business_id, start_at FROM app.bookings WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!b || (ctx.businessId && b.business_id !== ctx.businessId)) throw new WhatsAppError('NOT_FOUND', 'booking not found');
      if (!allowed[status].includes(b.status)) throw new WhatsAppError('CONFLICT', `A ${b.status.toLowerCase()} booking cannot become ${status.toLowerCase()}.`);
      await db.query(`UPDATE app.bookings SET status = $2, cancelled_at = CASE WHEN $2 = 'CANCELLED' THEN now() ELSE cancelled_at END WHERE id = $1`, [id, status]);
      await db.query(`INSERT INTO app.booking_events (organization_id, booking_id, event_type, performed_by_type, performed_by_user_id, old_start_at, metadata)
                      VALUES (app.current_org_id(), $1, $2, 'USER', $3, $4, $5)`, [id, status, ctx.userId ?? null, b.start_at, JSON.stringify(reason ? { reason: reason.slice(0, 300) } : {})]);
      await this.audit(db, ctx, `BOOKING_${status}`, 'BOOKING', id);
      return { id, status };
    }, ctx);
  }
}
