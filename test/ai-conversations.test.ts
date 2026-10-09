import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '../src/common/uuid.js';
import { localDates, newBusiness, seedBusinessData } from './ai-helpers.js';
import { FakeOpenAI } from './fakes/fake-openai.js';
import { intentBrain } from './fakes/intent-brain.js';
import { makeHarness, seedTenant, type Harness, type Tenant } from './helpers.js';
import { startApi, type Api } from './saas-helpers.js';

/**
 * Realistic conversations per template (spec 85), through the REAL runtime,
 * prompt layers, dynamic tool loading, tool gate and backends. The model is a
 * deterministic intent script (test/fakes/intent-brain.ts) that can only pick
 * from the tools the runtime offered - so these tests prove which capabilities
 * each assistant exposes, that the right backend capability answers, and that
 * tools outside the assistant are never executed. They do NOT measure a real
 * LLM's language quality.
 */
let h: Harness;
let api: Api;
let fake: FakeOpenAI;
let T: Tenant;
const d = localDates();
const as = <R extends import('supertest').Test>(r: R) => api.as(T.userId, T.orgId)(r);

async function assistant(templateKey: string, businessId: string, name: string): Promise<string> {
  return (await as(api.http.post('/v1/ai/assistants')).send({ templateKey, businessId, name }).expect(201)).body.id;
}
async function chat(id: string, text: string) {
  fake.requests.length = 0;
  const sid = (await as(api.http.post(`/v1/ai/assistants/${id}/test-sessions`)).send({ customerName: 'Rahul' }).expect(201)).body.id;
  const r = (await as(api.http.post(`/v1/ai/assistants/${id}/test-sessions/${sid}/messages`)).send({ text }).expect(200)).body;
  return { ...r, offered: fake.requests[fake.requests.length - 1].tools, tools: r.trace.toolsUsed.map((t: any) => t.tool) as string[] };
}

beforeAll(async () => {
  fake = await new FakeOpenAI().start();
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.OPENAI_BASE_URL = fake.url;
  h = makeHarness();
  api = await startApi();
  T = await seedTenant(h, 'ai-conv');
  fake.brain = intentBrain(d);
});
afterAll(async () => { await api.app.close(); await h.close(); await fake.stop(); });

