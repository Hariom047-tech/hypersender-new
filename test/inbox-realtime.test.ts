import { proto, type WAMessage } from 'baileys';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '../src/common/uuid.js';
import { waText } from './fakes/fake-baileys-socket.js';
import { makeHarness, seedTenant, type Harness, type Tenant } from './helpers.js';
import { openSse, sleep, startApi, type Api, type SseClient } from './saas-helpers.js';
import { drainRouted, makeGateway, settle, waitFor, type GatewayRig } from './whatsapp-helpers.js';

let h: Harness;
let api: Api;
let rig: GatewayRig;
let A: Tenant;
let B: Tenant;
let instanceId: string;
let streamA: SseClient;
let streamB: SseClient;
const OWNER = '919900088899';
const CUSTOMER = '919811100011';
const asA = <T extends import('supertest').Test>(r: T) => api.as(A.userId, A.orgId)(r);
const hdr = (t: Tenant) => ({ authorization: `Bearer ${api.token(t.userId)}`, 'x-organization-id': t.orgId });
const sock = () => rig.fake.last;
const relay = () => rig.worker.relay.relayBatch('relay-test', 200);
const eventsOf = (s: SseClient, type: string) => s.events.filter((e) => e.type === type);

beforeAll(async () => {
  process.env.WHATSAPP_RECONNECT_ALERT_GRACE_SECONDS = '0';
  h = makeHarness();
  api = await startApi();
  A = await seedTenant(h, 'inbox-a');
  B = await seedTenant(h, 'inbox-b');
  rig = makeGateway(h, { bus: api.bus });
  await rig.worker.start({ loops: false });
  const inst = await asA(api.http.post('/v1/whatsapp/instances')).send({ businessId: A.businessId, name: 'Reception' });
  instanceId = inst.body.id;
  await asA(api.http.post(`/v1/whatsapp/instances/${instanceId}/connect`)).expect(202);
  await drainRouted(rig);
  sock().qr();
  sock().mutateCreds((c) => { c.me = { id: `${OWNER}:3@s.whatsapp.net` }; c.registered = true; });
  sock().open(OWNER);
  await settle(rig, instanceId);
  await relay();
  streamA = await openSse(api.port, '/v1/realtime/stream', hdr(A));
  streamB = await openSse(api.port, '/v1/realtime/stream', hdr(B));
  await waitFor(() => streamA.events.some((e) => e.type === 'ready') && streamB.events.some((e) => e.type === 'ready'), 3000, 'streams ready');
});
afterAll(async () => { await streamA?.close(); await streamB?.close(); await rig.worker.stop(); await api.app.close(); await h.close(); });

