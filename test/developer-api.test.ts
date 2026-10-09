import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { HmacSessionService } from '../src/api/auth/session.service.js';
import { uuidv7 } from '../src/common/uuid.js';
import { makeHarness, seedTenant, setPlan, TEST_DB, type Harness, type Tenant } from './helpers.js';

let h: Harness;
let A: Tenant;
let B: Tenant;
let app: NestExpressApplication;
let http: ReturnType<typeof request>;
let tokenA: string;
let tokenB: string;
let keyA: string;

const asA = (r: request.Test) => r.set('authorization', `Bearer ${tokenA}`).set('x-organization-id', A.orgId);
const withKey = (r: request.Test, key = keyA) => r.set('authorization', `Bearer ${key}`);
const someone = () => `+9198${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;

beforeAll(async () => {
  process.env.DB_NAME = TEST_DB;
  process.env.REALTIME_BUS = 'memory';
  process.env.WHATSAPP_API_SEND_RATE_PER_MINUTE = '500';
  process.env.SESSION_SECRET ??= 'test-session-secret-0123456789-abcdefghij';
  process.env.PUBLIC_API_URL = 'https://api.example.test';
  h = makeHarness();
  A = await seedTenant(h, 'devapi-a');
  B = await seedTenant(h, 'devapi-b');
  const { createApiApp } = await import('../src/api/app-factory.js');
  app = await createApiApp({ swagger: false });
  await app.init();
  http = request(app.getHttpServer());
  const sessions = app.get(HmacSessionService);
  tokenA = sessions.issue(A.userId);
  tokenB = sessions.issue(B.userId);
  const r = await asA(http.post(`/v1/whatsapp/instances/${A.instanceId}/api-key`));
  expect(r.status).toBe(201);
  keyA = r.body.apiKey;
});
afterAll(async () => { await app?.close(); await h?.close(); });

describe('instance API key', () => {
  it('is shown once; afterwards only the prefix, base URL and instance id are readable', async () => {
    expect(keyA).toMatch(/^hs_live_[A-Za-z0-9]{8}_/);
    const r = await asA(http.get(`/v1/whatsapp/instances/${A.instanceId}/api-key`));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ instanceId: A.instanceId, baseUrl: 'https://api.example.test', key: { prefix: keyA.slice(0, 16) } });
    expect(JSON.stringify(r.body)).not.toContain(keyA.slice(17));
  });

  it('another tenant cannot read or rotate it', async () => {
    const r = await http.post(`/v1/whatsapp/instances/${A.instanceId}/api-key`).set('authorization', `Bearer ${tokenB}`).set('x-organization-id', B.orgId);
    expect(r.status).toBe(404);
  });

  it('sends through its own instance with Authorization: Bearer (gateway style), to or chatId', async () => {
    const r = await withKey(http.post(`/api/whatsapp/v1/${A.instanceId}/send-text`)).send({ to: someone(), text: 'hello from api' });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ queued: true, status: 'QUEUED', statusUrl: `https://api.example.test/api/whatsapp/v1/${A.instanceId}/messages/${r.body.messageId}` });
    const m = await h.owner.query('SELECT origin, whatsapp_instance_id FROM app.messages WHERE id = $1', [r.body.messageId]);
    expect(m.rows[0]).toEqual({ origin: 'API', whatsapp_instance_id: A.instanceId });
    const chat = await withKey(http.post(`/api/whatsapp/v1/${A.instanceId}/send-text`)).send({ chatId: `${someone().slice(1)}@c.us`, text: 'hi' });
    expect(chat.status).toBe(202);
    const s = await withKey(http.get(`/api/whatsapp/v1/${A.instanceId}/messages/${r.body.messageId}`));
    expect(s.status).toBe(200);
    expect(s.body.message.status).toBe('QUEUED');
    expect((await withKey(http.get(`/api/whatsapp/v1/${A.instanceId}/status`))).body).toMatchObject({ instanceId: A.instanceId, status: 'CONNECTED' });
  });

  it('cannot use another instance - not even one of the same business - nor another tenant\'s', async () => {
    const other = uuidv7();
    await h.owner.query(`INSERT INTO app.whatsapp_instances (id, organization_id, business_id, instance_name, phone_e164, whatsapp_jid, status, connection_state)
                         VALUES ($1, $2, $3, 'second', $4, $5, 'CONNECTED', 'OPEN')`, [other, A.orgId, A.businessId, '+919900000123', '919900000123@s.whatsapp.net']);
    for (const id of [other, B.instanceId]) {
      const r = await withKey(http.post(`/api/whatsapp/v1/${id}/send-text`)).send({ to: someone(), text: 'hijack' });
      expect(r.status).toBe(404);
      expect((await withKey(http.post(`/api/otp/v1/${id}/request-code`)).send({ to: someone() })).status).toBe(404);
    }
    // the org-level message API also refuses the other instance
    expect((await withKey(http.get(`/api/whatsapp/v1/${A.instanceId}/messages/${B.inboundMessageId}`))).status).toBe(404);
  });

  it('never reaches the dashboard API (bearer or X-Api-Key)', async () => {
    for (const r of [() => withKey(http.get('/v1/conversations')), () => http.get('/v1/conversations').set('x-api-key', keyA),
                     () => withKey(http.post('/v1/whatsapp/messages/text')).send({ instanceId: A.instanceId, to: someone(), text: 'x' }),
                     () => withKey(http.get(`/v1/whatsapp/instances/${A.instanceId}/api-key`))]) {
      const res = await r();
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
  });

  it('rotation revokes the previous key immediately', async () => {
    const r = await asA(http.post(`/v1/whatsapp/instances/${A.instanceId}/api-key`));
    const fresh = r.body.apiKey as string;
    expect((await withKey(http.get(`/api/whatsapp/v1/${A.instanceId}/status`))).status).toBe(401);
    expect((await withKey(http.get(`/api/whatsapp/v1/${A.instanceId}/status`), fresh)).status).toBe(200);
    keyA = fresh;
  });
});

