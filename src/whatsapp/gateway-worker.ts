import type { Logger } from 'pino';
import type { Pool } from 'pg';
import type { WhatsAppConfig } from '../config/whatsapp.config.js';
import { TransactionRunner } from '../database/transaction-runner.js';
import { MessagingRepository } from '../repositories/messaging.repository.js';
import { OpsRepository } from '../repositories/ops.repository.js';
import { WebhookRepository } from '../repositories/webhook.repository.js';
import { WhatsAppRepository } from '../repositories/whatsapp.repository.js';
import type { KeyProvider } from '../security/crypto/key-provider.js';
import { MessageIngestionService } from '../services/message-ingestion.service.js';
import { OutboundMessageService } from '../services/outbound-message.service.js';
import { OutboxRelayService } from '../services/outbox-relay.service.js';
import { WebhookService, type HttpSender } from '../services/webhook.service.js';
import type { WhatsAppProvider } from './domain/whatsapp-provider.interface.js';
import type { MediaStorageService } from './media/media-storage.service.js';
import { createBaileysAuthPort } from './providers/baileys/baileys-auth-store.js';
import type { RealtimeBus } from './realtime/realtime-bus.js';
import { GatewayRepository } from './repositories/gateway.repository.js';
import { FetchWebhookSender } from './services/webhook-http-sender.js';
import { WhatsAppConnectionService } from './services/whatsapp-connection.service.js';
import { WhatsAppSessionManager, type AuthPortFactory } from './services/whatsapp-session-manager.service.js';
import { registerWebhookBridge } from './services/whatsapp-webhook-bridge.js';
import { registerAppEventBridge, registerWebhookTestHandler } from './services/app-events-bridge.js';
import { NotificationService } from '../services/notification.service.js';
import { BookingRepository } from '../repositories/booking.repository.js';
import { KnowledgeRepository } from '../repositories/knowledge.repository.js';
import { BookingService } from '../services/booking.service.js';
import { LeadService } from '../services/lead.service.js';
import { OrderingService } from '../ordering/ordering.service.js';
import type { EmbeddingProvider, ModelProviderRegistry } from '../ai/model/model-provider.js';
import { KnowledgeIngestionService } from '../ai/knowledge/ingestion.js';
import { AssistantWorker } from '../ai/runtime/assistant-worker.js';
import { LiveAssistantService } from '../ai/runtime/live-assistant.service.js';
import { ToolRegistry } from '../ai/tools/registry.js';
import { registerReminderDelivery } from '../havan/reminders.js';
import { registerCampaignDelivery } from '../marketing/campaign-delivery.js';
import { GoogleCalendarService, googleCalendarConfigFromEnv, registerCalendarSync } from '../integrations/google-calendar.js';

export interface GatewayWorkerDeps {
  pool: Pool;                      // hs_worker pool
  provider: WhatsAppProvider;
  keys: KeyProvider;
  media: MediaStorageService;
  bus: RealtimeBus;
  config: WhatsAppConfig;
  logger: Logger;
  http?: HttpSender;
  authFactory?: AuthPortFactory;
  /** Pandit Ji's Google Calendar (tests inject a fake-backed one). Default: from env. */
  calendar?: GoogleCalendarService;
  /** AI assistants (Phase 4). Omitted => this worker runs no assistant turns. */
  ai?: { models: ModelProviderRegistry; embedder?: EmbeddingProvider; registry?: ToolRegistry; concurrency?: number };
}

/**
 * The WhatsApp gateway worker process (hs_worker role):
 *   - WhatsAppSessionManager: live sockets, heartbeat, orphan takeover, restore
 *   - routed relay: INSTANCE_COMMAND / MESSAGE_SEND_REQUESTED for instances this worker owns
 *   - general relay: outbox -> normalised webhook events
 *   - webhook dispatcher: signed HTTP delivery with retries (never on the socket path)
 */
