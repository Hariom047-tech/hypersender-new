import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { HmacSessionService } from '../src/api/auth/session.service.js';
import { buildOpenApiDocument } from '../src/api/openapi.js';
import { uuidv7 } from '../src/common/uuid.js';
import { REALTIME_BUS, type RealtimeBus } from '../src/whatsapp/realtime/realtime-bus.js';
import { makeHarness, seedTenant, TEST_DB, type Harness, type Tenant } from './helpers.js';

let h: Harness;
let A: Tenant;
let B: Tenant;
let app: NestExpressApplication;
let http: ReturnType<typeof request>;
let bus: RealtimeBus;
let tokenA: string;
let tokenB: string;

const asA = (r: request.Test) => r.set('authorization', `Bearer ${tokenA}`).set('x-organization-id', A.orgId);
const asB = (r: request.Test) => r.set('authorization', `Bearer ${tokenB}`).set('x-organization-id', B.orgId);

async function apiKey(t: Tenant, token: string, scopes: string[], extra: Record<string, unknown> = {}): Promise<{ id: string; plaintext: string }> {
  const r = await http.post('/v1/api-keys').set('authorization', `Bearer ${token}`).set('x-organization-id', t.orgId).send({ name: `k-${uuidv7()}`, scopes, ...extra });
  expect(r.status).toBe(201);
  return r.body;
}

beforeAll(async () => {
  process.env.DB_NAME = TEST_DB;
  process.env.REALTIME_BUS = 'memory';
  process.env.WHATSAPP_API_SEND_RATE_PER_MINUTE = '5';
  process.env.SESSION_SECRET ??= 'test-session-secret-0123456789-abcdefghij';
  process.env.INTERNAL_OPS_TOKEN = 'ops-test-token';
  h = makeHarness();
  A = await seedTenant(h, 'api-a');
  B = await seedTenant(h, 'api-b');
  // B's seeded instance is a live, connected number; A's too.
  const { createApiApp } = await import('../src/api/app-factory.js');
  app = await createApiApp({ swagger: false });
  await app.init();
  http = request(app.getHttpServer());
  bus = app.get(REALTIME_BUS);
  const sessions = app.get(HmacSessionService);
  tokenA = sessions.issue(A.userId);
  tokenB = sessions.issue(B.userId);
});
afterAll(async () => { await app?.close(); await h?.close(); });

