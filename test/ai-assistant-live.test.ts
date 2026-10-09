import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { aiProvidersFromEnv } from '../src/ai/model/providers-from-env.js';
import { ToolExecutor, type ExecutorScope, type LoadedTool } from '../src/ai/tools/executor.js';
import { ToolRegistry, DEFAULT_TOOLS } from '../src/ai/tools/registry.js';
import { MemoryPendingActionStore } from '../src/ai/runtime/pending-store.js';
import { loadDraftSnapshot } from '../src/ai/runtime/assistant-config.js';
import { loadRunTools } from '../src/ai/runtime/tool-loader.js';
import { BookingRepository } from '../src/repositories/booking.repository.js';
import { KnowledgeRepository } from '../src/repositories/knowledge.repository.js';
import { OpsRepository } from '../src/repositories/ops.repository.js';
import { BookingService } from '../src/services/booking.service.js';
import { LeadService } from '../src/services/lead.service.js';
import { OrderingService } from '../src/ordering/ordering.service.js';
import { istInstant, localDates, seedBusinessData, type Clinic } from './ai-helpers.js';
import { waText } from './fakes/fake-baileys-socket.js';
import { FakeOpenAI } from './fakes/fake-openai.js';
import { intentBrain } from './fakes/intent-brain.js';
import { makeHarness, seedTenant, type Harness, type Tenant } from './helpers.js';
import { sleep, startApi, type Api } from './saas-helpers.js';
import { drainRouted, makeGateway, settle, type GatewayRig } from './whatsapp-helpers.js';

let h: Harness;
let api: Api;
let fake: FakeOpenAI;
let rig: GatewayRig;
let A: Tenant;
let B: Tenant;
let clinic: Clinic;
let clinicB: Clinic;
let instanceId: string;
let assistantId: string;
const OWNER = '919900077788';
const d = localDates();
const as = (t: Tenant) => <T extends import('supertest').Test>(r: T) => api.as(t.userId, t.orgId)(r);
const sock = () => rig.fake.last;
let phoneSeq = 0;
const newCustomer = () => `9198111${String(20000 + phoneSeq++).padStart(5, '0')}`;
const REASONING_MARKER = 'ENCRYPTED-REASONING-MARKER-7f3a';

/** Drives the whole pipeline until quiet: ingestion -> relay -> AI turns -> routed sends -> relay. */
async function pump(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await settle(rig, instanceId);
    const a = await rig.worker.relay.relayBatch('relay-live', 200);
    const b = await rig.worker.assistant!.processOnce();
    await drainRouted(rig);
    const c = await rig.worker.relay.relayBatch('relay-live', 200);
    if (a + b + c === 0 && i > 1) return;
  }
}
async function say(from: string, text: string) { sock().upsert([waText(from, text)]); await pump(); }
const sentTo = (phone: string) => sock().sent.filter((s) => s.jid.startsWith(phone)).map((s) => String(s.content.text));
const conv = async (phone: string) => (await h.owner.query(
  `SELECT c.* FROM app.conversations c JOIN app.contacts ct ON ct.id = c.contact_id WHERE ct.phone_e164 = $1 AND c.organization_id = $2`, [`+${phone}`, A.orgId])).rows[0];

