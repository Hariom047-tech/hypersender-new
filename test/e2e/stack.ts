/**
 * E2E stack (TEST-ONLY, never imported by src/): real Nest API + real gateway
 * worker + real PostgreSQL (dedicated *_test database), with only the WhatsApp
 * socket replaced by the fake. A loopback-only control server lets Playwright
 * act as "the phone" (show QR, link, receive messages, deliver receipts).
 *
 *   npx tsx test/e2e/stack.ts      (Playwright starts/stops this itself)
 */
import 'dotenv/config';
import 'reflect-metadata';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proto } from 'baileys';

const DB = process.env.E2E_DB_NAME ?? 'hypersender_e2e_test';
if (!DB.endsWith('_test')) throw new Error('E2E database name must end in _test');
const API_PORT = Number(process.env.E2E_API_PORT ?? 3101);
const CONTROL_PORT = Number(process.env.E2E_CONTROL_PORT ?? 3102);

// Everything the processes print is kept so tests can assert secrets never reach logs.
const printed: string[] = [];
for (const stream of [process.stdout, process.stderr]) {
  const orig = stream.write.bind(stream) as (...a: unknown[]) => boolean;
  (stream as unknown as { write: (...a: unknown[]) => boolean }).write = (chunk: unknown, ...rest: unknown[]) => {
    printed.push(String(chunk));
    return orig(chunk, ...rest);
  };
}

Object.assign(process.env, {
  TEST_DB_NAME: DB, DB_NAME: DB, REALTIME_BUS: 'memory', MEDIA_STORAGE_PROVIDER: 'LOCAL_DEV',
  MEDIA_LOCAL_DIR: mkdtempSync(join(tmpdir(), 'hs-e2e-media-')), WHATSAPP_RECONNECT_ALERT_GRACE_SECONDS: '0',
  SESSION_SECRET: process.env.SESSION_SECRET ?? 'e2e-session-secret-0123456789-abcdefghijkl',
});

// Test-only stand-in for the OpenAI API (deterministic intent script) - E2E never calls a real model.
const { FakeOpenAI } = await import('../fakes/fake-openai.js');
const { intentBrain } = await import('../fakes/intent-brain.js');
const { localDates, seedBusinessData } = await import('../ai-helpers.js');
const fakeModel = await new FakeOpenAI().start();
fakeModel.brain = intentBrain(localDates());
Object.assign(process.env, { OPENAI_API_KEY: 'test-openai-key', OPENAI_BASE_URL: fakeModel.url });

const { bootstrap } = await import('../../scripts/bootstrap.js');
const { migrateUp } = await import('../../scripts/migrate.js');
const { seed } = await import('../../scripts/seed.js');
await bootstrap(DB, { recreate: true });
await migrateUp(DB, () => undefined);
await seed(DB, () => undefined);

const { makeHarness, setPlan } = await import('../helpers.js');
const { makeGateway } = await import('../whatsapp-helpers.js');
const { waText } = await import('../fakes/fake-baileys-socket.js');
const { createApiApp } = await import('../../src/api/app-factory.js');
const { aiProvidersFromEnv } = await import('../../src/ai/model/providers-from-env.js');
const { REALTIME_BUS } = await import('../../src/whatsapp/realtime/realtime-bus.js');
type FakeSock = import('../fakes/fake-baileys-socket.js').FakeBaileysSocket;

const h = makeHarness();
const app = await createApiApp({ swagger: false });
await app.listen(API_PORT, '127.0.0.1');
const rig = makeGateway(h, {
  bus: app.get(REALTIME_BUS),
  config: { connectTimeoutMs: 120_000, outboxPollIntervalMs: 100, webhookPollIntervalMs: 200, staleAfterMs: 30_000, heartbeatIntervalMs: 5_000 },
  ai: aiProvidersFromEnv(),
});
await rig.worker.start();

