import makeWASocket, {
  generateMessageIDV2, isJidBroadcast, isJidGroup, isJidNewsletter, makeCacheableSignalKeyStore, proto,
  type AnyMessageContent, type UserFacingSocketConfig, type WAMessage, type WAMessageKey, type WAMessageUpdate,
  downloadMediaMessage,
} from 'baileys';
import type { Logger } from 'pino';
import { isLeaseLost, LeaseLostError } from '../../../database/errors.js';
import type { ProviderEvent } from '../../domain/whatsapp-events.js';
import type { ConnectionParams, WhatsAppConnection } from '../../domain/whatsapp-provider.interface.js';
import { WhatsAppError } from '../../domain/whatsapp-errors.js';
import type {
  OutboundLocationRequest, OutboundMediaRequest, OutboundTextRequest, SendResult, TransportState,
} from '../../domain/whatsapp-types.js';
import { userJidToE164 } from '../../domain/phone.js';
import { mapAckStatus, mapDisconnect } from './baileys-error-mapper.js';
import { normalizeBaileysMessage } from './baileys-message-normalizer.js';
import type { BaileysAuthState } from './baileys-auth-store.js';

/**
 * History-sync policy. Baileys 7 warns that refusing EVERY sync type prevents it
 * from receiving the initial phone-number <-> LID mappings ("instability and
 * session errors") - found during the live smoke test. So we accept only the
 * identity/bootstrap syncs and refuse message-history syncs. Chat content in
 * bootstrap payloads is still never stored: we do not subscribe to
 * 'messaging-history.set', and the normalizer drops anything older than linked_at.
 */
const ALLOWED_HISTORY_SYNC = new Set<number>([
  proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP,
  proto.HistorySync.HistorySyncType.PUSH_NAME,
  proto.HistorySync.HistorySyncType.NON_BLOCKING_DATA,
]);
export const shouldSyncHistory = (msg: { syncType?: number | null }): boolean =>
  msg.syncType != null && ALLOWED_HISTORY_SYNC.has(msg.syncType);

/** The subset of the Baileys socket we use (lets tests inject a fake). */
export type BaileysSocket = Pick<ReturnType<typeof makeWASocket>, 'ev' | 'sendMessage' | 'logout' | 'end' | 'requestPairingCode' | 'user' | 'updateMediaMessage'>
  & Partial<Pick<ReturnType<typeof makeWASocket>, 'signalRepository' | 'readMessages' | 'sendPresenceUpdate'>>;
export type SocketFactory = (config: UserFacingSocketConfig) => BaileysSocket;

export const defaultSocketFactory: SocketFactory = (config) => makeWASocket(config);

export interface BaileysSessionOptions {
  logger: Logger;                 // already redacting; Baileys gets a child at baileysLogLevel
  baileysLogLevel: string;
  qrTimeoutMs: number;
  connectTimeoutMs: number;
  mediaMaxBytes: number;
  socketFactory?: SocketFactory;
  /** Test hook: point the socket at a local server instead of WhatsApp. */
  waWebSocketUrl?: string;
  /** Test seam: replaces Baileys' CDN download (production uses downloadMediaMessage). */
  mediaDownloader?: (msg: WAMessage) => Promise<Buffer>;
  /** Re-encryption on recipient retry requests: returns stored outbound content. */
  getStoredMessage?: (providerMessageId: string) => Promise<{ text: string } | undefined>;
}

/**
 * One Baileys socket lifetime for one instance. Reconnecting = the session
 * manager creating a NEW BaileysSession (Baileys sockets are not reusable
 * after close).
 */
export class BaileysSession implements WhatsAppConnection {
  private sock!: BaileysSocket;
  private state: TransportState = 'CONNECTING';
  private registered = false;
  private meJid: string | null = null;
  private closedByUs = false;
  private pairingRequested = false;
  private credsChain: Promise<void> = Promise.resolve();
  private releaseAuth: () => void = () => undefined;
  /** Recent inbound keys exactly as WhatsApp sent them (LID or phone addressing), for read receipts. Bounded. */
  private readonly inboundKeys = new Map<string, WAMessageKey>();
  /** Stored chat jid (phone-number form after identity resolution) -> the jid WhatsApp actually used for that chat. Bounded. */
  private readonly chatAddress = new Map<string, string>();

