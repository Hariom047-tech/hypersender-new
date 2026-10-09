import { createRequire } from 'node:module';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '../src/common/uuid.js';
import { createLogger } from '../src/common/logger.js';
import { WhatsAppRepository } from '../src/repositories/whatsapp.repository.js';
import type { ProviderEvent } from '../src/whatsapp/domain/whatsapp-events.js';
import { createBaileysAuthPort } from '../src/whatsapp/providers/baileys/baileys-auth-store.js';
import { BaileysSession } from '../src/whatsapp/providers/baileys/baileys-session.js';
import { InMemoryRealtimeBus } from '../src/whatsapp/realtime/realtime-bus.js';
import { FakeSocketFactory } from './fakes/fake-baileys-socket.js';
import { asUser, makeHarness, registerWorker, seedTenant, type Harness, type Tenant } from './helpers.js';
import { drainRouted, makeApiServices, makeGateway, settle, waitFor, type GatewayRig } from './whatsapp-helpers.js';

let h: Harness;
let T: Tenant;
const PHONE = '919900022233';

beforeAll(async () => {
  h = makeHarness();
  T = await seedTenant(h, 'sessions');
  // This file links many instances: test-only plan with unlimited instances (the limit itself is tested elsewhere).
  await h.owner.query(`INSERT INTO app.subscription_plans (code, name, billing_interval, price_minor_units, currency)
                       VALUES ('TEST_UNLIMITED', 'Test', 'MONTH', 0, 'INR') ON CONFLICT (code) DO NOTHING`);
  await h.owner.query(`INSERT INTO app.plan_entitlements (plan_id, feature_key, limit_value, enabled)
                       SELECT id, 'MAX_WHATSAPP_INSTANCES', NULL, true FROM app.subscription_plans WHERE code = 'TEST_UNLIMITED'
                       ON CONFLICT (plan_id, feature_key) DO NOTHING`);
  await h.owner.query(`UPDATE app.subscriptions SET plan_id = (SELECT id FROM app.subscription_plans WHERE code = 'TEST_UNLIMITED') WHERE organization_id = $1`, [T.orgId]);
});
afterAll(async () => h.close());

/** Each test starts from a clean slate: no other session of this tenant is eligible for boot-restore. */
async function quiesce(): Promise<void> {
  await h.owner.query(`UPDATE app.whatsapp_instances SET status = 'DISCONNECTED', worker_id = NULL, worker_lease_expires_at = NULL
                        WHERE organization_id = $1 AND status IN ('CONNECTED','RECONNECTING','WAITING_FOR_QR','PAIRING')`, [T.orgId]);
}
beforeEach(quiesce);

const row = async (id: string) => (await h.owner.query(
  'SELECT status, worker_id, worker_lease_token, reconnect_attempts FROM app.whatsapp_instances WHERE id = $1', [id])).rows[0];

/** Links a fresh instance on `rig` (QR -> open) and returns its id. */
async function linkedInstance(rig: GatewayRig, api: ReturnType<typeof makeApiServices>, phone: string): Promise<string> {
  const inst = await api.instances.create(asUser(T), { businessId: T.businessId, name: `inst-${uuidv7().slice(-6)}` });
  await api.instances.command(asUser(T), inst.id, 'CONNECT');
  await drainRouted(rig);
  const s = rig.fake.last;
  s.qr();
  s.mutateCreds((c) => { c.me = { id: `${phone}:5@s.whatsapp.net`, name: 'Clinic' }; c.registered = true; });
  s.open(phone);
  await settle(rig, inst.id);
  expect((await row(inst.id)).status).toBe('CONNECTED');
  return inst.id;
}

