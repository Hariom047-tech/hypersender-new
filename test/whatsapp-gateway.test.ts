import { createHmac } from 'node:crypto';
import { proto } from 'baileys';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryRealtimeBus } from '../src/whatsapp/realtime/realtime-bus.js';
import { waText, type FakeBaileysSocket } from './fakes/fake-baileys-socket.js';
import { asUser, makeHarness, seedTenant, type Harness, type Tenant } from './helpers.js';
import { drainRouted, makeApiServices, makeGateway, settle, waitFor, type GatewayRig } from './whatsapp-helpers.js';

let h: Harness;
let T: Tenant;
let rig: GatewayRig;
let api: ReturnType<typeof makeApiServices>;
let instanceId: string;
const OWNER_PHONE = '919900011122';
const CUSTOMER = '919811112222';
const bus = new InMemoryRealtimeBus();

const instRow = async (id = instanceId) => (await h.owner.query(
  `SELECT status, connection_state, phone_e164, whatsapp_jid, worker_id, linked_at, reconnect_attempts, disconnect_reason FROM app.whatsapp_instances WHERE id = $1`, [id])).rows[0];
const credsCount = async (id = instanceId) => (await h.owner.query('SELECT count(*)::int AS n FROM app.whatsapp_auth_credentials WHERE instance_id = $1', [id])).rows[0].n;
const eventsOf = async (id = instanceId) => (await h.owner.query('SELECT event_type FROM app.whatsapp_instance_events WHERE instance_id = $1 ORDER BY created_at, id', [id])).rows.map((r) => r.event_type);
const sock = (): FakeBaileysSocket => rig.fake.last;