describe('automatic instance key + reveal', () => {
  it('a new instance gets its API key immediately; owners can copy it again and it authenticates', async () => {
    const c = await asA(http.post('/v1/whatsapp/instances')).send({ businessId: A.businessId, name: `auto-${uuidv7().slice(-6)}` });
    expect(c.status).toBe(201);
    const meta = await asA(http.get(`/v1/whatsapp/instances/${c.body.id}/api-key`));
    expect(meta.body.key).toMatchObject({ recoverable: true });
    const rev = await asA(http.post(`/v1/whatsapp/instances/${c.body.id}/api-key/reveal`));
    expect(rev.status).toBe(200);
    expect(rev.body.apiKey.startsWith(meta.body.key.prefix)).toBe(true);
    expect((await withKey(http.get(`/api/whatsapp/v1/${c.body.id}/status`), rev.body.apiKey)).status).toBe(200);
    // stored encrypted, never in plaintext; every reveal is audited
    const row = await h.owner.query('SELECT secret_ciphertext FROM app.api_keys WHERE instance_id = $1 AND revoked_at IS NULL', [c.body.id]);
    expect(row.rows[0].secret_ciphertext.toString('utf8')).not.toContain(rev.body.apiKey.slice(17));
    const audit = await h.owner.query(`SELECT count(*)::int AS n FROM app.audit_logs WHERE organization_id = $1 AND action = 'API_KEY_REVEALED'`, [A.orgId]);
    expect(audit.rows[0].n).toBeGreaterThan(0);
  });

  it('GET is idempotent (one live key), other tenants cannot reveal', async () => {
    await Promise.all([asA(http.get(`/v1/whatsapp/instances/${A.instanceId}/api-key`)), asA(http.get(`/v1/whatsapp/instances/${A.instanceId}/api-key`))]);
    const n = await h.owner.query('SELECT count(*)::int AS n FROM app.api_keys WHERE instance_id = $1 AND revoked_at IS NULL', [A.instanceId]);
    expect(n.rows[0].n).toBe(1);
    const r = await http.post(`/v1/whatsapp/instances/${A.instanceId}/api-key/reveal`).set('authorization', `Bearer ${tokenB}`).set('x-organization-id', B.orgId);
    expect(r.status).toBe(404);
    // an instance key can never reveal keys
    expect((await withKey(http.post(`/v1/whatsapp/instances/${A.instanceId}/api-key/reveal`))).status).toBe(403);
  });
});

