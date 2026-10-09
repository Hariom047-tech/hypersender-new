/**
 * WhatsApp gateway worker entry point (hs_worker credentials only).
 *   npm run start:worker
 */
import 'dotenv/config';
import 'reflect-metadata';
import { createLogger } from './common/logger.js';
import { loadWhatsAppConfig } from './config/whatsapp.config.js';
import { createPool } from './database/pools.js';
import { keyProviderFromEnv } from './security/crypto/key-provider.js';
import { GatewayWorker } from './whatsapp/gateway-worker.js';
import { mediaStorageFromEnv } from './whatsapp/media/media-storage.service.js';
import { BaileysWhatsAppProvider } from './whatsapp/providers/baileys/baileys.provider.js';
import { PgNotifyRealtimeBus } from './whatsapp/realtime/realtime-bus.js';
import { aiProvidersFromEnv } from './ai/model/providers-from-env.js';

async function main(): Promise<void> {
  const config = loadWhatsAppConfig();
  const logger = createLogger({ bindings: { process: 'whatsapp-worker' }, logMessageContent: config.logMessageContent });
  const pool = createPool('worker');
  const busKey = process.env.REALTIME_BUS_KEY;
  if (!busKey) throw new Error('REALTIME_BUS_KEY is required');
  const bus = new PgNotifyRealtimeBus(pool, busKey);
  await bus.start();

  const provider = new BaileysWhatsAppProvider({
    logger, baileysLogLevel: config.baileysLogLevel, qrTimeoutMs: config.qrTimeoutMs, connectTimeoutMs: config.connectTimeoutMs,
    mediaMaxBytes: config.mediaMaxBytes,
  });
  const ai = process.env.AI_ASSISTANTS_ENABLED === 'false' ? undefined : aiProvidersFromEnv();
  const worker = new GatewayWorker({ pool, provider, keys: keyProviderFromEnv(), media: mediaStorageFromEnv(), bus, config, logger, ai });
  await worker.start();

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ event_name: 'whatsapp.worker_shutdown', signal });
    const force = setTimeout(() => process.exit(1), 30_000);
    try {
      await worker.stop();
      await bus.close();
      await pool.end();
    } finally {
      clearTimeout(force);
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('worker failed to start:', (err as Error).message);
  process.exit(1);
});
