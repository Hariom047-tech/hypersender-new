import type { Logger } from 'pino';
import { backoffDelay, Semaphore, SerialRateLimiter, withTimeout } from '../../common/concurrency.js';
import { isLeaseLost, LeaseLostError } from '../../database/errors.js';
import type { TransactionRunner } from '../../database/transaction-runner.js';
import { WhatsAppRepository } from '../../repositories/whatsapp.repository.js';
import { MessageIngestionService } from '../../services/message-ingestion.service.js';
import { MessagingRepository } from '../../repositories/messaging.repository.js';
import { OutboundMessageService } from '../../services/outbound-message.service.js';
import type { WhatsAppConfig } from '../../config/whatsapp.config.js';
import type { ProviderEvent } from '../domain/whatsapp-events.js';
import { WhatsAppError } from '../domain/whatsapp-errors.js';
import type { ProviderAuthPort, WhatsAppConnection, WhatsAppProvider } from '../domain/whatsapp-provider.interface.js';
import type { InstanceStatus, NormalizedIncomingMessage, TransportState } from '../domain/whatsapp-types.js';
import type { MediaStorageService } from '../media/media-storage.service.js';
import { AuthStateMissingError } from '../postgres-auth-state.js';
import type { RealtimeBus } from '../realtime/realtime-bus.js';
import { GatewayRepository, type RoutedOutboxEvent } from '../repositories/gateway.repository.js';
import { onClose } from './connection-state-machine.js';
import { DuplicatePhoneError, WhatsAppConnectionService, type SessionRef, type TransitionInput } from './whatsapp-connection.service.js';

export type AuthPortFactory = (ref: SessionRef) => ProviderAuthPort;

/** One live socket in THIS process. Not the source of truth - the DB lease is. */
export interface ActiveSession extends SessionRef {
  connection: WhatsAppConnection | null;
  connectionState: TransportState;
  status: InstanceStatus;
  connectedAt: Date | null;
  lastEventAt: Date;
  meJid: string | null;
  linkedAt: Date | null;
  reconnectAttempts: number;
  reconnectTimer?: NodeJS.Timeout;
  qrSeen: boolean;
  stopping: boolean;
  pairingPhoneE164?: string;
  logoutOnOpen?: { resolve: () => void };
  sendLimiter: SerialRateLimiter;
  events: Promise<void>;
  /** Resolves when the current connection attempt opens or closes (bounds concurrent handshakes). */
  handshake: { promise: Promise<void>; resolve: () => void };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

export type ConnectOutcome = 'STARTED' | 'ALREADY_CONNECTED' | 'IN_PROGRESS' | 'OWNED_BY_ANOTHER_WORKER' | 'AT_CAPACITY' | 'NOT_ACCEPTING';
export type RestoreOutcome = 'RESTORED' | 'ALREADY_ACTIVE' | 'OWNED_BY_ANOTHER_WORKER' | 'AUTH_MISSING' | 'AT_CAPACITY' | 'NOT_ACCEPTING';

export interface SessionManagerDeps {
  tx: TransactionRunner;                 // hs_worker
  provider: WhatsAppProvider;
  authFactory: AuthPortFactory;
  whatsapp: WhatsAppRepository;
  gateway: GatewayRepository;
  connections: WhatsAppConnectionService;
  ingestion: MessageIngestionService;
  outbound: OutboundMessageService;
  messaging: MessagingRepository;
  media: MediaStorageService;
  bus: RealtimeBus;
  config: WhatsAppConfig;
  logger: Logger;
  random?: () => number;
}

/**
 * Runs the WhatsApp sessions owned by this worker process.
 *
 * Ownership: every session starts with an atomic lease claim in PostgreSQL
 * (fencing token). Heartbeats renew the leases of live sockets; a session whose
 * lease cannot be renewed is stopped locally at once. Every credential/state
 * write re-checks the token, so a stale worker can never persist anything.
 */
export class WhatsAppSessionManager {
  private readonly sessions = new Map<string, ActiveSession>();
  private accepting = true;
  private timers: NodeJS.Timeout[] = [];
  private readonly restoreLimiter: Semaphore;
  private readonly mediaLimiter = new Semaphore(3);
  private readonly log: Logger;
  private readonly random: () => number;

  constructor(private readonly d: SessionManagerDeps) {
    this.restoreLimiter = new Semaphore(d.config.restoreConcurrency);
    this.log = d.logger.child({ worker_id: d.config.workerId });
    this.random = d.random ?? Math.random;
  }