beforeAll(async () => {
  fake = await new FakeOpenAI().start();
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.OPENAI_BASE_URL = fake.url;
  process.env.AI_MODEL_RETRY_DELAY_MS = '10';
  h = makeHarness();
  api = await startApi();
  A = await seedTenant(h, 'ai-live-a');
  B = await seedTenant(h, 'ai-live-b');
  clinic = await seedBusinessData(h, A);
  clinicB = await seedBusinessData(h, B);
  rig = makeGateway(h, { bus: api.bus, ai: aiProvidersFromEnv(), config: { staleAfterMs: 600_000 } });
  await rig.worker.start({ loops: false });
  instanceId = (await as(A)(api.http.post('/v1/whatsapp/instances')).send({ businessId: A.businessId, name: 'Clinic main' })).body.id;
  await as(A)(api.http.post(`/v1/whatsapp/instances/${instanceId}/connect`)).expect(202);
  await drainRouted(rig);
  sock().qr();
  sock().mutateCreds((c) => { c.me = { id: `${OWNER}:3@s.whatsapp.net` }; c.registered = true; });
  sock().open(OWNER);
  await settle(rig, instanceId);
  assistantId = (await as(A)(api.http.post('/v1/ai/assistants')).send({ templateKey: 'DOCTOR_APPOINTMENT', businessId: A.businessId, name: 'Priya from ABC Dental' })).body.id;
  await as(A)(api.http.patch(`/v1/ai/assistants/${assistantId}`)).send({ responseWaitMs: 0 }).expect(200);
  await as(A)(api.http.put(`/v1/ai/assistants/${assistantId}/whatsapp`)).send({ whatsappInstanceId: instanceId }).expect(200);
  const pub = await as(A)(api.http.post(`/v1/ai/assistants/${assistantId}/publish`)).expect(200);
  expect(pub.body.published).toBe(true);
  await pump();
});
afterAll(async () => {
  // Leave no restorable session behind for later test files: delete (logout + destroy auth) through the real API.
  const own = (await h.owner.query('SELECT id FROM app.whatsapp_instances WHERE organization_id = $1 AND id <> $2 AND deleted_at IS NULL', [A.orgId, A.instanceId])).rows;
  for (const i of own) await as(A)(api.http.delete(`/v1/whatsapp/instances/${i.id}`));
  await drainRouted(rig);
  await rig.worker.stop(); await api.app.close(); await h.close(); await fake.stop(); });
beforeEach(() => fake.reset(intentBrain(d)));

