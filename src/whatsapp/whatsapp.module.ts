import { type DynamicModule, Module } from '@nestjs/common';
import type { Pool } from 'pg';
import { loadWhatsAppConfig, WHATSAPP_CONFIG, type WhatsAppConfig } from '../config/whatsapp.config.js';
import { APP_POOL } from '../database/pools.js';
import { APP_TX, TransactionRunner } from '../database/transaction-runner.js';
import { MessagingRepository } from '../repositories/messaging.repository.js';
import { OpsRepository } from '../repositories/ops.repository.js';
import { OutboundMessageService } from '../services/outbound-message.service.js';
import { WhatsAppInstancesController } from './controllers/whatsapp-instances.controller.js';
import { WhatsAppMessagesController } from './controllers/whatsapp-messages.controller.js';
import { MEDIA_STORAGE, mediaStorageFromEnv, type MediaStorageService } from './media/media-storage.service.js';
import { QrCache } from './realtime/qr-cache.js';
import { InMemoryRealtimeBus, PgNotifyRealtimeBus, REALTIME_BUS, type RealtimeBus } from './realtime/realtime-bus.js';
import { WhatsAppInstanceService } from './services/whatsapp-instance.service.js';
import { WhatsAppMessageService } from './services/whatsapp-message.service.js';
import { WorkspaceService } from '../api/workspace.service.js';
import { ApiKeyService } from '../services/api-key.service.js';
import { DeveloperService } from '../api/developer.service.js';

/**
 * API-side WhatsApp module (hs_app). Talks to gateway workers only through
 * the transactional outbox (commands/sends) and the realtime bus (QR/status).
 * The worker side is composed in src/whatsapp/gateway-worker.ts.
 */
@Module({})
export class WhatsAppApiModule {
  static register(): DynamicModule {
    return {
      module: WhatsAppApiModule,
      controllers: [WhatsAppInstancesController, WhatsAppMessagesController],
      providers: [
        { provide: WHATSAPP_CONFIG, useFactory: () => loadWhatsAppConfig() },
        {
          provide: REALTIME_BUS,
          inject: [APP_POOL],
          useFactory: async (pool: Pool): Promise<RealtimeBus> => {
            if ((process.env.REALTIME_BUS ?? 'pg') === 'memory') return new InMemoryRealtimeBus();
            const key = process.env.REALTIME_BUS_KEY;
            if (!key) throw new Error('REALTIME_BUS_KEY is required (or REALTIME_BUS=memory for single-process dev/tests)');
            const bus = new PgNotifyRealtimeBus(pool, key);
            await bus.start();
            return bus;
          },
        },
        { provide: QrCache, inject: [REALTIME_BUS], useFactory: (bus: RealtimeBus) => new QrCache(bus) },
        { provide: MEDIA_STORAGE, useFactory: mediaStorageFromEnv },
        { provide: MessagingRepository, useClass: MessagingRepository },
        { provide: WorkspaceService, inject: [APP_TX, REALTIME_BUS], useFactory: (tx: TransactionRunner, bus: RealtimeBus) => new WorkspaceService(tx, bus) },
        { provide: DeveloperService, inject: [APP_TX, REALTIME_BUS], useFactory: (tx: TransactionRunner, bus: RealtimeBus) => new DeveloperService(tx, bus) },
        { provide: OpsRepository, useClass: OpsRepository },
        ApiKeyService,
        {
          provide: WhatsAppInstanceService,
          inject: [APP_TX, OpsRepository, REALTIME_BUS, QrCache, WHATSAPP_CONFIG],
          useFactory: (tx: TransactionRunner, ops: OpsRepository, bus: RealtimeBus, qr: QrCache, cfg: WhatsAppConfig) =>
            new WhatsAppInstanceService(tx, ops, bus, qr, { staleAfterMs: cfg.staleAfterMs,
              pairingCodeWaitMs: Number(process.env.WHATSAPP_PAIRING_CODE_WAIT_MS ?? 25_000) }),
        },
        {
          provide: WhatsAppMessageService,
          inject: [APP_TX, MessagingRepository, OpsRepository, MEDIA_STORAGE, REALTIME_BUS, WHATSAPP_CONFIG],
          useFactory: (tx: TransactionRunner, m: MessagingRepository, ops: OpsRepository, media: MediaStorageService, bus: RealtimeBus, cfg: WhatsAppConfig) =>
            new WhatsAppMessageService(tx, m, new OutboundMessageService(tx, m, ops), media, bus,
              { ratePerMinute: cfg.apiSendRatePerMinute, mediaMaxBytes: cfg.mediaMaxBytes }),
        },
      ],
      exports: [REALTIME_BUS, QrCache, MEDIA_STORAGE, WhatsAppMessageService, WhatsAppInstanceService, WorkspaceService, DeveloperService, ApiKeyService],
    };
  }
}