describe('tenant isolation on every instance endpoint (IDOR)', () => {
  it('Tenant A cannot see, connect, restart, disconnect, logout or delete Tenant B\'s instance (404, no side effects)', async () => {
    for (const [method, path] of [['get', ''], ['get', '/status'], ['post', '/connect'], ['post', '/restart'], ['post', '/disconnect'],
                                  ['post', '/logout'], ['delete', '']] as const) {
      const r = await asA(http[method](`/v1/whatsapp/instances/${B.instanceId}${path}`));
      expect(r.status, `${method} ${path}`).toBe(404);
      expect(r.body.error.code).toBe('WHATSAPP_INSTANCE_NOT_FOUND');
    }
    const cmds = await h.owner.query(`SELECT count(*)::int AS n FROM app.outbox_events WHERE target_instance_id = $1`, [B.instanceId]);
    expect(cmds.rows[0].n).toBe(0);
    expect((await h.owner.query('SELECT deleted_at FROM app.whatsapp_instances WHERE id = $1', [B.instanceId])).rows[0].deleted_at).toBeNull();
  });

  it('Tenant A cannot fetch Tenant B\'s QR (while B can)', async () => {
    await bus.publish({ type: 'whatsapp.instance.qr', organizationId: B.orgId, instanceId: B.instanceId, at: new Date().toISOString(),
                        data: { qr: '2@B-SECRET-QR', expiresAt: new Date(Date.now() + 30_000).toISOString() } });
    const own = await asB(http.get(`/v1/whatsapp/instances/${B.instanceId}/qr`));
    expect(own.status).toBe(200);
    expect(own.body.qr).toBe('2@B-SECRET-QR');
    const foreign = await asA(http.get(`/v1/whatsapp/instances/${B.instanceId}/qr`));
    expect(foreign.status).toBe(404);
    expect(JSON.stringify(foreign.body)).not.toContain('B-SECRET-QR');
    // A spoofed event tagging A's instance with B's organization is never served to A.
    await bus.publish({ type: 'whatsapp.instance.qr', organizationId: B.orgId, instanceId: A.instanceId, at: new Date().toISOString(),
                        data: { qr: '2@SPOOF-FOR-A', expiresAt: new Date(Date.now() + 30_000).toISOString() } });
    const spoofed = await asA(http.get(`/v1/whatsapp/instances/${A.instanceId}/qr`));
    expect(spoofed.status).toBe(404);
    expect(JSON.stringify(spoofed.body)).not.toContain('SPOOF');
  });

  it('Tenant A cannot send through Tenant B\'s instance nor read B\'s messages', async () => {
    const send = await asA(http.post('/v1/whatsapp/messages/text')).send({ instanceId: B.instanceId, to: '+919811112222', text: 'hijack' });
    expect(send.status).toBe(404);
    const leaked = await h.owner.query(`SELECT count(*)::int AS n FROM app.messages WHERE whatsapp_instance_id = $1 AND text_body = 'hijack'`, [B.instanceId]);
    expect(leaked.rows[0].n).toBe(0);
    const read = await asA(http.get(`/v1/whatsapp/messages/${B.inboundMessageId}`));
    expect(read.status).toBe(404);
    expect((await asB(http.get(`/v1/whatsapp/messages/${B.inboundMessageId}`))).status).toBe(200);
  });

  it('realtime stream: A cannot subscribe to B\'s instance; A\'s stream never carries B\'s events', async () => {
    const server = app.getHttpServer();
    await new Promise<void>((r) => (server.listening ? r() : server.listen(0, r)));
    const port = (server.address() as { port: number }).port;
    const denied = await fetch(`http://127.0.0.1:${port}/v1/whatsapp/instances/${B.instanceId}/events`,
      { headers: { authorization: `Bearer ${tokenA}`, 'x-organization-id': A.orgId } });
    expect(denied.status).toBe(404);

    const ctrl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/v1/whatsapp/instances/${A.instanceId}/events`,
      { headers: { authorization: `Bearer ${tokenA}`, 'x-organization-id': A.orgId }, signal: ctrl.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    let text = '';
    const collect = (async () => { try { for (;;) { const { done, value } = await reader.read(); if (done) break; text += Buffer.from(value).toString(); } } catch { /* aborted */ } })();
    await new Promise((r) => setTimeout(r, 100));
    await bus.publish({ type: 'whatsapp.instance.qr', organizationId: B.orgId, instanceId: B.instanceId, at: '', data: { qr: '2@B-ONLY', expiresAt: new Date(Date.now() + 9e4).toISOString() } });
    await bus.publish({ type: 'whatsapp.instance.qr', organizationId: B.orgId, instanceId: A.instanceId, at: '', data: { qr: '2@SPOOFED', expiresAt: new Date(Date.now() + 9e4).toISOString() } });
    await bus.publish({ type: 'whatsapp.instance.qr', organizationId: A.orgId, instanceId: A.instanceId, at: '', data: { qr: '2@A-OWN', expiresAt: new Date(Date.now() + 9e4).toISOString() } });
    await new Promise((r) => setTimeout(r, 150));
    ctrl.abort();
    await collect;
    expect(text).toContain('event: whatsapp.instance.status');
    expect(text).toContain('2@A-OWN');
    expect(text).not.toContain('2@B-ONLY');
    expect(text).not.toContain('2@SPOOFED');
  });
});

describe('API key authentication and scopes', () => {
  it('Tenant A API key cannot access Tenant B\'s instance', async () => {
    const k = await apiKey(A, tokenA, ['instances:read', 'instances:write', 'messages:send']);
    expect((await http.get(`/v1/whatsapp/instances/${B.instanceId}`).set('x-api-key', k.plaintext)).status).toBe(404);
    expect((await http.post(`/v1/whatsapp/instances/${B.instanceId}/connect`).set('x-api-key', k.plaintext)).status).toBe(404);
    // X-Organization-Id cannot redirect an API key to another tenant.
    const r = await http.get('/v1/whatsapp/instances').set('x-api-key', k.plaintext).set('x-organization-id', B.orgId);
    expect(r.status).toBe(200);
    expect(r.body.map((i: { id: string }) => i.id)).toEqual([A.instanceId]);
  });

  it('valid key works; missing scope 403; revoked and expired keys 401', async () => {
    const reader = await apiKey(A, tokenA, ['instances:read']);
    expect((await http.get('/v1/whatsapp/instances').set('x-api-key', reader.plaintext)).status).toBe(200);
    const noScope = await http.post('/v1/whatsapp/messages/text').set('x-api-key', reader.plaintext).send({ instanceId: A.instanceId, to: '+919811112222', text: 'x' });
    expect(noScope.status).toBe(403);

    const sender = await apiKey(A, tokenA, ['messages:send']);
    const ok = await http.post('/v1/whatsapp/messages/text').set('x-api-key', sender.plaintext).send({ instanceId: A.instanceId, to: '+919811112222', text: 'hi from API' });
    expect(ok.status).toBe(202);
    expect(ok.body).toMatchObject({ status: 'QUEUED' });
    const origin = await h.owner.query('SELECT origin FROM app.messages WHERE id = $1', [ok.body.messageId]);
    expect(origin.rows[0].origin).toBe('API');

    await asA(http.delete(`/v1/api-keys/${sender.id}`)).expect(200);
    const revoked = await http.post('/v1/whatsapp/messages/text').set('x-api-key', sender.plaintext).send({ instanceId: A.instanceId, to: '+919811112222', text: 'after revoke' });
    expect(revoked.status).toBe(401);

    const expiring = await apiKey(A, tokenA, ['messages:send']);
    await h.owner.query(`UPDATE app.api_keys SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day' WHERE id = $1`, [expiring.id]);
    expect((await http.post('/v1/whatsapp/messages/text').set('x-api-key', expiring.plaintext).send({ instanceId: A.instanceId, to: '+919811112222', text: 'x' })).status).toBe(401);
    expect((await http.get('/v1/whatsapp/instances').set('x-api-key', 'hs_live_notakey')).status).toBe(401);
  });

  it('business-restricted key cannot touch another business of the same tenant', async () => {
    const other = await h.owner.query(`INSERT INTO app.businesses (organization_id, name) VALUES ($1, 'ABC Pharmacy') RETURNING id`, [A.orgId]);
    const k = await apiKey(A, tokenA, ['instances:read'], { businessId: other.rows[0].id });
    expect((await http.get(`/v1/whatsapp/instances/${A.instanceId}`).set('x-api-key', k.plaintext)).status).toBe(404);
    expect((await http.get('/v1/whatsapp/instances').set('x-api-key', k.plaintext)).body).toEqual([]);
  });
});