describe('instance keys on a plan without API access (trial)', () => {
  it('still get a key and can send; organization keys stay blocked', async () => {
    await setPlan(h, B.orgId, 'TRIAL');
    try {
      const meta = await http.get(`/v1/whatsapp/instances/${B.instanceId}/api-key`).set('authorization', `Bearer ${tokenB}`).set('x-organization-id', B.orgId);
      expect(meta.status).toBe(200);
      expect(meta.body.key).toMatchObject({ recoverable: true });
      const key = (await http.post(`/v1/whatsapp/instances/${B.instanceId}/api-key/reveal`).set('authorization', `Bearer ${tokenB}`).set('x-organization-id', B.orgId)).body.apiKey;
      expect((await withKey(http.post(`/api/whatsapp/v1/${B.instanceId}/send-text`), key).send({ to: someone(), text: 'trial' })).status).toBe(202);
      const org = await http.post('/v1/api-keys').set('authorization', `Bearer ${tokenB}`).set('x-organization-id', B.orgId).send({ name: 'org', scopes: ['messages:send'] });
      expect(org.status).toBe(402);
    } finally {
      await setPlan(h, B.orgId, 'GROWTH');
    }
  });
});

describe('instance edit', () => {
  it('renames an instance; instance keys and other tenants cannot', async () => {
    const r = await asA(http.patch(`/v1/whatsapp/instances/${A.instanceId}`)).send({ name: 'Front desk', description: 'main number' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ name: 'Front desk', description: 'main number', status: 'CONNECTED' });
    expect((await asA(http.patch(`/v1/whatsapp/instances/${A.instanceId}`)).send({ description: null })).body).toMatchObject({ name: 'Front desk', description: null });
    expect((await asA(http.patch(`/v1/whatsapp/instances/${A.instanceId}`)).send({ name: '' })).status).toBe(400);
    expect((await withKey(http.patch(`/v1/whatsapp/instances/${A.instanceId}`)).send({ name: 'x' })).status).toBe(403);
    expect((await http.patch(`/v1/whatsapp/instances/${A.instanceId}`).set('authorization', `Bearer ${tokenB}`).set('x-organization-id', B.orgId).send({ name: 'x' })).status).toBe(404);
    await asA(http.patch(`/v1/whatsapp/instances/${A.instanceId}`)).send({ name: 'main' });
  });
});

