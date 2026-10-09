import { Injectable } from '@nestjs/common';
import { uuidv7 } from '../common/uuid.js';
import { isPgError, PgCode } from '../database/errors.js';
import type { DbContext } from '../database/tenant-context.js';
import type { TransactionRunner } from '../database/transaction-runner.js';
import { BookingRepository, type NewBooking } from '../repositories/booking.repository.js';
import { OpsRepository } from '../repositories/ops.repository.js';

export type CreateBookingInput = Omit<NewBooking, 'id' | 'organizationId' | 'status'> & { confirm?: boolean };

export type BookingResult =
  | { ok: true; bookingId: string; replayed: boolean }
  | { ok: false; reason: 'SLOT_UNAVAILABLE' | 'OUTSIDE_AVAILABILITY' | 'RESOURCE_DOES_NOT_PROVIDE_SERVICE' | 'INVALID_REFERENCE' };

class BookingRejected extends Error {
  constructor(readonly reason: Exclude<BookingResult, { ok: true }>['reason']) { super(reason); }
}

export type CancelResult = { ok: true; bookingId: string; startAt: Date; alreadyCancelled: boolean } | { ok: false; reason: 'NOT_FOUND' | 'NOT_CANCELLABLE' | 'TOO_LATE' };
export type RescheduleResult =
  | { ok: true; bookingId: string; previousBookingId: string; startAt: Date; endAt: Date; replayed: boolean }
  | { ok: false; reason: 'NOT_FOUND' | 'NOT_RESCHEDULABLE' | 'TOO_LATE' | 'SLOT_UNAVAILABLE' | 'OUTSIDE_AVAILABILITY' };

class RescheduleRejected extends Error {
  constructor(readonly reason: Exclude<RescheduleResult, { ok: true }>['reason']) { super(reason); }
}

/**
 * BOOKING CREATION STRATEGY
 *   - one READ COMMITTED transaction;
 *   - idempotency key (AI: "<ai_run_id>:<tool_call_id>") => replays return the
 *     original booking instead of creating a second one;
 *   - a transaction-scoped advisory lock per resource serialises competing
 *     writers (no exclusion-constraint deadlocks, deterministic outcome);
 *   - availability rules are checked for a good error message, but the
 *     GiST exclusion constraint bookings_no_overlap is what guarantees that two
 *     concurrent requests can never both hold the same resource/time;
 *   - composite FKs reject contacts/services/resources of another tenant or
 *     another business (FK checks bypass RLS, composite keys do not);
 *   - the result is only { ok: true } AFTER COMMIT succeeded - the AI tool
 *     layer relays exactly this value, so the assistant can never claim a
 *     booking that does not exist.
 */
@Injectable()
export class BookingService {
  constructor(
    private readonly tx: TransactionRunner,
    private readonly bookings: BookingRepository,
    private readonly ops: OpsRepository,
  ) {}

  /** Read access for availability search (same repository, same tenant transaction rules). */
  get bookingsRepo(): BookingRepository { return this.bookings; }