async function socketFor(instanceId: string): Promise<FakeSock> {
  for (let i = 0; i < 200; i++) {
    const conn = rig.worker.manager.getSession(instanceId)?.connection as unknown as { sock?: FakeSock } | null | undefined;
    if (conn?.sock && !conn.sock.ended) return conn.sock;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('no live socket for instance (did the UI click Connect?)');
}

const STATUS = { DELIVERED: proto.WebMessageInfo.Status.DELIVERY_ACK, READ: proto.WebMessageInfo.Status.READ } as const;

async function searchDatabase(needle: string): Promise<string[]> {
  const tables = await h.owner.query<{ s: string; t: string }>(
    `SELECT table_schema AS s, table_name AS t FROM information_schema.tables
      WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema')`);
  const hits: string[] = [];
  for (const { s, t } of tables.rows) {
    const r = await h.owner.query(`SELECT count(*)::int AS n FROM "${s}"."${t}" x WHERE x::text LIKE $1`, [`%${needle}%`]);
    if (r.rows[0].n > 0) hits.push(`${s}.${t}`);
  }
  return hits;
}

type Handler = (body: any, params: string[]) => Promise<unknown>;
const routes: Array<[string, RegExp, Handler]> = [
  ['GET', /^\/health$/, async () => ({ ok: true })],
  ['POST', /^\/instances\/([\w-]+)\/qr$/, async (_b, [id]) => ({ qr: (await socketFor(id)).qr() })],
  ['POST', /^\/instances\/([\w-]+)\/open$/, async (b, [id]) => {
    const s = await socketFor(id);
    s.mutateCreds((c) => { c.me = { id: `${b.phone}:3@s.whatsapp.net` }; c.registered = true; });
    s.open(b.phone, b.name ?? 'E2E Clinic');
    return { ok: true };
  }],
  ['POST', /^\/instances\/([\w-]+)\/inbound$/, async (b, [id]) => {
    const m = waText(b.from, b.text);
    (await socketFor(id)).upsert([m]);
    return { providerMessageId: m.key.id };
  }],
  ['POST', /^\/instances\/([\w-]+)\/from-me$/, async (b, [id]) => {
    const s = await socketFor(id);
    const m = waText(b.owner, b.text, { fromMe: true, toDigits: b.to });
    s.upsert([m], 'append');
    if (b.twice) s.upsert([m], 'append');
    return { providerMessageId: m.key.id };
  }],
  ['GET', /^\/instances\/([\w-]+)\/sent$/, async (_b, [id]) => (await socketFor(id)).sent.map((x) => ({ jid: x.jid, text: x.content.text, id: x.messageId }))],
  ['POST', /^\/instances\/([\w-]+)\/receipt$/, async (b, [id]) => {
    const s = await socketFor(id);
    const sent = s.sent.find((x) => x.content.text === b.text);
    if (!sent) throw new Error('message not sent by the worker yet');
    s.update([{ key: { remoteJid: sent.jid, fromMe: true, id: sent.messageId }, update: { status: STATUS[b.status as keyof typeof STATUS] } }]);
    return { ok: true };
  }],
  ['POST', /^\/orgs\/([\w-]+)\/plan$/, async (b, [orgId]) => { await setPlan(h, orgId, b.code); return { ok: true }; }],
  ['POST', /^\/orgs\/([\w-]+)\/business-data$/, async (b, [orgId]) => seedBusinessData(h, { orgId } as never, b.businessId)],
  ['POST', /^\/scan$/, async (b) => ({
    logs: printed.some((l) => l.includes(b.needle)) || rig.logs.some((l) => l.includes(b.needle)),
    tables: await searchDatabase(b.needle),
  })],
  ['GET', /^\/webhook-calls$/, async () => rig.http.calls.map((c) => ({ url: c.url, body: c.body }))],
];

const control = createServer((req: IncomingMessage, res: ServerResponse) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', async () => {
    const path = (req.url ?? '/').split('?')[0];
    for (const [method, re, fn] of routes) {
      const m = re.exec(path);
      if (m && method === req.method) {
        try {
          const out = await fn(raw ? JSON.parse(raw) : {}, m.slice(1));
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
        } catch (err) {
          res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: (err as Error).message }));
        }
        return;
      }
    }
    res.writeHead(404).end();
  });
});
control.listen(CONTROL_PORT, '127.0.0.1');
console.log(`e2e stack ready: api :${API_PORT}, control :${CONTROL_PORT}, db ${DB}`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  control.close();
  await rig.worker.stop().catch(() => undefined);
  await fakeModel.stop().catch(() => undefined);
  await app.close().catch(() => undefined);
  await h.close().catch(() => undefined);
  process.exit(0);
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
