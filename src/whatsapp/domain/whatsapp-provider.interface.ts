import type { ProviderEventHandler } from './whatsapp-events.js';
import type {
  OutboundLocationRequest, OutboundMediaRequest, OutboundTextRequest, SendResult, TransportState,
} from './whatsapp-types.js';

/**
 * Durable, encrypted credential storage handed to a provider. The provider
 * never sees the database, KMS or tenant context - only this port.
 */
export interface ProviderAuthPort {
  /** Opaque provider-specific auth state (e.g. Baileys creds + key store). */
  load(opts: { requireExisting: boolean }): Promise<{ state: unknown; saveCreds: () => Promise<void>; isNew: boolean; close: () => void }>;
}

export interface ConnectionParams {
  instanceId: string;
  auth: ProviderAuthPort;
  /** Existing auth required (restore). If missing, fail instead of producing a QR. */
  requireExistingAuth: boolean;
  /** Request a pairing code for this E.164 number instead of showing QR. */
  pairingPhoneE164?: string;
  /** Messages older than this are history and must not be emitted. */
  ignoreMessagesBefore?: Date | null;
  markOnline: boolean;
  onEvent: ProviderEventHandler;
  /** Stored outbound content for provider-level resend on recipient retry requests. */
  getStoredMessage?: (providerMessageId: string) => Promise<{ text: string } | undefined>;
}

/** A live connection to WhatsApp for one instance. */
export interface WhatsAppConnection {
  readonly instanceId: string;
  getConnectionState(): TransportState;
  sendText(req: OutboundTextRequest): Promise<SendResult>;
  sendImage(req: OutboundMediaRequest): Promise<SendResult>;
  sendDocument(req: OutboundMediaRequest): Promise<SendResult>;
  sendAudio(req: OutboundMediaRequest & { voiceNote?: boolean }): Promise<SendResult>;
  sendVideo(req: OutboundMediaRequest): Promise<SendResult>;
  sendLocation(req: OutboundLocationRequest): Promise<SendResult>;
  /** Provider-format message id to pre-assign before sending (echo de-duplication). Null if the provider assigns ids server-side. */
  generateMessageId(): string | null;
  /** Send read receipts (blue ticks) for inbound messages of a chat. Optional: providers without it are skipped. */
  markRead?(chatJid: string, providerMessageIds: string[]): Promise<void>;
  /** Show / clear the "typing..." indicator in a chat. Optional. */
  setTyping?(chatJid: string, typing: boolean): Promise<void>;
  /** Close the socket but KEEP the linked device (normal shutdown / disconnect). */
  disconnect(): Promise<void>;
  /** Unlink the device on WhatsApp's side. Caller destroys stored auth afterwards. */
  logout(): Promise<void>;
}

/**
 * Provider abstraction. Initial implementation: Baileys. A Meta Cloud API
 * provider would implement the same contract (connect = webhook subscription,
 * no QR, generateMessageId() = null).
 */
export interface WhatsAppProvider {
  readonly name: 'BAILEYS' | 'META_CLOUD' | 'OTHER';
  createConnection(params: ConnectionParams): Promise<WhatsAppConnection>;
  /** Same as createConnection with requireExistingAuth = true. */
  restoreConnection(params: Omit<ConnectionParams, 'requireExistingAuth' | 'pairingPhoneE164'>): Promise<WhatsAppConnection>;
}

export const WHATSAPP_PROVIDER = Symbol('WHATSAPP_PROVIDER');