  async createBooking(ctx: DbContext, input: CreateBookingInput): Promise<BookingResult> {
    const organizationId = ctx.organizationId!;
    try {
      return await this.tx.inTenant(async (db) => {
        if (input.resourceId) await this.bookings.lockResourceCalendar(db, input.resourceId);
        if (input.idempotencyKey) {
          const existing = await this.bookings.findByIdempotencyKey(db, input.idempotencyKey);
          if (existing) return { ok: true as const, bookingId: existing.id, replayed: true };
        }
        if (input.resourceId && input.serviceId && !(await this.bookings.resourceProvidesService(db, input.resourceId, input.serviceId))) {
          throw new BookingRejected('RESOURCE_DOES_NOT_PROVIDE_SERVICE');
        }
        if (!(await this.bookings.isWithinAvailability(db, { businessId: input.businessId, resourceId: input.resourceId ?? null,
                                                               startAt: input.startAt, endAt: input.endAt }))) {
          throw new BookingRejected('OUTSIDE_AVAILABILITY');
        }

        const id = await this.bookings.insert(db, { ...input, id: uuidv7(), organizationId, status: input.confirm ? 'CONFIRMED' : 'PENDING' });
        if (!id) {
          // Lost an idempotency race with an identical request: return the winner.
          const existing = await this.bookings.findByIdempotencyKey(db, input.idempotencyKey!);
          return { ok: true as const, bookingId: existing!.id, replayed: true };
        }
        await this.bookings.insertEvent(db, { organizationId, bookingId: id, eventType: 'CREATED', performedByType: input.createdByType,
          performedByUserId: input.createdByUserId, newStartAt: input.startAt });
        await this.ops.enqueueOutbox(db, { organizationId, eventType: 'BOOKING_CREATED', aggregateType: 'BOOKING', aggregateId: id,
          payload: { booking_id: id, business_id: input.businessId }, dedupeKey: `booking-created:${id}` });
        await this.ops.recordUsage(db, { organizationId, businessId: input.businessId, eventType: 'BOOKING_CREATED', quantity: 1,
          resourceType: 'BOOKING', resourceId: id, idempotencyKey: `booking:${id}` });
        return { ok: true as const, bookingId: id, replayed: false };
      }, ctx, { retries: 2 }); // deadlock backstop (e.g. resource-less bookings); the callback is idempotent
    } catch (err) {
      if (err instanceof BookingRejected) return { ok: false, reason: err.reason };
      if (isPgError(err, PgCode.EXCLUSION_VIOLATION)) return { ok: false, reason: 'SLOT_UNAVAILABLE' };
      if (isPgError(err, PgCode.FOREIGN_KEY_VIOLATION)) return { ok: false, reason: 'INVALID_REFERENCE' };
      throw err;
    }
  }

  /**
   * Cancel a booking that belongs to `contactId` (customers can only cancel their own).
   * Idempotent: cancelling an already-cancelled booking reports alreadyCancelled.
   */
  async cancelBooking(ctx: DbContext, p: { bookingId: string; businessId: string; contactId: string; reason?: string | null;
    performedByType: 'AI' | 'USER' | 'CUSTOMER' | 'API' | 'SYSTEM'; minNoticeMinutes?: number; now?: Date }): Promise<CancelResult> {
    const organizationId = ctx.organizationId!;
    return this.tx.inTenant(async (db) => {
      const b = await this.bookings.findForContact(db, p.bookingId, p.businessId, p.contactId);
      if (!b) return { ok: false, reason: 'NOT_FOUND' } as const;
      if (b.status === 'CANCELLED') return { ok: true, bookingId: b.id, startAt: b.startAt, alreadyCancelled: true } as const;
      if (!['PENDING', 'CONFIRMED'].includes(b.status)) return { ok: false, reason: 'NOT_CANCELLABLE' } as const;
      const now = p.now ?? new Date();
      if (b.startAt.getTime() - now.getTime() < (p.minNoticeMinutes ?? 0) * 60_000) return { ok: false, reason: 'TOO_LATE' } as const;
      const done = await this.bookings.cancel(db, b.id);
      if (!done) return { ok: false, reason: 'NOT_CANCELLABLE' } as const;
      await this.bookings.insertEvent(db, { organizationId, bookingId: b.id, eventType: 'CANCELLED', performedByType: p.performedByType,
        oldStartAt: b.startAt, metadata: p.reason ? { reason: p.reason.slice(0, 300) } : {} });
      await this.ops.enqueueOutbox(db, { organizationId, eventType: 'BOOKING_CANCELLED', aggregateType: 'BOOKING', aggregateId: b.id,
        payload: { booking_id: b.id, business_id: p.businessId }, dedupeKey: `booking-cancelled:${b.id}` });
      return { ok: true, bookingId: b.id, startAt: b.startAt, alreadyCancelled: false } as const;
    }, ctx, { retries: 2 });
  }