  get workerId(): string { return this.d.config.workerId; }
  get activeCount(): number { return this.sessions.size; }
  get isAccepting(): boolean { return this.accepting; }
  hasCapacity(): boolean { return this.accepting && this.sessions.size < this.d.config.workerCapacity; }
  getSession(instanceId: string): ActiveSession | undefined { return this.sessions.get(instanceId); }

  /**
   * Chat signals (read receipts, typing). Best-effort and local-only: if this worker does not own the
   * instance's socket, or it is not connected, nothing happens. Never throws into the caller.
   */
  async chatSignal(instanceId: string, fn: (conn: WhatsAppConnection) => Promise<void> | undefined): Promise<void> {
    const conn = this.sessions.get(instanceId)?.connection;
    if (!conn || conn.getConnectionState() !== 'OPEN') return;
    try { await fn(conn); } catch (err) {
      this.log.warn({ event_name: 'whatsapp.chat_signal_failed', instance_id: instanceId, err: { message: String((err as Error)?.message).slice(0, 200) } });
    }
  }
  private get leaseSeconds(): number { return Math.ceil(this.d.config.staleAfterMs / 1000); }

  // ================================================================ lifecycle
  async start(opts: { loops?: boolean } = {}): Promise<void> {
    await this.d.tx.run({}, (db) => this.d.gateway.upsertWorker(db, {
      id: this.workerId, hostname: this.d.config.workerHostname, capacity: this.d.config.workerCapacity }));
    this.log.info({ event_name: 'whatsapp.worker_started' });
    await this.restoreEligible();
    if (opts.loops !== false) {
      this.timers.push(setInterval(() => void this.heartbeatOnce().catch((e) => this.logErr('whatsapp.heartbeat_failed', e)), this.d.config.heartbeatIntervalMs));
      this.timers.push(setInterval(() => void this.restoreEligible().catch((e) => this.logErr('whatsapp.orphan_scan_failed', e)), this.d.config.orphanScanIntervalMs));
    }
  }

  /**
   * Graceful shutdown: stop taking work, close sockets WITHOUT logging out
   * (the linked device stays valid), mark sessions RECONNECTING, release
   * leases so another worker (or this one after restart) restores them.
   */
  async shutdown(): Promise<void> {
    this.accepting = false;
    this.timers.forEach(clearInterval);
    this.timers = [];
    const all = [...this.sessions.values()];
    await Promise.all(all.map((s) => this.restoreLimiter.run(async () => {
      s.stopping = true;
      if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
      try { if (s.connection) await withTimeout(s.connection.disconnect(), 5_000, 'socket close'); } catch { /* best effort */ }
      await s.events.catch(() => undefined);
      const wasLive = s.status === 'CONNECTED' || s.status === 'RECONNECTING';
      await this.safeTransition(s, {
        status: wasLive ? 'RECONNECTING' : 'DISCONNECTED', connectionState: 'CLOSED', eventType: wasLive ? 'RECONNECTING' : 'DISCONNECTED',
        reason: 'WORKER_SHUTDOWN', releaseLease: true, disconnected: !wasLive,
      });
      this.sessions.delete(s.instanceId);
    })));
    await this.d.tx.run({}, (db) => this.d.gateway.heartbeat(db, this.workerId, 0, 'STOPPED')).catch(() => undefined);
    this.log.info({ event_name: 'whatsapp.worker_stopped', sessions_closed: all.length });
  }

  /** Renew leases of live sockets; drop any session whose ownership moved. Publish worker liveness. */
  async heartbeatOnce(): Promise<void> {
    const ids = [...this.sessions.keys()];
    const renewed = await this.d.tx.run({}, (db) => this.d.gateway.renewLeases(db, this.workerId, ids, this.leaseSeconds));
    for (const id of ids) {
      if (!renewed.has(id)) await this.dropLocally(this.sessions.get(id)!, 'LEASE_LOST');
    }
    await this.d.tx.run({}, async (db) => {
      await this.d.gateway.heartbeat(db, this.workerId, this.sessions.size, this.accepting ? 'ACTIVE' : 'DRAINING');
      await this.d.gateway.reapStaleWorkers(db, Math.ceil(this.d.config.staleAfterMs / 1000));
    });
  }

  /** Boot restore + orphan takeover, with bounded concurrency (no reconnect storms). */
  async restoreEligible(): Promise<number> {
    if (!this.hasCapacity()) return 0;
    const room = this.d.config.workerCapacity - this.sessions.size;
    const candidates = await this.d.tx.run({}, (db) => this.d.gateway.listRestorable(db, this.workerId, room));
    const results = await Promise.all(candidates.filter((c) => !this.sessions.has(c.id))
      .map((c) => this.restoreLimiter.run(() => this.restore(c.id, c.organizationId).catch((e) => { this.logErr('whatsapp.restore_failed', e, c.id); return 'NOT_ACCEPTING' as const; }))));
    return results.filter((r) => r === 'RESTORED').length;
  }