  private constructor(readonly instanceId: string, private readonly params: ConnectionParams, private readonly opts: BaileysSessionOptions) {}

  static async open(params: ConnectionParams, opts: BaileysSessionOptions): Promise<BaileysSession> {
    const session = new BaileysSession(params.instanceId, params, opts);
    await session.start();
    return session;
  }

  private emit(event: ProviderEvent): void {
    Promise.resolve(this.params.onEvent(event)).catch((err) =>
      this.opts.logger.error({ event_name: 'whatsapp.provider_event_handler_failed', err: { message: (err as Error).message } }));
  }

  private async start(): Promise<void> {
    const loaded = await this.params.auth.load({ requireExisting: this.params.requireExistingAuth });
    const auth = loaded.state as BaileysAuthState;
    this.releaseAuth = loaded.close;
    this.registered = Boolean(auth.creds.registered || auth.creds.me?.id);
    this.meJid = auth.creds.me?.id ?? null;

    const baileysLogger = this.opts.logger.child({ component: 'baileys' }, { level: this.opts.baileysLogLevel });
    const config: UserFacingSocketConfig = {
      auth: { creds: auth.creds, keys: makeCacheableSignalKeyStore(auth.keys, baileysLogger) },
      logger: baileysLogger,
      markOnlineOnConnect: this.params.markOnline,
      // Data minimisation: never request full history; only identity/bootstrap syncs (see shouldSyncHistory).
      syncFullHistory: false,
      shouldSyncHistoryMessage: shouldSyncHistory,
      // Group / broadcast / newsletter traffic is not processed (not even decrypted).
      shouldIgnoreJid: (jid: string) => Boolean(isJidGroup(jid) || isJidBroadcast(jid) || isJidNewsletter(jid)),
      qrTimeout: this.opts.qrTimeoutMs,
      connectTimeoutMs: this.opts.connectTimeoutMs,
      generateHighQualityLinkPreview: false,
      getMessage: async (key: WAMessageKey) => {
        const lookup = this.params.getStoredMessage ?? this.opts.getStoredMessage;
        if (!key.id || !lookup) return undefined;
        const stored = await lookup(key.id);
        return stored ? proto.Message.create({ conversation: stored.text }) : undefined;
      },
      ...(this.opts.waWebSocketUrl ? { waWebSocketUrl: this.opts.waWebSocketUrl } : {}),
    };
    this.sock = (this.opts.socketFactory ?? defaultSocketFactory)(config);

    // Credentials: serialised writes, fenced by the lease inside the store.
    this.sock.ev.on('creds.update', () => {
      this.credsChain = this.credsChain.then(() => loaded.saveCreds()).catch((err) => {
        if (err instanceof LeaseLostError || isLeaseLost(err)) {
          this.emit({ type: 'closed', category: 'CONNECTION_REPLACED', code: null, message: 'lease lost' });
          void this.hardStop();
        } else {
          this.opts.logger.error({ event_name: 'whatsapp.creds_persist_failed', instance_id: this.instanceId, err: { message: (err as Error).message } });
        }
      });
    });

    this.sock.ev.on('connection.update', (u) => void this.onConnectionUpdate(u));
    this.sock.ev.on('messages.upsert', ({ messages, type }) => {
      for (const m of messages) {
        if (!m.key?.fromMe && m.key?.id && m.key.remoteJid) remember(this.inboundKeys, m.key.id, m.key);
        void this.resolveIdentity(this.normalize(m, type)).then((ev) => {
          if (ev.type === 'message' && !ev.message.fromMe && m.key?.remoteJid) remember(this.chatAddress, ev.message.chatJid, m.key.remoteJid);
          this.emit(ev);
        });
      }
    });
    this.sock.ev.on('lid-mapping.update', (mapping) => {
      if (mapping?.lid && mapping?.pn) this.emit({ type: 'identity', lidJid: mapping.lid, pnJid: mapping.pn });
    });
    this.sock.ev.on('messages.update', (updates) => {
      for (const u of updates) this.onMessageUpdate(u);
    });
    // Ignored on purpose: history sync, presence, chats/contacts sync, group events, calls.
  }

