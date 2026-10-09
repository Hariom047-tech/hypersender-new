import {
  getContentType, isJidBroadcast, isJidGroup, isJidNewsletter, isJidStatusBroadcast, isLidUser, isPnUser,
  jidNormalizedUser, normalizeMessageContent, proto, toNumber, WAMessageStubType, type WAMessage,
} from 'baileys';
import type { ProviderEvent } from '../../domain/whatsapp-events.js';
import type { MediaType, NormalizedIncomingMessage, NormalizedMedia, NormalizedMessageType } from '../../domain/whatsapp-types.js';
import { userJidToE164 } from '../../domain/phone.js';

export interface NormalizeContext {
  instanceId: string;
  meJid: string | null;
  upsertKind: 'notify' | 'append';
  /** Anything older is history (data minimisation) and is dropped. */
  ignoreBefore?: Date | null;
  downloadMedia?: (msg: WAMessage) => Promise<Buffer>;
}

const MAX_TEXT = 65_536;
const clip = (s: string | null | undefined) => (s == null ? null : s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s);

function mediaOf(msg: WAMessage, mediaType: MediaType, m: { mimetype?: string | null; fileLength?: unknown; fileName?: string | null },
                 ctx: NormalizeContext, fallbackMime: string): NormalizedMedia {
  const size = m.fileLength == null ? null : toNumber(m.fileLength as number);
  return {
    mediaType,
    mimeType: (m.mimetype ?? fallbackMime).split(';')[0].trim().toLowerCase() || fallbackMime,
    fileName: m.fileName ?? null,
    fileSize: Number.isSafeInteger(size) ? size : null,
    download: ctx.downloadMedia ? () => ctx.downloadMedia!(msg) : undefined,
  };
}

/**
 * Converts one raw Baileys WAMessage into exactly one provider-neutral event.
 * Never throws on unexpected shapes: anything unrecognised becomes UNKNOWN
 * (with minimal metadata) or an 'ignored' event. The raw protobuf never
 * leaves this function.
 */
export function normalizeBaileysMessage(msg: WAMessage, ctx: NormalizeContext): ProviderEvent {
  try {
    return normalizeUnsafe(msg, ctx);
  } catch {
    return { type: 'ignored', reason: 'EMPTY' };
  }
}