describe('session restore across worker restarts', () => {
  it('graceful shutdown keeps the link; a NEW session manager restores it from encrypted PostgreSQL without any QR', async () => {
    const bus = new InMemoryRealtimeBus();
    const rigA = makeGateway(h, { bus });
    const api = makeApiServices(h, bus, rigA.media);
    await rigA.worker.start({ loops: false });
    const id = await linkedInstance(rigA, api, PHONE);
    const storedMe = rigA.fake.last.config.auth.creds.me?.id;
    const noise = Buffer.from(rigA.fake.last.config.auth.creds.noiseKey.private).toString('hex');

    await rigA.worker.stop(); // SIGTERM path
    expect(rigA.fake.last.logoutCalls).toBe(0); // shutdown must NOT unlink the device
    expect(await row(id)).toMatchObject({ status: 'RECONNECTING', worker_id: null });
    expect((await h.owner.query('SELECT count(*)::int AS n FROM app.whatsapp_auth_credentials WHERE instance_id = $1', [id])).rows[0].n).toBe(1);

    const rigB = makeGateway(h, { bus }); // brand-new process/manager, different worker id
    await rigB.worker.start({ loops: false }); // boot restore
    await waitFor(() => rigB.fake.sockets.length > 0, 3000, 'restored socket');
    const cfg = rigB.fake.last.config;
    expect(cfg.auth.creds.me?.id).toBe(storedMe);                                          // decrypted auth reached the provider
    expect(Buffer.from(cfg.auth.creds.noiseKey.private).toString('hex')).toBe(noise);
    rigB.fake.last.open(PHONE);
    await settle(rigB, id);
    expect(await row(id)).toMatchObject({ status: 'CONNECTED' });
    expect(rigB.events.filter((e) => e.type === 'whatsapp.instance.qr' && e.instanceId === id)).toHaveLength(0); // no QR needed
    await rigB.worker.stop();
  });

  it('restore is bounded by WHATSAPP_RESTORE_CONCURRENCY', async () => {
    const bus = new InMemoryRealtimeBus();
    const rigA = makeGateway(h, { bus });
    const api = makeApiServices(h, bus, rigA.media);
    await rigA.worker.start({ loops: false });
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push(await linkedInstance(rigA, api, `91990003333${i}`));
    await rigA.worker.stop();

    const fake = new FakeSocketFactory();
    const original = fake.factory;
    let inFlight = 0; let peak = 0;
    // Each fake socket completes its "handshake" (opens) 50 ms after creation.
    (fake as { factory: typeof original }).factory = (config) => {
      inFlight++; peak = Math.max(peak, inFlight);
      const sock = original(config);
      const s = fake.last;
      setTimeout(() => { inFlight--; s.open(`91990004444${fake.sockets.indexOf(s)}`); }, 50);
      return sock;
    };
    const rigB = makeGateway(h, { bus, fake, config: { restoreConcurrency: 2 } });
    await rigB.worker.start({ loops: false });
    expect(fake.sockets.length).toBeGreaterThanOrEqual(4);
    expect(peak).toBeLessThanOrEqual(2);
    await rigB.worker.stop();
  });
});