  // ============================================================== operations
  /** User-initiated connection (QR, or pairing code when a phone is given). */
  async connect(instanceId: string, organizationId: string, opts: { pairingPhoneE164?: string } = {}): Promise<ConnectOutcome> {
    if (!this.accepting) return 'NOT_ACCEPTING';
    const existing = this.sessions.get(instanceId);
    if (existing) return existing.connectionState === 'OPEN' ? 'ALREADY_CONNECTED' : 'IN_PROGRESS';
    if (!this.hasCapacity()) return 'AT_CAPACITY';
    const token = await this.d.tx.run({}, (db) => this.d.whatsapp.claimLeaseForLink(db, instanceId, this.workerId, this.leaseSeconds));
    if (token === null) return 'OWNED_BY_ANOTHER_WORKER';
    const s = await this.createSession(instanceId, organizationId, token, opts.pairingPhoneE164);
    if (!s) return 'NOT_ACCEPTING';
    await this.open(s, 'NEW');
    return 'STARTED';
  }

  /** Re-establish a linked session from stored credentials (no QR, ever). */
  async restore(instanceId: string, organizationId: string): Promise<RestoreOutcome> {
    if (!this.accepting) return 'NOT_ACCEPTING';
    if (this.sessions.has(instanceId)) return 'ALREADY_ACTIVE';
    if (!this.hasCapacity()) return 'AT_CAPACITY';
    const token = await this.d.tx.run({}, (db) => this.d.whatsapp.claimLease(db, instanceId, this.workerId, this.leaseSeconds));
    if (token === null) return 'OWNED_BY_ANOTHER_WORKER';
    const s = await this.createSession(instanceId, organizationId, token);
    if (!s) return 'NOT_ACCEPTING';
    if (!(await this.open(s, 'RESTORE'))) return 'AUTH_MISSING';
    // Hold the restore slot until the handshake settles, so RESTORE_CONCURRENCY
    // really bounds simultaneous WhatsApp handshakes (no reconnect storms).
    await withTimeout(s.handshake.promise, this.d.config.connectTimeoutMs, 'handshake').catch(() => undefined);
    return 'RESTORED';
  }

  /** Close the socket, keep the linked device. */
  async disconnect(instanceId: string, organizationId: string, reason = 'USER_DISCONNECT'): Promise<void> {
    let s = this.sessions.get(instanceId);
    if (s) {
      await this.closeLocal(s);
    } else {
      const token = await this.d.tx.run({}, (db) => this.d.whatsapp.claimLeaseForLink(db, instanceId, this.workerId, this.leaseSeconds));
      if (token === null) throw new WhatsAppError('WHATSAPP_WORKER_OWNERSHIP_CONFLICT');
      s = (await this.createSession(instanceId, organizationId, token, undefined, false))!;
    }
    await this.safeTransition(s, { status: 'DISCONNECTED', connectionState: 'CLOSED', eventType: 'DISCONNECTED', reason, disconnected: true, releaseLease: true });
    this.sessions.delete(instanceId);
    await this.publishStatus(s, 'DISCONNECTED', reason);
  }

  /** Close and reopen from stored credentials (auth preserved). */
  async restart(instanceId: string, organizationId: string): Promise<RestoreOutcome> {
    const s = this.sessions.get(instanceId);
    if (!s) return this.restore(instanceId, organizationId);
    await this.closeLocal(s);
    s.stopping = false;
    s.qrSeen = false;
    await this.safeTransition(s, { eventType: 'RESTARTED', reason: 'USER_RESTART' });
    return (await this.open(s, 'RESTORE')) ? 'RESTORED' : 'AUTH_MISSING';
  }