describe('webhook logs', () => {
  it('lists all deliveries of the org with endpoint, instance, HTTP status and response time; detail and retry', async () => {
    const ctx = { organizationId: A.orgId, userId: A.userId, role: 'OWNER' as const };
    const ep = await h.services.webhooksApp.createEndpoint(ctx, { name: 'logs', url: 'https://hooks.example.test/logs', eventTypes: ['MESSAGE_RECEIVED'], businessId: A.businessId });
    await h.services.webhooksWorker.fanOut(A.orgId, { eventType: 'MESSAGE_RECEIVED', businessId: A.businessId, instanceId: A.instanceId, resourceType: 'MESSAGE',
      resourceId: null, payload: { message: { text: 'hi' } }, idempotencyKey: `t:${uuidv7()}` });
    for (let i = 0; i < 5; i++) {
      await h.services.webhooksWorker.dispatchBatch('test-worker', { post: async (url) => {
        await new Promise((res) => setTimeout(res, 5));
        return url.endsWith('/logs') ? { status: 404, body: 'not here' } : { status: 200, body: 'ok' };
      } });
    }
    const r = await asA(http.get(`/v1/webhook-logs?endpoint=${ep.id}`));
    expect(r.status).toBe(200);
    const log = r.body.items[0];
    expect(log).toMatchObject({ eventType: 'MESSAGE_RECEIVED', httpStatus: 404, status: 'RETRYING', retries: 0,
      endpoint: { id: ep.id, url: 'https://hooks.example.test/logs' }, instance: { id: A.instanceId, name: 'main' } });
    expect(log.latencyMs).toBeGreaterThanOrEqual(0);
    expect(log.payload).toBeUndefined();
    expect((await asA(http.get('/v1/webhook-logs?status=FAILED'))).body.items.some((x: { id: string }) => x.id === log.id)).toBe(true);
    expect((await asA(http.get('/v1/webhook-logs?status=SUCCESS'))).body.items.some((x: { id: string }) => x.id === log.id)).toBe(false);
    expect((await asA(http.get('/v1/webhook-logs?httpStatus=404'))).body.items.some((x: { id: string }) => x.id === log.id)).toBe(true);
    const d = await asA(http.get(`/v1/webhook-logs/${log.id}`));
    expect(d.body).toMatchObject({ responseBodySnippet: 'not here', payload: { message: { text: 'hi' } } });
    // retrying is only for failed / dead deliveries
    expect((await asA(http.post(`/v1/webhook-logs/${log.id}/retry`))).status).toBe(409);
    await h.owner.query(`UPDATE app.webhook_deliveries SET status = 'DEAD', next_retry_at = NULL WHERE id = $1`, [log.id]);
    expect((await asA(http.post(`/v1/webhook-logs/${log.id}/retry`))).status).toBe(202);
    // don't leave a due delivery behind: other test files dispatch across tenants on the shared test DB
    await h.owner.query(`UPDATE app.webhook_deliveries SET status = 'DEAD', next_retry_at = NULL WHERE webhook_endpoint_id = $1`, [ep.id]);
    // tenant isolation
    expect((await http.get(`/v1/webhook-logs/${log.id}`).set('authorization', `Bearer ${tokenB}`).set('x-organization-id', B.orgId)).status).toBe(404);
  });
});