describe('worker ownership', () => {
  it('B cannot restore a session A owns; after A goes stale B takes over and A can no longer persist auth', async () => {
    const bus = new InMemoryRealtimeBus();
    const rigA = makeGateway(h, { bus });
    const api = makeApiServices(h, bus, rigA.media);
    await rigA.worker.start({ loops: false });
    const id = await linkedInstance(rigA, api, '919900044455');
    const sockA = rigA.fake.last;
    const tokenA = (await row(id)).worker_lease_token;

    const rigB = makeGateway(h, { bus });
    await rigB.worker.start({ loops: false });
    expect(await rigB.worker.manager.restore(id, T.orgId)).toBe('OWNED_BY_ANOTHER_WORKER');
    expect(rigB.fake.sockets).toHaveLength(0);

    // A stops heartbeating (crash/partition): its lease expires.
    await h.owner.query(`UPDATE app.whatsapp_instances SET worker_lease_expires_at = now() - interval '1 second' WHERE id = $1`, [id]);
    expect(await rigB.worker.manager.restore(id, T.orgId)).toBe('RESTORED');
    expect((await row(id)).worker_lease_token).toBe(tokenA + 1);

    // Stale A tries to persist new credentials: rejected by the fencing token, DB unchanged.
    const before = (await h.owner.query('SELECT encrypted_credentials FROM app.whatsapp_auth_credentials WHERE instance_id = $1', [id])).rows[0].encrypted_credentials;
    sockA.mutateCreds((c) => { c.lastPropHash = 'stale-worker-write'; });
    await waitFor(() => rigA.worker.manager.getSession(id) === undefined, 3000, 'A drops the session');
    const after = (await h.owner.query('SELECT encrypted_credentials FROM app.whatsapp_auth_credentials WHERE instance_id = $1', [id])).rows[0].encrypted_credentials;
    expect(Buffer.compare(before, after)).toBe(0);
    expect(rigA.logs.join('\n')).toContain('whatsapp.session_dropped');

    // A's stale state write is refused too.
    await expect(h.workerTx.run({}, (db) => new WhatsAppRepository().assertLease(db, id, rigA.config.workerId, tokenA))).rejects.toMatchObject({ code: '55P03' });
    await rigA.worker.stop();
    await rigB.worker.stop();
  });

  it('heartbeat detects lost ownership and stops the local socket without DB writes', async () => {
    const bus = new InMemoryRealtimeBus();
    const rigA = makeGateway(h, { bus });
    const api = makeApiServices(h, bus, rigA.media);
    await rigA.worker.start({ loops: false });
    const id = await linkedInstance(rigA, api, '919900055566');
    const thief = await registerWorker(h, 'thief');
    await h.owner.query(`UPDATE app.whatsapp_instances SET worker_id = $2, worker_lease_token = worker_lease_token + 1 WHERE id = $1`, [id, thief]);
    await rigA.worker.manager.heartbeatOnce();
    expect(rigA.worker.manager.getSession(id)).toBeUndefined();
    expect((await row(id)).worker_id).toBe(thief);
    const w = await h.owner.query('SELECT status, active_sessions FROM app.whatsapp_workers WHERE id = $1', [rigA.config.workerId]);
    expect(w.rows[0]).toEqual({ status: 'ACTIVE', active_sessions: 0 });
    await rigA.worker.stop();
  });

  it('stale workers are reaped; queued sends for an unreachable instance fail after the TTL', async () => {
    const bus = new InMemoryRealtimeBus();
    const rig = makeGateway(h, { bus, config: { sendQueueTtlSeconds: 1 } });
    const api = makeApiServices(h, bus, rig.media);
    await rig.worker.start({ loops: false });
    const id = await linkedInstance(rig, api, '919900066677');
    const q = await api.messages.sendText(asUser(T), { instanceId: id, to: '+919811112222', text: 'will expire' });
    // Instance owner vanishes before sending.
    const ghost = await registerWorker(h, 'ghost');
    await h.owner.query(`UPDATE app.whatsapp_workers SET last_heartbeat_at = now() - interval '1 hour' WHERE id = $1`, [ghost]);
    await h.owner.query(`UPDATE app.whatsapp_instances SET worker_id = $2, worker_lease_expires_at = now() - interval '1 second' WHERE id = $1`, [id, ghost]);
    await h.owner.query(`UPDATE app.outbox_events SET created_at = now() - interval '1 minute' WHERE aggregate_id = $1`, [q.messageId]);
    await rig.worker.manager.heartbeatOnce();
    expect((await h.owner.query('SELECT status FROM app.whatsapp_workers WHERE id = $1', [ghost])).rows[0].status).toBe('DEAD');
    await drainRouted(rig);
    const m = await h.owner.query('SELECT status, error_code FROM app.messages WHERE id = $1', [q.messageId]);
    expect(m.rows[0]).toEqual({ status: 'FAILED', error_code: 'WHATSAPP_INSTANCE_NOT_CONNECTED' });
    await rig.worker.stop();
  });
});

