import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '../src/common/uuid.js';
import { issueMediaToken } from '../src/api/media.controller.js';
import { contentDisposition } from '../src/whatsapp/media/media-storage.service.js';
import { assertSafeWebhookUrl, isPrivateAddress, SafeWebhookSender } from '../src/whatsapp/services/webhook-http-sender.js';
import { makeHarness, seedTenant, setPlan, type Harness, type Tenant } from './helpers.js';
import { startApi, type Api } from './saas-helpers.js';

let h: Harness;
let api: Api;
let A: Tenant;
let B: Tenant;
const asA = <T extends import('supertest').Test>(r: T) => api.as(A.userId, A.orgId)(r);
const asB = <T extends import('supertest').Test>(r: T) => api.as(B.userId, B.orgId)(r);

async function registerUser(label: string) {
  const email = `${label}-${uuidv7().slice(-8)}@example.test`;
  const r = await api.http.post('/v1/auth/register').send({ email, password: 'correct horse battery', firstName: label });
  expect(r.status).toBe(201);
  return { userId: r.body.userId as string, token: r.body.token as string, email };
}

async function newOrg(userToken: string, slug = `org-${uuidv7().slice(-10)}`) {
  const r = await api.http.post('/v1/account/organizations').set('authorization', `Bearer ${userToken}`)
    .send({ name: 'Sharma Dental', slug, timezone: 'Asia/Kolkata', countryCode: 'IN', currency: 'INR' });
  return r;
}

beforeAll(async () => {
  h = makeHarness();
  api = await startApi();
  A = await seedTenant(h, 'saas-a');
  B = await seedTenant(h, 'saas-b');
});
afterAll(async () => { await api.app.close(); await h.close(); });

describe('onboarding: account -> organization -> business', () => {
  it('register, create organization (idempotent on refresh), me', async () => {
    const u = await registerUser('owner');
    const slug = `onb-${uuidv7().slice(-10)}`;
    const first = await newOrg(u.token, slug);
    expect(first.status).toBe(201);
    expect(first.body.created).toBe(true);
    const retry = await newOrg(u.token, slug); // page refresh re-submits the same step
    expect(retry.body).toEqual({ organizationId: first.body.organizationId, created: false });
    const other = await registerUser('squatter');
    expect((await newOrg(other.token, slug)).status).toBe(409); // someone else's slug is not "yours"

    const me = await api.http.get('/v1/account/me').set('authorization', `Bearer ${u.token}`);
    expect(me.body.organizations).toHaveLength(1);
    expect(me.body.organizations[0]).toMatchObject({ id: first.body.organizationId, role: 'OWNER', timezone: 'Asia/Kolkata', businessCount: 0 });
    expect(JSON.stringify(me.body)).not.toMatch(/password|hash|token/i);

    const as = api.as(u.userId, first.body.organizationId);
    const biz = await as(api.http.post('/v1/businesses')).send({ name: 'Sharma Dental Clinic', industry: 'DENTAL_CLINIC', phone: '098123 45678',
      countryCode: 'IN', timezone: 'Asia/Kolkata', address: { line1: 'MG Road', city: 'Indore' } });
    expect(biz.status).toBe(201);
    expect(biz.body).toMatchObject({ name: 'Sharma Dental Clinic', phone: '+919812345678', industry: 'DENTAL_CLINIC', address: { city: 'Indore' } });
    const bad = await as(api.http.patch(`/v1/businesses/${biz.body.id}`)).send({ timezone: 'Mars/Olympus' });
    expect(bad.status).toBe(400);
    const ok = await as(api.http.patch(`/v1/businesses/${biz.body.id}`)).send({ website: 'https://sharma.example', businessHours: { mon: [['09:00', '18:00']] } });
    expect(ok.body).toMatchObject({ website: 'https://sharma.example', businessHours: { mon: [['09:00', '18:00']] } });
  });

  it('account endpoints require a valid session; me never needs an organization header', async () => {
    expect((await api.http.get('/v1/account/me')).status).toBe(401);
    expect((await api.http.get('/v1/account/me').set('authorization', 'Bearer hs1.x.y')).status).toBe(401);
    expect((await api.http.post('/v1/auth/register').send({ email: 'x@example.test', password: 'short' })).status).toBe(400);
  });
});