  /**
   * Unlink the device on WhatsApp (best effort) and destroy stored auth.
   * If no socket is live here but credentials exist, the session is briefly
   * restored just to send the logout; after `timeoutMs` auth is destroyed anyway.
   */
  async logout(instanceId: string, organizationId: string, reason = 'USER_LOGOUT', timeoutMs = 20_000): Promise<void> {
    let s = this.sessions.get(instanceId);
    if (!s) {
      const token = await this.d.tx.run({}, (db) => this.d.whatsapp.claimLeaseForLink(db, instanceId, this.workerId, this.leaseSeconds));
      if (token !== null) {
        s = (await this.createSession(instanceId, organizationId, token, undefined, false)) ?? undefined;
        const hasCreds = s ? await this.d.tx.inTenant((db) => this.d.gateway.hasCredentials(db, instanceId), { organizationId }) : false;
        if (s && hasCreds) {
          const done = new Promise<void>((resolve) => { s!.logoutOnOpen = { resolve }; });
          this.sessions.set(instanceId, s);
          if (await this.open(s, 'RESTORE')) await withTimeout(done, timeoutMs, 'logout').catch(() => undefined);
        }
      }
    } else if (s.connection) {
      s.stopping = true;
      if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
      try { await withTimeout(s.connection.logout(), timeoutMs, 'logout'); } catch (e) { this.logErr('whatsapp.logout_call_failed', e, instanceId); }
    }
    const ref = s ?? await this.refFor(instanceId, organizationId);
    await this.d.connections.destroyAuth(ref, reason);
    this.sessions.delete(instanceId);
    await this.publishStatus(ref, 'LOGGED_OUT', reason);
  }

  // =========================================================== routed work
  /** INSTANCE_COMMAND handler (routed to this worker). */
  async handleCommand(e: RoutedOutboxEvent): Promise<void> {
    const command = String(e.payload.command ?? '');
    const instanceId = e.targetInstanceId;
    const org = e.organizationId;
    const log = this.log.child({ instance_id: instanceId, organization_id: org, event_name: 'whatsapp.command', command });
    switch (command) {
      case 'CONNECT': {
        const phone = typeof e.payload.pairing_phone_e164 === 'string' ? e.payload.pairing_phone_e164 : undefined;
        const outcome = await this.connect(instanceId, org, { pairingPhoneE164: phone });
        log.info({ outcome });
        if (outcome === 'AT_CAPACITY' || outcome === 'NOT_ACCEPTING') throw new Error(`retry: ${outcome}`);
        return;
      }
      case 'RESTART': log.info({ outcome: await this.restart(instanceId, org) }); return;
      case 'DISCONNECT': await this.disconnect(instanceId, org); log.info({}); return;
      case 'LOGOUT': await this.logout(instanceId, org); log.info({}); return;
      case 'DELETE': await this.logout(instanceId, org, 'INSTANCE_DELETED'); log.info({}); return;
      default: log.warn({ outcome: 'UNKNOWN_COMMAND' });
    }
  }

  /** MESSAGE_SEND_REQUESTED handler: provider send under the per-instance limiter. Throw => outbox retry. */
  async handleSend(e: RoutedOutboxEvent, attachmentsLoader: (storageKey: string) => Promise<Buffer>): Promise<void> {
    const org = e.organizationId;
    const messageId = String(e.payload.message_id);
    const msg = await this.d.tx.inTenant(async (db) => {
      const r = await db.query(
        `SELECT m.status, m.message_type, m.text_body, m.recipient_jid, i.deleted_at IS NOT NULL AS instance_deleted,
                a.storage_key, a.mime_type, a.file_name
           FROM app.messages m JOIN app.whatsapp_instances i ON i.id = m.whatsapp_instance_id
           LEFT JOIN app.message_attachments a ON a.message_id = m.id
          WHERE m.id = $1 LIMIT 1`, [messageId]);
      return r.rows[0];
    }, { organizationId: org });
    if (!msg || msg.status !== 'QUEUED') return; // already sent/failed: idempotent no-op

    const s = this.sessions.get(e.targetInstanceId);
    const conn = s?.connection;
    // TTL counts from when the send was queued (outbox event), not from message creation.
    const expired = Date.now() - e.createdAt.getTime() > this.d.config.sendQueueTtlSeconds * 1000;
    if (!conn || conn.getConnectionState() !== 'OPEN' || msg.instance_deleted) {
      if (expired || msg.instance_deleted) {
        await this.d.outbound.markFailed(org, messageId, 'WHATSAPP_INSTANCE_NOT_CONNECTED', 'instance was not connected within the send window');
        return;
      }
      throw new WhatsAppError('WHATSAPP_INSTANCE_NOT_CONNECTED', undefined, true);
    }

    try {
      await s!.sendLimiter.run(async () => {
        // Pre-assign the provider id BEFORE sending: the provider's echo of this
        // send will collide with it and never be treated as a new message.
        const candidate = conn.generateMessageId();
        let providerId: string | undefined;
        if (candidate) {
          const assigned = await this.d.tx.inTenant((db) => this.d.whatsapp.assignProviderId(db, messageId, candidate), { organizationId: org });
          if (!assigned) return; // no longer QUEUED
          providerId = assigned;
        }
        const to = msg.recipient_jid as string;
        let result;
        switch (msg.message_type) {
          case 'TEXT': result = await conn.sendText({ toJid: to, text: msg.text_body ?? '', providerMessageId: providerId }); break;
          case 'IMAGE': result = await conn.sendImage({ toJid: to, data: await attachmentsLoader(msg.storage_key), mimeType: msg.mime_type, caption: msg.text_body, providerMessageId: providerId }); break;
          case 'DOCUMENT': result = await conn.sendDocument({ toJid: to, data: await attachmentsLoader(msg.storage_key), mimeType: msg.mime_type, fileName: msg.file_name, caption: msg.text_body, providerMessageId: providerId }); break;
          case 'AUDIO': result = await conn.sendAudio({ toJid: to, data: await attachmentsLoader(msg.storage_key), mimeType: msg.mime_type, providerMessageId: providerId }); break;
          case 'VIDEO': result = await conn.sendVideo({ toJid: to, data: await attachmentsLoader(msg.storage_key), mimeType: msg.mime_type, caption: msg.text_body, providerMessageId: providerId }); break;
          default: throw new WhatsAppError('WHATSAPP_UNSUPPORTED_MESSAGE');
        }
        await this.d.outbound.markSent(org, messageId, result.providerMessageId, result.timestamp);
        this.log.info({ event_name: 'whatsapp.message_sent', instance_id: e.targetInstanceId, organization_id: org, message_id: messageId });
      });
    } catch (err) {
      const retryable = err instanceof WhatsAppError ? err.retryable : true;
      if (retryable && e.attempts < this.d.config.sendMaxAttempts && !expired) throw err;
      const code = err instanceof WhatsAppError ? err.code : 'WHATSAPP_SEND_FAILED';
      await this.d.outbound.markFailed(org, messageId, code, (err as Error).message ?? code);
    }
  }