describe('pairing code and QR expiry', () => {
  it('pairing code: PAIRING state, code delivered only to the caller via the bus', async () => {
    const bus = new InMemoryRealtimeBus();
    const rig = makeGateway(h, { bus });
    const api = makeApiServices(h, bus, rig.media);
    await rig.worker.start({ loops: false });
    const inst = await api.instances.create(asUser(T), { businessId: T.businessId, name: 'pairing' });
    const pending = api.instances.requestPairingCode(asUser(T), inst.id, '+919900077788');
    await waitFor(async () => (await rig.worker.processRoutedOnce()) > 0 || rig.fake.sockets.length > 0, 3000, 'command');
    rig.fake.last.qr(); // Baileys is ready -> adapter requests the pairing code instead of showing a QR
    expect(await pending).toEqual({ pairingCode: 'ABCD1234', expiresInSeconds: 60 });
    await settle(rig, inst.id);
    expect((await row(inst.id)).status).toBe('PAIRING');
    expect(rig.events.some((e) => e.type === 'whatsapp.instance.qr' && e.instanceId === inst.id)).toBe(false);
    expect(rig.logs.join('\n')).not.toContain('ABCD1234');
    await rig.worker.stop();
  });

  it('QR window elapsing without a scan: DISCONNECTED (QR_EXPIRED), lease released, no reconnect loop', async () => {
    const bus = new InMemoryRealtimeBus();
    const rig = makeGateway(h, { bus });
    const api = makeApiServices(h, bus, rig.media);
    await rig.worker.start({ loops: false });
    const inst = await api.instances.create(asUser(T), { businessId: T.businessId, name: 'qr-expiry' });
    await api.instances.command(asUser(T), inst.id, 'CONNECT');
    await drainRouted(rig);
    rig.fake.last.qr();
    await settle(rig, inst.id);
    rig.fake.last.close(408);
    await waitFor(async () => (await row(inst.id)).status === 'DISCONNECTED', 3000, 'QR expired');
    expect(await row(inst.id)).toMatchObject({ worker_id: null });
    await new Promise((r) => setTimeout(r, 100));
    expect(rig.fake.sockets).toHaveLength(1);
    await rig.worker.stop();
  });
});

describe('REAL Baileys socket (no WhatsApp account): compiled + constructed against the installed package', () => {
  it('makeWASocket loads our encrypted DB auth, dials the configured endpoint, and its close is mapped by our adapter', async () => {
    const require = createRequire(import.meta.url);
    const { WebSocketServer } = require('ws') as { WebSocketServer: new (o: { port: number }) => { on: (e: string, f: (...a: any[]) => void) => void; close: () => void; address: () => { port: number } } };
    const wss = new WebSocketServer({ port: 0 });
    const handshake = new Promise<{ bytes: number }>((resolve) => {
      wss.on('connection', (ws: { on: (e: string, f: (d: Buffer) => void) => void; close: () => void }) => {
        ws.on('message', (data: Buffer) => { resolve({ bytes: data.length }); setTimeout(() => ws.close(), 20); });
      });
    });

    const inst = await h.owner.query(
      `INSERT INTO app.whatsapp_instances (organization_id, business_id, instance_name) VALUES ($1, $2, 'real-socket') RETURNING id`, [T.orgId, T.businessId]);
    const id = inst.rows[0].id;
    const worker = await registerWorker(h, 'real-socket-worker');
    const token = await h.workerTx.run({}, (db) => new WhatsAppRepository().claimLeaseForLink(db, id, worker, 60));
    const events: ProviderEvent[] = [];
    const session = await BaileysSession.open({
      instanceId: id,
      auth: createBaileysAuthPort({ tx: h.workerTx, repo: new WhatsAppRepository(), keys: h.keys, organizationId: T.orgId, instanceId: id, workerId: worker, leaseToken: token! }),
      requireExistingAuth: false, markOnline: false, onEvent: (e) => { events.push(e); },
    }, { logger: createLogger({ level: 'silent' }), baileysLogLevel: 'silent', qrTimeoutMs: 20_000, connectTimeoutMs: 5_000, mediaMaxBytes: 1024,
         waWebSocketUrl: `ws://127.0.0.1:${wss.address().port}` });

    const hs = await handshake;          // Baileys really opened a WebSocket and sent its Noise hello
    expect(hs.bytes).toBeGreaterThan(20);
    await waitFor(() => events.find((e) => e.type === 'closed'), 10_000, 'close event');
    const closed = events.find((e) => e.type === 'closed') as Extract<ProviderEvent, { type: 'closed' }>;
    expect(['QR_EXPIRED', 'TRANSIENT']).toContain(closed.category); // unregistered creds + server hang-up
    expect(events.some((e) => e.type === 'connecting')).toBe(true);
    // initAuthCreds() output was persisted encrypted before dialling.
    const creds = await h.owner.query('SELECT octet_length(encrypted_credentials) AS n, key_reference FROM app.whatsapp_auth_credentials WHERE instance_id = $1', [id]);
    expect(creds.rows[0].n).toBeGreaterThan(500);
    expect(session.getConnectionState()).toBe('CLOSED');
    wss.close();
  });
});