describe('OTP by code', () => {
  it('sends the code on WhatsApp and validates it once (wrong codes count as attempts)', async () => {
    const to = someone();
    const r = await withKey(http.post(`/api/otp/v1/${A.instanceId}/request-code`)).send({ chatId: `${to.slice(1)}@c.us`, name: 'PanditSuggest', length: 6 });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ kind: 'CODE', status: 'PENDING', to });
    expect(r.body.code).toMatch(/^\d{6}$/);
    const msg = await h.owner.query('SELECT text_body FROM app.messages WHERE id = $1', [r.body.messageId]);
    expect(msg.rows[0].text_body).toContain(r.body.code);
    expect(msg.rows[0].text_body).toContain('PanditSuggest');
    const stored = await h.owner.query('SELECT code_hash FROM app.otp_requests WHERE id = $1', [r.body.id]);
    expect(stored.rows[0].code_hash.toString('utf8')).not.toContain(r.body.code);

    const wrong = r.body.code === '000000' ? '111111' : '000000';
    const bad = await withKey(http.post(`/api/otp/v1/${A.instanceId}/validate-code`)).send({ to, code: wrong });
    expect(bad.status).toBe(200);
    expect(bad.body).toMatchObject({ valid: false, reason: 'INVALID_CODE', attemptsLeft: 4 });
    const ok = await withKey(http.post(`/api/otp/v1/${A.instanceId}/validate-code`)).send({ to, code: r.body.code });
    expect(ok.body).toMatchObject({ valid: true, reason: 'OK', otp: { status: 'VERIFIED' } });
    const again = await withKey(http.post(`/api/otp/v1/${A.instanceId}/validate-code`)).send({ to, code: r.body.code });
    expect(again.body).toMatchObject({ valid: false, reason: 'NOT_FOUND' });
  });

  it('only the newest code is valid, and 5 wrong tries lock it', async () => {
    const to = someone();
    const first = await withKey(http.post(`/api/otp/v1/${A.instanceId}/request-code`)).send({ to });
    const second = await withKey(http.post(`/api/otp/v1/${A.instanceId}/request-code`)).send({ to, useLetter: true, allCapital: true, length: 8 });
    expect(second.body.code).toMatch(/^[0-9A-Z]{8}$/);
    if (first.body.code !== second.body.code) {
      expect((await withKey(http.post(`/api/otp/v1/${A.instanceId}/validate-code`)).send({ to, code: first.body.code })).body.valid).toBe(false);
    }
    for (let i = 0; i < 5; i++) await withKey(http.post(`/api/otp/v1/${A.instanceId}/validate-code`)).send({ to, code: 'ZZZZZZZZ' });
    const locked = await withKey(http.post(`/api/otp/v1/${A.instanceId}/validate-code`)).send({ to, code: second.body.code });
    expect(locked.body.valid).toBe(false);
  });

  it('rate-limits codes per number (5 per 10 minutes)', async () => {
    const to = someone();
    for (let i = 0; i < 5; i++) expect((await withKey(http.post(`/api/otp/v1/${A.instanceId}/request-code`)).send({ to })).status).toBe(201);
    const r = await withKey(http.post(`/api/otp/v1/${A.instanceId}/request-code`)).send({ to });
    expect(r.status).toBe(429);
  });

  it('rejects bad input', async () => {
    expect((await withKey(http.post(`/api/otp/v1/${A.instanceId}/request-code`)).send({ to: someone(), useNumber: false })).status).toBe(400);
    expect((await withKey(http.post(`/api/otp/v1/${A.instanceId}/request-code`)).send({ to: someone(), template: 'no placeholder' })).status).toBe(400);
    expect((await withKey(http.post(`/api/otp/v1/${A.instanceId}/request-code`)).send({ chatId: '12036302@g.us' })).status).toBe(422);
  });
});

describe('OTP by WhatsApp link ("login by WhatsApp")', () => {
  it('verifies when the user sends the code to the number, replies, emits OTP_VERIFIED and keeps the AI out', async () => {
    const r = await withKey(http.post(`/api/otp/v1/${A.instanceId}/generate-link`)).send({ name: 'PanditSuggest', message: { success: 'Welcome to {name}!' } });
    expect(r.status).toBe(201);
    expect(r.body.code).toMatch(/^[A-Z2-9]{8}$/);
    expect(r.body.whatsappLink).toBe(`https://wa.me/${A.instancePhone.slice(1)}?text=${encodeURIComponent(r.body.text)}`);
    expect(r.body.text).toContain('Log me in to PanditSuggest');

    const user = someone();
    const res = await h.services.ingestion.ingest({
      organizationId: A.orgId, businessId: A.businessId, instanceId: A.instanceId, instanceJid: A.instanceJid, providerMessageId: `OTP${uuidv7()}`,
      fromJid: `${user.slice(1)}@s.whatsapp.net`, fromPhoneE164: user, type: 'TEXT', text: r.body.text.toLowerCase(), providerTimestamp: new Date(),
    });
    const s = await withKey(http.get(`/api/otp/v1/${A.instanceId}/requests/${r.body.id}`));
    expect(s.body).toMatchObject({ status: 'VERIFIED', to: user, kind: 'LINK' });
    const reply = await h.owner.query(`SELECT text_body, origin FROM app.messages WHERE conversation_id = $1 AND direction = 'OUTBOUND'`, [res.conversationId]);
    expect(reply.rows).toEqual([{ text_body: 'Welcome to PanditSuggest!', origin: 'SYSTEM' }]);
    const ev = await h.owner.query(`SELECT event_type, payload FROM app.outbox_events WHERE organization_id = $1 AND (aggregate_id = $2 OR aggregate_id = $3)`,
      [A.orgId, r.body.id, res.messageId]);
    expect(ev.rows.find((e) => e.event_type === 'OTP_VERIFIED')).toBeTruthy();
    expect(ev.rows.find((e) => e.event_type === 'MESSAGE_RECEIVED')?.payload.otp_request_id).toBe(r.body.id);

    // the same code cannot verify twice
    await h.services.ingestion.ingest({
      organizationId: A.orgId, businessId: A.businessId, instanceId: A.instanceId, instanceJid: A.instanceJid, providerMessageId: `OTP${uuidv7()}`,
      fromJid: `${someone().slice(1)}@s.whatsapp.net`, type: 'TEXT', text: r.body.text, providerTimestamp: new Date(),
    });
    expect((await withKey(http.get(`/api/otp/v1/${A.instanceId}/requests/${r.body.id}`))).body.to).toBe(user);
  });

  it('a code sent to a different instance does nothing', async () => {
    const r = await withKey(http.post(`/api/otp/v1/${A.instanceId}/generate-link`)).send({});
    await h.services.ingestion.ingest({
      organizationId: B.orgId, businessId: B.businessId, instanceId: B.instanceId, instanceJid: B.instanceJid, providerMessageId: `OTP${uuidv7()}`,
      fromJid: `${someone().slice(1)}@s.whatsapp.net`, type: 'TEXT', text: r.body.text, providerTimestamp: new Date(),
    });
    expect((await withKey(http.get(`/api/otp/v1/${A.instanceId}/requests/${r.body.id}`))).body.status).toBe('PENDING');
  });
});