function normalizeUnsafe(msg: WAMessage, ctx: NormalizeContext): ProviderEvent {
  const key = msg.key;
  const remoteJid = key?.remoteJid ?? undefined;
  if (!key?.id || !remoteJid) return { type: 'ignored', reason: 'EMPTY' };

  // ---- chat policy -------------------------------------------------------
  if (isJidGroup(remoteJid)) return { type: 'ignored', reason: 'GROUP' };
  if (isJidStatusBroadcast(remoteJid)) return { type: 'ignored', reason: 'STATUS' };
  if (isJidBroadcast(remoteJid)) return { type: 'ignored', reason: 'BROADCAST' };
  if (isJidNewsletter(remoteJid)) return { type: 'ignored', reason: 'NEWSLETTER' };

  const tsSeconds = msg.messageTimestamp == null ? Math.floor(Date.now() / 1000) : toNumber(msg.messageTimestamp as number);
  const timestamp = new Date(tsSeconds * 1000);
  if (ctx.ignoreBefore && timestamp < ctx.ignoreBefore) return { type: 'ignored', reason: 'HISTORY' };

  const fromMe = Boolean(key.fromMe);

  // ---- identity (PN vs LID) ----------------------------------------------
  const alt = (key as { remoteJidAlt?: string }).remoteJidAlt;
  let pnJid: string | null = null;
  let lidJid: string | null = null;
  if (isLidUser(remoteJid)) {
    lidJid = jidNormalizedUser(remoteJid);
    if (alt && isPnUser(alt)) pnJid = jidNormalizedUser(alt);
  } else {
    pnJid = jidNormalizedUser(remoteJid);
    if (alt && isLidUser(alt)) lidJid = jidNormalizedUser(alt);
  }
  const chatJid = pnJid ?? lidJid!;

  // Stub-only revoke notifications (some clients deliver revokes this way).
  if (msg.messageStubType === WAMessageStubType.REVOKE) {
    return { type: 'revoked', providerMessageId: key.id, chatJid, at: timestamp };
  }

  const content = normalizeMessageContent(msg.message);
  if (!content) return { type: 'ignored', reason: 'EMPTY' };

  // ---- protocol messages ---------------------------------------------------
  if (content.protocolMessage) {
    const pm = content.protocolMessage;
    if (pm.type === proto.Message.ProtocolMessage.Type.REVOKE && pm.key?.id) {
      return { type: 'revoked', providerMessageId: pm.key.id, chatJid, at: timestamp };
    }
    return { type: 'ignored', reason: 'PROTOCOL' }; // edits, history-sync notices, key shares, ephemeral settings...
  }

  const contentType = getContentType(content);
  const base: NormalizedIncomingMessage = {
    instanceId: ctx.instanceId,
    providerMessageId: key.id,
    chatJid,
    chatLid: lidJid,
    senderJid: fromMe ? (ctx.meJid ? jidNormalizedUser(ctx.meJid) : 'me') : chatJid,
    senderPhone: fromMe ? null : userJidToE164(pnJid),
    pushName: fromMe ? null : (msg.pushName ?? null),
    fromMe,
    timestamp,
    messageType: 'UNKNOWN',
    text: null,
    quotedMessageId: null,
    reactionTargetId: null,
    media: null,
    rawMetadata: null,
    upsertKind: ctx.upsertKind,
  };
  const withType = (messageType: NormalizedMessageType, extra: Partial<NormalizedIncomingMessage>): ProviderEvent =>
    ({ type: 'message', message: { ...base, messageType, ...extra } });
  const quoted = (ci?: proto.IContextInfo | null) => ci?.stanzaId ?? null;

  switch (contentType) {
    case 'conversation':
      return withType('TEXT', { text: clip(content.conversation) });
    case 'extendedTextMessage':
      return withType('TEXT', { text: clip(content.extendedTextMessage?.text), quotedMessageId: quoted(content.extendedTextMessage?.contextInfo) });
    case 'imageMessage': {
      const m = content.imageMessage!;
      return withType('IMAGE', { text: clip(m.caption), quotedMessageId: quoted(m.contextInfo), media: mediaOf(msg, 'IMAGE', m, ctx, 'image/jpeg') });
    }
    case 'videoMessage':
    case 'ptvMessage': {
      const m = (content.videoMessage ?? content.ptvMessage)!;
      return withType('VIDEO', { text: clip(m.caption), quotedMessageId: quoted(m.contextInfo), media: mediaOf(msg, 'VIDEO', m, ctx, 'video/mp4') });
    }
    case 'audioMessage': {
      const m = content.audioMessage!;
      const t: MediaType = m.ptt ? 'VOICE' : 'AUDIO';
      return withType(t, { quotedMessageId: quoted(m.contextInfo), media: mediaOf(msg, t, m, ctx, 'audio/ogg') });
    }
    case 'documentMessage': {
      const m = content.documentMessage!;
      return withType('DOCUMENT', { text: clip(m.caption), quotedMessageId: quoted(m.contextInfo), media: mediaOf(msg, 'DOCUMENT', m, ctx, 'application/octet-stream') });
    }
    case 'stickerMessage': {
      const m = content.stickerMessage!;
      return withType('STICKER', { media: mediaOf(msg, 'STICKER', m, ctx, 'image/webp') });
    }
    case 'locationMessage':
    case 'liveLocationMessage': {
      const m = (content.locationMessage ?? content.liveLocationMessage)!;
      return withType('LOCATION', {
        text: clip((m as proto.Message.ILocationMessage).name ?? null),
        rawMetadata: { latitude: m.degreesLatitude ?? null, longitude: m.degreesLongitude ?? null,
                       name: (m as proto.Message.ILocationMessage).name ?? null, address: (m as proto.Message.ILocationMessage).address ?? null,
                       live: contentType === 'liveLocationMessage' },
      });
    }
    case 'contactMessage':
      // vCards carry third-party PII: keep only the display name.
      return withType('CONTACT', { text: clip(content.contactMessage?.displayName ?? null), rawMetadata: { contacts: 1 } });
    case 'contactsArrayMessage':
      return withType('CONTACT', { text: clip(content.contactsArrayMessage?.displayName ?? null),
                                   rawMetadata: { contacts: content.contactsArrayMessage?.contacts?.length ?? 0 } });
    case 'reactionMessage': {
      const r = content.reactionMessage!;
      return withType('REACTION', { text: r.text || null, reactionTargetId: r.key?.id ?? null });
    }
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3': {
      const p = (content.pollCreationMessage ?? content.pollCreationMessageV2 ?? content.pollCreationMessageV3)!;
      return withType('POLL', { text: clip(p.name ?? null),
        rawMetadata: { options: (p.options ?? []).map((o) => o.optionName ?? '').slice(0, 12), selectableCount: p.selectableOptionsCount ?? null } });
    }
    case 'pollUpdateMessage':             // encrypted vote: out of scope
    case 'senderKeyDistributionMessage':  // signalling only
    case 'messageContextInfo':
    case 'editedMessage':
    case 'keepInChatMessage':
    case 'pinInChatMessage':
      return { type: 'ignored', reason: 'PROTOCOL' };
    default:
      return withType('UNKNOWN', { rawMetadata: { contentType: contentType ?? null } });
  }
}