export class GatewayWorker {
  readonly tx: TransactionRunner;
  readonly manager: WhatsAppSessionManager;
  readonly relay: OutboxRelayService;
  readonly webhooks: WebhookService;
  readonly outbound: OutboundMessageService;
  readonly ingestion: MessageIngestionService;
  readonly notifications: NotificationService;
  readonly assistant: AssistantWorker | null = null;
  readonly liveAssistant: LiveAssistantService | null = null;
  private readonly ops = new OpsRepository();
  private readonly gateway = new GatewayRepository();
  private readonly http: HttpSender;
  private running = false;
  private loops: Promise<void>[] = [];
  private readonly waiters = new Set<() => void>();
  private readonly wake = () => { for (const w of [...this.waiters]) w(); };
  private unsubscribeWake: () => void = () => undefined;

  constructor(private readonly d: GatewayWorkerDeps) {
    this.tx = new TransactionRunner(d.pool);
    const whatsapp = new WhatsAppRepository();
    const messaging = new MessagingRepository();
    this.outbound = new OutboundMessageService(this.tx, messaging, this.ops);
    this.ingestion = new MessageIngestionService(this.tx, messaging, this.ops);
    this.webhooks = new WebhookService(this.tx, new WebhookRepository(), this.ops, d.keys);
    this.relay = new OutboxRelayService(this.tx, this.ops);
    registerWebhookBridge(this.relay, this.tx, this.webhooks);
    this.notifications = new NotificationService(this.tx, d.bus);
    registerAppEventBridge(this.relay, this.tx, d.bus, this.notifications);
    registerWebhookTestHandler(this.relay, this.tx);
    registerReminderDelivery(this.relay, { tx: this.tx, ops: this.ops, messaging, outbound: this.outbound, notifications: this.notifications,
      bus: d.bus, logger: d.logger });
    registerCampaignDelivery(this.relay, { tx: this.tx, ops: this.ops, messaging, outbound: this.outbound, notifications: this.notifications,
      bus: d.bus, logger: d.logger });
    const calendar = d.calendar ?? new GoogleCalendarService(googleCalendarConfigFromEnv(), d.keys);
    registerCalendarSync(this.relay, this.tx, calendar, d.logger);
    this.webhooks.onDead = (organizationId, endpointId) => this.onWebhookDead(organizationId, endpointId);
    if (d.ai) {
      const knowledge = new KnowledgeRepository();
      const registry = d.ai.registry ?? new ToolRegistry();
      this.liveAssistant = new LiveAssistantService({
        tx: this.tx, keys: d.keys, ops: this.ops, outbound: this.outbound, notifications: this.notifications, registry, models: d.ai.models,
        logger: d.logger, workerId: d.config.workerId,
        // Resolved lazily: the session manager is constructed below.
        presence: {
          markRead: (instanceId, jid, ids) => this.manager.chatSignal(instanceId, (c) => c.markRead?.(jid, ids)),
          setTyping: (instanceId, jid, on) => this.manager.chatSignal(instanceId, (c) => c.setTyping?.(jid, on)),
        },
        toolDeps: { tx: this.tx, bookings: new BookingService(this.tx, new BookingRepository(), this.ops), leads: new LeadService(this.tx, this.ops),
                    knowledge, ops: this.ops, notifications: this.notifications, embedder: d.ai.embedder, ordering: new OrderingService(), calendar },
      });
      this.assistant = new AssistantWorker({ tx: this.tx, ops: this.ops, live: this.liveAssistant, logger: d.logger, workerId: d.config.workerId,
        ingestion: new KnowledgeIngestionService(this.tx, knowledge, d.ai.embedder, d.logger), concurrency: d.ai.concurrency });
      this.assistant.register(this.relay);
    }
    this.http = d.http ?? new FetchWebhookSender(d.config.webhookTimeoutMs, d.config.webhookAllowPrivateNetworks);
    const authFactory: AuthPortFactory = d.authFactory ?? ((ref) => createBaileysAuthPort({
      tx: this.tx, repo: whatsapp, keys: d.keys, organizationId: ref.organizationId, instanceId: ref.instanceId,
      workerId: ref.workerId, leaseToken: ref.leaseToken }));
    this.manager = new WhatsAppSessionManager({
      tx: this.tx, provider: d.provider, authFactory, whatsapp, gateway: this.gateway,
      connections: new WhatsAppConnectionService(this.tx, whatsapp, this.ops), ingestion: this.ingestion,
      outbound: this.outbound, messaging, media: d.media, bus: d.bus, config: d.config, logger: d.logger,
    });
  }

