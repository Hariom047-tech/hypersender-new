import { Injectable } from '@nestjs/common';
import type { Db } from '../database/transaction-runner.js';

export interface NewBooking {
  id: string;
  organizationId: string;
  businessId: string;
  contactId: string;
  serviceId?: string | null;
  resourceId?: string | null;
  locationId?: string | null;
  conversationId?: string | null;
  aiAgentId?: string | null;
  bookingType: string;
  status: 'PENDING' | 'CONFIRMED';
  startAt: Date;
  endAt: Date;
  timezone: string;
  customerName: string;
  customerPhone: string;
  customerEmail?: string | null;
  partySize?: number | null;
  notes?: string | null;
  source: 'AI_WHATSAPP' | 'HUMAN' | 'DASHBOARD' | 'API';
  createdByType: 'AI' | 'USER' | 'CUSTOMER' | 'API' | 'SYSTEM';
  createdByUserId?: string | null;
  idempotencyKey?: string | null;
}

@Injectable()
export class BookingRepository {
  /**
   * Serialises booking writes per resource for the rest of the transaction.
   * Concurrent inserts checked by a GiST exclusion constraint can otherwise
   * deadlock (each waits on the other's speculative tuple); with the lock the
   * second writer simply sees the first booking and gets a clean conflict.
   * The exclusion constraint remains the correctness guarantee.
   */
  async lockResourceCalendar(db: Db, resourceId: string): Promise<void> {
    await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('booking-resource:' || $1::text, 0))`, [resourceId]);
  }

  async findByIdempotencyKey(db: Db, key: string): Promise<{ id: string; status: string; startAt: Date; endAt: Date } | null> {
    const r = await db.query(
      `SELECT id, status, start_at, end_at FROM app.bookings
        WHERE organization_id = app.current_org_id() AND idempotency_key = $1`, [key]);
    const row = r.rows[0];
    return row ? { id: row.id, status: row.status, startAt: row.start_at, endAt: row.end_at } : null;
  }

  /**
   * Is [start, end) inside the working hours of the resource (resource-specific
   * rules win over business-wide rules) and not blocked by an exception?
   * Advisory only - the exclusion constraint is the real double-booking guard.
   */
  async isWithinAvailability(db: Db, a: { businessId: string; resourceId: string | null; startAt: Date; endAt: Date }): Promise<boolean> {
    const r = await db.query(
      `WITH scope AS (
         SELECT CASE WHEN $2::uuid IS NOT NULL AND EXISTS (
                  SELECT 1 FROM app.availability_rules WHERE business_id = $1 AND resource_id = $2)
                THEN $2::uuid END AS resource_id)
       SELECT EXISTS (
                SELECT 1 FROM app.availability_rules r, scope s
                 WHERE r.business_id = $1
                   AND r.resource_id IS NOT DISTINCT FROM s.resource_id
                   AND r.day_of_week = extract(isodow FROM ($3::timestamptz AT TIME ZONE r.timezone))
                   -- whole booking on one local day, inside [start_time, end_time)
                   AND (($4::timestamptz - interval '1 microsecond') AT TIME ZONE r.timezone)::date
                       = ($3::timestamptz AT TIME ZONE r.timezone)::date
                   AND ($3::timestamptz AT TIME ZONE r.timezone)::time >= r.start_time
                   AND (($4::timestamptz - interval '1 microsecond') AT TIME ZONE r.timezone)::time < r.end_time
                   AND (r.effective_from IS NULL OR ($3::timestamptz AT TIME ZONE r.timezone)::date >= r.effective_from)
                   AND (r.effective_until IS NULL OR ($3::timestamptz AT TIME ZONE r.timezone)::date <= r.effective_until))
          AND NOT EXISTS (
                SELECT 1 FROM app.availability_exceptions e
                 WHERE e.business_id = $1
                   AND (e.resource_id IS NULL OR e.resource_id = $2)
                   AND e.type IN ('HOLIDAY','LEAVE','BLOCKED')
                   AND tstzrange(e.start_at, e.end_at, '[)') && tstzrange($3, $4, '[)')) AS ok`,
      [a.businessId, a.resourceId, a.startAt, a.endAt]);
    return r.rows[0].ok;
  }

  async resourceProvidesService(db: Db, resourceId: string, serviceId: string): Promise<boolean> {
    const r = await db.query('SELECT EXISTS (SELECT 1 FROM app.resource_services WHERE resource_id = $1 AND service_id = $2) AS ok',
      [resourceId, serviceId]);
    return r.rows[0].ok;
  }

  /**
   * INSERT; the idempotency conflict target is explicit so that an exclusion
   * violation (slot taken, SQLSTATE 23P01) still raises instead of being
   * swallowed. Returns null on idempotent replay.
   */
  async insert(db: Db, b: NewBooking): Promise<string | null> {
    const r = await db.query(
      `INSERT INTO app.bookings (id, organization_id, business_id, contact_id, service_id, resource_id, location_id, conversation_id,
                                 ai_agent_id, booking_type, status, start_at, end_at, timezone, customer_name, customer_phone,
                                 customer_email, party_size, notes, source, created_by_type, created_by_user_id, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
       ON CONFLICT (organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [b.id, b.organizationId, b.businessId, b.contactId, b.serviceId ?? null, b.resourceId ?? null, b.locationId ?? null,
       b.conversationId ?? null, b.aiAgentId ?? null, b.bookingType, b.status, b.startAt, b.endAt, b.timezone, b.customerName,
       b.customerPhone, b.customerEmail ?? null, b.partySize ?? null, b.notes ?? null, b.source, b.createdByType,
       b.createdByUserId ?? null, b.idempotencyKey ?? null]);
    return r.rows[0]?.id ?? null;
  }

