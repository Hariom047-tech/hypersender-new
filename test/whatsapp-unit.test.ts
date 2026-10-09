import { BufferJSON as BaileysBufferJSON, initAuthCreds, proto, type WAMessage } from 'baileys';
import { describe, expect, it } from 'vitest';
import { HmacSessionService } from '../src/api/auth/session.service.js';
import { backoffDelay, SerialRateLimiter, WindowRateLimiter } from '../src/common/concurrency.js';
import { e164ToUserJid, InvalidPhoneNumberError, isGroupJid, normalizeUserJid, toE164, userJidToE164 } from '../src/whatsapp/domain/phone.js';
import { mapAckStatus, mapDisconnect } from '../src/whatsapp/providers/baileys/baileys-error-mapper.js';
import { normalizeBaileysMessage, type NormalizeContext } from '../src/whatsapp/providers/baileys/baileys-message-normalizer.js';
import { onClose } from '../src/whatsapp/services/connection-state-machine.js';
import { boom } from './fakes/fake-baileys-socket.js';

const ctx: NormalizeContext = { instanceId: '01a0e2cb-8d1d-7887-8f50-2eac28fbb2e1', meJid: '919900000001:3@s.whatsapp.net', upsertKind: 'notify' };
const now = () => Math.floor(Date.now() / 1000);
const msg = (message: proto.IMessage | null, key: Partial<WAMessage['key']> = {}, extra: Partial<WAMessage> = {}): WAMessage =>
  ({ key: { remoteJid: '919811112222@s.whatsapp.net', fromMe: false, id: 'ABC123', ...key }, messageTimestamp: now(), pushName: 'Rahul', message, ...extra }) as WAMessage;

