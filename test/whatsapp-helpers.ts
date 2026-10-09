import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { createLogger } from '../src/common/logger.js';
import { uuidv7 } from '../src/common/uuid.js';
import { loadWhatsAppConfig, type WhatsAppConfig } from '../src/config/whatsapp.config.js';
import { MessagingRepository } from '../src/repositories/messaging.repository.js';
import { OpsRepository } from '../src/repositories/ops.repository.js';
import { OutboundMessageService } from '../src/services/outbound-message.service.js';
import type { HttpSender } from '../src/services/webhook.service.js';
import { GatewayWorker, type GatewayWorkerDeps } from '../src/whatsapp/gateway-worker.js';
import { LocalMediaStorage } from '../src/whatsapp/media/media-storage.service.js';
import { BaileysWhatsAppProvider } from '../src/whatsapp/providers/baileys/baileys.provider.js';
import { QrCache } from '../src/whatsapp/realtime/qr-cache.js';
import { InMemoryRealtimeBus, type RealtimeBus, type RealtimeEvent } from '../src/whatsapp/realtime/realtime-bus.js';
import { WhatsAppInstanceService } from '../src/whatsapp/services/whatsapp-instance.service.js';
import { WhatsAppMessageService } from '../src/whatsapp/services/whatsapp-message.service.js';
import { FakeSocketFactory } from './fakes/fake-baileys-socket.js';
import type { Harness } from './helpers.js';

export interface GatewayRig {
  worker: GatewayWorker;
  fake: FakeSocketFactory;
  bus: RealtimeBus;
  events: RealtimeEvent[];
  logs: string[];
  config: WhatsAppConfig;
  media: LocalMediaStorage;
  http: HttpSender & { calls: Array<{ url: string; body: string; headers: Record<string, string> }> };
  downloads: { fail: boolean; bytes: Buffer };
}

/** Real session manager + real Baileys adapter + real DB; only the socket is fake. */
export function makeGateway(h: Harness, o: { bus?: RealtimeBus; fake?: FakeSocketFactory; media?: LocalMediaStorage; workerId?: string; config?: Partial<WhatsAppConfig>;
  ai?: GatewayWorkerDeps['ai'] } = {}): GatewayRig {
  const logs: string[] = [];
  const logger = createLogger({ level: 'trace', destination: new Writable({ write(chunk, _e, cb) { logs.push(chunk.toString()); cb(); } }) });
  const bus = o.bus ?? new InMemoryRealtimeBus();
  const events: RealtimeEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const fake = o.fake ?? new FakeSocketFactory();
  const media = o.media ?? new LocalMediaStorage(mkdtempSync(join(tmpdir(), 'hs-media-')));
  const config = loadWhatsAppConfig({
    workerId: o.workerId ?? uuidv7(), workerHostname: 'test-worker', heartbeatIntervalMs: 1_000, staleAfterMs: 5_000,
    orphanScanIntervalMs: 60_000, reconnectMinDelayMs: 5, reconnectMaxDelayMs: 20, sendMinIntervalMs: 0, restoreConcurrency: 3,
    sendQueueTtlSeconds: 3_600, connectTimeoutMs: 300, ...o.config,
  });
  const downloads = { fail: false, bytes: Buffer.from('fake-jpeg-bytes') };
  const provider = new BaileysWhatsAppProvider({
    logger, baileysLogLevel: 'silent', qrTimeoutMs: 30_000, connectTimeoutMs: 5_000, mediaMaxBytes: 1_000_000, socketFactory: fake.factory,
    mediaDownloader: async () => { if (downloads.fail) throw new Error('cdn unavailable'); return downloads.bytes; },
  });
  const calls: GatewayRig['http']['calls'] = [];
  const http = { calls, post: async (url: string, body: string, headers: Record<string, string>) => { calls.push({ url, body, headers }); return { status: 200, body: 'ok' }; } };
  const worker = new GatewayWorker({ pool: h.workerPool, provider, keys: h.keys, media, bus, config, logger, http, ai: o.ai });
  return { worker, fake, bus, events, logs, config, media, http, downloads };
}

export function makeApiServices(h: Harness, bus: RealtimeBus, media: LocalMediaStorage) {
  const ops = new OpsRepository();
  const messaging = new MessagingRepository();
  const qr = new QrCache(bus);
  const instances = new WhatsAppInstanceService(h.appTx, ops, bus, qr, { staleAfterMs: 5_000, pairingCodeWaitMs: 2_000 });
  const messages = new WhatsAppMessageService(h.appTx, messaging, new OutboundMessageService(h.appTx, messaging, ops), media, bus,
    { ratePerMinute: 1_000, mediaMaxBytes: 1_000_000 });
  return { instances, messages, qr };
}

export async function waitFor<T>(fn: () => Promise<T | undefined | null | false> | T | undefined | null | false, timeoutMs = 5_000, label = 'condition'): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Waits until the session's event chain is drained (all provider events processed). */
export async function settle(rig: GatewayRig, instanceId: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const s = rig.worker.manager.getSession(instanceId);
    if (!s) { await new Promise((r) => setTimeout(r, 10)); return; }
    const before = s.events;
    await before;
    await new Promise((r) => setTimeout(r, 5));
    if (s.events === before) return;
  }
}

/** Runs routed work (commands/sends) until the queue for this worker is empty. */
export async function drainRouted(rig: GatewayRig): Promise<void> {
  for (let i = 0; i < 20; i++) if ((await rig.worker.processRoutedOnce()) === 0) return;
}