  /**
   * LID-only chats: ask Baileys' own LID<->PN store (persisted, encrypted, in
   * our signal-key table) for the phone number before the message is stored,
   * so the contact is keyed by phone number whenever WhatsApp has revealed it.
   * Never guesses: no mapping => stays LID-addressed.
   */
  private async resolveIdentity(ev: ProviderEvent): Promise<ProviderEvent> {
    if (ev.type !== 'message' || !ev.message.chatJid.endsWith('@lid')) return ev;
    try {
      const pn = await this.sock.signalRepository?.lidMapping?.getPNForLID(ev.message.chatJid);
      if (!pn || !pn.endsWith('@s.whatsapp.net')) return ev;
      const pnJid = `${pn.split(':')[0].split('@')[0]}@s.whatsapp.net`;
      return { ...ev, message: { ...ev.message, chatLid: ev.message.chatJid, chatJid: pnJid,
        senderJid: ev.message.fromMe ? ev.message.senderJid : pnJid, senderPhone: ev.message.fromMe ? null : userJidToE164(pnJid) } };
    } catch {
      return ev;
    }
  }

  private normalize(m: WAMessage, type: 'notify' | 'append'): ProviderEvent {
    return normalizeBaileysMessage(m, {
      instanceId: this.instanceId,
      meJid: this.meJid,
      upsertKind: type,
      ignoreBefore: this.params.ignoreMessagesBefore ?? null,
      downloadMedia: (msg) => this.downloadMedia(msg),
    });
  }

  private async downloadMedia(msg: WAMessage): Promise<Buffer> {
    const buf = this.opts.mediaDownloader ? await this.opts.mediaDownloader(msg) : await downloadMediaMessage(msg, 'buffer', {}, {
      logger: this.opts.logger.child({ component: 'baileys-media' }, { level: this.opts.baileysLogLevel }),
      reuploadRequest: (m) => this.sock.updateMediaMessage(m),
    });
    if (buf.length > this.opts.mediaMaxBytes) throw new WhatsAppError('WHATSAPP_MEDIA_TOO_LARGE');
    return buf;
  }

  private onMessageUpdate(u: WAMessageUpdate): void {
    const jid = u.key.remoteJid ?? '';
    if (!u.key.id || isJidGroup(jid) || isJidBroadcast(jid) || isJidNewsletter(jid)) return;
    if (u.update.messageStubType === proto.WebMessageInfo.StubType.REVOKE ||
        u.update.message?.protocolMessage?.type === proto.Message.ProtocolMessage.Type.REVOKE) {
      this.emit({ type: 'revoked', providerMessageId: u.key.id, chatJid: jid, at: new Date() });
      return;
    }
    const status = mapAckStatus(u.update.status as number | null | undefined);
    if (status) this.emit({ type: 'receipt', providerMessageId: u.key.id, chatJid: jid, fromMe: Boolean(u.key.fromMe), status, at: new Date() });
  }

  private async onConnectionUpdate(u: Partial<import('baileys').ConnectionState>): Promise<void> {
    if (u.qr) {
      if (this.params.pairingPhoneE164) {
        if (!this.pairingRequested) {
          this.pairingRequested = true;
          try {
            const code = await this.sock.requestPairingCode(this.params.pairingPhoneE164.replace(/^\+/, ''));
            this.emit({ type: 'pairing_code', code });
          } catch (err) {
            this.opts.logger.warn({ event_name: 'whatsapp.pairing_code_failed', instance_id: this.instanceId, err: { message: (err as Error).message } });
          }
        }
      } else {
        this.emit({ type: 'qr', qr: u.qr, expiresAt: new Date(Date.now() + this.opts.qrTimeoutMs) });
      }
    }
    if (u.isNewLogin) {
      this.registered = true;
      this.emit({ type: 'paired' });
    }
    if (u.connection === 'connecting') {
      this.state = 'CONNECTING';
      this.emit({ type: 'connecting' });
    } else if (u.connection === 'open') {
      this.state = 'OPEN';
      this.registered = true;
      const user = this.sock.user;
      this.meJid = user?.id ?? this.meJid;
      const jid = user?.id ? `${user.id.split(':')[0].split('@')[0]}@s.whatsapp.net` : '';
      this.emit({ type: 'open', profile: { jid, phoneE164: userJidToE164(jid), displayName: user?.name ?? user?.notify ?? null, lid: user?.lid ?? null } });
    } else if (u.connection === 'close') {
      this.state = 'CLOSED';
      await this.credsChain; // flush pending credential writes before anyone reconnects
      this.releaseAuth();
      if (this.closedByUs) {
        this.emit({ type: 'closed', category: 'LOCAL_CLOSE', code: null, message: null });
        return;
      }
      const err = u.lastDisconnect?.error;
      const mapped = mapDisconnect(err, this.registered);
      this.emit({ type: 'closed', category: mapped.category, code: mapped.code, message: err ? String((err as Error).message ?? '').slice(0, 200) : null });
    }
  }