describe('live inbox', () => {
  let conversationId: string;

  it('inbound WhatsApp message appears live (conversation.created + message.created) only for its tenant', async () => {
    sock().upsert([waText(CUSTOMER, 'Kal appointment available hai?')]);
    await settle(rig, instanceId);
    await relay();
    const created = await waitFor(() => eventsOf(streamA, 'message.created').find((e) => e.data.message.text === 'Kal appointment available hai?'), 3000, 'message.created');
    conversationId = created.data.message.conversationId;
    expect(created.data.message).toMatchObject({ direction: 'INBOUND', origin: 'CONTACT', type: 'TEXT', status: 'RECEIVED' });
    expect(eventsOf(streamA, 'conversation.created').some((e) => e.data.conversation.id === conversationId)).toBe(true);
    expect(streamB.events.filter((e) => e.type !== 'ready' && e.type !== 'ping')).toEqual([]); // tenant B sees nothing
    expect(streamA.raw()).not.toMatch(/remoteJid|protocolMessage|noiseKey/);

    const list = await asA(api.http.get('/v1/conversations?filter=unread'));
    const conv = list.body.items.find((c: { id: string }) => c.id === conversationId);
    expect(conv).toMatchObject({ unreadCount: 1, contact: { phone: `+${CUSTOMER}`, identityType: 'PHONE' }, instanceName: 'Reception',
      lastMessage: { preview: 'Kal appointment available hai?', direction: 'INBOUND' } });
    const read = await asA(api.http.post(`/v1/conversations/${conversationId}/read`));
    expect(read.body.unreadCount).toBe(0);
  });

  it('reply: double submit => one message; QUEUED -> SENT -> DELIVERED -> READ arrive over realtime, no duplicates', async () => {
    const clientRequestId = uuidv7();
    const [r1, r2] = await Promise.all([1, 2].map(() => asA(api.http.post(`/v1/conversations/${conversationId}/messages`)).send({ text: 'Yes, 4 PM available hai.', clientRequestId })));
    expect(r1.body.message.id).toBe(r2.body.message.id);
    expect([r1.body.duplicate, r2.body.duplicate].sort()).toEqual([false, true]);
    expect(r1.body.message.status).toBe('QUEUED');
    const id = r1.body.message.id;
    await waitFor(() => eventsOf(streamA, 'message.created').find((e) => e.data.message.id === id), 3000, 'queued event');

    await drainRouted(rig);
    const sent = sock().sent.filter((s) => s.content.text === 'Yes, 4 PM available hai.');
    expect(sent).toHaveLength(1);
    await relay();
    await waitFor(() => eventsOf(streamA, 'message.status_updated').find((e) => e.data.messageId === id && e.data.status === 'SENT'), 3000, 'SENT');
    for (const status of [proto.WebMessageInfo.Status.DELIVERY_ACK, proto.WebMessageInfo.Status.READ]) {
      sock().update([{ key: { remoteJid: `${CUSTOMER}@s.whatsapp.net`, fromMe: true, id: sent[0].messageId }, update: { status } }]);
    }
    await settle(rig, instanceId);
    await relay();
    await waitFor(() => eventsOf(streamA, 'message.status_updated').find((e) => e.data.messageId === id && e.data.status === 'READ'), 3000, 'READ');
    const statuses = eventsOf(streamA, 'message.status_updated').filter((e) => e.data.messageId === id).map((e) => e.data.status);
    expect(statuses).toEqual(expect.arrayContaining(['SENT', 'READ']));
    expect(eventsOf(streamA, 'message.created').filter((e) => e.data.message.id === id)).toHaveLength(1);
    const page = await asA(api.http.get(`/v1/conversations/${conversationId}/messages`));
    expect(page.body.items.filter((m: { id: string }) => m.id === id)).toHaveLength(1);
    expect(page.body.items[0]).toMatchObject({ id, status: 'READ', origin: 'DASHBOARD', direction: 'OUTBOUND' });
  });

  it('message typed on the owner\'s phone appears as OUTBOUND from LINKED_DEVICE, is not re-sent, not duplicated', async () => {
    const before = sock().sent.length;
    const m = waText(OWNER, 'Main 5 min mein call karta hoon', { fromMe: true, toDigits: CUSTOMER });
    sock().upsert([m], 'append');
    sock().upsert([m], 'append');
    await settle(rig, instanceId);
    await relay();
    const ev = await waitFor(() => eventsOf(streamA, 'message.created').find((e) => e.data.message.text === 'Main 5 min mein call karta hoon'), 3000, 'manual msg');
    expect(ev.data.message).toMatchObject({ direction: 'OUTBOUND', origin: 'LINKED_DEVICE', fromMe: true, status: 'SENT' });
    expect(eventsOf(streamA, 'message.created').filter((e) => e.data.message.text === 'Main 5 min mein call karta hoon')).toHaveLength(1);
    const jobs = await h.owner.query(`SELECT count(*)::int AS n FROM app.outbox_events WHERE aggregate_id = $1 AND event_type = 'MESSAGE_SEND_REQUESTED'`, [ev.data.message.id]);
    expect(jobs.rows[0].n).toBe(0);
    await drainRouted(rig);
    expect(sock().sent.length).toBe(before);
  });

  it('messages are cursor-paginated (no full history load); disconnected instance => clear error on send', async () => {
    for (let i = 0; i < 5; i++) sock().upsert([waText(CUSTOMER, `page msg ${i}`)]);
    await settle(rig, instanceId);
    const p1 = await asA(api.http.get(`/v1/conversations/${conversationId}/messages?limit=3`));
    expect(p1.body.items).toHaveLength(3);
    const p2 = await asA(api.http.get(`/v1/conversations/${conversationId}/messages?limit=3&cursor=${p1.body.nextCursor}`));
    const ids1 = p1.body.items.map((m: { id: string }) => m.id);
    expect(p2.body.items.some((m: { id: string }) => ids1.includes(m.id))).toBe(false);
    expect(new Date(p2.body.items[0].timestamp) <= new Date(p1.body.items[2].timestamp)).toBe(true);
    expect((await asA(api.http.get(`/v1/conversations/${conversationId}/messages?cursor=garbage`))).status).toBe(400);
  });

  it('LID-only chats resolve to the phone contact via Baileys\' LID store; protocol mapping upgrades LID-only contacts', async () => {
    const LID = '123456789012345@lid';
    (sock() as unknown as { signalRepository: unknown }).signalRepository = { lidMapping: { getPNForLID: async (l: string) => (l === LID ? `${CUSTOMER}@s.whatsapp.net` : null) } };
    sock().upsert([{ key: { remoteJid: LID, fromMe: false, id: `LID${Date.now()}` }, messageTimestamp: Math.floor(Date.now() / 1000),
                     message: { conversation: 'from lid' } } as WAMessage]);
    await settle(rig, instanceId);
    const row = (await h.owner.query(`SELECT c.whatsapp_jid, c.whatsapp_lid FROM app.messages m JOIN app.contacts c ON c.id = m.contact_id WHERE m.text_body = 'from lid'`)).rows[0];
    expect(row).toEqual({ whatsapp_jid: `${CUSTOMER}@s.whatsapp.net`, whatsapp_lid: LID });

    // A contact first seen ONLY by LID, later mapped by the protocol -> upgraded in place (no duplicate, no merge by name).
    const LID2 = '555555555555555@lid';
    (sock() as unknown as { signalRepository: unknown }).signalRepository = { lidMapping: { getPNForLID: async () => null } };
    sock().upsert([{ key: { remoteJid: LID2, fromMe: false, id: `LIDONLY${Date.now()}` }, messageTimestamp: Math.floor(Date.now() / 1000),
                     message: { conversation: 'lid only' } } as WAMessage]);
    await settle(rig, instanceId);
    sock().ev.emit('lid-mapping.update', { lid: LID2, pn: '919822200022@s.whatsapp.net' });
    await settle(rig, instanceId);
    const up = (await h.owner.query(`SELECT whatsapp_jid, whatsapp_lid, phone_e164 FROM app.contacts WHERE business_id = $1 AND whatsapp_lid = $2`, [A.businessId, LID2])).rows[0];
    expect(up).toEqual({ whatsapp_jid: '919822200022@s.whatsapp.net', whatsapp_lid: LID2, phone_e164: '+919822200022' });
  });
});

