import { EventEmitter } from 'node:events';
import type { UserFacingSocketConfig, WAMessage } from 'baileys';
import type { BaileysSocket, SocketFactory } from '../../src/whatsapp/providers/baileys/baileys-session.js';

/** Boom-like error as Baileys produces for disconnects. */
export function boom(statusCode: number, message = `status ${statusCode}`): Error {
  return Object.assign(new Error(message), { output: { statusCode } });
}

/**
 * Minimal stand-in for a Baileys socket: same event names/payload shapes as
 * Baileys 7 (connection.update, creds.update, messages.upsert, messages.update).
 * Lets the REAL adapter/session-manager code run without WhatsApp.
 */
export class FakeBaileysSocket {
  readonly ev = new EventEmitter();
  readonly sent: Array<{ jid: string; content: Record<string, unknown>; messageId?: string }> = [];
  logoutCalls = 0;
  endCalls = 0;
  ended = false;
  user: { id: string; name?: string; lid?: string } | undefined;
  failSends = 0;
  /** Read receipts sent (blue ticks) and chat-state presence updates ("typing..."). */
  readonly reads: Array<{ remoteJid: string; id: string }> = [];
  readonly presence: Array<{ type: string; jid: string }> = [];

  constructor(readonly config: UserFacingSocketConfig) {}

  // --- driving the fake (what WhatsApp would do) ---
  emitConnection(update: Record<string, unknown>): void { this.ev.emit('connection.update', update); }
  qr(value = `2@FAKE-QR-${Math.random().toString(36).slice(2)},abc,def,ghi`): string { this.emitConnection({ qr: value }); return value; }
  open(phoneDigits: string, name = 'ABC Dental'): void {
    this.user = { id: `${phoneDigits}:7@s.whatsapp.net`, name, lid: `${phoneDigits}7@lid` };
    this.emitConnection({ connection: 'open' });
  }
  close(statusCode: number): void {
    this.ended = true;
    this.emitConnection({ connection: 'close', lastDisconnect: { error: boom(statusCode), date: new Date() } });
  }
  upsert(messages: WAMessage[], type: 'notify' | 'append' = 'notify'): void { this.ev.emit('messages.upsert', { messages, type }); }
  update(updates: Array<{ key: WAMessage['key']; update: Record<string, unknown> }>): void { this.ev.emit('messages.update', updates); }
  /** Simulates Baileys mutating creds and asking for persistence. */
  mutateCreds(mutator: (creds: UserFacingSocketConfig['auth']['creds']) => void): void {
    mutator(this.config.auth.creds);
    this.ev.emit('creds.update', {});
  }

  // --- socket API used by the adapter ---
  async sendMessage(jid: string, content: Record<string, unknown>, opts?: { messageId?: string }): Promise<WAMessage> {
    if (this.failSends > 0) { this.failSends--; throw new Error('Connection Closed'); }
    const id = opts?.messageId ?? `FAKE${Date.now()}${Math.random().toString(16).slice(2, 8)}`;
    this.sent.push({ jid, content, messageId: id });
    return { key: { remoteJid: jid, fromMe: true, id }, messageTimestamp: Math.floor(Date.now() / 1000), message: {} } as WAMessage;
  }
  async logout(): Promise<void> { this.logoutCalls++; }
  async end(): Promise<void> {
    this.endCalls++;
    if (this.ended) return;
    this.ended = true;
    this.emitConnection({ connection: 'close', lastDisconnect: { error: boom(428, 'Connection Closed'), date: new Date() } });
  }
  async readMessages(keys: Array<WAMessage['key']>): Promise<void> { for (const k of keys) this.reads.push({ remoteJid: String(k.remoteJid), id: String(k.id) }); }
  async sendPresenceUpdate(type: string, jid?: string): Promise<void> { this.presence.push({ type, jid: String(jid) }); }
  async requestPairingCode(): Promise<string> { return 'ABCD1234'; }
  async updateMediaMessage(m: WAMessage): Promise<WAMessage> { return m; }
}

export class FakeSocketFactory {
  readonly sockets: FakeBaileysSocket[] = [];
  readonly factory: SocketFactory = (config) => {
    const s = new FakeBaileysSocket(config);
    this.sockets.push(s);
    return s as unknown as BaileysSocket;
  };
  get last(): FakeBaileysSocket { return this.sockets[this.sockets.length - 1]; }
  /** Latest socket for an instance is simply the newest one (tests run one instance per factory at a time). */
}

let counter = 0;
export function waText(fromDigits: string, text: string, opts: { id?: string; fromMe?: boolean; ts?: number; toDigits?: string } = {}): WAMessage {
  const chat = opts.fromMe ? `${opts.toDigits ?? fromDigits}@s.whatsapp.net` : `${fromDigits}@s.whatsapp.net`;
  return {
    key: { remoteJid: chat, fromMe: Boolean(opts.fromMe), id: opts.id ?? `3EB0${Date.now().toString(16)}${(counter++).toString(16)}`.toUpperCase() },
    messageTimestamp: opts.ts ?? Math.floor(Date.now() / 1000),
    pushName: opts.fromMe ? undefined : 'Rahul',
    message: { conversation: text },
  } as WAMessage;
}