/** Scans every app table as text for a needle (QR / secrets must never appear anywhere). */
async function foundInDatabase(needle: string): Promise<string[]> {
  const tables = (await h.owner.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'app'`)).rows.map((r) => r.tablename);
  const hits: string[] = [];
  for (const t of tables) {
    const r = await h.owner.query(`SELECT count(*)::int AS n FROM app.${t} x WHERE x::text LIKE '%' || $1 || '%'`, [needle]);
    if (r.rows[0].n > 0) hits.push(t);
  }
  return hits;
}

beforeAll(async () => {
  h = makeHarness();
  T = await seedTenant(h, 'gateway');
  // The seeded tenant already has one instance; the TRIAL plan allows exactly one.
  await h.owner.query(`UPDATE app.subscriptions SET plan_id = (SELECT id FROM app.subscription_plans WHERE code = 'GROWTH') WHERE organization_id = $1`, [T.orgId]);
  rig = makeGateway(h, { bus });
  api = makeApiServices(h, bus, rig.media);
  await rig.worker.start({ loops: false });
  const created = await api.instances.create(asUser(T), { businessId: T.businessId, name: 'Front desk' });
  instanceId = created.id;
});
afterAll(async () => { await rig.worker.stop().catch(() => undefined); await h.close(); });

describe('connection lifecycle (QR -> pairing -> connected)', () => {
  it('create => CREATED, nothing connected, nothing leased', async () => {
    expect(await instRow()).toMatchObject({ status: 'CREATED', worker_id: null });
    expect(rig.fake.sockets).toHaveLength(0);
  });

  it('CONNECT command routes to a worker, starts Baileys with safe config, and emits the QR ONLY on the realtime bus', async () => {
    await api.instances.command(asUser(T), instanceId, 'CONNECT');
    await drainRouted(rig);
    expect(rig.fake.sockets).toHaveLength(1);
    const cfg = sock().config;
    expect(cfg.syncFullHistory).toBe(false);
    const H = proto.HistorySync.HistorySyncType;
    for (const t of [H.FULL, H.RECENT, H.ON_DEMAND, H.INITIAL_STATUS_V3]) expect(cfg.shouldSyncHistoryMessage!({ syncType: t } as never)).toBe(false);
    for (const t of [H.INITIAL_BOOTSTRAP, H.PUSH_NAME]) expect(cfg.shouldSyncHistoryMessage!({ syncType: t } as never)).toBe(true);
    expect(cfg.markOnlineOnConnect).toBe(false);
    expect(cfg.shouldIgnoreJid!('1203@g.us')).toBe(true);
    expect(await credsCount()).toBe(1); // fresh creds, encrypted in PostgreSQL

    const qr = sock().qr();
    await settle(rig, instanceId);
    expect(await instRow()).toMatchObject({ status: 'WAITING_FOR_QR' });
    expect(await eventsOf()).toContain('QR_GENERATED');
    const qrEvent = rig.events.find((e) => e.type === 'whatsapp.instance.qr');
    expect(qrEvent).toMatchObject({ organizationId: T.orgId, instanceId, data: { qr } });
    expect(await api.instances.getQr(asUser(T), instanceId)).toMatchObject({ qr });
    // QR is authentication material: never persisted, never logged.
    expect(await foundInDatabase(qr)).toEqual([]);
    expect(await foundInDatabase('FAKE-QR')).toEqual([]);
    expect(rig.logs.join('\n')).not.toContain('FAKE-QR');
  });

  it('WAITING_FOR_QR -> PAIRING -> (515 restart) -> CONNECTED, and auth is restored from PostgreSQL for the restart', async () => {
    sock().emitConnection({ isNewLogin: true });
    sock().mutateCreds((c) => { c.me = { id: `${OWNER_PHONE}:7@s.whatsapp.net`, name: 'ABC Dental' }; c.registered = true; });
    await settle(rig, instanceId);
    expect(await instRow()).toMatchObject({ status: 'PAIRING' });

    const before = rig.fake.sockets.length;
    sock().close(515); // Baileys: restart required after successful pairing
    await waitFor(() => rig.fake.sockets.length > before, 3000, 'reconnect socket');
    // The new socket got the decrypted, persisted creds (me.id written by the previous socket).
    expect(sock().config.auth.creds.me?.id).toBe(`${OWNER_PHONE}:7@s.whatsapp.net`);
    sock().open(OWNER_PHONE);
    await settle(rig, instanceId);
    const row = await instRow();
    expect(row).toMatchObject({ status: 'CONNECTED', connection_state: 'OPEN', phone_e164: `+${OWNER_PHONE}`, whatsapp_jid: `${OWNER_PHONE}@s.whatsapp.net` });
    expect(row.linked_at).not.toBeNull();
    expect(await eventsOf()).toEqual(expect.arrayContaining(['QR_GENERATED', 'PAIRING_STARTED', 'RESTARTED', 'CONNECTED']));
    const outbox = await h.owner.query(`SELECT event_type FROM app.outbox_events WHERE aggregate_id = $1 AND event_type LIKE 'INSTANCE_%'`, [instanceId]);
    expect(outbox.rows.map((r) => r.event_type)).toEqual(expect.arrayContaining(['INSTANCE_CONNECTED', 'INSTANCE_STATUS_CHANGED']));
    expect(await api.instances.getQr(asUser(T), instanceId).catch((e) => e.code)).toBe('WHATSAPP_QR_NOT_AVAILABLE');
    expect(await api.instances.command(asUser(T), instanceId, 'CONNECT').catch((e) => e.code)).toBe('WHATSAPP_INSTANCE_ALREADY_CONNECTED');
  });
});

describe('incoming message pipeline', () => {
  it('inbound text: contact + conversation + message + usage + outbox, in one transaction', async () => {
    const m = waText(CUSTOMER, 'hello gateway');
    sock().upsert([m]);
    await settle(rig, instanceId);
    const row = (await h.owner.query(
      `SELECT m.direction, m.status, m.text_body, m.origin, c.phone_e164, c.profile_name, cv.unread_count
         FROM app.messages m JOIN app.contacts c ON c.id = m.contact_id JOIN app.conversations cv ON cv.id = m.conversation_id
        WHERE m.whatsapp_instance_id = $1 AND m.provider_message_id = $2`, [instanceId, m.key.id])).rows[0];
    expect(row).toEqual({ direction: 'INBOUND', status: 'RECEIVED', text_body: 'hello gateway', origin: 'CONTACT',
                          phone_e164: `+${CUSTOMER}`, profile_name: 'Rahul', unread_count: 1 });
    const ob = await h.owner.query(`SELECT count(*)::int AS n FROM app.outbox_events o JOIN app.messages m ON m.id = o.aggregate_id
                                     WHERE m.provider_message_id = $1 AND o.event_type = 'MESSAGE_RECEIVED'`, [m.key.id]);
    expect(ob.rows[0].n).toBe(1);
    // message content is not logged by default
    expect(rig.logs.join('\n')).not.toContain('hello gateway');
  });

  it('duplicate delivery of the same event is idempotent (no second row/outbox/usage/unread)', async () => {
    const m = waText(CUSTOMER, 'dup check');
    sock().upsert([m]);
    sock().upsert([m]);
    sock().upsert([m], 'append');
    await settle(rig, instanceId);
    const n = await h.owner.query(
      `SELECT (SELECT count(*)::int FROM app.messages WHERE provider_message_id = $1) AS msgs,
              (SELECT count(*)::int FROM app.outbox_events o JOIN app.messages m ON m.id = o.aggregate_id WHERE m.provider_message_id = $1) AS events,
              (SELECT count(*)::int FROM app.usage_events u JOIN app.messages m ON m.id = u.resource_id WHERE m.provider_message_id = $1) AS usage`, [m.key.id]);
    expect(n.rows[0]).toEqual({ msgs: 1, events: 1, usage: 1 });
    const unread = await h.owner.query(`SELECT unread_count FROM app.conversations WHERE whatsapp_instance_id = $1 AND status <> 'CLOSED'`, [instanceId]);
    expect(unread.rows[0].unread_count).toBe(2);
  });

  it('fromMe message typed on the owner\'s phone: stored OUTBOUND/LINKED_DEVICE, never sent again', async () => {
    const sendsBefore = sock().sent.length;
    const m = waText(OWNER_PHONE, 'I will call you back', { fromMe: true, toDigits: CUSTOMER });
    sock().upsert([m], 'append');
    await settle(rig, instanceId);
    const row = (await h.owner.query(`SELECT id, direction, status, from_me, origin, sender_jid, recipient_jid FROM app.messages WHERE provider_message_id = $1`, [m.key.id])).rows[0];
    expect(row).toMatchObject({ direction: 'OUTBOUND', status: 'SENT', from_me: true, origin: 'LINKED_DEVICE',
                                sender_jid: `${OWNER_PHONE}@s.whatsapp.net`, recipient_jid: `${CUSTOMER}@s.whatsapp.net` });
    const jobs = await h.owner.query(`SELECT event_type FROM app.outbox_events WHERE aggregate_id = $1`, [row.id]);
    expect(jobs.rows.map((r) => r.event_type)).toEqual(['MESSAGE_SENT']); // webhook yes, send job NO
    await drainRouted(rig);
    expect(sock().sent.length).toBe(sendsBefore);
  });

  it('reaction, revoke, unsupported type, group policy', async () => {
    const target = waText(CUSTOMER, 'please confirm');
    sock().upsert([target]);
    sock().upsert([{ key: { remoteJid: `${CUSTOMER}@s.whatsapp.net`, fromMe: false, id: 'REACT1' }, messageTimestamp: Math.floor(Date.now() / 1000),
                     message: { reactionMessage: { text: '👍', key: { id: target.key.id } } } }]);
    sock().upsert([{ key: { remoteJid: `${CUSTOMER}@s.whatsapp.net`, fromMe: false, id: 'WEIRD1' }, messageTimestamp: Math.floor(Date.now() / 1000),
                     message: { buttonsResponseMessage: { selectedButtonId: 'b1' } } as proto.IMessage }]);
    sock().upsert([{ key: { remoteJid: '120363000000000001@g.us', participant: `${CUSTOMER}@s.whatsapp.net`, fromMe: false, id: 'GROUP1' },
                     messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: 'group chatter' } }]);
    sock().upsert([{ key: { remoteJid: `${CUSTOMER}@s.whatsapp.net`, fromMe: false, id: 'REVOKER' }, messageTimestamp: Math.floor(Date.now() / 1000),
                     message: { protocolMessage: { type: proto.Message.ProtocolMessage.Type.REVOKE, key: { id: target.key.id } } } }]);
    await settle(rig, instanceId);

    const byId = async (id: string) => (await h.owner.query(
      `SELECT m.message_type, m.status, m.text_body, t.provider_message_id AS target FROM app.messages m
         LEFT JOIN app.messages t ON t.id = m.reply_to_message_id WHERE m.provider_message_id = $1`, [id])).rows[0];
    expect(await byId('REACT1')).toMatchObject({ message_type: 'REACTION', text_body: '👍', target: target.key.id });
    expect(await byId('WEIRD1')).toMatchObject({ message_type: 'UNKNOWN' });
    expect(await byId(target.key.id!)).toMatchObject({ status: 'REVOKED' });
    expect(await byId('GROUP1')).toBeUndefined();
    expect(await byId('REVOKER')).toBeUndefined();
    expect((await h.owner.query(`SELECT count(*)::int AS n FROM app.contacts WHERE whatsapp_jid LIKE '%@g.us'`)).rows[0].n).toBe(0);
    const types = (await h.owner.query(`SELECT o.event_type FROM app.outbox_events o JOIN app.messages m ON m.id = o.aggregate_id
                                         WHERE m.provider_message_id IN ($1, 'REACT1') ORDER BY o.created_at`, [target.key.id])).rows.map((r) => r.event_type);
    expect(types).toEqual(expect.arrayContaining(['MESSAGE_RECEIVED', 'MESSAGE_REACTION', 'MESSAGE_REVOKED']));
  });

  it('incoming media: metadata row immediately, bytes stored privately with sha256; download failure never loses the message', async () => {
    const img = { key: { remoteJid: `${CUSTOMER}@s.whatsapp.net`, fromMe: false, id: 'IMG1' }, messageTimestamp: Math.floor(Date.now() / 1000),
                  message: { imageMessage: { mimetype: 'image/jpeg', caption: 'my x-ray', fileLength: 15 } } };
    sock().upsert([img]);
    await settle(rig, instanceId);
    const att = await waitFor(async () => (await h.owner.query(
      `SELECT a.status, a.storage_provider, a.storage_key, a.file_size, encode(a.sha256, 'hex') AS sha FROM app.message_attachments a
         JOIN app.messages m ON m.id = a.message_id WHERE m.provider_message_id = 'IMG1' AND a.status = 'STORED'`)).rows[0], 3000, 'media stored');
    expect(att).toMatchObject({ storage_provider: 'LOCAL_DEV', file_size: rig.downloads.bytes.length });
    expect(att.storage_key).toMatch(/^org\/[0-9a-f-]{36}\/msg\//);
    expect((await rig.media.get(att.storage_key)).equals(rig.downloads.bytes)).toBe(true);

    rig.downloads.fail = true;
    sock().upsert([{ ...img, key: { ...img.key, id: 'IMG2' } }]);
    await settle(rig, instanceId);
    const failed = await waitFor(async () => (await h.owner.query(
      `SELECT a.status, m.text_body FROM app.message_attachments a JOIN app.messages m ON m.id = a.message_id WHERE m.provider_message_id = 'IMG2' AND a.status = 'FAILED'`)).rows[0], 3000, 'media failed');
    expect(failed).toEqual({ status: 'FAILED', text_body: 'my x-ray' });
    rig.downloads.fail = false;
  });
});

describe('outgoing pipeline, loop prevention and acknowledgements', () => {
  it('API send -> QUEUED -> worker sends with a PRE-ASSIGNED id -> SENT; the provider echo is NOT re-sent or duplicated', async () => {
    const q = await api.messages.sendText(asUser(T), { instanceId, to: `+${CUSTOMER}`, text: 'hello from gateway', idempotencyKey: 'smoke-1' });
    expect(q).toMatchObject({ status: 'QUEUED', duplicate: false });
    const again = await api.messages.sendText(asUser(T), { instanceId, to: `+${CUSTOMER}`, text: 'hello from gateway', idempotencyKey: 'smoke-1' });
    expect(again).toMatchObject({ messageId: q.messageId, duplicate: true });

    await drainRouted(rig);
    expect(sock().sent.filter((s) => s.content.text === 'hello from gateway')).toHaveLength(1);
    const sent = sock().sent[sock().sent.length - 1];
    const row = (await h.owner.query('SELECT status, provider_message_id, origin FROM app.messages WHERE id = $1', [q.messageId])).rows[0];
    expect(row).toEqual({ status: 'SENT', provider_message_id: sent.messageId, origin: 'DASHBOARD' });

    // Baileys later emits our own message back (fromMe echo).
    sock().upsert([{ key: { remoteJid: `${CUSTOMER}@s.whatsapp.net`, fromMe: true, id: sent.messageId }, messageTimestamp: Math.floor(Date.now() / 1000),
                     message: { conversation: 'hello from gateway' } }], 'append');
    await settle(rig, instanceId);
    await drainRouted(rig);
    expect(sock().sent.filter((s) => s.content.text === 'hello from gateway')).toHaveLength(1); // no loop
    const count = await h.owner.query('SELECT count(*)::int AS n FROM app.messages WHERE provider_message_id = $1', [sent.messageId]);
    expect(count.rows[0].n).toBe(1);
    const usage = await h.owner.query(`SELECT count(*)::int AS n FROM app.usage_events WHERE resource_id = $1 AND event_type = 'WHATSAPP_MESSAGE_OUT'`, [q.messageId]);
    expect(usage.rows[0].n).toBe(1);

    // Delivery / read acknowledgements.
    sock().update([{ key: { remoteJid: `${CUSTOMER}@s.whatsapp.net`, fromMe: true, id: sent.messageId }, update: { status: proto.WebMessageInfo.Status.DELIVERY_ACK } }]);
    await settle(rig, instanceId);
    expect((await h.owner.query('SELECT status FROM app.messages WHERE id = $1', [q.messageId])).rows[0].status).toBe('DELIVERED');
    sock().update([{ key: { remoteJid: `${CUSTOMER}@s.whatsapp.net`, fromMe: true, id: sent.messageId }, update: { status: proto.WebMessageInfo.Status.READ } }]);
    sock().update([{ key: { remoteJid: `${CUSTOMER}@s.whatsapp.net`, fromMe: true, id: sent.messageId }, update: { status: 99 } }]); // unknown: ignored
    await settle(rig, instanceId);
    const st = await h.owner.query('SELECT status FROM app.message_status_events WHERE message_id = $1 ORDER BY status', [q.messageId]);
    expect(st.rows.map((r) => r.status)).toEqual(['DELIVERED', 'READ', 'SENT']);
    expect((await h.owner.query('SELECT status FROM app.messages WHERE id = $1', [q.messageId])).rows[0].status).toBe('READ');
  });

  it('image and document sends go through private storage and the provider abstraction', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000', 'hex');
    const img = await api.messages.sendMedia(asUser(T), 'IMAGE', { instanceId, to: `+${CUSTOMER}`, dataBase64: png.toString('base64'), mimeType: 'image/png', caption: 'your report' });
    const doc = await api.messages.sendMedia(asUser(T), 'DOCUMENT', { instanceId, to: `+${CUSTOMER}`, dataBase64: Buffer.from('%PDF-1.4').toString('base64'), mimeType: 'application/pdf', fileName: 'invoice.pdf' });
    await drainRouted(rig);
    const imgSent = sock().sent.find((s) => s.content.caption === 'your report');
    expect(Buffer.isBuffer(imgSent?.content.image) && (imgSent!.content.image as Buffer).equals(png)).toBe(true);
    expect(sock().sent.find((s) => s.content.fileName === 'invoice.pdf')?.content.mimetype).toBe('application/pdf');
    const st = await h.owner.query('SELECT status FROM app.messages WHERE id = ANY($1::uuid[])', [[img.messageId, doc.messageId]]);
    expect(st.rows.every((r) => r.status === 'SENT')).toBe(true);
    await expect(api.messages.sendMedia(asUser(T), 'IMAGE', { instanceId, to: `+${CUSTOMER}`, dataBase64: 'AAAA', mimeType: 'application/x-msdownload' }))
      .rejects.toMatchObject({ code: 'WHATSAPP_UNSUPPORTED_MESSAGE' });
  });

  it('transient provider send failures are retried; the message is sent exactly once', async () => {
    sock().failSends = 1;
    const q = await api.messages.sendText(asUser(T), { instanceId, to: `+${CUSTOMER}`, text: 'retry me' });
    await rig.worker.processRoutedOnce(); // attempt 1 fails -> outbox FAILED with backoff
    expect((await h.owner.query('SELECT status FROM app.messages WHERE id = $1', [q.messageId])).rows[0].status).toBe('QUEUED');
    await h.owner.query(`UPDATE app.outbox_events SET available_at = now() WHERE aggregate_id = $1`, [q.messageId]);
    await drainRouted(rig);
    expect((await h.owner.query('SELECT status FROM app.messages WHERE id = $1', [q.messageId])).rows[0].status).toBe('SENT');
    expect(sock().sent.filter((s) => s.content.text === 'retry me')).toHaveLength(1);
  });
});

describe('webhooks from WhatsApp events', () => {
  it('MESSAGE_RECEIVED is delivered with the normalised schema and a verifiable signature', async () => {
    await h.owner.query(`UPDATE app.outbox_events SET status = 'PROCESSED', processed_at = now() WHERE status <> 'PROCESSED' AND target_instance_id IS NULL`);
    // Endpoint management is an API (hs_app) operation; hs_worker cannot create endpoints.
    const ep = await h.services.webhooksApp.createEndpoint(asUser(T), { name: 'crm', url: 'https://hooks.example.test/wa', eventTypes: ['MESSAGE_RECEIVED', 'INSTANCE_STATUS_CHANGED'] });
    const m = waText(CUSTOMER, 'webhook me');
    sock().upsert([m]);
    await settle(rig, instanceId);
    await rig.worker.relay.relayBatch('test-relay', 100);
    await rig.worker.webhooks.dispatchBatch('test-dispatch', rig.http, 50);
    const call = rig.http.calls.find((c) => JSON.parse(c.body).message?.providerMessageId === m.key.id)!;
    expect(call).toBeDefined();
    const body = JSON.parse(call.body);
    expect(body).toMatchObject({ type: 'MESSAGE_RECEIVED', organizationId: T.orgId, businessId: T.businessId,
      instance: { id: instanceId, phone: `+${OWNER_PHONE}` },
      message: { direction: 'INBOUND', from: `+${CUSTOMER}`, type: 'TEXT', text: 'webhook me', providerMessageId: m.key.id } });
    expect(body.id).toBe(call.headers['x-webhook-id']);
    const expected = createHmac('sha256', ep.secret).update(`${call.headers['x-webhook-id']}.${call.headers['x-webhook-timestamp']}.${call.body}`).digest('hex');
    expect(call.headers['x-webhook-signature']).toBe(`v1=${expected}`);
    for (const forbidden of ['encrypted', 'key_hash', 'wrapped', 'noiseKey', 'raw_metadata', 'remoteJid', 'protocol']) expect(call.body).not.toContain(forbidden);
  });
});

describe('reconnect, disconnect, restart, logout', () => {
  it('temporary disconnect: CONNECTED -> RECONNECTING -> CONNECTED without a new QR', async () => {
    const before = rig.fake.sockets.length;
    const qrBefore = rig.events.filter((e) => e.type === 'whatsapp.instance.qr').length;
    sock().close(428);
    await waitFor(async () => (await instRow()).status === 'RECONNECTING', 3000, 'RECONNECTING');
    await waitFor(() => rig.fake.sockets.length > before, 3000, 'backoff reconnect');
    sock().open(OWNER_PHONE);
    await settle(rig, instanceId);
    expect(await instRow()).toMatchObject({ status: 'CONNECTED', reconnect_attempts: 0 });
    expect(rig.events.filter((e) => e.type === 'whatsapp.instance.qr').length).toBe(qrBefore);
    expect(await eventsOf()).toContain('RECONNECTING');
  });

  it('user DISCONNECT closes the socket but keeps the linked device; RESTART restores it without a QR', async () => {
    await api.instances.command(asUser(T), instanceId, 'DISCONNECT');
    await drainRouted(rig);
    expect(await instRow()).toMatchObject({ status: 'DISCONNECTED', worker_id: null, disconnect_reason: 'USER_DISCONNECT' });
    expect(await credsCount()).toBe(1);
    expect(sock().logoutCalls).toBe(0);

    const before = rig.fake.sockets.length;
    await api.instances.command(asUser(T), instanceId, 'RESTART');
    await drainRouted(rig);
    expect(rig.fake.sockets.length).toBe(before + 1);
    expect(sock().config.auth.creds.me?.id).toBe(`${OWNER_PHONE}:7@s.whatsapp.net`);
    sock().open(OWNER_PHONE);
    await settle(rig, instanceId);
    expect(await instRow()).toMatchObject({ status: 'CONNECTED' });
  });

  it('logged out from the phone (401): LOGGED_OUT, credentials destroyed, no reconnect loop', async () => {
    const before = rig.fake.sockets.length;
    sock().close(401);
    await waitFor(async () => (await instRow()).status === 'LOGGED_OUT', 3000, 'LOGGED_OUT');
    expect(await credsCount()).toBe(0);
    expect((await h.owner.query('SELECT count(*)::int AS n FROM app.whatsapp_signal_keys WHERE instance_id = $1', [instanceId])).rows[0].n).toBe(0);
    await new Promise((r) => setTimeout(r, 100));
    expect(rig.fake.sockets.length).toBe(before);
    expect(rig.worker.manager.getSession(instanceId)).toBeUndefined();
  });

  it('after logout a new CONNECT requires a fresh QR (new credentials)', async () => {
    await api.instances.command(asUser(T), instanceId, 'CONNECT');
    await drainRouted(rig);
    expect(sock().config.auth.creds.me).toBeUndefined();
    sock().qr();
    await settle(rig, instanceId);
    expect(await instRow()).toMatchObject({ status: 'WAITING_FOR_QR' });
    sock().mutateCreds((c) => { c.me = { id: `${OWNER_PHONE}:8@s.whatsapp.net` }; c.registered = true; });
    sock().open(OWNER_PHONE);
    await settle(rig, instanceId);
    expect(await instRow()).toMatchObject({ status: 'CONNECTED' });
  });

  it('explicit LOGOUT unlinks via the provider and destroys stored auth', async () => {
    const s = sock();
    await api.instances.command(asUser(T), instanceId, 'LOGOUT');
    await drainRouted(rig);
    expect(s.logoutCalls).toBe(1);
    expect(await credsCount()).toBe(0);
    expect(await instRow()).toMatchObject({ status: 'LOGGED_OUT', worker_id: null });
  });
});

describe('logging hygiene', () => {
  it('no QR, credentials, key material or message bodies in any log line', () => {
    const all = rig.logs.join('\n');
    for (const needle of ['FAKE-QR', 'noiseKey', 'signedIdentityKey', 'advSecretKey', 'hello gateway', 'webhook me', 'whsec_', 'private']) {
      expect(all.includes(needle), needle).toBe(false);
    }
    expect(all).toContain('whatsapp.message_stored'); // structured events are there
    expect(all).toContain('"instance_id"');
  });
});