  async insertEvent(db: Db, e: { organizationId: string; bookingId: string; eventType: string; performedByType: string; performedByUserId?: string | null; oldStartAt?: Date | null; newStartAt?: Date | null; metadata?: object }): Promise<void> {
    await db.query(
      `INSERT INTO app.booking_events (organization_id, booking_id, event_type, performed_by_type, performed_by_user_id, old_start_at, new_start_at, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [e.organizationId, e.bookingId, e.eventType, e.performedByType, e.performedByUserId ?? null, e.oldStartAt ?? null,
       e.newStartAt ?? null, JSON.stringify(e.metadata ?? {})]);
  }

  /**
   * Free slots (read-only). Candidate starts are generated in SQL from the
   * weekly availability rules in each rule's own timezone (resource-specific
   * rules win over business-wide ones - same semantics as isWithinAvailability),
   * then exceptions and overlapping PENDING/CONFIRMED bookings are removed.
   * `resourceIds = [null]` means business-level slots (no bookable resource).
   */
  async findFreeSlots(db: Db, q: { businessId: string; resourceIds: Array<string | null>; fromDate: string; toDate: string; durationMinutes: number;
    stepMinutes: number; earliest: Date; latest: Date; limit: number; excludeBookingId?: string | null }):
    Promise<Array<{ resourceId: string | null; startAt: Date; endAt: Date; timezone: string; localDate: string; localTime: string; isoDow: number }>> {
    const r = await db.query(
      `WITH res AS (SELECT unnest($2::uuid[]) AS rid),
       eff AS (
         SELECT res.rid, r.day_of_week, r.start_time, r.end_time, r.timezone, r.effective_from, r.effective_until
           FROM res JOIN app.availability_rules r ON r.business_id = $1
            AND (   (res.rid IS NOT NULL AND r.resource_id = res.rid)
                 OR (r.resource_id IS NULL AND (res.rid IS NULL OR NOT EXISTS (
                       SELECT 1 FROM app.availability_rules r2 WHERE r2.business_id = $1 AND r2.resource_id = res.rid))))),
       cand AS (
         SELECT e.rid, e.timezone, (g.ts AT TIME ZONE e.timezone) AS start_at
           FROM eff e
           JOIN (SELECT gs::date AS day FROM generate_series($3::date, $4::date, interval '1 day') gs) d
             ON e.day_of_week = extract(isodow FROM d.day)
            AND (e.effective_from IS NULL OR d.day >= e.effective_from) AND (e.effective_until IS NULL OR d.day <= e.effective_until)
          CROSS JOIN LATERAL generate_series(d.day + e.start_time, d.day + e.end_time - make_interval(mins => $5), make_interval(mins => $6)) AS g(ts))
       SELECT c.rid, c.start_at, c.start_at + make_interval(mins => $5) AS end_at, c.timezone,
              to_char(c.start_at AT TIME ZONE c.timezone, 'YYYY-MM-DD') AS local_date,
              to_char(c.start_at AT TIME ZONE c.timezone, 'HH24:MI') AS local_time,
              extract(isodow FROM c.start_at AT TIME ZONE c.timezone)::int AS iso_dow
         FROM cand c
        WHERE c.start_at >= $7 AND c.start_at < $8
          AND NOT EXISTS (
                SELECT 1 FROM app.availability_exceptions x
                 WHERE x.business_id = $1 AND (x.resource_id IS NULL OR x.resource_id = c.rid)
                   AND x.type IN ('HOLIDAY','LEAVE','BLOCKED')
                   AND tstzrange(x.start_at, x.end_at, '[)') && tstzrange(c.start_at, c.start_at + make_interval(mins => $5), '[)'))
          AND (c.rid IS NULL OR NOT EXISTS (
                SELECT 1 FROM app.bookings b
                 WHERE b.resource_id = c.rid AND b.status IN ('PENDING','CONFIRMED') AND b.id IS DISTINCT FROM $10::uuid
                   AND tstzrange(b.start_at, b.end_at, '[)') && tstzrange(c.start_at, c.start_at + make_interval(mins => $5), '[)')))
        ORDER BY c.start_at, c.rid
        LIMIT $9`,
      [q.businessId, q.resourceIds, q.fromDate, q.toDate, q.durationMinutes, q.stepMinutes, q.earliest, q.latest, q.limit, q.excludeBookingId ?? null]);
    return r.rows.map((x) => ({ resourceId: x.rid, startAt: x.start_at, endAt: x.end_at, timezone: x.timezone, localDate: x.local_date,
                                localTime: x.local_time, isoDow: x.iso_dow }));
  }

  /** Booking of one contact (null when it belongs to someone else: customers only ever touch their own bookings). */
  async findForContact(db: Db, bookingId: string, businessId: string, contactId: string): Promise<{
    id: string; status: string; startAt: Date; endAt: Date; timezone: string; serviceId: string | null; resourceId: string | null;
    locationId: string | null; bookingType: string; customerName: string; customerPhone: string; customerEmail: string | null; partySize: number | null;
    notes: string | null } | null> {
    const r = await db.query(
      `SELECT id, status, start_at, end_at, timezone, service_id, resource_id, location_id, booking_type, customer_name, customer_phone,
              customer_email, party_size, notes
         FROM app.bookings WHERE id = $1 AND business_id = $2 AND contact_id = $3`, [bookingId, businessId, contactId]);
    const x = r.rows[0];
    return x ? { id: x.id, status: x.status, startAt: x.start_at, endAt: x.end_at, timezone: x.timezone, serviceId: x.service_id,
      resourceId: x.resource_id, locationId: x.location_id, bookingType: x.booking_type, customerName: x.customer_name,
      customerPhone: x.customer_phone, customerEmail: x.customer_email, partySize: x.party_size, notes: x.notes } : null;
  }

  async markRescheduled(db: Db, bookingId: string): Promise<boolean> {
    const r = await db.query(`UPDATE app.bookings SET status = 'RESCHEDULED' WHERE id = $1 AND status IN ('PENDING','CONFIRMED')`, [bookingId]);
    return (r.rowCount ?? 0) > 0;
  }

  async cancel(db: Db, bookingId: string): Promise<{ startAt: Date } | null> {
    const r = await db.query(
      `UPDATE app.bookings SET status = 'CANCELLED', cancelled_at = now()
        WHERE id = $1 AND status IN ('PENDING','CONFIRMED') RETURNING start_at`, [bookingId]);
    return r.rows[0] ? { startAt: r.rows[0].start_at } : null;
  }
}
