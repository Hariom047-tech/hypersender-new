import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDraftSnapshot } from '../src/ai/runtime/assistant-config.js';
import { MemoryPendingActionStore } from '../src/ai/runtime/pending-store.js';
import { loadRunTools } from '../src/ai/runtime/tool-loader.js';
import { ToolExecutor, type ExecutorScope, type LoadedTool } from '../src/ai/tools/executor.js';
import { ToolRegistry } from '../src/ai/tools/registry.js';
import { KnowledgeIngestionService } from '../src/ai/knowledge/ingestion.js';
import { starterKnowledge } from '../src/havan/knowledge/starter-knowledge.js';
import { registerReminderDelivery } from '../src/havan/reminders.js';
import { GoogleCalendarService, googleCalendarConfigFromEnv, registerCalendarSync } from '../src/integrations/google-calendar.js';
import { keyProviderFromEnv } from '../src/security/crypto/key-provider.js';
import { FakeGoogle } from './fakes/fake-google.js';
import { OrderingService } from '../src/ordering/ordering.service.js';
import { BookingRepository } from '../src/repositories/booking.repository.js';
import { KnowledgeRepository } from '../src/repositories/knowledge.repository.js';
import { MessagingRepository } from '../src/repositories/messaging.repository.js';
import { OpsRepository } from '../src/repositories/ops.repository.js';
import { BookingService } from '../src/services/booking.service.js';
import { LeadService } from '../src/services/lead.service.js';
import { NotificationService } from '../src/services/notification.service.js';
import { OutboundMessageService } from '../src/services/outbound-message.service.js';
import { OutboxRelayService } from '../src/services/outbox-relay.service.js';
import { istInstant, localDates } from './ai-helpers.js';
import { FakeOpenAI } from './fakes/fake-openai.js';
import { makeHarness, seedTenant, type Harness, type Tenant } from './helpers.js';
import { startApi, type Api } from './saas-helpers.js';

/*
 * Havan Booking Assistant: every capability through the REAL tool gate
 * (ToolExecutor + catalog schemas + handlers + RLS), the owner APIs, and the
 * reminder delivery path (outbox relay -> WhatsApp message / notification).
 */