  /**
   * RESCHEDULE in ONE transaction: lock the resource calendar, verify ownership
   * and notice, mark the old booking RESCHEDULED, insert the new booking (same
   * details, rescheduled_from = old). The exclusion constraint guarantees the
   * new slot is free; any failure rolls everything back, so the customer never
   * loses the original slot. Idempotent via the new booking's idempotency key.
   */
  async rescheduleBooking(ctx: DbContext, p: { bookingId: string; businessId: string; contactId: string; newStartAt: Date;
    idempotencyKey: string; performedByType: 'AI' | 'USER' | 'CUSTOMER' | 'API' | 'SYSTEM'; aiAgentId?: string | null;
    conversationId?: string | null; minNoticeMinutes?: number; now?: Date }): Promise<RescheduleResult> {
    const organizationId = ctx.organizationId!;
    try {
      return await this.tx.inTenant(async (db) => {
        const replay = await this.bookings.findByIdempotencyKey(db, p.idempotencyKey);
        if (replay) return { ok: true as const, bookingId: replay.id, previousBookingId: p.bookingId, startAt: replay.startAt, endAt: replay.endAt, replayed: true };
        const b = await this.bookings.findForContact(db, p.bookingId, p.businessId, p.contactId);
        if (!b) throw new RescheduleRejected('NOT_FOUND');
        if (b.resourceId) await this.bookings.lockResourceCalendar(db, b.resourceId);
        if (!['PENDING', 'CONFIRMED'].includes(b.status)) throw new RescheduleRejected('NOT_RESCHEDULABLE');
        const now = p.now ?? new Date();
        const notice = (p.minNoticeMinutes ?? 0) * 60_000;
        if (b.startAt.getTime() - now.getTime() < notice || p.newStartAt.getTime() - now.getTime() < notice) throw new RescheduleRejected('TOO_LATE');
        const endAt = new Date(p.newStartAt.getTime() + (b.endAt.getTime() - b.startAt.getTime()));
        if (!(await this.bookings.isWithinAvailability(db, { businessId: p.businessId, resourceId: b.resourceId, startAt: p.newStartAt, endAt }))) {
          throw new RescheduleRejected('OUTSIDE_AVAILABILITY');
        }
        await this.bookings.markRescheduled(db, b.id);
        const id = uuidv7();
        await this.bookings.insert(db, {
          id, organizationId, businessId: p.businessId, contactId: p.contactId, serviceId: b.serviceId, resourceId: b.resourceId, locationId: b.locationId,
          conversationId: p.conversationId ?? null, aiAgentId: p.aiAgentId ?? null, bookingType: b.bookingType, status: b.status as 'PENDING' | 'CONFIRMED',
          startAt: p.newStartAt, endAt, timezone: b.timezone, customerName: b.customerName, customerPhone: b.customerPhone, customerEmail: b.customerEmail,
          partySize: b.partySize, notes: b.notes, source: p.performedByType === 'AI' ? 'AI_WHATSAPP' : 'DASHBOARD', createdByType: p.performedByType,
          idempotencyKey: p.idempotencyKey,
        });
        await db.query('UPDATE app.bookings SET rescheduled_from_booking_id = $2 WHERE id = $1', [id, b.id]);
        await this.bookings.insertEvent(db, { organizationId, bookingId: b.id, eventType: 'RESCHEDULED', performedByType: p.performedByType,
          oldStartAt: b.startAt, newStartAt: p.newStartAt, metadata: { new_booking_id: id } });
        await this.bookings.insertEvent(db, { organizationId, bookingId: id, eventType: 'CREATED', performedByType: p.performedByType,
          newStartAt: p.newStartAt, metadata: { rescheduled_from: b.id } });
        await this.ops.enqueueOutbox(db, { organizationId, eventType: 'BOOKING_RESCHEDULED', aggregateType: 'BOOKING', aggregateId: id,
          payload: { booking_id: id, previous_booking_id: b.id, business_id: p.businessId }, dedupeKey: `booking-rescheduled:${id}` });
        return { ok: true as const, bookingId: id, previousBookingId: b.id, startAt: p.newStartAt, endAt, replayed: false };
      }, ctx, { retries: 2 });
    } catch (err) {
      if (err instanceof RescheduleRejected) return { ok: false, reason: err.reason };
      if (isPgError(err, PgCode.EXCLUSION_VIOLATION)) return { ok: false, reason: 'SLOT_UNAVAILABLE' };
      throw err;
    }
  }
}