describe('Baileys message normalizer', () => {
  it('TEXT (conversation) with phone/JID separation', () => {
    const ev = normalizeBaileysMessage(msg({ conversation: 'hello gateway' }), ctx);
    expect(ev).toMatchObject({ type: 'message', message: { messageType: 'TEXT', text: 'hello gateway', chatJid: '919811112222@s.whatsapp.net',
      senderPhone: '+919811112222', fromMe: false, pushName: 'Rahul', providerMessageId: 'ABC123' } });
  });

  it('extended text keeps the quoted message id', () => {
    const ev = normalizeBaileysMessage(msg({ extendedTextMessage: { text: 'yes', contextInfo: { stanzaId: 'QUOTED1' } } }), ctx);
    expect(ev).toMatchObject({ type: 'message', message: { messageType: 'TEXT', text: 'yes', quotedMessageId: 'QUOTED1' } });
  });

  it('media types expose metadata only (no bytes, no media keys)', () => {
    const img = normalizeBaileysMessage(msg({ imageMessage: { mimetype: 'image/jpeg', caption: 'x-ray', fileLength: 2048, mediaKey: Buffer.alloc(32, 9) } }), ctx);
    expect(img).toMatchObject({ type: 'message', message: { messageType: 'IMAGE', text: 'x-ray', media: { mediaType: 'IMAGE', mimeType: 'image/jpeg', fileSize: 2048 } } });
    expect(JSON.stringify(img)).not.toContain('mediaKey');
    const voice = normalizeBaileysMessage(msg({ audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true } }), ctx);
    expect(voice).toMatchObject({ message: { messageType: 'VOICE', media: { mimeType: 'audio/ogg' } } });
    const doc = normalizeBaileysMessage(msg({ documentMessage: { mimetype: 'application/pdf', fileName: 'report.pdf' } }), ctx);
    expect(doc).toMatchObject({ message: { messageType: 'DOCUMENT', media: { fileName: 'report.pdf' } } });
    const vid = normalizeBaileysMessage(msg({ videoMessage: { mimetype: 'video/mp4' } }), ctx);
    expect(vid).toMatchObject({ message: { messageType: 'VIDEO' } });
  });

  it('LOCATION, CONTACT (no vCard PII), REACTION, POLL', () => {
    expect(normalizeBaileysMessage(msg({ locationMessage: { degreesLatitude: 12.9, degreesLongitude: 77.6, name: 'Clinic' } }), ctx))
      .toMatchObject({ message: { messageType: 'LOCATION', rawMetadata: { latitude: 12.9, longitude: 77.6 } } });
    const contact = normalizeBaileysMessage(msg({ contactMessage: { displayName: 'Dr. Rao', vcard: 'BEGIN:VCARD\nTEL:+919999999999\nEND:VCARD' } }), ctx);
    expect(contact).toMatchObject({ message: { messageType: 'CONTACT', text: 'Dr. Rao' } });
    expect(JSON.stringify(contact)).not.toContain('+919999999999');
    expect(normalizeBaileysMessage(msg({ reactionMessage: { text: '👍', key: { id: 'TARGET1' } } }), ctx))
      .toMatchObject({ message: { messageType: 'REACTION', text: '👍', reactionTargetId: 'TARGET1' } });
    expect(normalizeBaileysMessage(msg({ pollCreationMessageV3: { name: 'Slot?', options: [{ optionName: '10am' }, { optionName: '11am' }], selectableOptionsCount: 1 } }), ctx))
      .toMatchObject({ message: { messageType: 'POLL', text: 'Slot?', rawMetadata: { options: ['10am', '11am'] } } });
  });

  it('unsupported/complex content becomes UNKNOWN with minimal metadata; garbage never throws', () => {
    expect(normalizeBaileysMessage(msg({ buttonsResponseMessage: { selectedButtonId: 'x' } } as proto.IMessage), ctx))
      .toMatchObject({ type: 'message', message: { messageType: 'UNKNOWN', rawMetadata: { contentType: 'buttonsResponseMessage' } } });
    expect(normalizeBaileysMessage({} as WAMessage, ctx)).toEqual({ type: 'ignored', reason: 'EMPTY' });
    expect(normalizeBaileysMessage(msg(null), ctx)).toEqual({ type: 'ignored', reason: 'EMPTY' });
  });

  it('group / status / broadcast / newsletter chats are never processed as contacts', () => {
    expect(normalizeBaileysMessage(msg({ conversation: 'hi' }, { remoteJid: '120363000000000000@g.us', participant: '9198@s.whatsapp.net' }), ctx)).toEqual({ type: 'ignored', reason: 'GROUP' });
    expect(normalizeBaileysMessage(msg({ conversation: 'hi' }, { remoteJid: 'status@broadcast' }), ctx)).toEqual({ type: 'ignored', reason: 'STATUS' });
    expect(normalizeBaileysMessage(msg({ conversation: 'hi' }, { remoteJid: '12345@broadcast' }), ctx)).toEqual({ type: 'ignored', reason: 'BROADCAST' });
    expect(normalizeBaileysMessage(msg({ conversation: 'hi' }, { remoteJid: '1203@newsletter' }), ctx)).toEqual({ type: 'ignored', reason: 'NEWSLETTER' });
  });

  it('history older than the link time is dropped (data minimisation)', () => {
    const old = msg({ conversation: 'from 2019' }, {}, { messageTimestamp: 1_550_000_000 });
    expect(normalizeBaileysMessage(old, { ...ctx, ignoreBefore: new Date() })).toEqual({ type: 'ignored', reason: 'HISTORY' });
  });

  it('protocol messages: revoke -> revoked event; edits/key shares ignored', () => {
    const revoke = msg({ protocolMessage: { type: proto.Message.ProtocolMessage.Type.REVOKE, key: { id: 'TARGET9' } } });
    expect(normalizeBaileysMessage(revoke, ctx)).toMatchObject({ type: 'revoked', providerMessageId: 'TARGET9' });
    const edit = msg({ protocolMessage: { type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT, key: { id: 'T' } } });
    expect(normalizeBaileysMessage(edit, ctx)).toEqual({ type: 'ignored', reason: 'PROTOCOL' });
  });

  it('fromMe messages identify the chat as the RECIPIENT and the sender as the instance', () => {
    const ev = normalizeBaileysMessage(msg({ conversation: 'typed on phone' }, { fromMe: true }, { pushName: undefined }), ctx);
    expect(ev).toMatchObject({ type: 'message', message: { fromMe: true, chatJid: '919811112222@s.whatsapp.net', senderJid: '919900000001@s.whatsapp.net', senderPhone: null } });
  });

  it('LID-addressed chats keep phone JID and LID apart', () => {
    const ev = normalizeBaileysMessage(msg({ conversation: 'hi' }, { remoteJid: '123456789012345@lid', remoteJidAlt: '919811112222@s.whatsapp.net' } as never), ctx);
    expect(ev).toMatchObject({ message: { chatJid: '919811112222@s.whatsapp.net', chatLid: '123456789012345@lid', senderPhone: '+919811112222' } });
    const lidOnly = normalizeBaileysMessage(msg({ conversation: 'hi' }, { remoteJid: '123456789012345@lid' }), ctx);
    expect(lidOnly).toMatchObject({ message: { chatJid: '123456789012345@lid', senderPhone: null } });
  });
});

