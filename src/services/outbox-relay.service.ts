import { Injectable } from '@nestjs/common';
import type { TransactionRunner } from '../database/transaction-runner.js';
import { OpsRepository, type ClaimedOutboxEvent } from '../repositories/ops.repository.js';

export type OutboxHandler = (event: ClaimedOutboxEvent) => Promise<void>;

/**
 * Transactional-outbox relay (worker process).
 *
 * Cross-tenant operation is split in two phases:
 *   1. CLAIM (no tenant context): SKIP LOCKED batch claim, allowed only by the
 *      outbox_events_relay_* policies granted to hs_worker.
 *   2. HANDLE (tenant context = event.organization_id): handlers use
 *      TransactionRunner.inTenant, so every read/write they do is RLS-scoped to
 *      the event's own organization.
 * Handlers must be idempotent (at-least-once delivery): they use idempotency
 * keys / ON CONFLICT so a redelivered event has no additional effect.
 */
@Injectable()
export class OutboxRelayService {
  private readonly handlers = new Map<string, OutboxHandler[]>();

  constructor(
    private readonly tx: TransactionRunner,
    private readonly ops: OpsRepository,
  ) {}

  on(eventType: string, handler: OutboxHandler): void {
    this.handlers.set(eventType, [...(this.handlers.get(eventType) ?? []), handler]);
  }

  async relayBatch(workerId: string, limit = 100): Promise<number> {
    const events = await this.tx.run({}, (db) => this.ops.claimOutbox(db, workerId, limit));
    for (const event of events) {
      try {
        for (const handler of this.handlers.get(event.eventType) ?? []) await handler(event);
        await this.tx.run({}, (db) => this.ops.completeOutbox(db, event.id, workerId));
      } catch (err) {
        await this.tx.run({}, (db) => this.ops.failOutbox(db, event.id, workerId, (err as Error).message));
      }
    }
    return events.length;
  }
}
