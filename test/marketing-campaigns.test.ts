import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '../src/common/uuid.js';
import { dailyCap, healthProblem, OPT_OUT_FOOTER, renderCampaignMessage, runCampaignTick, sendingSlot, type CampaignDeliveryDeps } from '../src/marketing/campaign-delivery.js';
import { marketingKeyword } from '../src/marketing/consent.js';
import { MessagingRepository } from '../src/repositories/messaging.repository.js';
import { OpsRepository } from '../src/repositories/ops.repository.js';
import { MessageIngestionService } from '../src/services/message-ingestion.service.js';
import { NotificationService } from '../src/services/notification.service.js';
import { OutboundMessageService } from '../src/services/outbound-message.service.js';
import { makeHarness, seedTenant, type Harness, type Tenant } from './helpers.js';
import { startApi, type Api } from './saas-helpers.js';

/*
 * Consent-first WhatsApp marketing campaigns: who can be reached, STOP/START,
 * paced delivery through the outbox relay, and tenant isolation.
 */
describe('marketing rules (unit)', () => {
  it('recognises STOP / START only when the whole message is the keyword', () => {
    expect(marketingKeyword('STOP')).toBe('STOP');
    expect(marketingKeyword(' stop! ')).toBe('STOP');
    expect(marketingKeyword('Band karo 🙏')).toBe('STOP');
    expect(marketingKeyword('बंद करो')).toBe('STOP');
    expect(marketingKeyword('start')).toBe('START');
    expect(marketingKeyword('please stop by the shop tomorrow')).toBeNull();
    expect(marketingKeyword('Kaju katli available hai?')).toBeNull();
    expect(marketingKeyword(null)).toBeNull();
  });

  it('personalises {name} and always carries an opt-out line', () => {
    expect(renderCampaignMessage('Namaste {name} ji, Diwali offer!', 'Ramesh Kumar')).toBe(`Namaste Ramesh ji, Diwali offer!\n\n${OPT_OUT_FOOTER}`);
    expect(renderCampaignMessage('Namaste {name} ji, Diwali offer!', null)).toBe(`Namaste ji, Diwali offer!\n\n${OPT_OUT_FOOTER}`);
    expect(renderCampaignMessage('Offer! Reply STOP to unsubscribe.', 'A')).toBe('Offer! Reply STOP to unsubscribe.');
  });

  it('limits new numbers (warm-up), keeps sending hours and pauses on bad signals', () => {
    expect(dailyCap(5000, 2)).toBe(50);
    expect(dailyCap(5000, 10)).toBe(250);
    expect(dailyCap(1000, 60)).toBe(1000);
    expect(dailyCap(null, 60)).toBe(50);
    expect(sendingSlot(8 * 60, 540, 1200)).toBe('BEFORE');
    expect(sendingSlot(12 * 60, 540, 1200)).toBe('OPEN');
    expect(sendingSlot(20 * 60, 540, 1200)).toBe('AFTER');
    expect(healthProblem({ queued: 10, failed: 0, optedOut: 3 })).toBeNull(); // too early to judge
    expect(healthProblem({ queued: 40, failed: 0, optedOut: 2 })).toMatch(/STOP/);
    expect(healthProblem({ queued: 40, failed: 1, optedOut: 1 })).toBeNull();
    expect(healthProblem({ queued: 20, failed: 6, optedOut: 0 })).toMatch(/failed/);
  });
});

let h: Harness;
let api: Api;
let A: Tenant;
let B: Tenant;
let deps: CampaignDeliveryDeps;
const ops = new OpsRepository();
const messaging = new MessagingRepository();
const as = (t: Tenant) => <T extends import('supertest').Test>(r: T) => api.as(t.userId, t.orgId)(r);
const url = (t: Tenant, p = '') => `/v1/businesses/${t.businessId}/campaigns${p}`;
const q = async (sql: string, p: unknown[] = []) => (await h.owner.query(sql, p)).rows;
let manualContact: string;
let chattedContact: string;
let chattedJid: string;