  getConnectionState(): TransportState { return this.state; }

  async markRead(chatJid: string, providerMessageIds: string[]): Promise<void> {
    if (this.state !== 'OPEN' || providerMessageIds.length === 0) return;
    const jid = this.chatAddress.get(chatJid) ?? chatJid;
    await this.sock.readMessages?.(providerMessageIds.map((id) => this.inboundKeys.get(id) ?? { remoteJid: jid, id, fromMe: false }));
  }

  async setTyping(chatJid: string, typing: boolean): Promise<void> {
    if (this.state !== 'OPEN') return;
    await this.sock.sendPresenceUpdate?.(typing ? 'composing' : 'paused', this.chatAddress.get(chatJid) ?? chatJid);
  }

  generateMessageId(): string | null {
    return generateMessageIDV2(this.sock.user?.id);
  }

  private async send(toJid: string, content: AnyMessageContent, providerMessageId?: string): Promise<SendResult> {
    if (this.state !== 'OPEN') throw new WhatsAppError('WHATSAPP_INSTANCE_NOT_CONNECTED', undefined, true);
    let res: WAMessage | undefined;
    try {
      res = await this.sock.sendMessage(toJid, content, providerMessageId ? { messageId: providerMessageId } : undefined);
    } catch (err) {
      throw new WhatsAppError('WHATSAPP_SEND_FAILED', (err as Error).message?.slice(0, 200), true);
    }
    const id = res?.key?.id ?? providerMessageId;
    if (!id) throw new WhatsAppError('WHATSAPP_SEND_FAILED', 'provider returned no message id', true);
    const ts = res?.messageTimestamp ? Number(res.messageTimestamp) * 1000 : Date.now();
    return { providerMessageId: id, timestamp: new Date(ts) };
  }

  sendText(r: OutboundTextRequest): Promise<SendResult> {
    return this.send(r.toJid, { text: r.text }, r.providerMessageId);
  }
  sendImage(r: OutboundMediaRequest): Promise<SendResult> {
    return this.send(r.toJid, { image: r.data, mimetype: r.mimeType, caption: r.caption ?? undefined }, r.providerMessageId);
  }
  sendDocument(r: OutboundMediaRequest): Promise<SendResult> {
    return this.send(r.toJid, { document: r.data, mimetype: r.mimeType, fileName: r.fileName ?? 'document', caption: r.caption ?? undefined }, r.providerMessageId);
  }
  sendAudio(r: OutboundMediaRequest & { voiceNote?: boolean }): Promise<SendResult> {
    return this.send(r.toJid, { audio: r.data, mimetype: r.mimeType, ptt: Boolean(r.voiceNote) }, r.providerMessageId);
  }
  sendVideo(r: OutboundMediaRequest): Promise<SendResult> {
    return this.send(r.toJid, { video: r.data, mimetype: r.mimeType, caption: r.caption ?? undefined }, r.providerMessageId);
  }
  sendLocation(r: OutboundLocationRequest): Promise<SendResult> {
    return this.send(r.toJid, { location: { degreesLatitude: r.latitude, degreesLongitude: r.longitude, name: r.name } }, r.providerMessageId);
  }

  /** Close the socket, keep the linked device (normal shutdown / user "disconnect"). Never logs out. */
  async disconnect(): Promise<void> {
    this.closedByUs = true;
    await this.credsChain;
    await this.sock.end(undefined);
  }

  private async hardStop(): Promise<void> {
    this.closedByUs = true;
    try { await this.sock.end(undefined); } catch { /* already closed */ }
  }

  /** Unlink this device on WhatsApp. The caller destroys stored credentials afterwards. */
  async logout(): Promise<void> {
    this.closedByUs = true;
    try {
      await this.sock.logout();
    } finally {
      try { await this.sock.end(undefined); } catch { /* ignore */ }
    }
  }
}

const MAX_REMEMBERED = 5000;
function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_REMEMBERED) map.delete(map.keys().next().value!);
}
