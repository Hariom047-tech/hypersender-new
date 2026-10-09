import { randomUUID } from 'node:crypto';

function int(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer >= ${min}`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes'].includes(raw.toLowerCase());
}

/** Typed, validated WhatsApp gateway configuration. No production values are hard-coded. */
export interface WhatsAppConfig {
  provider: 'baileys';
  workerId: string;
  workerHostname: string;
  workerCapacity: number;
  restoreConcurrency: number;
  reconnectMinDelayMs: number;
  reconnectMaxDelayMs: number;
  maxReconnectAttempts: number;
  heartbeatIntervalMs: number;
  staleAfterMs: number;
  orphanScanIntervalMs: number;
  qrTimeoutMs: number;
  connectTimeoutMs: number;
  mediaMaxBytes: number;
  sendMinIntervalMs: number;
  sendQueueTtlSeconds: number;
  sendMaxAttempts: number;
  apiSendRatePerMinute: number;
  outboxPollIntervalMs: number;
  webhookPollIntervalMs: number;
  webhookTimeoutMs: number;
  webhookAllowPrivateNetworks: boolean;
  logMessageContent: boolean;
  baileysLogLevel: 'silent' | 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  /** Honour whatsapp_instances.appear_online (markOnlineOnConnect). Off by default. */
  honourAppearOnline: boolean;
}

export function loadWhatsAppConfig(overrides: Partial<WhatsAppConfig> = {}): WhatsAppConfig {
  const provider = (process.env.WHATSAPP_PROVIDER ?? 'baileys').toLowerCase();
  if (provider !== 'baileys') throw new Error(`Unsupported WHATSAPP_PROVIDER "${provider}"`);
  const level = (process.env.BAILEYS_LOG_LEVEL ?? 'warn') as WhatsAppConfig['baileysLogLevel'];
  const cfg: WhatsAppConfig = {
    provider: 'baileys',
    workerId: process.env.WHATSAPP_WORKER_ID || randomUUID(),
    workerHostname: process.env.WHATSAPP_WORKER_HOSTNAME || process.env.HOSTNAME || process.env.COMPUTERNAME || 'unknown',
    workerCapacity: int('WHATSAPP_WORKER_CAPACITY', 200, 1),
    restoreConcurrency: int('WHATSAPP_RESTORE_CONCURRENCY', 5, 1),
    reconnectMinDelayMs: int('WHATSAPP_RECONNECT_MIN_DELAY_MS', 2_000, 0),
    reconnectMaxDelayMs: int('WHATSAPP_RECONNECT_MAX_DELAY_MS', 120_000, 1),
    maxReconnectAttempts: int('WHATSAPP_MAX_RECONNECT_ATTEMPTS', 50, 1),
    heartbeatIntervalMs: int('WHATSAPP_WORKER_HEARTBEAT_INTERVAL_MS', 10_000, 100),
    staleAfterMs: int('WHATSAPP_WORKER_STALE_AFTER_MS', 45_000, 1_000),
    orphanScanIntervalMs: int('WHATSAPP_ORPHAN_SCAN_INTERVAL_MS', 30_000, 100),
    qrTimeoutMs: int('WHATSAPP_QR_TIMEOUT_MS', 30_000, 5_000),
    connectTimeoutMs: int('WHATSAPP_CONNECT_TIMEOUT_MS', 30_000, 1_000),
    mediaMaxBytes: int('WHATSAPP_MEDIA_MAX_BYTES', 16 * 1024 * 1024, 1),
    sendMinIntervalMs: int('WHATSAPP_SEND_MIN_INTERVAL_MS', 1_000, 0),
    sendQueueTtlSeconds: int('WHATSAPP_SEND_QUEUE_TTL_SECONDS', 3_600, 1),
    sendMaxAttempts: int('WHATSAPP_SEND_MAX_ATTEMPTS', 8, 1),
    apiSendRatePerMinute: int('WHATSAPP_API_SEND_RATE_PER_MINUTE', 60, 1),
    outboxPollIntervalMs: int('WHATSAPP_OUTBOX_POLL_INTERVAL_MS', 500, 10),
    webhookPollIntervalMs: int('WEBHOOK_POLL_INTERVAL_MS', 1_000, 10),
    webhookTimeoutMs: int('WEBHOOK_TIMEOUT_MS', 10_000, 100),
    webhookAllowPrivateNetworks: bool('WEBHOOK_ALLOW_PRIVATE_NETWORKS', false),
    logMessageContent: bool('LOG_MESSAGE_CONTENT', false),
    baileysLogLevel: level,
    honourAppearOnline: bool('WHATSAPP_HONOUR_APPEAR_ONLINE', false),
    ...overrides,
  };
  if (cfg.reconnectMaxDelayMs < cfg.reconnectMinDelayMs) throw new Error('WHATSAPP_RECONNECT_MAX_DELAY_MS < MIN');
  if (cfg.staleAfterMs <= cfg.heartbeatIntervalMs * 2) throw new Error('WHATSAPP_WORKER_STALE_AFTER_MS must exceed 2x heartbeat interval');
  return cfg;
}

export const WHATSAPP_CONFIG = Symbol('WHATSAPP_CONFIG');