async function addContact(t: Tenant, name: string, withInbound: boolean) {
  const id = uuidv7();
  const jid = `9198${Math.floor(10_000_000 + Math.random() * 89_999_999)}@s.whatsapp.net`;
  await h.owner.query(`INSERT INTO app.contacts (id, organization_id, business_id, whatsapp_jid, display_name, source) VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, t.orgId, t.businessId, jid, name, withInbound ? 'WHATSAPP_INBOUND' : 'MANUAL']);
  if (withInbound) {
    const conv = uuidv7();
    await h.owner.query(`INSERT INTO app.conversations (id, organization_id, business_id, whatsapp_instance_id, contact_id) VALUES ($1, $2, $3, $4, $5)`,
      [conv, t.orgId, t.businessId, t.instanceId, id]);
    await h.owner.query(
      `INSERT INTO app.messages (id, organization_id, business_id, whatsapp_instance_id, conversation_id, contact_id, provider_message_id, direction,
                                 sender_jid, recipient_jid, message_type, text_body, provider_timestamp, status, from_me)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'INBOUND', $8, $9, 'TEXT', 'hello', now(), 'RECEIVED', false)`,
      [uuidv7(), t.orgId, t.businessId, t.instanceId, conv, id, `P${id.slice(-8)}`, jid, t.instanceJid]);
  }
  return { id, jid };
}
/**
 * Runs the current tick of every running campaign of the tenant, as the relay would once it is due.
 * (Called directly: test files share one database, and another file's relay may complete events it has no handler for.)
 */
async function tick(orgId: string) {
  const rows = await q(`SELECT id, tick_seq FROM app.marketing_campaigns WHERE organization_id = $1 AND status IN ('SENDING','SCHEDULED','PAUSED')`, [orgId]);
  for (const r of rows) {
    await runCampaignTick(deps, { id: r.id, organizationId: orgId, eventType: 'CAMPAIGN_TICK', aggregateType: 'CAMPAIGN', aggregateId: r.id,
      payload: { campaign_id: r.id, seq: r.tick_seq }, attempts: 1 } as never);
  }
}

beforeAll(async () => {
  h = makeHarness();
  api = await startApi();
  A = await seedTenant(h, 'mkt-a');
  B = await seedTenant(h, 'mkt-b');
  deps = { tx: h.workerTx, ops, messaging, outbound: new OutboundMessageService(h.workerTx, messaging, ops),
    notifications: new NotificationService(h.workerTx, api.bus), bus: api.bus };
  chattedContact = (await addContact(A, 'Ramesh Kumar', true)).id;
  chattedJid = (await q(`SELECT whatsapp_jid FROM app.contacts WHERE id = $1`, [chattedContact]))[0].whatsapp_jid;
  manualContact = (await addContact(A, 'Walk-in Customer', false)).id;
});
afterAll(async () => { await api.app.close(); await h.close(); });

describe('consent-first audience', () => {
  it('only people who messaged the business (or opted in) are reachable', async () => {
    const a = (await as(A)(api.http.post(url(A, '/audience'))).send({ audience: { type: 'ALL' } }).expect(200)).body;
    // Fixture contact + Ramesh have messaged the business; the walk-in customer has not.
    expect(a.eligible).toBe(2);
    expect(a.noConsent).toBe(1);
    const list = (await as(A)(api.http.get(url(A, '/contacts?status=NO_CONSENT'))).expect(200)).body;
    expect(list.map((x: any) => x.id)).toEqual([manualContact]);
  });

  it('a manual opt-in must say how the customer agreed, and then counts', async () => {
    expect((await as(A)(api.http.put(url(A, `/contacts/${manualContact}/preference`))).send({ status: 'OPTED_IN' })).status).toBe(400);
    await as(A)(api.http.put(url(A, `/contacts/${manualContact}/preference`))).send({ status: 'OPTED_IN', note: 'Signed up at the shop counter' }).expect(200);
    expect((await as(A)(api.http.post(url(A, '/audience'))).send({})).body.eligible).toBe(3);
    const log = await q(`SELECT action FROM app.audit_logs WHERE organization_id = $1 AND action = 'MARKETING_OPT_IN'`, [A.orgId]);
    expect(log.length).toBe(1);
  });

  it('a customer who replies STOP is removed, and only they can come back with START', async () => {
    const ingest = new MessageIngestionService(h.workerTx, messaging, ops);
    const inbound = (text: string) => ingest.ingest({ organizationId: A.orgId, businessId: A.businessId, instanceId: A.instanceId, instanceJid: A.instanceJid,
      providerMessageId: `STOP${uuidv7().slice(-10)}`, fromJid: chattedJid, type: 'TEXT', text, providerTimestamp: new Date() });
    await inbound('Stop');
    expect((await q(`SELECT status, source FROM app.marketing_contact_prefs WHERE contact_id = $1`, [chattedContact]))[0]).toEqual({ status: 'OPTED_OUT', source: 'KEYWORD' });
    expect((await as(A)(api.http.post(url(A, '/audience'))).send({})).body.eligible).toBe(2);
    // The business cannot override the customer's STOP.
    expect((await as(A)(api.http.put(url(A, `/contacts/${chattedContact}/preference`))).send({ status: 'OPTED_IN', note: 'he said ok' })).status).toBe(409);
    await inbound('START');
    expect((await q(`SELECT status FROM app.marketing_contact_prefs WHERE contact_id = $1`, [chattedContact]))[0].status).toBe('OPTED_IN');
    await inbound('stop by tomorrow please'); // not a keyword
    expect((await q(`SELECT status FROM app.marketing_contact_prefs WHERE contact_id = $1`, [chattedContact]))[0].status).toBe('OPTED_IN');
  });
});

describe('paced campaign delivery', () => {
  let id: string;
  const body = () => ({ name: 'Diwali offer', message: 'Namaste {name} ji 🙏 Diwali par *20% off*!', whatsappInstanceId: A.instanceId,
    audience: { type: 'ALL' }, sendFrom: '00:00', sendUntil: '24:00', intervalSeconds: 20 });

  it('validates input and keeps sending speed within safe limits', async () => {
    expect((await as(A)(api.http.post(url(A))).send({ ...body(), intervalSeconds: 5 })).status).toBe(400);
    expect((await as(A)(api.http.post(url(A))).send({ ...body(), sendFrom: '10:00', sendUntil: '10:30' })).status).toBe(400);
    expect((await as(A)(api.http.post(url(A))).send({ ...body(), whatsappInstanceId: B.instanceId })).status).toBe(400);
    const cr = await as(A)(api.http.post(url(A))).send(body()).expect(201);
    id = cr.body.id;
  });

  it('snapshots the eligible audience and sends ONE message per tick with the opt-out line', async () => {
    const s = (await as(A)(api.http.post(url(A, `/${id}/start`))).send({}).expect(200)).body;
    expect(s.status).toBe('SENDING');
    expect(s.recipientCount).toBe(3);
    await tick(A.orgId);
    let msgs = await q(`SELECT m.text_body FROM app.marketing_campaign_recipients r JOIN app.messages m ON m.id = r.message_id WHERE r.campaign_id = $1`, [id]);
    expect(msgs.length).toBe(1);
    expect(msgs[0].text_body).toContain('STOP');
    expect(msgs[0].text_body).not.toContain('{name}');
    // The next message waits for the interval, not sent in a burst.
    const next = await q(`SELECT o.available_at > now() + interval '10 seconds' AS later FROM app.outbox_events o JOIN app.marketing_campaigns c ON o.dedupe_key = 'campaign:' || c.id || ':' || c.tick_seq
                          WHERE c.id = $1`, [id]);
    expect(next).toEqual([{ later: true }]);
    await tick(A.orgId);
    await tick(A.orgId);
    msgs = await q(`SELECT m.text_body FROM app.marketing_campaign_recipients r JOIN app.messages m ON m.id = r.message_id WHERE r.campaign_id = $1`, [id]);
    expect(msgs.length).toBe(3);
    expect(msgs.map((m: any) => m.text_body).join('|')).toContain('Namaste Ramesh ji');
    await tick(A.orgId);
    const done = (await as(A)(api.http.get(url(A, `/${id}`))).expect(200)).body;
    expect(done.status).toBe('COMPLETED');
    expect(done.stats).toMatchObject({ total: 3, sent: 3, pending: 0 });
    // A started campaign cannot be started or edited again.
    expect((await as(A)(api.http.post(url(A, `/${id}/start`))).send({})).status).toBe(409);
    expect((await as(A)(api.http.put(url(A, `/${id}`))).send(body())).status).toBe(409);
  });

  it('skips a customer who replied STOP after the campaign started; pause stops sending, resume continues once', async () => {
    const c2 = (await as(A)(api.http.post(url(A))).send({ ...body(), name: 'New arrivals' }).expect(201)).body.id;
    await as(A)(api.http.post(url(A, `/${c2}/start`))).send({}).expect(200);
    await h.owner.query(`UPDATE app.marketing_contact_prefs SET status = 'OPTED_OUT', source = 'KEYWORD' WHERE contact_id = $1`, [manualContact]);
    await as(A)(api.http.post(url(A, `/${c2}/pause`))).expect(200);
    await tick(A.orgId);
    expect((await q(`SELECT count(*)::int AS n FROM app.marketing_campaign_recipients WHERE campaign_id = $1 AND status <> 'PENDING'`, [c2]))[0].n).toBe(0);
    await as(A)(api.http.post(url(A, `/${c2}/resume`))).expect(200);
    for (let i = 0; i < 5; i++) await tick(A.orgId);
    const r = await q(`SELECT contact_id, status, skip_reason FROM app.marketing_campaign_recipients WHERE campaign_id = $1 ORDER BY status`, [c2]);
    expect(r.filter((x: any) => x.status === 'QUEUED').length).toBe(2);
    expect(r.find((x: any) => x.contact_id === manualContact)).toMatchObject({ status: 'SKIPPED', skip_reason: 'OPTED_OUT' });
    // Resume started exactly one chain: no customer got the campaign twice.
    const dup = await q(`SELECT count(*)::int AS n FROM app.messages WHERE idempotency_key LIKE 'campaign:%' AND organization_id = $1`, [A.orgId]);
    expect(dup[0].n).toBe(5);
  });

  it('waits outside sending hours instead of sending', async () => {
    const now = new Date();
    const ist = (now.getUTCHours() * 60 + now.getUTCMinutes() + 330) % 1440;
    // A two-hour window that starts one hour from now (business time).
    const from = (ist + 60) % 1440;
    if (from + 120 > 1440) return; // too close to midnight to build the window; covered by the unit test
    const hh = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const c3 = (await as(A)(api.http.post(url(A))).send({ ...body(), name: 'Evening offer', sendFrom: hh(from), sendUntil: hh(from + 120) }).expect(201)).body.id;
    await h.owner.query(`UPDATE app.marketing_contact_prefs SET status = 'OPTED_IN' WHERE contact_id = $1`, [manualContact]);
    await as(A)(api.http.post(url(A, `/${c3}/start`))).send({}).expect(200);
    await tick(A.orgId);
    const c = (await as(A)(api.http.get(url(A, `/${c3}`))).expect(200)).body;
    expect(c.waitingReason).toBe('OUTSIDE_HOURS');
    expect(c.stats.sent).toBe(0);
    await as(A)(api.http.post(url(A, `/${c3}/cancel`))).expect(200);
  });

  it('another business cannot see or control these campaigns', async () => {
    expect((await as(B)(api.http.get(url(A, `/${id}`)))).status).toBe(404);
    expect((await as(B)(api.http.post(url(A, `/${id}/pause`)))).status).toBe(404);
    expect((await as(B)(api.http.get(url(B)))).body).toEqual([]);
  });
});