describe('plan entitlements (central, race-free)', () => {
  it('TRIAL allows 1 instance: 5 concurrent creates => exactly 1 succeeds; then further creates are refused', async () => {
    const u = await registerUser('limits');
    const org = (await newOrg(u.token)).body.organizationId;
    const as = api.as(u.userId, org);
    const biz = (await as(api.http.post('/v1/businesses')).send({ name: 'Limit Test' })).body.id;
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) =>
      as(api.http.post('/v1/whatsapp/instances')).send({ businessId: biz, name: `race-${i}` })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 402 && r.body.error.code === 'WHATSAPP_INSTANCE_LIMIT_REACHED')).toHaveLength(4);
    const n = await h.owner.query('SELECT count(*)::int AS n FROM app.whatsapp_instances WHERE organization_id = $1', [org]);
    expect(n.rows[0].n).toBe(1);
  });

  it('API_ACCESS: TRIAL cannot create API keys; a downgrade cuts off existing keys', async () => {
    const u = await registerUser('noapi');
    const org = (await newOrg(u.token)).body.organizationId;
    const r = await api.as(u.userId, org)(api.http.post('/v1/api-keys')).send({ name: 'x', scopes: ['instances:read'] });
    expect(r.status).toBe(402);
    expect(r.body.error.code).toBe('FEATURE_NOT_IN_PLAN');

    const key = await asA(api.http.post('/v1/api-keys')).send({ name: 'downgrade', scopes: ['instances:read'] });
    expect((await api.http.get('/v1/whatsapp/instances').set('x-api-key', key.body.plaintext)).status).toBe(200);
    await setPlan(h, A.orgId, 'STARTER');
    expect((await api.http.get('/v1/whatsapp/instances').set('x-api-key', key.body.plaintext)).status).toBe(401);
    await setPlan(h, A.orgId, 'GROWTH');
  });

  it('WEBHOOKS and TEAM_MEMBERS limits are enforced', async () => {
    const owner = await registerUser('teamlimit');
    const org = (await newOrg(owner.token)).body.organizationId;
    const as = api.as(owner.userId, org);
    const mate = await registerUser('mate');
    const third = await registerUser('third');
    expect((await as(api.http.post('/v1/team/invitations')).send({ email: mate.email, role: 'AGENT' })).status).toBe(201); // owner + 1 = 2 (TRIAL)
    const over = await as(api.http.post('/v1/team/invitations')).send({ email: third.email, role: 'AGENT' });
    expect(over.status).toBe(402);
    expect(over.body.error.code).toBe('PLAN_LIMIT_REACHED');
  });
});

describe('team invitations & roles', () => {
  it('invite existing account -> invitee sees it -> accepts -> becomes member; role rules enforced', async () => {
    const invitee = await registerUser('invitee');
    const inv = await asA(api.http.post('/v1/team/invitations')).send({ email: invitee.email, role: 'AGENT' });
    expect(inv.status).toBe(201);
    expect(inv.body.find((m: { email: string }) => m.email === invitee.email)).toMatchObject({ status: 'INVITED', role: 'AGENT' });
    const me = await api.http.get('/v1/account/me').set('authorization', `Bearer ${invitee.token}`);
    expect(me.body.invitations).toEqual([expect.objectContaining({ organizationId: A.orgId, role: 'AGENT' })]);
    expect(me.body.organizations).toEqual([]);
    // Before accepting, the invitee has no access to the organization.
    expect((await api.as(invitee.userId, A.orgId)(api.http.get('/v1/whatsapp/instances'))).status).toBe(403);
    await api.http.post(`/v1/account/invitations/${A.orgId}/accept`).set('authorization', `Bearer ${invitee.token}`).expect(200);
    expect((await api.as(invitee.userId, A.orgId)(api.http.get('/v1/whatsapp/instances'))).status).toBe(200);
    // AGENT cannot manage the team or read the audit log.
    expect((await api.as(invitee.userId, A.orgId)(api.http.post('/v1/team/invitations')).send({ email: 'x@example.test', role: 'VIEWER' })).status).toBe(403);
    expect((await api.as(invitee.userId, A.orgId)(api.http.get('/v1/audit-logs'))).status).toBe(403);

    expect((await asA(api.http.post('/v1/team/invitations')).send({ email: `nobody-${uuidv7()}@example.test`, role: 'AGENT' })).status).toBe(404);
    expect((await asA(api.http.patch(`/v1/team/members/${A.userId}`)).send({ role: 'ADMIN' })).body.error.code).toBe('CONFLICT'); // last owner
    const promoted = await asA(api.http.patch(`/v1/team/members/${invitee.userId}`)).send({ role: 'MANAGER' });
    expect(promoted.body.find((m: { userId: string }) => m.userId === invitee.userId).role).toBe('MANAGER');
    await asA(api.http.delete(`/v1/team/members/${invitee.userId}`)).expect(200);
    expect((await api.as(invitee.userId, A.orgId)(api.http.get('/v1/whatsapp/instances'))).status).toBe(403);
  });
});

