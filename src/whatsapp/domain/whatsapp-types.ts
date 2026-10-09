/** Provider-agnostic WhatsApp domain types. No Baileys types may appear in this folder. */

export type InstanceStatus =
  | 'CREATED' | 'WAITING_FOR_QR' | 'PAIRING' | 'CONNECTED' | 'RECONNECTING'
  | 'DISCONNECTED' | 'LOGGED_OUT' | 'ERROR' | 'SUSPENDED';

export type TransportState = 'CLOSED' | 'CONNECTING' | 'OPEN';

export type NormalizedMessageType =
  | 'TEXT' | 'IMAGE' | 'VIDEO' | 'AUDIO' | 'VOICE' | 'DOCUMENT' | 'LOCATION'
  | 'CONTACT' | 'REACTION' | 'POLL' | 'STICKER' | 'UNKNOWN';

export type MediaType = 'IMAGE' | 'VIDEO' | 'AUDIO' | 'VOICE' | 'DOCUMENT' | 'STICKER';

export interface NormalizedMedia {
  mediaType: MediaType;
  mimeType: string;
  fileName: string | null;
  fileSize: number | null;
  /** Lazily downloads + decrypts the bytes. Holds provider data in a closure; never serialised. */
  download?: () => Promise<Buffer>;
}

/** A message observed on the connection (incoming from a contact OR sent from the owner's own devices). */
export interface NormalizedIncomingMessage {
  instanceId: string;
  providerMessageId: string;
  chatJid: string;             // the 1:1 chat (contact) JID
  chatLid: string | null;      // privacy LID of the contact, when known
  senderJid: string;
  senderPhone: string | null;  // E.164 when derivable
  pushName: string | null;
  fromMe: boolean;
  timestamp: Date;
  messageType: NormalizedMessageType;
  text: string | null;
  quotedMessageId: string | null;
  /** For REACTION: provider id of the message reacted to. */
  reactionTargetId: string | null;
  media: NormalizedMedia | null;
  /** Small, safe, non-secret metadata (e.g. location coords, poll options). */
  rawMetadata: Record<string, unknown> | null;
  /** 'notify' = live, 'append' = own/other-device or backfilled. */
  upsertKind: 'notify' | 'append';
}

export type ReceiptStatus = 'SENT' | 'DELIVERED' | 'READ' | 'FAILED' | 'REVOKED';

export interface OutboundTextRequest { toJid: string; text: string; providerMessageId?: string; quotedProviderMessageId?: string }
export interface OutboundMediaRequest {
  toJid: string;
  data: Buffer;
  mimeType: string;
  fileName?: string | null;
  caption?: string | null;
  providerMessageId?: string;
}
export interface OutboundLocationRequest { toJid: string; latitude: number; longitude: number; name?: string; providerMessageId?: string }

export interface SendResult { providerMessageId: string; timestamp: Date }