describe('error / ack / state mapping', () => {
  it('maps Baileys disconnect reasons to stable categories', () => {
    expect(mapDisconnect(boom(401), true).category).toBe('LOGGED_OUT');
    expect(mapDisconnect(boom(515), false).category).toBe('RESTART_REQUIRED');
    expect(mapDisconnect(boom(440), true).category).toBe('CONNECTION_REPLACED');
    expect(mapDisconnect(boom(411), true).category).toBe('AUTH_INVALID');
    expect(mapDisconnect(boom(403), true).category).toBe('FORBIDDEN');
    expect(mapDisconnect(boom(428), true).category).toBe('TRANSIENT');
    expect(mapDisconnect(boom(408), false).category).toBe('QR_EXPIRED');
    expect(mapDisconnect(new Error('no status'), true).category).toBe('TRANSIENT');
    expect(mapDisconnect(undefined, true).category).toBe('TRANSIENT');
  });

  it('maps ack statuses; unknown values are ignored, not thrown', () => {
    expect([2, 3, 4, 5, 0].map(mapAckStatus)).toEqual(['SENT', 'DELIVERED', 'READ', 'READ', 'FAILED']);
    expect(mapAckStatus(1)).toBeNull();
    expect(mapAckStatus(99)).toBeNull();
    expect(mapAckStatus(undefined)).toBeNull();
  });

  it('close-handling policy: temporary vs logout vs terminal', () => {
    expect(onClose('TRANSIENT', 0, 10).action).toBe('RECONNECT_BACKOFF');
    expect(onClose('TRANSIENT', 10, 10)).toMatchObject({ action: 'STOP', status: 'ERROR' });
    expect(onClose('RESTART_REQUIRED', 0, 10).action).toBe('RECONNECT_NOW');
    expect(onClose('LOGGED_OUT', 0, 10)).toMatchObject({ action: 'DESTROY_AUTH', status: 'LOGGED_OUT' });
    expect(onClose('AUTH_INVALID', 0, 10)).toMatchObject({ action: 'DESTROY_AUTH' });
    expect(onClose('QR_EXPIRED', 0, 10)).toMatchObject({ action: 'STOP', status: 'DISCONNECTED', reason: 'QR_EXPIRED' });
    expect(onClose('CONNECTION_REPLACED', 0, 10)).toMatchObject({ action: 'STOP', status: 'ERROR' });
    expect(onClose('LOCAL_CLOSE', 0, 10).action).toBe('NONE');
  });

  it('backoff is exponential, jittered and capped', () => {
    expect(backoffDelay(0, 1000, 60_000, () => 0)).toBe(1000);
    expect(backoffDelay(3, 1000, 60_000, () => 1)).toBe(8000);
    expect(backoffDelay(30, 1000, 60_000, () => 1)).toBe(60_000);
    const samples = new Set(Array.from({ length: 20 }, () => backoffDelay(5, 1000, 60_000)));
    expect(samples.size).toBeGreaterThan(1);
  });
});

