import type { NormalizedIncomingMessage, ReceiptStatus } from './whatsapp-types.js';

/**
 * Why a connection closed, in OUR vocabulary (never provider objects/codes
 * leaking out). Each category drives one reconnect policy.
 */
export type DisconnectCategory =
  | 'RESTART_REQUIRED'   // expected after pairing: reconnect immediately
  | 'TRANSIENT'          // network/server hiccup: reconnect with backoff
  | 'LOGGED_OUT'         // user removed the linked device: destroy auth, need QR
  | 'AUTH_INVALID'       // credentials unusable: destroy auth, need QR
  | 'CONNECTION_REPLACED'// another client took this session: stop, do not fight
  | 'QR_EXPIRED'         // pairing window elapsed without a scan
  | 'FORBIDDEN'          // account restricted by WhatsApp: stop
  | 'LOCAL_CLOSE';       // we closed it (disconnect/shutdown)

export type ProviderEvent =
  | { type: 'qr'; qr: string; expiresAt: Date }
  | { type: 'pairing_code'; code: string }
  | { type: 'connecting' }
  | { type: 'paired' }                                   // credentials accepted (isNewLogin)
  | { type: 'open'; profile: { jid: string; phoneE164: string | null; displayName: string | null; lid: string | null } }
  | { type: 'closed'; category: DisconnectCategory; code: number | null; message: string | null }
  | { type: 'message'; message: NormalizedIncomingMessage }
  | { type: 'receipt'; providerMessageId: string; chatJid: string; fromMe: boolean; status: ReceiptStatus; at: Date }
  | { type: 'revoked'; providerMessageId: string; chatJid: string; at: Date }
  /** Protocol-level phone-number <-> LID mapping (Baileys 'lid-mapping.update'). */
  | { type: 'identity'; lidJid: string; pnJid: string }
  | { type: 'ignored'; reason: 'GROUP' | 'BROADCAST' | 'NEWSLETTER' | 'HISTORY' | 'PROTOCOL' | 'STATUS' | 'EMPTY' };

export type ProviderEventHandler = (event: ProviderEvent) => void | Promise<void>;