  async start(opts: { loops?: boolean } = {}): Promise<void> {
    await this.manager.start({ loops: opts.loops });
    if (opts.loops === false) return;
    this.running = true;
    this.unsubscribeWake = this.d.bus.onOutboxWakeup(() => this.wake());
    this.loops = [
      this.loop('routed', this.d.config.outboxPollIntervalMs, () => this.processRoutedOnce()),
      this.loop('relay', this.d.config.outboxPollIntervalMs, () => this.relay.relayBatch(this.d.config.workerId, 100)),
      this.loop('webhooks', this.d.config.webhookPollIntervalMs, () => this.webhooks.dispatchBatch(this.d.config.workerId, this.http, 25)),
    ];
    this.assistant?.start();
  }

  private async onWebhookDead(organizationId: string, endpointId: string): Promise<void> {
    const ep = await this.tx.inTenant((db) => db.query('SELECT name FROM app.webhook_endpoints WHERE id = $1', [endpointId]), { organizationId }, { readOnly: true });
    await this.notifications.notifyAdmins(organizationId, { type: 'WEBHOOK_FAILING', dedupeKey: `webhook:${endpointId}`,
      title: `Webhook failing: ${ep.rows[0]?.name ?? 'endpoint'}`, body: 'A delivery failed after all retries. Check the delivery log.',
      data: { webhook_endpoint_id: endpointId } });
  }

  /** One pass over routed work for this worker. Returns number of events handled. */
  async processRoutedOnce(limit = 25): Promise<number> {
    const events = await this.tx.run({}, (db) => this.gateway.claimRouted(db, this.d.config.workerId, limit,
      this.manager.hasCapacity(), this.d.config.sendQueueTtlSeconds));
    for (const e of events) {
      try {
        if (e.eventType === 'INSTANCE_COMMAND') await this.manager.handleCommand(e);
        else if (e.eventType === 'MESSAGE_SEND_REQUESTED') await this.manager.handleSend(e, (key) => this.d.media.get(key));
        await this.tx.run({}, (db) => this.ops.completeOutbox(db, e.id, this.d.config.workerId));
      } catch (err) {
        await this.tx.run({}, (db) => this.ops.failOutbox(db, e.id, this.d.config.workerId, (err as Error).message ?? 'error', 1_000));
      }
    }
    return events.length;
  }

  private async loop(name: string, intervalMs: number, fn: () => Promise<number>): Promise<void> {
    while (this.running) {
      let n = 0;
      try { n = await fn(); } catch (err) {
        this.d.logger.error({ event_name: 'whatsapp.worker_loop_failed', loop: name, err: { message: String((err as Error).message).slice(0, 300) } });
      }
      if (n === 0 && this.running) {
        await new Promise<void>((resolve) => {
          const done = () => { clearTimeout(t); this.waiters.delete(done); resolve(); };
          const t = setTimeout(done, intervalMs);
          this.waiters.add(done);
        });
      }
    }
  }

  /** SIGTERM/SIGINT: stop pulling work, finish in-flight loops, close sockets without logout, release leases. */
  async stop(): Promise<void> {
    this.running = false;
    this.wake();
    this.unsubscribeWake();
    await this.assistant?.stop();
    await Promise.allSettled(this.loops);
    await this.manager.shutdown();
  }
}