describe('dashboard auth, roles, rate limits, error hygiene', () => {
  it('dashboard session + forged organization header => 403; missing auth => 401', async () => {
    expect((await http.get('/v1/whatsapp/instances').set('authorization', `Bearer ${tokenA}`).set('x-organization-id', B.orgId)).status).toBe(403);
    expect((await http.get('/v1/whatsapp/instances')).status).toBe(401);
    expect((await http.get('/v1/whatsapp/instances').set('authorization', 'Bearer hs1.forged.sig').set('x-organization-id', A.orgId)).status).toBe(401);
  });

  it('VIEWER members can read but cannot connect or send', async () => {
    const viewer = uuidv7();
    await h.owner.query(`INSERT INTO app.users (id, email) VALUES ($1, $2)`, [viewer, `viewer-${viewer}@example.test`]);
    await h.owner.query(`INSERT INTO app.organization_members (organization_id, user_id, role, status, joined_at) VALUES ($1, $2, 'VIEWER', 'ACTIVE', now())`, [A.orgId, viewer]);
    const t = app.get(HmacSessionService).issue(viewer);
    const as = (r: request.Test) => r.set('authorization', `Bearer ${t}`).set('x-organization-id', A.orgId);
    expect((await as(http.get('/v1/whatsapp/instances'))).status).toBe(200);
    expect((await as(http.post(`/v1/whatsapp/instances/${A.instanceId}/connect`))).status).toBe(403);
    expect((await as(http.get(`/v1/whatsapp/instances/${A.instanceId}/qr`))).status).toBe(403);
    expect((await as(http.post('/v1/whatsapp/messages/text')).send({ instanceId: A.instanceId, to: '+919811112222', text: 'x' })).status).toBe(403);
  });

  it('per-principal send rate limit returns 429 WHATSAPP_RATE_LIMITED', async () => {
    const k = await apiKey(A, tokenA, ['messages:send']);
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      statuses.push((await http.post('/v1/whatsapp/messages/text').set('x-api-key', k.plaintext).send({ instanceId: A.instanceId, to: '+919811112222', text: `n${i}` })).status);
    }
    expect(statuses.filter((s) => s === 202)).toHaveLength(5);
    expect(statuses.slice(5)).toEqual([429, 429]);
  });

  it('errors are stable codes without stack traces; invalid recipients are 422', async () => {
    const bad = await asA(http.post('/v1/whatsapp/messages/text')).send({ instanceId: A.instanceId, to: 'not-a-phone', text: 'x' });
    expect(bad.status).toBe(422);
    expect(bad.body).toEqual({ error: { code: 'WHATSAPP_INVALID_RECIPIENT', message: 'recipient is not a valid phone number' } });
    const invalid = await asA(http.post('/v1/whatsapp/instances')).send({ businessId: 'nope', name: '' });
    expect(invalid.status).toBe(400);
    expect(JSON.stringify(invalid.body)).not.toMatch(/at \w+ \(|node_modules|\.ts:\d+/);
  });

  it('internal health requires the ops token and returns aggregates only', async () => {
    expect((await http.get('/internal/health/whatsapp')).status).toBe(403);
    const r = await http.get('/internal/health/whatsapp').set('x-ops-token', 'ops-test-token');
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('instances_by_status');
    expect(JSON.stringify(r.body)).not.toContain(A.orgId);
    expect(JSON.stringify(r.body)).not.toContain(A.instanceId);
  });

  it('OpenAPI document covers the gateway endpoints and the webhook schema', () => {
    const doc = buildOpenApiDocument(app);
    for (const p of ['/v1/whatsapp/instances', '/v1/whatsapp/instances/{id}/connect', '/v1/whatsapp/instances/{id}/events',
                     '/v1/whatsapp/instances/{id}/status', '/v1/whatsapp/instances/{id}/logout', '/v1/whatsapp/messages/text']) {
      expect(doc.paths[p], p).toBeDefined();
    }
    expect(doc.components?.schemas?.WebhookEvent).toBeDefined();
    expect(doc.components?.securitySchemes).toHaveProperty('api-key');
  });
});