let h: Harness;
let api: Api;
let fake: FakeOpenAI;
let A: Tenant;
let B: Tenant;
let assistantId: string;
const PANDIT = '+919826012345';
const d = localDates();
const add = (s: string, n: number) => { const x = new Date(`${s}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const day3 = add(d.today, 3);
const day4 = add(d.today, 4);
const as = (t: Tenant) => <T extends import('supertest').Test>(r: T) => api.as(t.userId, t.orgId)(r);
const havan = (p: string) => `/v1/businesses/${A.businessId}/havan${p}`;
const q = async (sql: string, p: unknown[] = []) => (await h.owner.query(sql, p)).rows;

const ops = new OpsRepository();
let google: FakeGoogle;
let calendar: GoogleCalendarService;
const deps = () => ({ calendar, tx: h.workerTx, bookings: new BookingService(h.workerTx, new BookingRepository(), ops), leads: new LeadService(h.workerTx, ops),
  knowledge: new KnowledgeRepository(), ops, ordering: new OrderingService() });
let relay: OutboxRelayService;

async function scopeFor(t: Tenant, requestId: string, o: { now?: Date; config?: Record<string, Record<string, unknown>> } = {}): Promise<ExecutorScope> {
  const snap = (await h.workerTx.inTenant((db) => loadDraftSnapshot(db, assistantId), { organizationId: A.orgId }))!;
  const tools: Map<string, LoadedTool> = await h.workerTx.inTenant((db) => loadRunTools(db, snap, new ToolRegistry(), { includeConfirm: false }), { organizationId: t.orgId });
  for (const [k, cfg] of Object.entries(o.config ?? {})) tools.get(k)!.config = { ...tools.get(k)!.config, ...cfg };
  return { base: { organizationId: t.orgId, businessId: t.businessId, assistantId, conversationId: t.conversationId, contactId: t.contactId,
    whatsappInstanceId: t.instanceId, requestId, dbContext: { organizationId: t.orgId }, timezone: 'Asia/Kolkata', currency: 'INR', now: o.now ?? new Date(),
    assistantDefaults: snap.defaults, signal: new AbortController().signal }, mode: 'LIVE', tools, pending: new MemoryPendingActionStore(), logger: null,
    confirmationTtlMinutes: 15 };
}
let n = 0;
async function run(name: string, args: unknown, o: Parameters<typeof scopeFor>[2] & { t?: Tenant } = {}) {
  const s = await scopeFor(o.t ?? A, `havan-${++n}`, o);
  return (await new ToolExecutor(new ToolRegistry(), deps()).execute(s, { callId: `c${n}`, name, arguments: JSON.stringify(args) })).output as any;
}
const noConfirm = { CREATE_HAVAN_BOOKING: { requireConfirmation: false }, RESCHEDULE_HAVAN_BOOKING: { requireConfirmation: false }, CANCEL_HAVAN_BOOKING: { requireConfirmation: false } };
/** Makes every pending reminder of the tenant due now and runs the relay. */
async function deliverDue(orgId: string) {
  await h.owner.query(`UPDATE app.scheduled_reminders SET due_at = now() - interval '1 second' WHERE organization_id = $1 AND status = 'PENDING'`, [orgId]);
  await h.owner.query(`UPDATE app.outbox_events SET available_at = now() WHERE organization_id = $1 AND event_type = 'REMINDER_DUE' AND status = 'PENDING'`, [orgId]);
  await relay.relayBatch('relay-havan', 500);
}

beforeAll(async () => {
  fake = await new FakeOpenAI().start();
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.OPENAI_BASE_URL = fake.url;
  google = await new FakeGoogle().start();
  Object.assign(process.env, google.env());
  calendar = new GoogleCalendarService(googleCalendarConfigFromEnv(), keyProviderFromEnv());
  h = makeHarness();
  api = await startApi();
  A = await seedTenant(h, 'havan-a');
  B = await seedTenant(h, 'havan-b');
  const messaging = new MessagingRepository();
  relay = new OutboxRelayService(h.workerTx, ops);
  registerReminderDelivery(relay, { tx: h.workerTx, ops, messaging, outbound: new OutboundMessageService(h.workerTx, messaging, ops),
    notifications: new NotificationService(h.workerTx, api.bus), bus: api.bus });
  registerCalendarSync(relay, h.workerTx, calendar);
});
afterAll(async () => { await api.app.close(); await h.close(); await fake.stop(); await google.stop(); });

describe('Pandit Ji sets up havan from the dashboard APIs', () => {
  it('settings, three packages (no price field), bookable timings; template installs, readiness passes and publishes', async () => {
    // No "service" is needed: a havan type is bookable by itself. Pandit Ji's bookable hours come from the fixture's 24h rules.
    // The fixture's generic agent answers this number; the havan assistant takes it over.
    await h.owner.query(`DELETE FROM app.ai_agent_channels WHERE whatsapp_instance_id = $1`, [A.instanceId]);
    expect((await as(A)(api.http.put(havan('/settings'))).send({ panditWhatsapp: '12345' })).status).toBe(400);
    const s = (await as(A)(api.http.put(havan('/settings'))).send({ panditDisplayName: 'Pandit Ramesh Ji', panditWhatsapp: '98260 12345',
      templeName: 'Maa Baglamukhi Mandir, Nalkheda', templeAddress: 'Nalkheda, Agar Malwa, Madhya Pradesh', darshanTimings: 'Subah 5 baje se raat 10 baje tak',
      howToReach: 'Ujjain se lagbhag 100 km, sadak marg se.' }).expect(200)).body;
    expect(s.panditWhatsapp).toBe(PANDIT);
    await as(A)(api.http.put(havan('/packages/samanya'))).send({}).expect(200);
    await as(A)(api.http.put(havan('/packages/VISHESH'))).send({ onlineLiveVideo: true, prasadCourier: true, yajmanPreparation: 'Snan karke peele vastra.' }).expect(200);
    await as(A)(api.http.put(havan('/packages/MAHA_VISHESH'))).send({ durationMinutes: 180, onlineLiveVideo: true, onlineRecording: true }).expect(200);
    expect((await as(A)(api.http.put(havan('/packages/SUPER'))).send({})).status).toBe(400);
    expect((await as(A)(api.http.put(havan('/packages/VISHESH'))).send({ inPersonAvailable: false, onlineAvailable: false })).status).toBe(400);
    const pk = (await as(A)(api.http.get(havan('/packages'))).expect(200)).body;
    expect(pk.map((p: any) => [p.tier, p.herbCount])).toEqual([['SAMANYA', null], ['VISHESH', 21], ['MAHA_VISHESH', 31]]);
    expect(JSON.stringify(pk)).not.toMatch(/price|amount|dakshina/i);
    // Another tenant cannot touch this business.
    expect((await as(B)(api.http.get(havan('/packages')))).status).toBe(404);

    assistantId = (await as(A)(api.http.post('/v1/ai/assistants')).send({ templateKey: 'HAVAN_BOOKING', businessId: A.businessId, name: 'Pandit Ji Seva Sahayak' }).expect(201)).body.id;
    await as(A)(api.http.put(`/v1/ai/assistants/${assistantId}/whatsapp`)).send({ whatsappInstanceId: A.instanceId }).expect(200);
    const r = (await as(A)(api.http.get(`/v1/ai/assistants/${assistantId}/readiness`))).body;
    for (const k of ['HAVAN_PACKAGES', 'AVAILABILITY', 'PANDIT_CONTACT', 'TEMPLE_INFO']) expect(r.checks.find((c: any) => c.key === k), k).toMatchObject({ ok: true });
    const pub = await as(A)(api.http.post(`/v1/ai/assistants/${assistantId}/publish`));
    expect(pub.status, JSON.stringify(pub.body)).toBe(200);
  });

  it('the template prompt is the documented prompt, and names only tools the assistant really has', async () => {
    const doc = readFileSync(new URL('../docs/havan-booking-assistant-prompt.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n').trimEnd();
    const t = (await q(`SELECT base_system_prompt FROM app.ai_assistant_templates WHERE key = 'HAVAN_BOOKING' AND status = 'ACTIVE'`))[0];
    expect(t.base_system_prompt).toBe(doc);
    const offered = (await q(`SELECT t.key FROM app.ai_agent_tools at JOIN app.ai_tools t ON t.id = at.tool_id WHERE at.ai_agent_id = $1 AND at.enabled`, [assistantId])).map((x) => x.key);
    const named = [...new Set(doc.match(/\b[A-Z][A-Z]+(?:_[A-Z]+){1,4}\b/g) ?? [])].filter((k) => /^(GET|SEARCH|CHECK|CREATE|UPDATE|CANCEL|RESCHEDULE|REQUEST)_/.test(k));
    expect(named.length).toBeGreaterThanOrEqual(16);
    for (const k of named) expect(offered, k).toContain(k);
  });
});

describe('researched starter knowledge', () => {
  it('installing the template copies the Baglamukhi / Nalkheda / havan knowledge pack; it is searchable and never contains a price', async () => {
    const pack = starterKnowledge('HAVAN_BOOKING');
    expect(pack.length).toBeGreaterThanOrEqual(14);
    expect(pack.flatMap((x) => x.faqs).length).toBeGreaterThanOrEqual(70);
    expect(JSON.stringify(pack)).not.toMatch(/₹|\bRs\.?\s?\d|\brupa?ye\b|\bINR\b/i);
    const src = await q(`SELECT id, title, type FROM app.knowledge_sources WHERE ai_agent_id = $1 AND deleted_at IS NULL ORDER BY title`, [assistantId]);
    expect(src.map((x) => x.title).sort()).toEqual(pack.map((x) => x.title).sort());
    expect(src.every((x) => x.type === 'FAQ')).toBe(true);
    const ingest = new KnowledgeIngestionService(h.workerTx, new KnowledgeRepository(), undefined, { warn() {}, info() {} } as any);
    for (const x of src) expect(await ingest.ingest(A.orgId, x.id)).toBe('READY');
    // Idempotent: a second request adds nothing.
    expect((await as(A)(api.http.post(`/v1/ai/assistants/${assistantId}/knowledge/starter`)).expect(200)).body).toMatchObject({ added: 0, skipped: pack.length });

    const ask = async (query: string) => (await run('SEARCH_BAGLAMUKHI_KNOWLEDGE', { query })).results.map((r: any) => r.text).join('\n');
    expect(await ask('Nalkheda mandir kisne sthapit kiya itihaas')).toMatch(/Yudhishthir/);
    expect(await ask('Maa ko peela rang kyu priya hai Pitambara')).toMatch(/Haridra/);
    expect(await ask('Baglamukhi Gayatri mantra')).toMatch(/Stambhinyai/);
    expect(await ask('gotra nahi pata havan')).toMatch(/Kashyap/);
    expect(await ask('Nalkheda kaise pahunche Indore se doori')).toMatch(/156 km/);
    expect(await ask('Maa Baglamukhi ki puja havan ke labh')).toMatch(/Shatru aur virodh se raksha[\s\S]*guaranteed/);
  });
});

describe('knowledge, packages, dakshina and festivals', () => {
  it('service details explain the three tiers and online facilities; no tool ever returns a dakshina amount', async () => {
    const all = await run('GET_HAVAN_SERVICE_DETAILS', {});
    expect(all.success).toBe(true);
    expect(all.packages.map((p: any) => [p.tier, p.herbs.count])).toEqual([['SAMANYA', null], ['VISHESH', 21], ['MAHA_VISHESH', 31]]);
    const v = all.packages.find((p: any) => p.tier === 'VISHESH');
    expect(v.online).toEqual({ liveVideoCall: true, recording: false, photos: false, prasadCourier: true, internationalCourier: false });
    expect(v.durationMinutes).toBe(120);
    expect(all.dakshina).toBe('CALL_ONLY');
    const pol = await run('GET_DAKSHINA_POLICY', {});
    expect(pol).toMatchObject({ success: true, policy: 'CALL_ONLY', canQuoteInChat: false });
    for (const out of [all, pol]) expect(JSON.stringify(out)).not.toMatch(/₹|\bINR\b|amountMinor|price_minor/);
  });

  it('temple information comes from the Pandit settings', async () => {
    const t = await run('GET_TEMPLE_INFORMATION', { topic: 'DARSHAN_TIMINGS' });
    expect(t.temple).toMatchObject({ templeName: 'Maa Baglamukhi Mandir, Nalkheda', darshanTimings: 'Subah 5 baje se raat 10 baje tak' });
    expect(t.temple.howToReach).toBeUndefined();
    // Another tenant cannot load this assistant's tools at all (RLS on the assistant's capabilities).
    expect((await run('GET_TEMPLE_INFORMATION', { topic: 'ALL' }, { t: B })).errorCode).toBe('TOOL_NOT_ENABLED');
  });

  it('festival context is computed from the current date: before, during and after Sharadiya Navratri 2026', async () => {
    const before = await run('GET_FESTIVAL_CONTEXT', {}, { now: new Date('2026-09-30T06:00:00Z') });
    expect(before).toMatchObject({ today: '2026-09-30', navratriStatus: 'BEFORE_NAVRATRI' });
    expect(before.upcoming[0]).toMatchObject({ name: 'Sharadiya Navratri', from: '2026-10-11', startsInDays: 11 });
    const during = await run('GET_FESTIVAL_CONTEXT', {}, { now: new Date('2026-10-12T06:00:00Z') });
    expect(during.navratriStatus).toBe('NAVRATRI_ACTIVE');
    expect(during.active[0]).toMatchObject({ name: 'Sharadiya Navratri', dayNumber: 2 });
    const after = await run('GET_FESTIVAL_CONTEXT', { lookahead_days: 10 }, { now: new Date('2026-10-21T06:00:00Z') });
    expect(after.navratriStatus).toBe('AFTER_NAVRATRI');
  });
});

describe('call-back to Pandit Ji', () => {
  it('validates the number, keeps ONE open request per yajman, updates the enquiry and notifies Pandit Ji on WhatsApp + dashboard', async () => {
    const badNum = await run('REQUEST_PANDIT_HANDOFF', { type: 'CALLBACK', reason: 'DAKSHINA', summary: 'Vishesh havan ki dakshina', callback_number: '987654' });
    expect(badNum.errorCode).toBe('INVALID_PHONE_NUMBER');
    expect((await run('REQUEST_PANDIT_HANDOFF', { type: 'CALLBACK', reason: 'DAKSHINA', summary: 'x1' })).errorCode).toBe('CALLBACK_NUMBER_REQUIRED');

    const r1 = await run('REQUEST_PANDIT_HANDOFF', { type: 'CALLBACK', reason: 'DAKSHINA', summary: 'Vishesh havan ki dakshina jaanni hai',
      callback_number: '98765 43210', tier: 'VISHESH', participation_mode: 'ONLINE_SANKALP', preferred_call_time: 'shaam 6 ke baad' });
    expect(r1).toMatchObject({ success: true, status: 'CALLBACK_REQUESTED', callbackNumber: '+91 98765 43210' });
    const r2 = await run('REQUEST_PANDIT_HANDOFF', { type: 'CALLBACK', reason: 'HAVAN_TYPE', summary: 'Kaunsa havan uchit rahega', use_whatsapp_number: true });
    expect(r2.status).toBe('CALLBACK_REQUEST_UPDATED');
    const open = await q(`SELECT callback_phone_e164, reason, tier, preferred_call_time FROM app.havan_callback_requests WHERE business_id = $1 AND status = 'NEW'`, [A.businessId]);
    const contactPhone = (await q('SELECT phone_e164 FROM app.contacts WHERE id = $1', [A.contactId]))[0].phone_e164;
    expect(open).toEqual([{ callback_phone_e164: contactPhone, reason: 'HAVAN_TYPE', tier: 'VISHESH', preferred_call_time: 'shaam 6 ke baad' }]);

    const lead = await run('GET_YAJMAN_LEAD', {});
    expect(lead.lead).toMatchObject({ stage: 'CALLBACK_REQUESTED', callbackRequested: true, serviceInterest: 'VISHESH', participationMode: 'ONLINE_SANKALP' });
    // The assistant stays on: a call-back is not a chat handoff.
    expect((await q('SELECT handling_mode FROM app.conversations WHERE id = $1', [A.conversationId]))[0].handling_mode).toBe('AI');

    await relay.relayBatch('relay-havan', 500);
    const toPandit = await q(`SELECT m.text_body, m.origin, c.handling_mode FROM app.messages m JOIN app.conversations c ON c.id = m.conversation_id
                               JOIN app.contacts ct ON ct.id = c.contact_id WHERE ct.phone_e164 = $1 AND m.organization_id = $2 ORDER BY m.created_at`, [PANDIT, A.orgId]);
    expect(toPandit).toHaveLength(2);
    expect(toPandit[0].text_body).toBe('📞 *Call-back request*\n\n🙏 Customer\n📞 +91 98765 43210\nKaran: Dakshina jaanni hai\nHavan: Vishesh Havan\n'
      + 'Kahan: Online (video call se sankalp)\nCall ka samay: shaam 6 ke baad\n\n📝 Vishesh havan ki dakshina jaanni hai');
    expect(toPandit[1].text_body).toMatch(/^📞 \*Call-back request \(update\)\*/);
    expect(toPandit.every((m) => m.origin === 'SYSTEM' && m.handling_mode === 'HUMAN')).toBe(true); // the assistant never answers Pandit Ji
    expect((await q(`SELECT count(*)::int AS n FROM app.notifications WHERE organization_id = $1 AND type = 'PANDIT_CALLBACK'`, [A.orgId]))[0].n).toBeGreaterThanOrEqual(1);

    const list = (await as(A)(api.http.get(havan('/callbacks'))).expect(200)).body;
    expect(list).toHaveLength(1);
    await as(A)(api.http.post(havan(`/callbacks/${list[0].id}/status`))).send({ status: 'CALLED' }).expect(200);
    expect((await as(A)(api.http.get(havan('/callbacks'))).expect(200)).body).toHaveLength(0);
  });

  it('when Pandit Ji\'s personal number IS the yajman\'s number (testing from one phone), the note still arrives and the assistant stays on', async () => {
    const yPhone = (await q('SELECT phone_e164 FROM app.contacts WHERE id = $1', [A.contactId]))[0].phone_e164;
    await h.owner.query('UPDATE app.havan_settings SET pandit_whatsapp_e164 = $2 WHERE business_id = $1', [A.businessId, yPhone]);
    const before = (await q(`SELECT count(*)::int AS n FROM app.messages WHERE conversation_id = $1 AND origin = 'SYSTEM'`, [A.conversationId]))[0].n;
    expect((await run('CREATE_PANDIT_REMINDER', { message: 'Test note' })).success).toBe(true);
    await relay.relayBatch('relay-havan', 500);
    const notes = await q(`SELECT text_body FROM app.messages WHERE conversation_id = $1 AND origin = 'SYSTEM' ORDER BY created_at`, [A.conversationId]);
    expect(notes.length).toBe(before + 1);
    expect(notes.at(-1)!.text_body).toMatch(/^🔔 Test note/);
    expect((await q('SELECT handling_mode FROM app.conversations WHERE id = $1', [A.conversationId]))[0].handling_mode).toBe('AI');
    await h.owner.query('UPDATE app.havan_settings SET pandit_whatsapp_e164 = $2 WHERE business_id = $1', [A.businessId, PANDIT]);
  });

  it('CHAT_HANDOFF hands the chat to Pandit Ji (assistant stops) and tells Pandit Ji why', async () => {
    const r = await run('REQUEST_PANDIT_HANDOFF', { type: 'CHAT_HANDOFF', reason: 'MANTRA_OR_TANTRA', summary: 'Vishesh prayog ke baare mein poochh rahe hain' }, { t: B });
    expect(r.errorCode).toBe('TOOL_NOT_ENABLED'); // another tenant never reaches A's assistant
    const ok = await run('REQUEST_PANDIT_HANDOFF', { type: 'CHAT_HANDOFF', reason: 'MANTRA_OR_TANTRA', summary: 'Vishesh prayog ke baare mein poochh rahe hain' });
    expect(ok).toMatchObject({ success: true, status: 'HANDED_OFF' });
    expect((await q('SELECT handling_mode FROM app.conversations WHERE id = $1', [A.conversationId]))[0].handling_mode).toBe('HUMAN');
    await relay.relayBatch('relay-havan', 500);
    const last = await q(`SELECT m.text_body FROM app.messages m JOIN app.conversations c ON c.id = m.conversation_id JOIN app.contacts ct ON ct.id = c.contact_id
                           WHERE ct.phone_e164 = $1 AND m.organization_id = $2 ORDER BY m.created_at DESC LIMIT 1`, [PANDIT, A.orgId]);
    expect(last[0].text_body).toMatch(/^💬 \*Yajman ki chat aapko saupi gayi\*[\s\S]*Karan: Mantra \/ vishesh vidhi/);
    await h.owner.query(`UPDATE app.conversations SET handling_mode = 'AI' WHERE id = $1`, [A.conversationId]);
  });
});

describe('availability, booking, reminders, reschedule, cancel', () => {
  let bookingId: string;

  it('slots come from the real calendar with the havan duration; a specific date answers requestedTimeFree', async () => {
    const s = await run('GET_AVAILABLE_SLOTS', { date_from: day3, tier: 'VISHESH', time_of_day: 'MORNING' });
    expect(s.success).toBe(true);
    expect(s.havanDurationMinutes).toBe(120);
    expect((await run('GET_AVAILABLE_SLOTS', { date_from: day3, tier: 'MAHA_VISHESH' })).havanDurationMinutes).toBe(180);
    const c = await run('CHECK_PANDIT_AVAILABILITY', { date: day3, preferred_time: '10:00', tier: 'VISHESH' });
    expect(c).toMatchObject({ success: true, requestedTimeFree: true });
    expect((await run('CHECK_PANDIT_AVAILABILITY', { date: day3, tier: 'VISHESH', resource_id: A.resourceId })).errorCode).toBe('INVALID_ARGUMENTS');
  });

  it('booking needs confirmation, stores havan details, schedules both 1-day-before reminders; no amount anywhere', async () => {
    const start = istInstant(day3, '10:00').toISOString();
    const args = { start_at: start, tier: 'VISHESH', participation_mode: 'ONLINE_SANKALP', yajman_name: 'Rahul Sharma', city: 'Indore', gotra: 'Kashyap',
      sankalp: 'Vyapar mein unnati', prasad_address: '12 MG Road, Delhi' };
    const pending = await run('CREATE_HAVAN_BOOKING', args);
    expect(pending.status).toBe('CONFIRMATION_REQUIRED');
    expect(pending.confirmationText).toMatch(/^Vishesh Havan · .* · Online \(video call se sankalp\) · Yajman: Rahul Sharma, Indore · Dakshina: Pandit Ji call par batayenge$/);
    // City is required: the assistant asks name and city together.
    const { city: _c, ...noCity } = args;
    expect((await run('CREATE_HAVAN_BOOKING', noCity)).errorCode).toBe('INVALID_ARGUMENTS');
    expect((await run('CREATE_HAVAN_BOOKING', { ...args, participation_mode: 'NALKHEDA_IN_PERSON', tier: 'SUPER' })).errorCode).toBe('INVALID_ARGUMENTS');

    const r = await run('CREATE_HAVAN_BOOKING', args, { config: noConfirm });
    expect(r.success, JSON.stringify(r)).toBe(true);
    expect(r).toMatchObject({ success: true, status: 'BOOKING_CREATED', havan: 'Vishesh Havan', dakshina: 'CALL_ONLY' });
    expect(r.reminders.map((x: any) => [x.audience, x.status])).toEqual([['PANDIT', 'SCHEDULED'], ['YAJMAN', 'SCHEDULED']]);
    expect(new Date(r.reminders[0].at).toISOString()).toBe(istInstant(add(day3, -1), '10:00').toISOString());
    bookingId = r.booking.id;
    const det = await q('SELECT tier, participation_mode, gotra, dakshina_status FROM app.havan_booking_details WHERE booking_id = $1', [bookingId]);
    expect(det).toEqual([{ tier: 'VISHESH', participation_mode: 'ONLINE_SANKALP', gotra: 'Kashyap', dakshina_status: 'TO_BE_DISCUSSED_ON_CALL' }]);
    const due = await q(`SELECT o.available_at > now() + interval '1 hour' AS later FROM app.outbox_events o JOIN app.scheduled_reminders r ON r.id = o.aggregate_id
                          WHERE r.booking_id = $1 AND r.kind = 'BOOKING'`, [bookingId]);
    expect(due).toEqual([{ later: true }, { later: true }]);
    // Not due yet: the relay does not deliver early.
    await relay.relayBatch('relay-havan', 500);
    expect((await q(`SELECT count(*)::int AS n FROM app.scheduled_reminders WHERE booking_id = $1 AND kind = 'BOOKING' AND status = 'PENDING'`, [bookingId]))[0].n).toBe(2);
    // Pandit Ji got the new-booking alert on the personal number right away.
    const alert = await q(`SELECT m.text_body FROM app.messages m JOIN app.conversations c ON c.id = m.conversation_id JOIN app.contacts ct ON ct.id = c.contact_id
                            WHERE ct.phone_e164 = $1 AND m.organization_id = $2 AND m.text_body LIKE '🆕%'`, [PANDIT, A.orgId]);
    expect(alert).toHaveLength(1);
    expect(alert[0].text_body).toMatch(/^🆕 \*Nayi havan booking\*\n\n🔥 Vishesh Havan\n📅 .+\n🙏 Rahul Sharma, Indore\n📞 \+91 \d{5} \d{5}\n💻 Online sankalp\nGotra: Kashyap\nSankalp: Vyapar mein unnati\n\nDakshina: yajman ko call karke tay karein$/);

    const got = await run('GET_HAVAN_BOOKING', {});
    expect(got.bookings[0]).toMatchObject({ havan: 'Vishesh Havan', mode: 'Online (video call se sankalp)', dakshina: 'Pandit Ji call par batayenge' });
    expect(got.bookings[0].reminders).toHaveLength(2);
    // The slot is taken now: a second booking at the same time is refused with alternatives.
    const taken = await run('CREATE_HAVAN_BOOKING', { ...args, yajman_name: 'Doosra Yajman' }, { config: noConfirm });
    expect(taken).toMatchObject({ success: false, errorCode: 'SLOT_NOT_AVAILABLE' });
    expect(taken.alternatives.length).toBeGreaterThan(0);
  });

  it('reschedule moves the booking, keeps the details and replaces the reminders', async () => {
    const r = await run('RESCHEDULE_HAVAN_BOOKING', { booking_id: bookingId, new_start_at: istInstant(day4, '09:00').toISOString() }, { config: noConfirm });
    expect(r).toMatchObject({ success: true, status: 'BOOKING_RESCHEDULED' });
    const newId = r.booking.id;
    expect((await q(`SELECT status, count(*)::int AS n FROM app.scheduled_reminders WHERE booking_id = $1 AND kind = 'BOOKING' GROUP BY status`, [bookingId]))).toEqual([{ status: 'CANCELLED', n: 2 }]);
    expect((await q(`SELECT audience, due_at FROM app.scheduled_reminders WHERE booking_id = $1 AND kind = 'BOOKING' AND status = 'PENDING' ORDER BY audience`, [newId])).map((x) => x.due_at.toISOString()))
      .toEqual([istInstant(add(day4, -1), '09:00').toISOString(), istInstant(add(day4, -1), '09:00').toISOString()]);
    expect((await q('SELECT gotra FROM app.havan_booking_details WHERE booking_id = $1', [newId]))[0].gotra).toBe('Kashyap');
    bookingId = newId;
  });

  it('due reminders are delivered: WhatsApp to the yajman in their chat, WhatsApp + notification to Pandit Ji; old ones never fire', async () => {
    const before = (await q(`SELECT count(*)::int AS n FROM app.messages WHERE conversation_id = $1 AND origin = 'SYSTEM'`, [A.conversationId]))[0].n;
    await deliverDue(A.orgId);
    const y = await q(`SELECT text_body FROM app.messages WHERE conversation_id = $1 AND origin = 'SYSTEM' ORDER BY created_at`, [A.conversationId]);
    expect(y.length - before).toBe(1);
    expect(y.at(-1)!.text_body).toMatch(/^Jai Maa Baglamukhi 🙏\n\nAapke havan ki yaad dila rahe hain\.\n\n🔥 \*Vishesh Havan\*\n📅 .+\n💻 Online – video call se sankalp\n\nSamay par shuddh hokar/);
    const p = await q(`SELECT m.text_body FROM app.messages m JOIN app.conversations c ON c.id = m.conversation_id JOIN app.contacts ct ON ct.id = c.contact_id
                        WHERE ct.phone_e164 = $1 AND m.organization_id = $2 AND m.text_body LIKE '🔔 *Havan reminder*%' ORDER BY m.created_at DESC LIMIT 1`, [PANDIT, A.orgId]);
    expect(p[0].text_body).toMatch(/^🔔 \*Havan reminder\*\n\n🔥 Vishesh Havan\n📅 .+\n🙏 Rahul Sharma, Indore\n📞 \+91\d+\n💻 Online sankalp\nGotra: Kashyap\nSankalp: Vyapar mein unnati\n\nDakshina: call par tay honi hai$/);
    expect((await q('SELECT city FROM app.havan_booking_details WHERE booking_id = $1', [bookingId]))[0].city).toBe('Indore');
    expect((await q(`SELECT status FROM app.scheduled_reminders WHERE booking_id = $1 AND kind = 'BOOKING'`, [bookingId])).map((x) => x.status)).toEqual(['SENT', 'SENT']);
    const moved = await q(`SELECT m.text_body FROM app.messages m JOIN app.conversations c ON c.id = m.conversation_id JOIN app.contacts ct ON ct.id = c.contact_id
                            WHERE ct.phone_e164 = $1 AND m.organization_id = $2 AND m.text_body LIKE '🔄%'`, [PANDIT, A.orgId]);
    expect(moved[0].text_body).toMatch(/^🔄 \*Havan booking ka samay badla\*\n\n🔥 Vishesh Havan\n📅 .+ ➜ \*.+\*\n🙏 Rahul Sharma, Indore/);
    // Redelivery of the same events is a no-op.
    await h.owner.query(`UPDATE app.outbox_events SET status = 'PENDING', available_at = now() WHERE organization_id = $1 AND event_type = 'REMINDER_DUE'`, [A.orgId]);
    await relay.relayBatch('relay-havan', 500);
    expect((await q(`SELECT count(*)::int AS n FROM app.messages WHERE conversation_id = $1 AND origin = 'SYSTEM'`, [A.conversationId]))[0].n).toBe(y.length);
  });

  it('cancel cancels the booking and any pending reminder; Pandit Ji marks dakshina agreed after the call', async () => {
    await as(A)(api.http.post(havan(`/bookings/${bookingId}/dakshina`))).send({ status: 'AGREED_ON_CALL' }).expect(200);
    expect((await as(A)(api.http.get(havan('/bookings'))).expect(200)).body.find((b: any) => b.id === bookingId).dakshinaStatus).toBe('AGREED_ON_CALL');
    const again = await run('CREATE_YAJMAN_REMINDER', { remind_at: new Date(Date.now() + 86_400_000).toISOString(), message: 'Kal havan hai', booking_id: bookingId });
    expect(again).toMatchObject({ success: true, status: 'REMINDER_SCHEDULED' });
    const c = await run('CANCEL_HAVAN_BOOKING', { booking_id: bookingId, reason: 'Family function' }, { config: noConfirm });
    expect(c).toMatchObject({ success: true, status: 'BOOKING_CANCELLED' });
    await deliverDue(A.orgId);
    expect((await q(`SELECT status FROM app.scheduled_reminders WHERE booking_id = $1 AND kind = 'CUSTOM'`, [bookingId]))[0].status).toBe('CANCELLED');
    const cancelled = await q(`SELECT m.text_body FROM app.messages m JOIN app.conversations c ON c.id = m.conversation_id JOIN app.contacts ct ON ct.id = c.contact_id
                                WHERE ct.phone_e164 = $1 AND m.organization_id = $2 AND m.text_body LIKE '❌%'`, [PANDIT, A.orgId]);
    expect(cancelled[0].text_body).toMatch(/^❌ \*Havan booking cancel hui\*[\s\S]*🙏 Rahul Sharma, Indore[\s\S]*Karan: Family function$/);
  });
});

describe('reminder tools and enquiry: limits and isolation', () => {
  it('yajman reminders need a future time within 60 days; Pandit reminders add the yajman automatically', async () => {
    expect((await run('CREATE_YAJMAN_REMINDER', { remind_at: new Date(Date.now() + 60_000).toISOString(), message: 'jaldi' })).errorCode).toBe('TIME_TOO_SOON');
    expect((await run('CREATE_YAJMAN_REMINDER', { remind_at: new Date(Date.now() + 90 * 86_400_000).toISOString(), message: 'baad mein' })).errorCode).toBe('TIME_TOO_FAR');
    expect((await run('CREATE_YAJMAN_REMINDER', { remind_at: new Date(Date.now() + 86_400_000).toISOString(), message: 'yaad dila dena', booking_id: B.conversationId })).errorCode).toBe('NOT_FOUND');
    const p = await run('CREATE_PANDIT_REMINDER', { message: 'Rahul ji ne Navratri ke baad follow-up ke liye kaha hai' });
    expect(p).toMatchObject({ success: true, status: 'PANDIT_REMINDER_SCHEDULED', reminder: { immediate: true } });
    const row = (await q(`SELECT message FROM app.scheduled_reminders WHERE id = $1`, [p.reminder.id]))[0];
    expect(row.message).toMatch(/^🔔 Rahul ji ne .*\n\n🙏 Customer\n📞 \+91 \d{5} \d{5}$/);
  });

  it('UPDATE_YAJMAN_LEAD merges havan fields without losing earlier ones', async () => {
    await run('UPDATE_YAJMAN_LEAD', { lead_stage: 'READY_TO_BOOK', preferred_date: day4, city: 'Delhi' });
    const l = (await run('GET_YAJMAN_LEAD', {})).lead;
    expect(l).toMatchObject({ stage: 'READY_TO_BOOK', preferredDate: day4, city: 'Delhi', callbackRequested: true, serviceInterest: 'VISHESH' });
    expect((await q('SELECT qualification FROM app.leads WHERE id = $1', [l.id]))[0].qualification).toBe('HOT');
  });
});

describe('Test Assistant chat through the real runtime', () => {
  it('"havan kitne type ke hote hai, kitna lagta hai" -> packages + dakshina policy; the model gets the havan prompt and all 16 capabilities', async () => {
    fake.brain = (t) => {
      if (t.results.length === 0) return { calls: [{ name: 'GET_HAVAN_SERVICE_DETAILS', args: {} }, { name: 'GET_DAKSHINA_POLICY', args: {} }] };
      const tiers = t.results[0].output.packages.map((p: any) => p.name).join(', ');
      return { text: `Ji, Pandit Ji teen prakar ke havan karwate hain: ${tiers}. Dakshina Pandit Ji call par hi bata payenge 🙏` };
    };
    const sid = (await as(A)(api.http.post(`/v1/ai/assistants/${assistantId}/test-sessions`)).send({ customerName: 'Rahul' }).expect(201)).body.id;
    fake.requests.length = 0;
    const r = (await as(A)(api.http.post(`/v1/ai/assistants/${assistantId}/test-sessions/${sid}/messages`)).send({ text: 'havan kitne type ke hote hai, kitna lagta hai' }).expect(200)).body;
    expect(r.reply).toBe('Ji, Pandit Ji teen prakar ke havan karwate hain: Samanya Havan, Vishesh Havan, Maha Vishesh Havan. Dakshina Pandit Ji call par hi bata payenge 🙏');
    expect(r.trace.toolsUsed.map((x: any) => x.tool)).toEqual(['GET_HAVAN_SERVICE_DETAILS', 'GET_DAKSHINA_POLICY']);
    const first = fake.requests[0];
    expect(first.instructions).toContain('Havan Booking Assistant');
    expect(first.instructions).toContain('Dakshina is NEVER quoted in chat.');
    expect(first.tools).toEqual(expect.arrayContaining(['SEARCH_BAGLAMUKHI_KNOWLEDGE', 'GET_TEMPLE_INFORMATION', 'GET_HAVAN_SERVICE_DETAILS', 'GET_DAKSHINA_POLICY',
      'GET_FESTIVAL_CONTEXT', 'GET_YAJMAN_LEAD', 'UPDATE_YAJMAN_LEAD', 'CHECK_PANDIT_AVAILABILITY', 'GET_AVAILABLE_SLOTS', 'CREATE_HAVAN_BOOKING', 'GET_HAVAN_BOOKING',
      'RESCHEDULE_HAVAN_BOOKING', 'CANCEL_HAVAN_BOOKING', 'CREATE_YAJMAN_REMINDER', 'CREATE_PANDIT_REMINDER', 'REQUEST_PANDIT_HANDOFF']));
    expect(first.tools).not.toContain('CREATE_PAYMENT_LINK');
    // A test chat never writes: a call-back request is only simulated.
    fake.brain = (t) => (t.results.length ? { text: t.results[0].output.status } : { calls: [{ name: 'REQUEST_PANDIT_HANDOFF',
      args: { type: 'CALLBACK', reason: 'DAKSHINA', summary: 'dakshina', callback_number: '9876543210' } }] });
    const before = (await q('SELECT count(*)::int AS n FROM app.havan_callback_requests WHERE organization_id = $1', [A.orgId]))[0].n;
    const r2 = (await as(A)(api.http.post(`/v1/ai/assistants/${assistantId}/test-sessions/${sid}/messages`)).send({ text: '9876543210' }).expect(200)).body;
    expect(r2.reply).toBe('WOULD_REQUEST_CALLBACK');
    expect((await q('SELECT count(*)::int AS n FROM app.havan_callback_requests WHERE organization_id = $1', [A.orgId]))[0].n).toBe(before);
  });
});

describe("Pandit Ji's Google Calendar", () => {
  const cal = (p = '') => `/v1/businesses/${A.businessId}/havan/google-calendar${p}`;
  const day5 = add(d.today, 5);

  it('connect: signed consent URL -> callback stores an encrypted refresh token -> dashboard shows the account', async () => {
    expect((await as(A)(api.http.get(cal())).expect(200)).body).toMatchObject({ configured: true, connected: false });
    const { authUrl } = (await as(A)(api.http.post(cal('/connect'))).expect(200)).body;
    const u = new URL(authUrl);
    expect(u.origin + u.pathname).toBe(`${google.url}/auth`);
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('scope')).toContain('calendar.freebusy');
    // A tampered state is refused (no connection is made).
    const bad = await api.http.get(`/v1/oauth/google/callback?code=x&state=${u.searchParams.get('state')}x`);
    expect(bad.status).toBe(302);
    expect(bad.headers.location).toBe('http://web.test/havan/settings?calendar=expired');
    expect((await api.http.get('/v1/oauth/google/callback?error=access_denied')).headers.location).toBe('http://web.test/havan/settings?calendar=denied');

    const ok = await api.http.get(`/v1/oauth/google/callback?code=auth-code-1&state=${encodeURIComponent(u.searchParams.get('state')!)}`);
    expect(ok.status).toBe(302);
    expect(ok.headers.location).toBe('http://web.test/havan/settings?calendar=connected');
    const row = (await q('SELECT account_email, refresh_token_enc FROM app.calendar_connections WHERE business_id = $1', [A.businessId]))[0];
    expect(row.account_email).toBe('pandit.ji@example.com');
    expect(Buffer.from(row.refresh_token_enc).toString('latin1')).not.toContain('refresh-token-SECRET');
    expect((await as(A)(api.http.get(cal())).expect(200)).body).toMatchObject({ connected: true, email: 'pandit.ji@example.com', status: 'ACTIVE' });
    // Other tenants cannot see or start it for this business.
    expect((await as(B)(api.http.get(cal()))).status).toBe(404);
  });

  it('busy time on the calendar hides slots and blocks a booking at that time', async () => {
    google.busy = [{ start: istInstant(day5, '09:00').toISOString(), end: istInstant(day5, '12:00').toISOString() }];
    const s = await run('GET_AVAILABLE_SLOTS', { date_from: day5, tier: 'VISHESH', time_of_day: 'MORNING' });
    expect(s.success).toBe(true);
    expect(s.googleCalendarChecked).toBe(true);
    // 120-minute havan: nothing may start before 12:00 or overlap 09:00-12:00.
    for (const x of s.slots) {
      const a = Date.parse(x.start_at);
      expect(a >= istInstant(day5, '12:00').getTime() || a + 120 * 60_000 <= istInstant(day5, '09:00').getTime()).toBe(true);
    }
    const c = await run('CHECK_PANDIT_AVAILABILITY', { date: day5, preferred_time: '10:00', tier: 'VISHESH' });
    expect(c.requestedTimeFree).toBe(false);
    const clash = await run('CREATE_HAVAN_BOOKING', { start_at: istInstant(day5, '11:00').toISOString(), tier: 'VISHESH', participation_mode: 'NALKHEDA_IN_PERSON',
      yajman_name: 'Suresh', city: 'Ujjain' }, { config: noConfirm });
    expect(clash).toMatchObject({ success: false, errorCode: 'SLOT_NOT_AVAILABLE' });
  });

  it('a booking becomes a Google Calendar event (worker); cancelling deletes it', async () => {
    const r = await run('CREATE_HAVAN_BOOKING', { start_at: istInstant(day5, '15:00').toISOString(), tier: 'MAHA_VISHESH', participation_mode: 'ONLINE_SANKALP',
      yajman_name: 'Suresh Verma', city: 'Ujjain', gotra: 'Bharadwaj' }, { config: noConfirm });
    expect(r.success, JSON.stringify(r)).toBe(true);
    await relay.relayBatch('relay-havan', 500);
    const link = (await q('SELECT provider_event_id FROM app.calendar_event_links WHERE booking_id = $1', [r.booking.id]))[0];
    const ev = google.events.get(link.provider_event_id);
    expect(ev.summary).toBe('🔥 Maha Vishesh Havan – Suresh Verma');
    expect(ev.description).toMatch(/Mode: Online \(video call se sankalp\)[\s\S]*Gotra: Bharadwaj[\s\S]*Dakshina: call par tay honi hai/);
    expect(ev.start).toEqual({ dateTime: istInstant(day5, '15:00').toISOString(), timeZone: 'Asia/Kolkata' });
    expect((await as(A)(api.http.get(cal())).expect(200)).body.lastSyncedAt).not.toBeNull();

    await run('CANCEL_HAVAN_BOOKING', { booking_id: r.booking.id }, { config: noConfirm });
    await relay.relayBatch('relay-havan', 500);
    expect(google.events.has(link.provider_event_id)).toBe(false);
    expect(await q('SELECT 1 FROM app.calendar_event_links WHERE booking_id = $1', [r.booking.id])).toHaveLength(0);
  });

  it('disconnect revokes the token at Google and forgets the calendar; slots no longer consult it', async () => {
    await as(A)(api.http.delete(cal())).expect(200);
    expect(google.revoked).toBe(true);
    expect((await as(A)(api.http.get(cal())).expect(200)).body.connected).toBe(false);
    const s = await run('GET_AVAILABLE_SLOTS', { date_from: day5, tier: 'VISHESH', time_of_day: 'MORNING' });
    expect(s.googleCalendarChecked).toBeUndefined();
  });
});