  // ============================================================== internals
  private async refFor(instanceId: string, organizationId: string): Promise<SessionRef> {
    const inst = await this.d.tx.inTenant((db) => this.d.gateway.loadInstance(db, instanceId), { organizationId });
    if (!inst) throw new WhatsAppError('WHATSAPP_INSTANCE_NOT_FOUND');
    return { instanceId, organizationId, businessId: inst.businessId, workerId: this.workerId, leaseToken: -1 };
  }

  private async createSession(instanceId: string, organizationId: string, leaseToken: number, pairingPhoneE164?: string, register = true): Promise<ActiveSession | null> {
    const inst = await this.d.tx.inTenant((db) => this.d.gateway.loadInstance(db, instanceId), { organizationId });
    if (!inst || inst.organizationId !== organizationId) {
      await this.d.tx.run({}, (db) => this.d.whatsapp.releaseLease(db, instanceId, this.workerId, leaseToken)).catch(() => undefined);
      return null;
    }
    const s: ActiveSession = {
      instanceId, organizationId, businessId: inst.businessId, workerId: this.workerId, leaseToken,
      connection: null, connectionState: 'CLOSED', status: inst.status, connectedAt: null, lastEventAt: new Date(),
      meJid: inst.whatsappJid, linkedAt: inst.linkedAt, reconnectAttempts: 0, qrSeen: false, stopping: false,
      pairingPhoneE164, sendLimiter: new SerialRateLimiter(this.d.config.sendMinIntervalMs), events: Promise.resolve(),
      handshake: deferred(),
    };
    (s as ActiveSession & { appearOnline: boolean }).appearOnline = inst.appearOnline;
    if (register) this.sessions.set(instanceId, s);
    return s;
  }