describe('realistic template conversations', () => {
  it('Doctor: "Kal Dr Sharma ki appointment chahiye" -> doctor lookup + availability, never a booking without confirmation', async () => {
    const biz = await newBusiness(h, T, 'ABC Dental');
    await seedBusinessData(h, T, biz);
    const id = await assistant('DOCTOR_APPOINTMENT', biz, 'ABC Dental Receptionist');
    const r = await chat(id, 'Kal Dr Sharma ki appointment chahiye');
    expect(r.tools).toEqual(['GET_RESOURCES', 'CHECK_AVAILABILITY']);
    expect(r.reply).toMatch(/Available slots/);
    expect(r.offered).toEqual(expect.arrayContaining(['CHECK_AVAILABILITY', 'CREATE_BOOKING', 'HUMAN_HANDOFF']));
    expect(r.offered).not.toContain('CREATE_PAYMENT_LINK');
    expect(r.offered).not.toContain('CREATE_LEAD');
  });

  it('Restaurant: "4 log kal 8 baje" -> table availability for 4 guests only on tables that seat 4+', async () => {
    const biz = await newBusiness(h, T, 'Spice Garden');
    const [t2, t4, t6] = [uuidv7(), uuidv7(), uuidv7()];
    await h.owner.query(`INSERT INTO app.business_resources (id, organization_id, business_id, resource_type, name, capacity)
                         VALUES ($1, $4, $5, 'TABLE', 'Table 2', 2), ($2, $4, $5, 'TABLE', 'Table 4', 4), ($3, $4, $5, 'TABLE', 'Table 6', 6)`, [t2, t4, t6, T.orgId, biz]);
    await h.owner.query(`INSERT INTO app.availability_rules (organization_id, business_id, day_of_week, start_time, end_time, timezone)
                         SELECT $1, $2, d, '12:00', '23:00', 'Asia/Kolkata' FROM generate_series(1, 7) d`, [T.orgId, biz]);
    const id = await assistant('RESTAURANT_RESERVATION', biz, 'Spice Garden Host');
    const r = await chat(id, '4 log kal 8 baje');
    expect(r.tools).toEqual(['CHECK_AVAILABILITY']);
    const req = fake.requests.find((x) => x.results[0]?.name === 'CHECK_AVAILABILITY')!;
    const out = req.results[0].output;
    expect(out.success).toBe(true);
    const tables = new Set(out.slots.flatMap((s: any) => s.with.map((w: any) => w.name)));
    expect(tables.has('Table 2')).toBe(false);
    expect([...tables].every((n) => n === 'Table 4' || n === 'Table 6')).toBe(true);
    expect(r.offered).not.toContain('CREATE_LEAD');
    // Party size is mandatory for this template: a request without it is refused by the backend, not guessed.
    fake.brain = (t) => (t.results.length ? { text: t.results[0].output.errorCode } : { calls: [{ name: 'CHECK_AVAILABILITY', args: { date_from: d.tomorrow } }] });
    expect((await chat(id, 'kal table?')).reply).toBe('PARTY_SIZE_REQUIRED');
    fake.brain = intentBrain(d);
  });

  it('Salon: "Sunday hair spa ka slot?" -> service lookup, then Sunday availability for the service duration', async () => {
    const biz = await newBusiness(h, T, 'Glow Salon');
    const [spa, anita] = [uuidv7(), uuidv7()];
    await h.owner.query(`INSERT INTO app.services (id, organization_id, business_id, name, duration_minutes, price_minor_units, currency) VALUES ($1, $2, $3, 'Hair Spa', 60, 149900, 'INR')`, [spa, T.orgId, biz]);
    await h.owner.query(`INSERT INTO app.business_resources (id, organization_id, business_id, resource_type, name) VALUES ($1, $2, $3, 'STYLIST', 'Anita')`, [anita, T.orgId, biz]);
    await h.owner.query(`INSERT INTO app.resource_services (organization_id, business_id, resource_id, service_id) VALUES ($1, $2, $3, $4)`, [T.orgId, biz, anita, spa]);
    await h.owner.query(`INSERT INTO app.availability_rules (organization_id, business_id, resource_id, day_of_week, start_time, end_time, timezone)
                         SELECT $1, $2, $3, d, '10:00', '19:00', 'Asia/Kolkata' FROM generate_series(1, 7) d`, [T.orgId, biz, anita]);
    const id = await assistant('SALON_BOOKING', biz, 'Glow Salon Desk');
    const r = await chat(id, 'Sunday hair spa ka slot?');
    expect(r.tools).toEqual(['GET_SERVICES', 'CHECK_AVAILABILITY']);
    const avail = fake.requests.flatMap((x) => x.results).find((x) => x.name === 'CHECK_AVAILABILITY')!.output;
    expect(avail.service).toMatchObject({ name: 'Hair Spa', durationMinutes: 60 });
    expect(avail.slots[0].local).toMatch(/Sun/);
    expect(avail.slots[0].with[0].name).toBe('Anita');
  });

  it('Real estate: "70 lakh tak Indore 3BHK" -> lead captured (dry run in test), no invented properties', async () => {
    const biz = await newBusiness(h, T, 'Indore Homes');
    const id = await assistant('REAL_ESTATE_LEAD', biz, 'Indore Homes Assistant');
    const before = (await h.owner.query('SELECT count(*)::int AS n FROM app.leads WHERE business_id = $1', [biz])).rows[0].n;
    const r = await chat(id, '70 lakh tak Indore 3BHK chahiye');
    expect(r.tools).toEqual(['CREATE_LEAD']);
    expect(r.trace.toolsUsed[0].status).toBe('DRY_RUN');
    const lead = fake.requests.flatMap((x) => x.results).find((x) => x.name === 'CREATE_LEAD')!.output;
    expect(lead.wouldSave).toMatchObject({ bedrooms: 3, budgetMaxMinor: 700000000, location: 'Indore', currency: 'INR' });
    expect(r.reply).toMatch(/Buy karna hai ya rent/);
    expect(r.offered).not.toContain('CHECK_AVAILABILITY'); // site-visit booking is optional and off by default
    expect((await h.owner.query('SELECT count(*)::int AS n FROM app.leads WHERE business_id = $1', [biz])).rows[0].n).toBe(before);
  });

  it('General: "Sunday open ho?" -> business hours tool; booking capabilities are not even offered and cannot be forced', async () => {
    const biz = await newBusiness(h, T, 'City Store');
    await h.owner.query(`UPDATE app.businesses SET business_hours = '{"sat":[["10:00","20:00"]],"sun":[["10:00","16:00"]]}' WHERE id = $1`, [biz]);
    const id = await assistant('GENERAL_BUSINESS_ASSISTANT', biz, 'City Store Assistant');
    const r = await chat(id, 'Sunday open ho?');
    expect(r.tools).toEqual(['GET_BUSINESS_HOURS']);
    expect(r.reply).toBe('Haan, Sunday ko 10:00 se 16:00 tak open hain.');
    expect(r.offered).not.toContain('CREATE_BOOKING');
    // A (misbehaving) model that tries anyway is stopped at the gate.
    fake.brain = (t) => (t.results.length ? { text: `gate: ${t.results[0].output.errorCode}` } : { calls: [{ name: 'CREATE_BOOKING', args: { start_at: new Date().toISOString() } }] });
    const forced = await chat(id, 'kal 5 baje book kar do');
    expect(forced.reply).toBe('gate: TOOL_NOT_ENABLED');
    expect(forced.trace.toolsUsed[0]).toMatchObject({ tool: 'CREATE_BOOKING', status: 'REJECTED' });
    fake.brain = intentBrain(d);
  });
});
