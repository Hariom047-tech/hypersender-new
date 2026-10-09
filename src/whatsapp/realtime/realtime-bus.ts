import { EventEmitter } from 'node:events';
import type { Pool, PoolClient } from 'pg';
import { aad, aesGcmDecrypt, aesGcmEncrypt } from '../../security/crypto/aes-gcm.js';

/**
 * Ephemeral, tenant-tagged events from gateway workers to API processes
 * (QR codes, pairing codes, live status). NEVER persisted.
 *
 * `organizationId` + `instanceId` are mandatory on every event; subscribers
 * (the SSE endpoint) only forward events whose organizationId equals the
 * caller's tenant AND whose instance the caller was just verified (via RLS)
 * to own.
 */
export type RealtimeEventType =
  // connection-level (per-instance stream only; QR/pairing code are credentials)
  | 'whatsapp.instance.qr'
  | 'whatsapp.instance.pairing_code'
  | 'whatsapp.instance.status'
  // normalised APPLICATION events (org-wide stream: GET /v1/realtime/stream)
  | 'conversation.created'
  | 'conversation.updated'
  | 'message.created'
  | 'message.status_updated'
  | 'instance.status_updated'
  | 'notification.created';

export const APP_EVENT_TYPES: ReadonlySet<RealtimeEventType> = new Set([
  'conversation.created', 'conversation.updated', 'message.created', 'message.status_updated', 'instance.status_updated', 'notification.created',
]);

export interface RealtimeEvent {
  type: RealtimeEventType;
  organizationId: string;
  /** Required for whatsapp.instance.* events; optional for application events. */
  instanceId?: string;
  businessId?: string;
  /** When set, only this user may receive the event (notifications). */
  userId?: string;
  at: string;
  data: Record<string, unknown>;
}

export type RealtimeListener = (event: RealtimeEvent) => void;

export interface RealtimeBus {
  publish(event: RealtimeEvent): Promise<void>;
  subscribe(listener: RealtimeListener): () => void;
  /** Lightweight "work available" signal for outbox pollers (no payload). */
  wakeOutbox(): Promise<void>;
  onOutboxWakeup(listener: () => void): () => void;
  close(): Promise<void>;
}

export const REALTIME_BUS = Symbol('REALTIME_BUS');

/** Single-process bus (tests; API + worker in one process). */
export class InMemoryRealtimeBus implements RealtimeBus {
  private readonly ee = new EventEmitter().setMaxListeners(0);
  async publish(event: RealtimeEvent): Promise<void> { this.ee.emit('event', event); }
  subscribe(listener: RealtimeListener): () => void {
    this.ee.on('event', listener);
    return () => this.ee.off('event', listener);
  }
  async wakeOutbox(): Promise<void> { this.ee.emit('wake'); }
  onOutboxWakeup(listener: () => void): () => void {
    this.ee.on('wake', listener);
    return () => this.ee.off('wake', listener);
  }
  async close(): Promise<void> { this.ee.removeAllListeners(); }
}

const CHANNEL = 'hs_realtime';
const WAKE_CHANNEL = 'hs_outbox_wakeup';

/**
 * Multi-process bus over PostgreSQL LISTEN/NOTIFY - no extra infrastructure.
 *
 * Confidentiality: NOTIFY payloads are AES-256-GCM encrypted with
 * REALTIME_BUS_KEY (shared by API and workers only), so QR/pairing codes are
 * never visible in plaintext inside PostgreSQL. NOTIFY is not WAL-logged, is
 * not stored in any table and is dropped once delivered; an 8 KB payload limit
 * applies (a QR is ~250 bytes).
 * Future: swap for Redis pub/sub when a Redis tier is introduced - the
 * RealtimeBus interface stays the same.
 */
export class PgNotifyRealtimeBus implements RealtimeBus {
  private readonly ee = new EventEmitter().setMaxListeners(0);
  private listenClient: PoolClient | null = null;
  private readonly key: Buffer;

  constructor(private readonly pool: Pool, keyBase64: string) {
    this.key = Buffer.from(keyBase64, 'base64');
    if (this.key.length !== 32) throw new Error('REALTIME_BUS_KEY must decode to 32 bytes');
  }

  async start(): Promise<void> {
    this.listenClient = await this.pool.connect();
    this.listenClient.on('notification', (n) => {
      if (n.channel === WAKE_CHANNEL) { this.ee.emit('wake'); return; }
      if (n.channel !== CHANNEL || !n.payload) return;
      try {
        const plain = aesGcmDecrypt(this.key, Buffer.from(n.payload, 'base64'), aad('realtime', 'v1'));
        this.ee.emit('event', JSON.parse(plain.toString('utf8')) as RealtimeEvent);
      } catch { /* tampered / foreign payload: drop */ }
    });
    await this.listenClient.query(`LISTEN ${CHANNEL}`);
    await this.listenClient.query(`LISTEN ${WAKE_CHANNEL}`);
  }

  async publish(event: RealtimeEvent): Promise<void> {
    const payload = aesGcmEncrypt(this.key, Buffer.from(JSON.stringify(event), 'utf8'), aad('realtime', 'v1')).toString('base64');
    await this.pool.query('SELECT pg_notify($1, $2)', [CHANNEL, payload]);
  }

  subscribe(listener: RealtimeListener): () => void {
    this.ee.on('event', listener);
    return () => this.ee.off('event', listener);
  }

  async wakeOutbox(): Promise<void> {
    await this.pool.query('SELECT pg_notify($1, $2)', [WAKE_CHANNEL, '']);
  }

  onOutboxWakeup(listener: () => void): () => void {
    this.ee.on('wake', listener);
    return () => this.ee.off('wake', listener);
  }

  async close(): Promise<void> {
    this.ee.removeAllListeners();
    if (this.listenClient) {
      await this.listenClient.query('UNLISTEN *').catch(() => undefined);
      this.listenClient.release();
      this.listenClient = null;
    }
  }
}