describe('live WhatsApp assistant', () => {
  it('inbound -> assistant -> availability -> confirmation -> booking, replies sent through our gateway', async () => {
    const cust = newCustomer();
    const brain = intentBrain(d);
    let first = true;
    fake.brain = (t) => { const r = brain(t); if (first) { first = false; return { ...r, reasoningMarker: REASONING_MARKER }; } return r; };
    await say(cust, 'Kal Dr Sharma ki appointment chahiye');
    expect(sentTo(cust).at(-1)).toMatch(/Available slots: /);
    await say(cust, '4 baje book kar do, naam Rahul');
    expect(sentTo(cust).at(-1)).toMatch(/Confirm karein: Book .*Dr Sharma.*Rahul/);
    const pending = (await h.owner.query(`SELECT state, args_ciphertext, summary FROM app.ai_pending_actions WHERE organization_id = $1 AND state = 'WAITING'`, [A.orgId])).rows[0];
    expect(pending.state).toBe('WAITING');
    expect(Buffer.from(pending.args_ciphertext).toString('latin1')).not.toMatch(/Rahul|start_at/); // encrypted arguments
    expect((await h.owner.query(`SELECT count(*)::int AS n FROM app.bookings WHERE organization_id = $1 AND customer_name = 'Rahul'`, [A.orgId])).rows[0].n).toBe(0);

    await say(cust, 'haan');
    expect(sentTo(cust).at(-1)).toMatch(/Aapki booking confirm ho gayi/);
    const bookings = (await h.owner.query(
      `SELECT b.status, b.created_by_type, b.ai_agent_id, b.source, b.start_at, r.name FROM app.bookings b JOIN app.business_resources r ON r.id = b.resource_id
        WHERE b.organization_id = $1 AND b.customer_name = 'Rahul'`, [A.orgId])).rows;
    expect(bookings).toHaveLength(1);
    expect(bookings[0]).toMatchObject({ status: 'CONFIRMED', created_by_type: 'AI', ai_agent_id: assistantId, source: 'AI_WHATSAPP', name: 'Dr Sharma' });
    expect(new Date(bookings[0].start_at).toISOString()).toBe(istInstant(d.tomorrow, '16:00').toISOString());
    expect((await h.owner.query(`SELECT state FROM app.ai_pending_actions WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 1`, [A.orgId])).rows[0].state).toBe('EXECUTED');

    // Outbound replies are AI messages sent through the gateway (never the fake "model" talking to WhatsApp directly).
    const c = await conv(cust);
    const ai = (await h.owner.query(`SELECT origin, is_ai_generated, ai_agent_id, status FROM app.messages WHERE conversation_id = $1 AND direction = 'OUTBOUND'`, [c.id])).rows;
    expect(ai).toHaveLength(3);
    expect(ai.every((m) => m.origin === 'AI' && m.is_ai_generated && m.ai_agent_id === assistantId && m.status === 'SENT')).toBe(true);
    const runs = (await h.owner.query(`SELECT status, outcome, input_tokens, output_tokens, model_name, tool_iterations FROM app.ai_runs WHERE conversation_id = $1 ORDER BY created_at`, [c.id])).rows;
    expect(runs.map((r) => r.outcome)).toEqual(['REPLIED', 'REPLIED', 'REPLIED']);
    expect(runs.every((r) => r.status === 'SUCCEEDED' && r.input_tokens > 0 && r.model_name === 'gpt-5-mini')).toBe(true);
    const calls = (await h.owner.query(
      `SELECT t.key, c.status, c.arguments, c.result_summary FROM app.ai_tool_calls c JOIN app.ai_tools t ON t.id = c.tool_id
         JOIN app.ai_runs r ON r.id = c.ai_run_id WHERE r.conversation_id = $1 ORDER BY c.created_at`, [c.id])).rows;
    expect(calls.map((x) => x.key)).toEqual(['GET_RESOURCES', 'CHECK_AVAILABILITY', 'GET_RESOURCES', 'CHECK_AVAILABILITY', 'CREATE_BOOKING', 'CREATE_BOOKING']);
    const usage = (await h.owner.query(`SELECT event_type, sum(quantity)::int AS q FROM app.usage_events WHERE organization_id = $1 AND resource_type = 'AI_RUN' GROUP BY 1`, [A.orgId])).rows;
    expect(Object.fromEntries(usage.map((u) => [u.event_type, u.q]))).toMatchObject({ AI_ASSISTANT_RUN: 3, AI_TOOL_CALL: expect.any(Number) });
    // No hidden reasoning / prompt persisted anywhere.
    const dump = JSON.stringify((await h.owner.query(
      `SELECT (SELECT json_agg(r) FROM app.ai_runs r WHERE r.organization_id = $1) AS runs, (SELECT json_agg(c) FROM app.ai_tool_calls c WHERE c.organization_id = $1) AS calls,
              (SELECT json_agg(s) FROM app.ai_conversation_states s WHERE s.organization_id = $1) AS states`, [A.orgId])).rows[0]);
    expect(dump).not.toContain(REASONING_MARKER);
    expect(dump).not.toMatch(/PLATFORM RULES|WHEN TO HAND OFF/);
    // The encrypted reasoning item WAS replayed to the provider within the same turn only.
    expect(JSON.stringify(fake.requests.map((r) => r.body.input))).toContain(REASONING_MARKER);
  });

  it('answered messages get read receipts (blue ticks) and the chat shows "typing..." while the assistant works', async () => {
    const cust = newCustomer();
    const msg = waText(cust, 'Kal Dr Sharma ki appointment chahiye');
    const readsBefore = sock().reads.length;
    sock().upsert([msg]);
    await pump();
    expect(sentTo(cust).at(-1)).toMatch(/Available slots: /);
    expect(sock().reads.slice(readsBefore)).toContainEqual({ remoteJid: `${cust}@s.whatsapp.net`, id: msg.key.id });
    expect(sock().presence).toContainEqual({ type: 'composing', jid: `${cust}@s.whatsapp.net` });

    // A chat the AI does not answer (handed to a human) is NOT auto-read: the team reads it themselves.
    const c = await conv(cust);
    await h.owner.query(`UPDATE app.conversations SET handling_mode = 'HUMAN' WHERE id = $1`, [c.id]);
    const later = waText(cust, 'hello?');
    sock().upsert([later]);
    await pump();
    expect(sock().reads.map((r) => r.id)).not.toContain(later.key.id);
    await h.owner.query(`UPDATE app.conversations SET handling_mode = 'AI' WHERE id = $1`, [c.id]);
  });

  it('an expired confirmation is never executed', async () => {
    const cust = newCustomer();
    await say(cust, 'Kal Dr Mehta ki appointment chahiye');
    await say(cust, '5 baje book kar do, naam Asha');
    await h.owner.query(`UPDATE app.ai_pending_actions SET expires_at = created_at + interval '1 second' WHERE organization_id = $1 AND state = 'WAITING'`, [A.orgId]);
    await sleep(1100);
    await say(cust, 'haan');
    expect(sentTo(cust).at(-1)).toMatch(/CONFIRMATION_EXPIRED/);
    expect((await h.owner.query(`SELECT count(*)::int AS n FROM app.bookings WHERE organization_id = $1 AND customer_name = 'Asha'`, [A.orgId])).rows[0].n).toBe(0);
    expect((await h.owner.query(`SELECT state FROM app.ai_pending_actions WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 1`, [A.orgId])).rows[0].state).toBe('EXPIRED');
  });

  it('HUMAN_HANDOFF: conversation goes to HUMAN, team notified, the AI stops replying', async () => {
    const cust = newCustomer();
    await say(cust, 'Mujhe kisi staff se baat karni hai');
    expect(sentTo(cust).at(-1)).toMatch(/team member/);
    const c = await conv(cust);
    expect(c.handling_mode).toBe('HUMAN');
    expect((await h.owner.query(`SELECT count(*)::int AS n FROM app.notifications WHERE organization_id = $1 AND type = 'AI_HANDOFF'`, [A.orgId])).rows[0].n).toBeGreaterThan(0);
    const before = sentTo(cust).length;
    await say(cust, 'hello?');
    expect(sentTo(cust).length).toBe(before);
    const last = (await h.owner.query(`SELECT count(*)::int AS n FROM app.ai_runs WHERE conversation_id = $1`, [c.id])).rows[0].n;
    expect(last).toBe(1);
    // Inbox "Resume AI" hands it back.
    await as(A)(api.http.post(`/v1/conversations/${c.id}/handling`)).send({ mode: 'AI' }).expect(200);
    await say(cust, 'Kal clinic kitne baje khule hain?');
    expect(sentTo(cust).length).toBe(before + 1);
  });

  it('manual reply from the owner\'s phone pauses the AI; the AI\'s own echo never does', async () => {
    const cust = newCustomer();
    await say(cust, 'Kal timings kya hain?');
    const c = await conv(cust);
    expect(c.handling_mode).toBe('AI');
    // WhatsApp echoes the AI's own message back as fromMe with the same provider id -> deduplicated, no takeover.
    const aiSent = sock().sent.filter((s) => s.jid.startsWith(cust)).at(-1)!;
    sock().upsert([{ key: { remoteJid: aiSent.jid, fromMe: true, id: aiSent.messageId }, messageTimestamp: Math.floor(Date.now() / 1000),
      message: { conversation: String(aiSent.content.text) } } as any], 'append');
    await pump();
    expect((await conv(cust)).handling_mode).toBe('AI');
    // The owner types on the phone -> takeover.
    sock().upsert([waText(OWNER, 'Main dekh leta hoon, ek minute', { fromMe: true, toDigits: cust })], 'append');
    await pump();
    expect((await conv(cust)).handling_mode).toBe('HUMAN');
    const before = sentTo(cust).length;
    await say(cust, 'ok thanks');
    expect(sentTo(cust).length).toBe(before);
  });

  it('a dashboard reply also pauses the AI (takeover policy PAUSE_AI)', async () => {
    const cust = newCustomer();
    await say(cust, 'Kal timings kya hain?');
    const c = await conv(cust);
    await as(A)(api.http.post(`/v1/conversations/${c.id}/messages`)).send({ text: 'Hi, this is Dr Sharma\'s assistant (human).', clientRequestId: crypto.randomUUID() }).expect(202);
    await pump();
    expect((await conv(cust)).handling_mode).toBe('HUMAN');
  });

  it('PAUSED assistant and DRAFT (unpublished) assistant never answer live customers', async () => {
    await as(A)(api.http.post(`/v1/ai/assistants/${assistantId}/pause`)).expect(200);
    const cust = newCustomer();
    await say(cust, 'Kal timings kya hain?');
    expect(sentTo(cust)).toEqual([]);
    await as(A)(api.http.post(`/v1/ai/assistants/${assistantId}/resume`)).expect(200);

    // Another number with a DRAFT assistant attached: nothing happens.
    const draft = (await as(A)(api.http.post('/v1/ai/assistants')).send({ templateKey: 'GENERAL_BUSINESS_ASSISTANT', businessId: A.businessId, name: 'Draft bot' })).body.id;
    const inst2 = (await as(A)(api.http.post('/v1/whatsapp/instances')).send({ businessId: A.businessId, name: 'Second' })).body.id;
    await as(A)(api.http.put(`/v1/ai/assistants/${draft}/whatsapp`)).send({ whatsappInstanceId: inst2 }).expect(200);
    const n = (await h.owner.query('SELECT count(*)::int AS n FROM app.ai_runs WHERE ai_agent_id = $1', [draft])).rows[0].n;
    expect(n).toBe(0);
    const resp = await h.workerTx.inTenant((db) => db.query(`SELECT 1 FROM app.ai_agents WHERE id = $1 AND status = 'ACTIVE' AND auto_reply_enabled`, [draft]), { organizationId: A.orgId });
    expect(resp.rowCount).toBe(0);
  });

  it('model failure: retried conservatively, then a safe fallback + handoff; the customer message is kept', async () => {
    const cust = newCustomer();
    fake.failNext = 10;
    await say(cust, 'Kal Dr Sharma ki appointment chahiye');
    expect(sentTo(cust).at(-1)).toMatch(/verify nahi kar pa rahi|can't verify/);
    const c = await conv(cust);
    expect(c.handling_mode).toBe('HUMAN');
    const run = (await h.owner.query('SELECT status, outcome, error_code FROM app.ai_runs WHERE conversation_id = $1', [c.id])).rows[0];
    expect(run).toMatchObject({ status: 'FAILED', outcome: 'FALLBACK', error_code: 'MODEL_UNAVAILABLE' });
    expect((await h.owner.query(`SELECT count(*)::int AS n FROM app.messages WHERE conversation_id = $1 AND direction = 'INBOUND'`, [c.id])).rows[0].n).toBe(1);
    expect((await h.owner.query(`SELECT count(*)::int AS n FROM app.notifications WHERE organization_id = $1 AND type = 'AI_ASSISTANT_FAILING'`, [A.orgId])).rows[0].n).toBeGreaterThan(0);
    fake.failNext = 0;
  });

  it('the assistant cannot claim an action no tool confirmed', async () => {
    const cust = newCustomer();
    fake.brain = () => ({ text: 'Aapki appointment kal 4 baje book ho gayi hai!' });
    await say(cust, 'Kal 4 baje appointment book kar do');
    const replies = sentTo(cust);
    expect(replies.join(' ')).not.toMatch(/book ho gayi/);
    expect(replies.at(-1)).toMatch(/verify nahi kar pa rahi|can't verify/);
    expect(fake.requests.at(-1)!.instructions).toContain('# CORRECTION');
  });

  it('multi-tool turn: parallel reads, then sequential availability -> booking, one reply', async () => {
    const cust = newCustomer();
    await say(cust, 'Kal 5 baje cleaning book kar do aur address bhi bhej dena');
    const reply = sentTo(cust).at(-1)!;
    expect(reply).toMatch(/Confirm karein: Book Dental Cleaning/);
    expect(reply).toMatch(/12 MG Road/);
    const c = await conv(cust);
    const calls = (await h.owner.query(
      `SELECT t.key, c.status FROM app.ai_tool_calls c JOIN app.ai_tools t ON t.id = c.tool_id JOIN app.ai_runs r ON r.id = c.ai_run_id
        WHERE r.conversation_id = $1 ORDER BY c.created_at`, [c.id])).rows.map((x) => x.key);
    expect(calls.slice(0, 2).sort()).toEqual(['GET_BUSINESS_LOCATION', 'GET_SERVICES']);
    expect(calls.slice(2)).toEqual(['CHECK_AVAILABILITY', 'CREATE_BOOKING']);
    expect(sentTo(cust)).toHaveLength(1);
  });

  it('rapid messages are debounced into ONE assistant turn', async () => {
    await as(A)(api.http.patch(`/v1/ai/assistants/${assistantId}`)).send({ responseWaitMs: 1200 }).expect(200);
    await as(A)(api.http.post(`/v1/ai/assistants/${assistantId}/publish`)).expect(200);
    const cust = newCustomer();
    for (const t of ['Hi', 'price', 'consultation', 'ka kya hai']) sock().upsert([waText(cust, t)]);
    await pump();
    expect(sentTo(cust)).toEqual([]); // still inside the wait window
    await sleep(1300);
    await pump();
    expect(sentTo(cust)).toHaveLength(1);
    const c = await conv(cust);
    const runs = (await h.owner.query('SELECT trigger_message_count FROM app.ai_runs WHERE conversation_id = $1', [c.id])).rows;
    expect(runs).toEqual([{ trigger_message_count: 4 }]);
    expect(fake.requests.find((r) => r.userTexts.length === 4)!.userTexts).toEqual(['Hi', 'price', 'consultation', 'ka kya hai']);
    await as(A)(api.http.patch(`/v1/ai/assistants/${assistantId}`)).send({ responseWaitMs: 0 }).expect(200);
    await as(A)(api.http.post(`/v1/ai/assistants/${assistantId}/publish`)).expect(200);
  });

  it('one response cycle per conversation even with two workers racing', async () => {
    const rig2 = makeGateway(h, { bus: api.bus, fake: rig.fake, ai: aiProvidersFromEnv(), config: { staleAfterMs: 600_000 } });
    await rig2.worker.start({ loops: false });
    const cust = newCustomer();
    fake.delayMs = 150;
    sock().upsert([waText(cust, 'Kal timings?')]);
    sock().upsert([waText(cust, 'aur Sunday?')]);
    await settle(rig, instanceId);
    await rig.worker.relay.relayBatch('relay-live', 200);
    await Promise.all([rig.worker.assistant!.processOnce(), rig2.worker.assistant!.processOnce(), rig2.worker.assistant!.processOnce()]);
    fake.delayMs = 0;
    await pump();
    await sleep(2100); // a deferred (BUSY) event becomes visible again
    await pump();
    const c = await conv(cust);
    const runs = (await h.owner.query('SELECT trigger_message_count FROM app.ai_runs WHERE conversation_id = $1', [c.id])).rows;
    expect(runs).toEqual([{ trigger_message_count: 2 }]);
    expect(sentTo(cust)).toHaveLength(1);
    await rig2.worker.stop();
  });
});

describe('tool gate (executor) - security, idempotency, conflicts, timeouts', () => {
  const deps = () => {
    const ops = new OpsRepository();
    return { tx: h.workerTx, bookings: new BookingService(h.workerTx, new BookingRepository(), ops), leads: new LeadService(h.workerTx, ops),
      knowledge: new KnowledgeRepository(), ops, ordering: new OrderingService() };
  };
  async function scopeFor(t: Tenant, requestId: string, overrides: Record<string, Record<string, unknown>> = {}): Promise<ExecutorScope> {
    const snap = (await h.workerTx.inTenant((db) => loadDraftSnapshot(db, assistantId), { organizationId: A.orgId }))!;
    const tools: Map<string, LoadedTool> = await h.workerTx.inTenant((db) => loadRunTools(db, snap, new ToolRegistry(), { includeConfirm: false }), { organizationId: t.orgId });
    for (const [k, cfg] of Object.entries(overrides)) tools.get(k)!.config = { ...tools.get(k)!.config, ...cfg };
    return { base: { organizationId: t.orgId, businessId: t.businessId, assistantId, conversationId: t.conversationId, contactId: t.contactId, whatsappInstanceId: t.instanceId,
      requestId, dbContext: { organizationId: t.orgId }, timezone: 'Asia/Kolkata', currency: 'INR', now: new Date(), assistantDefaults: snap.defaults, signal: new AbortController().signal },
      mode: 'LIVE', tools, pending: new MemoryPendingActionStore(), logger: null, confirmationTtlMinutes: 15 };
  }
  const call = (name: string, args: unknown, id = 'c1') => ({ callId: id, name, arguments: JSON.stringify(args) });

  it('model-supplied tenant ids, schema violations and disabled/unknown tools are rejected before any handler runs', async () => {
    const ex = new ToolExecutor(new ToolRegistry(), deps());
    const s = await scopeFor(A, 'sec-1');
    expect((await ex.execute(s, call('GET_SERVICES', { query: 'x', organization_id: B.orgId }))).output).toMatchObject({ success: false, errorCode: 'FORBIDDEN_ARGUMENT' });
    expect((await ex.execute(s, call('CHECK_AVAILABILITY', { date_from: 'kal' }))).output).toMatchObject({ success: false, errorCode: 'INVALID_ARGUMENTS' });
    expect((await ex.execute(s, call('CHECK_AVAILABILITY', { date_from: d.tomorrow, sql: 'DROP TABLE app.bookings' }))).output.errorCode).toBe('FORBIDDEN_ARGUMENT');
    expect((await ex.execute(s, call('CREATE_PAYMENT_LINK', { service_id: clinic.serviceConsult }))).output.errorCode).toBe('TOOL_NOT_ENABLED');
    expect((await ex.execute(s, call('EXECUTE_SQL', { q: 'select 1' }))).output.errorCode).toBe('TOOL_NOT_ENABLED');
    expect((await ex.execute(s, { callId: 'c9', name: 'GET_SERVICES', arguments: '{not json' })).output.errorCode).toBe('INVALID_ARGUMENTS');
    // disabling a capability takes effect immediately, even before re-publishing
    await as(A)(api.http.put(`/v1/ai/assistants/${assistantId}/capabilities/CANCEL_BOOKING`)).send({ enabled: false }).expect(200);
    const s2 = await scopeFor(A, 'sec-2');
    expect((await ex.execute(s2, call('CANCEL_BOOKING', { booking_id: crypto.randomUUID() }))).output.errorCode).toBe('TOOL_NOT_ENABLED');
    await as(A)(api.http.put(`/v1/ai/assistants/${assistantId}/capabilities/CANCEL_BOOKING`)).send({ enabled: true }).expect(200);
  });

  it('ids belonging to another tenant resolve to NOT_FOUND (read and write)', async () => {
    const ex = new ToolExecutor(new ToolRegistry(), deps());
    const s = await scopeFor(A, 'foreign-1', { CREATE_BOOKING: { requireConfirmation: false } });
    expect((await ex.execute(s, call('GET_SERVICE_PRICE', { service_id: clinicB.serviceConsult }))).output).toMatchObject({ success: false, errorCode: 'NOT_FOUND' });
    const w = await ex.execute(s, call('CREATE_BOOKING', { start_at: istInstant(d.tomorrow, '11:00').toISOString(), resource_id: clinicB.drSharma, customer_name: 'X' }));
    expect(w.output).toMatchObject({ success: false, errorCode: 'RESOURCE_NOT_FOUND' });
    expect((await ex.execute(s, call('GET_BOOKING', { booking_id: B.conversationId }))).output.errorCode).toBe('NOT_FOUND');
  });

  it('write tools are idempotent per run; a taken slot returns SLOT_NOT_AVAILABLE with alternatives', async () => {
    const ex = new ToolExecutor(new ToolRegistry(), deps());
    const args = { start_at: istInstant(d.tomorrow, '10:00').toISOString(), resource_id: clinic.drMehta, customer_name: 'Idem Test', service_id: clinic.serviceConsult };
    const s = await scopeFor(A, 'idem-run-1', { CREATE_BOOKING: { requireConfirmation: false } });
    const r1 = await ex.execute(s, call('CREATE_BOOKING', args, 'x1'));
    const r2 = await ex.execute(s, call('CREATE_BOOKING', args, 'x2')); // retry of the same run
    expect(r1.output).toMatchObject({ success: true, status: 'BOOKING_CREATED' });
    expect((r2.output as any).booking.id).toBe((r1.output as any).booking.id);
    expect((await h.owner.query(`SELECT count(*)::int AS n FROM app.bookings WHERE customer_name = 'Idem Test'`)).rows[0].n).toBe(1);
    const other = await scopeFor(A, 'idem-run-2', { CREATE_BOOKING: { requireConfirmation: false } });
    const conflict = await ex.execute(other, call('CREATE_BOOKING', { ...args, customer_name: 'Second person' }));
    expect(conflict.output).toMatchObject({ success: false, errorCode: 'SLOT_NOT_AVAILABLE' });
    expect((conflict.output as any).alternatives.length).toBeGreaterThan(0);
  });

  it('a slow capability times out with TOOL_TIMEOUT (conversation never hangs)', async () => {
    const slow = DEFAULT_TOOLS.map((t) => (t.handlerKey === 'business.info'
      ? { ...t, timeoutMs: 50, execute: async () => { await sleep(500); return { result: { success: true } }; } } : t));
    const ex = new ToolExecutor(new ToolRegistry(slow), deps());
    const s = await scopeFor(A, 'timeout-1');
    const r = await ex.execute(s, call('GET_BUSINESS_INFO', {}));
    expect(r.output).toMatchObject({ success: false, errorCode: 'TOOL_TIMEOUT' });
  });
});