  /** Opens a provider connection for the session. Returns false when stored auth is missing on RESTORE. */
  private async open(s: ActiveSession, mode: 'NEW' | 'RESTORE'): Promise<boolean> {
    const ignoreBefore = s.linkedAt ? new Date(s.linkedAt.getTime() - 60_000) : new Date(Date.now() - 60_000);
    const appearOnline = Boolean((s as ActiveSession & { appearOnline?: boolean }).appearOnline);
    s.handshake.resolve();
    s.handshake = deferred();
    try {
      const params = {
        instanceId: s.instanceId,
        auth: this.d.authFactory(s),
        ignoreMessagesBefore: ignoreBefore,
        markOnline: this.d.config.honourAppearOnline && appearOnline,
        onEvent: (ev: ProviderEvent) => { s.events = s.events.then(() => this.onEvent(s, ev)).catch((err) => this.logErr('whatsapp.event_failed', err, s.instanceId)); },
        getStoredMessage: (providerMessageId: string) => this.storedOutbound(s, providerMessageId),
      };
      s.connection = mode === 'RESTORE'
        ? await this.d.provider.restoreConnection(params)
        : await this.d.provider.createConnection({ ...params, requireExistingAuth: false, pairingPhoneE164: s.pairingPhoneE164 });
      s.connectionState = 'CONNECTING';
      return true;
    } catch (err) {
      s.handshake.resolve();
      this.sessions.delete(s.instanceId);
      if (err instanceof AuthStateMissingError) {
        await this.safeTransition(s, { status: 'DISCONNECTED', connectionState: 'CLOSED', eventType: 'DISCONNECTED', reason: 'AUTH_MISSING', disconnected: true, releaseLease: true });
        await this.publishStatus(s, 'DISCONNECTED', 'AUTH_MISSING');
        return false;
      }
      if (err instanceof LeaseLostError || isLeaseLost(err)) return false;
      await this.safeTransition(s, { status: 'ERROR', connectionState: 'CLOSED', eventType: 'ERROR', reason: 'PROVIDER_START_FAILED', releaseLease: true, errorCode: 'PROVIDER_START_FAILED' });
      throw err;
    }
  }

  private async storedOutbound(s: SessionRef, providerMessageId: string): Promise<{ text: string } | undefined> {
    const r = await this.d.tx.inTenant((db) => db.query(
      `SELECT text_body FROM app.messages WHERE whatsapp_instance_id = $1 AND provider_message_id = $2 AND direction = 'OUTBOUND' AND text_body IS NOT NULL`,
      [s.instanceId, providerMessageId]), { organizationId: s.organizationId });
    return r.rows[0] ? { text: r.rows[0].text_body } : undefined;
  }

  private async onEvent(s: ActiveSession, ev: ProviderEvent): Promise<void> {
    s.lastEventAt = new Date();
    const log = this.log.child({ instance_id: s.instanceId, organization_id: s.organizationId, business_id: s.businessId });
    switch (ev.type) {
      case 'qr': {
        if (s.stopping) return;
        if (!s.qrSeen) {
          s.qrSeen = true;
          await this.safeTransition(s, { status: 'WAITING_FOR_QR', connectionState: 'CONNECTING', eventType: 'QR_GENERATED',
                                         metadata: { expires_at: ev.expiresAt.toISOString() } });
        }
        // The QR goes ONLY to the realtime bus (tenant-tagged, never persisted, never logged).
        await this.d.bus.publish({ type: 'whatsapp.instance.qr', organizationId: s.organizationId, instanceId: s.instanceId,
                                   at: new Date().toISOString(), data: { qr: ev.qr, expiresAt: ev.expiresAt.toISOString() } });
        log.info({ event_name: 'whatsapp.qr_generated' });
        return;
      }
      case 'pairing_code': {
        await this.safeTransition(s, { status: 'PAIRING', eventType: 'PAIRING_STARTED', metadata: { method: 'PAIRING_CODE' } });
        await this.d.bus.publish({ type: 'whatsapp.instance.pairing_code', organizationId: s.organizationId, instanceId: s.instanceId,
                                   at: new Date().toISOString(), data: { pairingCode: ev.code } });
        log.info({ event_name: 'whatsapp.pairing_code_generated' });
        return;
      }
      case 'paired':
        await this.safeTransition(s, { status: 'PAIRING', eventType: 'PAIRING_STARTED', metadata: { method: s.pairingPhoneE164 ? 'PAIRING_CODE' : 'QR', credentials_accepted: true } });
        return;
      case 'connecting':
        s.connectionState = 'CONNECTING';
        return;
      case 'open': {
        s.handshake.resolve();
        s.connectionState = 'OPEN';
        s.meJid = ev.profile.jid || s.meJid;
        if (s.logoutOnOpen) {
          try { await s.connection?.logout(); } catch { /* best effort */ }
          s.logoutOnOpen.resolve();
          return;
        }
        try {
          await this.transition(s, { status: 'CONNECTED', connectionState: 'OPEN', eventType: 'CONNECTED', connected: true,
            profile: ev.profile, reconnectAttempts: 0, metadata: { reconnect_attempts: s.reconnectAttempts } });
        } catch (err) {
          if (err instanceof DuplicatePhoneError) {
            log.warn({ event_name: 'whatsapp.duplicate_phone_rejected' });
            s.stopping = true;
            try { await s.connection?.logout(); } catch { /* ignore */ }
            await this.d.connections.destroyAuth(s, 'DUPLICATE_PHONE_NUMBER');
            this.sessions.delete(s.instanceId);
            await this.publishStatus(s, 'LOGGED_OUT', 'DUPLICATE_PHONE_NUMBER');
            return;
          }
          throw err;
        }
        s.reconnectAttempts = 0;
        s.connectedAt = new Date();
        s.linkedAt = s.linkedAt ?? new Date();
        await this.publishStatus(s, 'CONNECTED', null);
        log.info({ event_name: 'whatsapp.connected' });
        return;
      }
      case 'closed':
        s.handshake.resolve();
        s.connectionState = 'CLOSED';
        if (s.stopping || ev.category === 'LOCAL_CLOSE') return;
        return this.onClosed(s, ev.category, ev.code);
      case 'message':
        return this.onMessage(s, ev.message);
      case 'receipt':
        if (ev.fromMe) await this.d.outbound.applyReceipt(s.organizationId, s.instanceId, ev.providerMessageId, ev.status, ev.at);
        return;
      case 'revoked':
        await this.d.outbound.applyReceipt(s.organizationId, s.instanceId, ev.providerMessageId, 'REVOKED', ev.at);
        return;
      case 'ignored':
        log.debug({ event_name: 'whatsapp.message_ignored', reason: ev.reason });
        return;
      case 'identity': {
        const upgraded = await this.d.tx.inTenant((db) => this.d.messaging.upgradeLidContact(db, s.businessId, ev.lidJid, ev.pnJid), { organizationId: s.organizationId });
        if (upgraded) log.info({ event_name: 'whatsapp.contact_identity_upgraded' });
        return;
      }
    }
  }

