import type { Logger } from '../../common/logger.js';
import type { TransactionRunner } from '../../database/transaction-runner.js';
import type { OpsRepository } from '../../repositories/ops.repository.js';
import type { OutboxRelayService } from '../../services/outbox-relay.service.js';
import { KNOWLEDGE_INGEST_REQUESTED, type KnowledgeIngestionService } from '../knowledge/ingestion.js';
import { AI_TURN_DUE, type LiveAssistantService } from './live-assistant.service.js';

/**
 * Wires the assistant into the worker:
 *  - general outbox relay: MESSAGE_RECEIVED (schedule), MESSAGE_SENT (human takeover), knowledge ingestion;
 *  - a dedicated AI_TURN_DUE queue with bounded concurrency (model calls take seconds; they must not
 *    block the general relay or webhooks).
 */
export class AssistantWorker {
  private running = false;
  private loop: Promise<void> | null = null;
  private wakeTimer: NodeJS.Timeout | null = null;
  private wake: (() => void) | null = null;

  constructor(private readonly d: { tx: TransactionRunner; ops: OpsRepository; live: LiveAssistantService; ingestion: KnowledgeIngestionService;
    logger: Logger; workerId: string; concurrency?: number; pollMs?: number }) {}

  register(relay: OutboxRelayService): void {
    relay.on('MESSAGE_RECEIVED', (e) => this.d.live.onMessageReceived(e));
    relay.on('MESSAGE_SENT', (e) => this.d.live.onMessageSent(e));
    relay.on(KNOWLEDGE_INGEST_REQUESTED, async (e) => { await this.d.ingestion.ingest(e.organizationId!, (e.payload as { source_id: string }).source_id); });
  }

  /** One pass: claim due turns and process them concurrently. Returns number handled. */
  async processOnce(limit = this.d.concurrency ?? 4): Promise<number> {
    const events = await this.d.tx.run({}, (db) => this.d.ops.claimOutbox(db, this.d.workerId, limit, 180, { onlyTypes: [AI_TURN_DUE] }));
    await Promise.all(events.map(async (e) => {
      try {
        const r = await this.d.live.processTurn(e);
        if (r === 'BUSY') await this.d.tx.run({}, (db) => this.d.ops.deferOutbox(db, e.id, this.d.workerId, 2));
        else await this.d.tx.run({}, (db) => this.d.ops.completeOutbox(db, e.id, this.d.workerId));
      } catch (err) {
        this.d.logger.error({ event_name: 'ai.turn_failed', outbox_event_id: e.id, err: { message: String((err as Error).message).slice(0, 300) } });
        await this.d.tx.run({}, (db) => this.d.ops.failOutbox(db, e.id, this.d.workerId, (err as Error).message ?? 'error', 5));
      }
    }));
    return events.length;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        let n = 0;
        try { n = await this.processOnce(); } catch (err) {
          this.d.logger.error({ event_name: 'ai.worker_loop_failed', err: { message: String((err as Error).message).slice(0, 300) } });
        }
        if (n === 0 && this.running) await new Promise<void>((r) => { this.wake = r; this.wakeTimer = setTimeout(r, this.d.pollMs ?? 250); });
      }
    })();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wake?.();
    await this.loop;
  }
}