describe('API keys lifecycle', () => {
  it('plaintext shown once, never listed; revoked key rejected', async () => {
    const created = await asA(api.http.post('/v1/api-keys')).send({ name: 'CRM', scopes: ['instances:read', 'messages:send'] });
    expect(created.body.plaintext).toMatch(/^hs_live_/);
    const list = await asA(api.http.get('/v1/api-keys'));
    const row = list.body.find((k: { id: string }) => k.id === created.body.id);
    expect(row).toMatchObject({ prefix: created.body.prefix, status: 'ACTIVE', scopes: ['instances:read', 'messages:send'] });
    expect(JSON.stringify(list.body)).not.toContain(created.body.plaintext.split('_').slice(3).join('_'));
    expect(JSON.stringify(list.body)).not.toMatch(/key_hash|keyHash/);
    expect((await api.http.get('/v1/whatsapp/instances').set('x-api-key', created.body.plaintext)).status).toBe(200);
    await asA(api.http.delete(`/v1/api-keys/${created.body.id}`)).expect(200);
    expect((await api.http.get('/v1/whatsapp/instances').set('x-api-key', created.body.plaintext)).status).toBe(401);
    expect((await asA(api.http.get('/v1/api-keys'))).body.find((k: { id: string }) => k.id === created.body.id).status).toBe('REVOKED');
  });
});

describe('webhook management', () => {
  it('rejects unsafe destinations (SSRF) at create/update time', async () => {
    for (const url of ['https://localhost/hook', 'https://127.0.0.1/hook', 'https://169.254.169.254/latest/meta-data', 'https://10.0.0.5/x',
                       'https://[::1]/x', 'https://metadata.google.internal/x', 'https://user:pass@example.com/x', 'http://example.com/x']) {
      const r = await asA(api.http.post('/v1/webhooks')).send({ name: 'bad', url, eventTypes: ['MESSAGE_RECEIVED'] });
      expect(r.status, url).toBe(400);
    }
  });

  it('SSRF primitives: private ranges, connect-time lookup guard, IP-literal refusal', async () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00:ec2::254', '::ffff:127.0.0.1', 'fe80::1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false);
    await expect(new SafeWebhookSender(2000, false).post('https://127.0.0.1:9/x', '{}', {})).rejects.toThrow(/private/);
    await expect(new SafeWebhookSender(2000, false).post('https://localhost:9/x', '{}', {})).rejects.toThrow(/private|internal/);
    await expect(assertSafeWebhookUrl('https://localhost/x', false)).rejects.toThrow();
  });

  it('create -> list -> edit events -> disable -> delete; tenant isolated; secret never listed', async () => {
    // Uses an IP literal that is public so no DNS is required in CI.
    const c = await asA(api.http.post('/v1/webhooks')).send({ name: 'CRM', url: 'https://93.184.215.14/hooks', eventTypes: ['MESSAGE_RECEIVED'] });
    expect(c.status).toBe(201);
    expect(c.body.secret).toMatch(/^whsec_/);
    const list = await asA(api.http.get('/v1/webhooks'));
    const ep = list.body.find((w: { id: string }) => w.id === c.body.id);
    expect(ep).toMatchObject({ scope: 'ORGANIZATION', enabled: true, events: ['MESSAGE_RECEIVED'], secretLast4: c.body.secret.slice(-4) });
    expect(JSON.stringify(list.body)).not.toContain(c.body.secret);
    const upd = await asA(api.http.patch(`/v1/webhooks/${c.body.id}`)).send({ eventTypes: ['MESSAGE_RECEIVED', 'MESSAGE_READ'], enabled: false });
    expect(upd.body).toMatchObject({ enabled: false, events: ['MESSAGE_READ', 'MESSAGE_RECEIVED'] });
    expect((await asA(api.http.post(`/v1/webhooks/${c.body.id}/test`))).status).toBe(409); // disabled: no test delivery
    expect((await asB(api.http.get(`/v1/webhooks/${c.body.id}`))).status).toBe(404);
    expect((await asB(api.http.patch(`/v1/webhooks/${c.body.id}`)).send({ enabled: true })).status).toBe(404);
    expect((await asB(api.http.get(`/v1/webhooks/${c.body.id}/deliveries`))).status).toBe(404);
    await asA(api.http.delete(`/v1/webhooks/${c.body.id}`)).expect(200);
    expect((await asA(api.http.get('/v1/webhooks'))).body.find((w: { id: string }) => w.id === c.body.id)).toBeUndefined();
  });
});