describe('phone <-> JID helpers', () => {
  it('parses to E.164 and converts explicitly', () => {
    expect(toE164('+91 98123 45678')).toBe('+919812345678');
    expect(toE164('098123 45678', 'IN')).toBe('+919812345678');
    expect(e164ToUserJid('+919812345678')).toBe('919812345678@s.whatsapp.net');
    expect(userJidToE164('919812345678:12@s.whatsapp.net')).toBe('+919812345678');
    expect(normalizeUserJid('919812345678:12@s.whatsapp.net')).toBe('919812345678@s.whatsapp.net');
  });
  it('never treats LIDs/groups as phone numbers and rejects junk', () => {
    expect(userJidToE164('123456789012345@lid')).toBeNull();
    expect(userJidToE164('1203@g.us')).toBeNull();
    expect(isGroupJid('1203@g.us')).toBe(true);
    expect(() => toE164('hello')).toThrow(InvalidPhoneNumberError);
    expect(() => toE164('+1 555')).toThrow(InvalidPhoneNumberError);
  });
});

describe('rate controls', () => {
  it('per-instance limiter serialises sends with a minimum interval', async () => {
    const lim = new SerialRateLimiter(40);
    const starts: number[] = [];
    let active = 0; let maxActive = 0;
    await Promise.all([1, 2, 3].map(() => lim.run(async () => {
      active++; maxActive = Math.max(maxActive, active); starts.push(Date.now());
      await new Promise((r) => setTimeout(r, 5)); active--;
    })));
    expect(maxActive).toBe(1);
    expect(starts[2] - starts[0]).toBeGreaterThanOrEqual(75);
  });
  it('API window limiter caps requests per key', () => {
    const w = new WindowRateLimiter(2, 60_000);
    expect([w.tryAcquire('k'), w.tryAcquire('k'), w.tryAcquire('k'), w.tryAcquire('other')]).toEqual([true, true, false, true]);
  });
});

describe('Baileys compatibility of the auth codec', () => {
  it('initAuthCreds round-trips through Baileys BufferJSON byte-for-byte', () => {
    const creds = initAuthCreds();
    const json = JSON.stringify(creds, BaileysBufferJSON.replacer);
    const back = JSON.parse(json, BaileysBufferJSON.reviver);
    expect(Buffer.from(back.noiseKey.private).equals(Buffer.from(creds.noiseKey.private))).toBe(true);
    expect(Buffer.from(back.signedPreKey.keyPair.public).equals(Buffer.from(creds.signedPreKey.keyPair.public))).toBe(true);
    expect(back.registrationId).toBe(creds.registrationId);
    // The mismatch that made us use Baileys' codec: numeric-key byte objects are revived by Baileys.
    const revived = JSON.parse(JSON.stringify({ k: { 0: 1, 1: 2 } }), BaileysBufferJSON.reviver);
    expect(Buffer.isBuffer(revived.k)).toBe(true);
  });
});

describe('dashboard session tokens', () => {
  it('issue / verify / tamper / expiry', async () => {
    process.env.SESSION_SECRET = 'test-session-secret-0123456789-abcdefghij';
    const s = new HmacSessionService();
    const uid = '01a0e2cb-8d1d-7887-8f50-2eac28fbb2e1';
    const t = s.issue(uid);
    expect(await s.verify(t)).toEqual({ userId: uid });
    expect(await s.verify(t.slice(0, -2) + 'xx')).toBeNull();
    expect(await s.verify(s.issue(uid, Date.now() - 13 * 3600_000))).toBeNull();
    expect(await s.verify('garbage')).toBeNull();
  });
});