  private async onClosed(s: ActiveSession, category: import('../domain/whatsapp-events.js').DisconnectCategory, code: number | null): Promise<void> {
    const action = onClose(category, s.reconnectAttempts, this.d.config.maxReconnectAttempts);
    const log = this.log.child({ instance_id: s.instanceId, organization_id: s.organizationId });
    log.info({ event_name: 'whatsapp.connection_closed', category, code, action: action.action });
    switch (action.action) {
      case 'RECONNECT_NOW':
        await this.safeTransition(s, { eventType: action.eventType, reason: action.reason, metadata: { code } });
        if (this.sessions.has(s.instanceId)) await this.open(s, 'RESTORE');
        return;
      case 'RECONNECT_BACKOFF': {
        s.reconnectAttempts++;
        const delay = backoffDelay(s.reconnectAttempts - 1, this.d.config.reconnectMinDelayMs, this.d.config.reconnectMaxDelayMs, this.random);
        const ok = await this.safeTransition(s, { status: 'RECONNECTING', connectionState: 'CONNECTING', eventType: 'RECONNECTING',
          reason: action.reason, reconnectAttempts: s.reconnectAttempts, metadata: { code, attempt: s.reconnectAttempts, delay_ms: delay } });
        if (!ok) return;
        await this.publishStatus(s, 'RECONNECTING', action.reason);
        s.reconnectTimer = setTimeout(() => {
          if (!this.accepting || s.stopping || !this.sessions.has(s.instanceId)) return;
          void this.open(s, 'RESTORE').catch((e) => this.logErr('whatsapp.reconnect_failed', e, s.instanceId));
        }, delay);
        return;
      }
      case 'DESTROY_AUTH':
        this.sessions.delete(s.instanceId);
        await this.d.connections.destroyAuth(s, action.reason);
        await this.publishStatus(s, 'LOGGED_OUT', action.reason);
        return;
      case 'STOP':
        this.sessions.delete(s.instanceId);
        await this.safeTransition(s, { status: action.status, connectionState: 'CLOSED', eventType: action.eventType, reason: action.reason,
          disconnected: true, releaseLease: true, errorCode: action.status === 'ERROR' ? action.reason : null, metadata: { code } });
        await this.publishStatus(s, action.status, action.reason);
        return;
      case 'NONE':
        return;
    }
  }