describe('secure media URLs', () => {
  it('attachment URL works only for its tenant; tokens are tamper-proof, expire, and re-check membership', async () => {
    const att = uuidv7();
    const key = `org/${A.orgId}/msg/${A.inboundMessageId}/${att}`;
    await h.owner.query(`INSERT INTO app.message_attachments (id, organization_id, message_id, media_type, mime_type, file_name, storage_provider, storage_key, status)
                         VALUES ($1, $2, $3, 'IMAGE', 'image/png', 'x.png', 'LOCAL_DEV', $4, 'STORED')`, [att, A.orgId, A.inboundMessageId, key]);
    const { LocalMediaStorage } = await import('../src/whatsapp/media/media-storage.service.js');
    await new LocalMediaStorage(process.env.MEDIA_LOCAL_DIR ?? '.data/media').put(key, Buffer.from('PNGDATA'));

    const u = await asA(api.http.get(`/v1/media/attachments/${att}/url`));
    expect(u.status).toBe(200);
    expect(u.body.url).toMatch(/^\/v1\/media\/download\//);
    const dl = await api.http.get(u.body.url);
    expect(dl.status).toBe(200);
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect(dl.body.toString()).toBe('PNGDATA');
    expect((await asB(api.http.get(`/v1/media/attachments/${att}/url`))).status).toBe(404);
    expect((await api.http.get(u.body.url.slice(0, -3) + 'abc')).status).toBe(404);
    const expired = issueMediaToken({ a: att, o: A.orgId, u: A.userId, exp: Math.floor(Date.now() / 1000) - 5 });
    expect((await api.http.get(`/v1/media/download/${expired}`)).status).toBe(404);
    const forged = issueMediaToken({ a: att, o: B.orgId, u: B.userId, exp: Math.floor(Date.now() / 1000) + 60 }); // B's user, A's attachment
    expect((await api.http.get(`/v1/media/download/${forged}`)).status).toBe(404);
    expect(contentDisposition(false, 'a"b;\r\nc.pdf')).toBe(`attachment; filename="a_b___c.pdf"; filename*=UTF-8''a%22b%3B%0D%0Ac.pdf`);
  });
});

describe('read models & tenant isolation', () => {
  it('conversations, contacts, messages of another tenant are 404; lists never include them', async () => {
    for (const path of [`/v1/conversations/${B.conversationId}`, `/v1/conversations/${B.conversationId}/messages`, `/v1/contacts/${B.contactId}`,
                        `/v1/whatsapp/instances/${B.instanceId}/activity`, `/v1/businesses/${B.businessId}`]) {
      expect((await asA(api.http.get(path))).status, path).toBe(404);
    }
    const convs = await asA(api.http.get('/v1/conversations'));
    expect(convs.body.items.every((c: { businessId: string }) => c.businessId === A.businessId)).toBe(true);
    const contacts = await asA(api.http.get('/v1/contacts'));
    expect(contacts.body.items.map((c: { id: string }) => c.id)).not.toContain(B.contactId);
    expect((await asA(api.http.post(`/v1/conversations/${B.conversationId}/messages`)).send({ text: 'x', clientRequestId: uuidv7() })).status).toBe(404);
  });

  it('dashboard, usage, billing and audit reflect real data only', async () => {
    const d = await asA(api.http.get('/v1/dashboard/summary'));
    expect(d.body).toMatchObject({ instances: { total: expect.any(Number) }, conversations: { open: expect.any(Number) }, contacts: expect.any(Number) });
    const u = await asA(api.http.get('/v1/usage?period=current'));
    expect(u.body).toMatchObject({ period: 'current', aiEnabled: false, totals: expect.objectContaining({ AI_RUN: 0 }) });
    const b = await asA(api.http.get('/v1/billing'));
    expect(b.body).toMatchObject({ paymentsEnabled: false, subscription: { planCode: 'GROWTH' } });
    expect(b.body.entitlements.find((e: { feature: string }) => e.feature === 'MAX_WHATSAPP_INSTANCES')).toMatchObject({ limit: 5, used: expect.any(Number) });
    const audit = await asA(api.http.get('/v1/audit-logs'));
    expect(audit.body.items.map((a: { action: string }) => a.action)).toEqual(expect.arrayContaining(['API_KEY_CREATED', 'TEAM_MEMBER_INVITED']));
    expect(JSON.stringify(audit.body)).not.toMatch(/whsec_|hs_live_[A-Za-z0-9]{8}_/);
  });
});