describe('webhook Authorization header', () => {
  it('is stored encrypted, never readable, and sent with every delivery', async () => {
    const ctx = { organizationId: A.orgId, userId: A.userId, role: 'OWNER' as const };
    const ep = await h.services.webhooksApp.createEndpoint(ctx, { name: 'otp', url: 'https://hooks.example.test/otp', eventTypes: ['OTP_VERIFIED'], businessId: A.businessId });
    await h.services.webhooksApp.setAuthHeader(ctx, ep.id, 'Bearer partner-secret-123');
    const row = await h.owner.query('SELECT auth_header_ciphertext, has_auth_header FROM app.webhook_endpoints WHERE id = $1', [ep.id]);
    expect(row.rows[0].has_auth_header).toBe(true);
    expect(row.rows[0].auth_header_ciphertext.toString('utf8')).not.toContain('partner-secret');
    const listed = await asA(http.get(`/v1/webhooks/${ep.id}`));
    expect(listed.body.hasAuthHeader).toBe(true);
    expect(JSON.stringify(listed.body)).not.toContain('partner-secret');

    await h.services.webhooksWorker.fanOut(A.orgId, { eventType: 'OTP_VERIFIED', businessId: A.businessId, instanceId: A.instanceId, resourceType: 'OTP_REQUEST',
      resourceId: null, payload: { otp: { status: 'VERIFIED' } }, idempotencyKey: `t:${uuidv7()}` });
    const sent: Array<{ url: string; headers: Record<string, string> }> = [];
    for (let i = 0; i < 5 && !sent.some((s) => s.url.endsWith('/otp')); i++) {
      await h.services.webhooksWorker.dispatchBatch('test-worker', { post: async (url, _b, headers) => { sent.push({ url, headers }); return { status: 200, body: 'ok' }; } });
    }
    const mine = sent.find((s) => s.url === 'https://hooks.example.test/otp');
    expect(mine?.headers.authorization).toBe('Bearer partner-secret-123');
    expect(mine?.headers['x-webhook-signature']).toMatch(/^v1=/);

    await h.services.webhooksApp.setAuthHeader(ctx, ep.id, null);
    expect((await asA(http.get(`/v1/webhooks/${ep.id}`))).body.hasAuthHeader).toBe(false);
  });

  it('the API rejects header values with line breaks', async () => {
    const list = await asA(http.get('/v1/webhooks'));
    const id = list.body[0].id;
    const r = await asA(http.patch(`/v1/webhooks/${id}`)).send({ authorizationHeader: 'x\r\nX-Evil: 1' });
    expect(r.status).toBe(400);
  });
});