  private async onMessage(s: ActiveSession, m: NormalizedIncomingMessage): Promise<void> {
    const instanceJid = s.meJid ? `${s.meJid.split(':')[0].split('@')[0]}@s.whatsapp.net` : 'unknown@s.whatsapp.net';
    const res = await this.d.ingestion.ingest({
      organizationId: s.organizationId, businessId: s.businessId, instanceId: s.instanceId, instanceJid,
      providerMessageId: m.providerMessageId, fromJid: m.chatJid, fromLid: m.chatLid, fromPhoneE164: m.senderPhone,
      pushName: m.pushName, fromMe: m.fromMe, type: m.messageType, text: m.text, providerTimestamp: m.timestamp,
      quotedProviderMessageId: m.quotedMessageId, reactionTargetProviderMessageId: m.reactionTargetId,
      attachments: m.media ? [{ mediaType: m.media.mediaType, mimeType: m.media.mimeType, fileName: m.media.fileName, fileSize: m.media.fileSize }] : [],
      rawMetadata: m.rawMetadata,
    });
    this.log.info({
      event_name: res.status === 'CREATED' ? 'whatsapp.message_stored' : 'whatsapp.message_duplicate',
      instance_id: s.instanceId, organization_id: s.organizationId, message_id: res.messageId, type: m.messageType, from_me: m.fromMe,
      ...(this.d.config.logMessageContent ? { text: m.text } : {}),
    });
    if (res.status === 'CREATED' && m.media?.download && res.attachments[0]) {
      const att = res.attachments[0];
      const download = m.media.download;
      const tooBig = m.media.fileSize !== null && m.media.fileSize > this.d.config.mediaMaxBytes;
      // Best effort, off the ingestion path: the message row already exists.
      void this.mediaLimiter.run(async () => {
        try {
          if (tooBig) throw new WhatsAppError('WHATSAPP_MEDIA_TOO_LARGE');
          const data = await withTimeout(download(), 60_000, 'media download');
          if (data.length > this.d.config.mediaMaxBytes) throw new WhatsAppError('WHATSAPP_MEDIA_TOO_LARGE');
          const stored = await this.d.media.put(att.storageKey, data, m.media!.mimeType);
          await this.d.tx.inTenant((db) => db.query(
            `UPDATE app.message_attachments SET status = 'STORED', storage_provider = $2, file_size = $3, sha256 = $4 WHERE id = $1`,
            [att.id, stored.storageProvider, stored.size, stored.sha256]), { organizationId: s.organizationId });
        } catch (err) {
          await this.d.tx.inTenant((db) => db.query(`UPDATE app.message_attachments SET status = 'FAILED' WHERE id = $1`, [att.id]),
            { organizationId: s.organizationId }).catch(() => undefined);
          this.logErr('whatsapp.media_download_failed', err, s.instanceId);
        }
      });
    }
  }

  private async transition(s: ActiveSession, t: TransitionInput): Promise<void> {
    const r = await this.d.connections.transition(s, t);
    s.status = r.status;
  }

  /** Transition that treats a lost lease as "stop touching this session" instead of an error. */
  private async safeTransition(s: ActiveSession | SessionRef, t: TransitionInput): Promise<boolean> {
    try {
      const r = await this.d.connections.transition(s, t);
      if ('status' in s) (s as ActiveSession).status = r.status;
      return true;
    } catch (err) {
      if (err instanceof LeaseLostError) {
        if ('connection' in s) await this.dropLocally(s as ActiveSession, 'LEASE_LOST');
        return false;
      }
      throw err;
    }
  }

  private async closeLocal(s: ActiveSession): Promise<void> {
    s.stopping = true;
    if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
    try { if (s.connection) await withTimeout(s.connection.disconnect(), 10_000, 'socket close'); } catch { /* ignore */ }
    await s.events.catch(() => undefined);
    s.connection = null;
    s.connectionState = 'CLOSED';
  }

  /** Ownership moved to another worker: stop the socket here WITHOUT any DB writes. */
  private async dropLocally(s: ActiveSession | undefined, reason: string): Promise<void> {
    if (!s) return;
    this.sessions.delete(s.instanceId);
    s.stopping = true;
    if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
    try { await s.connection?.disconnect(); } catch { /* ignore */ }
    this.log.warn({ event_name: 'whatsapp.session_dropped', instance_id: s.instanceId, organization_id: s.organizationId, reason });
  }

  private async publishStatus(s: Pick<SessionRef, 'organizationId' | 'instanceId'>, status: InstanceStatus, reason: string | null): Promise<void> {
    await this.d.bus.publish({ type: 'whatsapp.instance.status', organizationId: s.organizationId, instanceId: s.instanceId,
                               at: new Date().toISOString(), data: { status, reason } }).catch(() => undefined);
  }

  private logErr(event: string, err: unknown, instanceId?: string): void {
    this.log.error({ event_name: event, instance_id: instanceId, err: { name: (err as Error)?.name, message: String((err as Error)?.message ?? err).slice(0, 300) } });
  }
}