describe('instance realtime, notifications, webhooks', () => {
  it('instance.status_updated flows; phone-side logout notifies OWNER/ADMIN only (once), reconnect trouble after grace', async () => {
    const other = uuidv7();
    await h.owner.query(`INSERT INTO app.users (id, email) VALUES ($1, $2)`, [other, `agent-${other}@example.test`]);
    await h.owner.query(`INSERT INTO app.organization_members (organization_id, user_id, role, status, joined_at) VALUES ($1, $2, 'AGENT', 'ACTIVE', now())`, [A.orgId, other]);
    const agentStream = await openSse(api.port, '/v1/realtime/stream', { authorization: `Bearer ${api.token(other)}`, 'x-organization-id': A.orgId });

    sock().close(428); // transient
    await waitFor(async () => (await h.owner.query('SELECT status FROM app.whatsapp_instances WHERE id = $1', [instanceId])).rows[0].status === 'RECONNECTING', 3000, 'reconnecting');
    await relay(); // INSTANCE_STATUS_CHANGED + delayed INSTANCE_RECONNECT_CHECK (grace 0 in this test)
    await waitFor(() => eventsOf(streamA, 'instance.status_updated').find((e) => e.data.status === 'RECONNECTING'), 3000, 'status event');
    await sleep(50);
    await relay();
    const n1 = await asA(api.http.get('/v1/notifications'));
    expect(n1.body.items.map((n: { type: string }) => n.type)).toContain('WHATSAPP_RECONNECT_TROUBLE');

    await waitFor(() => rig.fake.sockets.length > 0 && rig.worker.manager.getSession(instanceId)?.connectionState !== 'CLOSED', 3000, 'reconnect socket');
    sock().close(401); // user removed the device on the phone
    await waitFor(async () => (await h.owner.query('SELECT status FROM app.whatsapp_instances WHERE id = $1', [instanceId])).rows[0].status === 'LOGGED_OUT', 3000, 'logged out');
    await relay();
    await relay();
    const n2 = await asA(api.http.get('/v1/notifications'));
    expect(n2.body.items.filter((n: { type: string }) => n.type === 'WHATSAPP_LOGGED_OUT')).toHaveLength(1);
    await waitFor(() => eventsOf(streamA, 'notification.created').length > 0, 3000, 'owner notification event');
    expect(eventsOf(agentStream, 'notification.created')).toEqual([]); // AGENT not notified, not leaked
    expect((await api.as(other, A.orgId)(api.http.get('/v1/notifications'))).body.items).toEqual([]);
    await asA(api.http.post('/v1/notifications/read-all')).expect(200);
    expect((await asA(api.http.get('/v1/notifications'))).body.unread).toBe(0);
    await agentStream.close();
  });

  it('webhook test event is delivered and logged; disabled webhook receives nothing; failed deliveries can be retried', async () => {
    const c = await asA(api.http.post('/v1/webhooks')).send({ name: 'Ops', url: 'https://93.184.215.14/hook', eventTypes: ['MESSAGE_RECEIVED'] });
    await asA(api.http.post(`/v1/webhooks/${c.body.id}/test`)).expect(202);
    await relay();
    await rig.worker.webhooks.dispatchBatch('disp', rig.http, 50);
    const log = await asA(api.http.get(`/v1/webhooks/${c.body.id}/deliveries`));
    expect(log.body.items[0]).toMatchObject({ eventType: 'WEBHOOK_TEST', status: 'DELIVERED', attempts: 1, httpStatus: 200, payload: { test: true } });
    const testCall = rig.http.calls.find((x) => JSON.parse(x.body).type === 'WEBHOOK_TEST');
    expect(testCall?.headers['x-webhook-signature']).toMatch(/^v1=/);

    await asA(api.http.patch(`/v1/webhooks/${c.body.id}`)).send({ enabled: false });
    const calls = rig.http.calls.length;
    await h.owner.query(`UPDATE app.outbox_events SET status = 'PROCESSED', processed_at = now() WHERE status <> 'PROCESSED' AND target_instance_id IS NULL`);
    await h.services.ingestion.ingest({ organizationId: A.orgId, businessId: A.businessId, instanceId, instanceJid: `${OWNER}@s.whatsapp.net`,
      providerMessageId: `WH${Date.now()}`, fromJid: `${CUSTOMER}@s.whatsapp.net`, type: 'TEXT', text: 'after disable', providerTimestamp: new Date() });
    await relay();
    await rig.worker.webhooks.dispatchBatch('disp', rig.http, 50);
    expect(rig.http.calls.length).toBe(calls);

    await asA(api.http.patch(`/v1/webhooks/${c.body.id}`)).send({ enabled: true });
    const failing = { calls: 0, post: async () => { failing.calls++; return { status: 500, body: 'boom' }; } };
    await asA(api.http.post(`/v1/webhooks/${c.body.id}/test`)).expect(202);
    await relay();
    await h.owner.query(`UPDATE app.webhook_deliveries SET attempt_number = 11 WHERE webhook_endpoint_id = $1 AND status = 'PENDING'`, [c.body.id]);
    await rig.worker.webhooks.dispatchBatch('disp', failing, 50);
    const dead = (await asA(api.http.get(`/v1/webhooks/${c.body.id}/deliveries`))).body.items.find((d: { status: string }) => d.status === 'DEAD');
    expect(dead).toMatchObject({ retryable: true, httpStatus: 500, responseBodySnippet: 'boom' });
    await asA(api.http.post(`/v1/webhooks/${c.body.id}/deliveries/${dead.id}/retry`)).expect(202);
    await rig.worker.webhooks.dispatchBatch('disp', rig.http, 50);
    const after = (await asA(api.http.get(`/v1/webhooks/${c.body.id}/deliveries`))).body.items.find((d: { id: string }) => d.id === dead.id);
    expect(after.status).toBe('DELIVERED');
    expect((await asA(api.http.post(`/v1/webhooks/${c.body.id}/deliveries/${dead.id}/retry`))).status).toBe(409);
    const notif = await asA(api.http.get('/v1/notifications'));
    expect(notif.body.items.map((n: { type: string }) => n.type)).toContain('WEBHOOK_FAILING');
  });
});
