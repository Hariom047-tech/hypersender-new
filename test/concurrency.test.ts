import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '../src/common/uuid.js';
import type { InboundWhatsAppMessage } from '../src/services/message-ingestion.service.js';
import { asUser, asWorker, makeHarness, registerWorker, seedTenant, type Harness, type Tenant } from './helpers.js';

let h: Harness;
let A: Tenant;
let B: Tenant;

beforeAll(async () => {
  h = makeHarness();
  A = await seedTenant(h, 'conc-a');
  B = await seedTenant(h, 'conc-b');
});
afterAll(async () => h.close());

const N = 8;

function inbound(t: Tenant, providerMessageId: string, text = 'Hi, I need an appointment'): InboundWhatsAppMessage {
  return { organizationId: t.orgId, businessId: t.businessId, instanceId: t.instanceId, instanceJid: t.instanceJid, providerMessageId,
    fromJid: '919811112222@s.whatsapp.net', fromPhoneE164: '+919811112222', pushName: 'Rahul', type: 'TEXT', text,
    providerTimestamp: new Date() };
}

describe('message ingestion idempotency', () => {
  it(`${N} concurrent deliveries of the same provider message create exactly one message, event and usage row`, async () => {
    const pmid = `3EB0${uuidv7().replace(/-/g, '').toUpperCase()}`;
    const results = await Promise.all(Array.from({ length: N }, () => h.services.ingestion.ingest(inbound(A, pmid))));
    expect(results.filter((r) => r.status === 'CREATED')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'DUPLICATE')).toHaveLength(N - 1);
    expect(new Set(results.map((r) => r.messageId)).size).toBe(1);

    const id = results[0].messageId;
    const q = (sql: string) => h.owner.query(sql, [id]).then((r) => r.rows[0].n);
    expect(await q(`SELECT count(*)::int AS n FROM app.messages WHERE id = $1`)).toBe(1);
    expect(await q(`SELECT count(*)::int AS n FROM app.outbox_events WHERE aggregate_id = $1 AND event_type = 'MESSAGE_RECEIVED'`)).toBe(1);
    expect(await q(`SELECT count(*)::int AS n FROM app.usage_events WHERE resource_id = $1`)).toBe(1);
    const conv = await h.owner.query('SELECT unread_count FROM app.conversations WHERE id = $1', [results[0].conversationId]);
    expect(conv.rows[0].unread_count).toBe(1);
  });

  it('the same provider message id on a different instance/tenant is a different message', async () => {
    const pmid = `SHARED${Date.now()}`;
    const [a, b] = await Promise.all([h.services.ingestion.ingest(inbound(A, pmid)), h.services.ingestion.ingest(inbound(B, pmid))]);
    expect([a.status, b.status]).toEqual(['CREATED', 'CREATED']);
    expect(a.messageId).not.toBe(b.messageId);
  });

  it('receipts are forward-only and duplicate-safe', async () => {
    const { messageId } = await h.services.outboundWorker.enqueueText(asWorker(A), { conversationId: A.conversationId, text: 'Your slot is 5pm', idempotencyKey: uuidv7() });
    const pmid = `OUT${Date.now()}`;
    await Promise.all([1, 2, 3].map(() => h.services.outboundWorker.markSent(A.orgId, messageId, pmid, new Date())));
    await h.services.outboundWorker.applyReceipt(A.orgId, A.instanceId, pmid, 'READ', new Date());
    await h.services.outboundWorker.applyReceipt(A.orgId, A.instanceId, pmid, 'DELIVERED', new Date()); // late, out of order
    await h.services.outboundWorker.applyReceipt(A.orgId, A.instanceId, pmid, 'READ', new Date());      // duplicate
    const m = await h.owner.query('SELECT status FROM app.messages WHERE id = $1', [messageId]);
    expect(m.rows[0].status).toBe('READ');
    const ev = await h.owner.query('SELECT status FROM app.message_status_events WHERE message_id = $1 ORDER BY status', [messageId]);
    expect(ev.rows.map((r) => r.status)).toEqual(['READ', 'SENT']);
    const usage = await h.owner.query(`SELECT count(*)::int AS n FROM app.usage_events WHERE resource_id = $1`, [messageId]);
    expect(usage.rows[0].n).toBe(1);
  });

  it('outbound sends are idempotent per idempotency key', async () => {
    const key = `api-${uuidv7()}`;
    const res = await Promise.all(Array.from({ length: N }, () =>
      h.services.outboundApp.enqueueText(asUser(A), { conversationId: A.conversationId, text: 'hello', idempotencyKey: key })));
    expect(new Set(res.map((r) => r.messageId)).size).toBe(1);
    expect(res.filter((r) => !r.duplicate)).toHaveLength(1);
  });
});

describe('booking races', () => {
  const slot = (daysAhead: number) => {
    const start = new Date(Date.UTC(2031, 0, 1 + daysAhead, 5, 30)); // 11:00 IST
    return { startAt: start, endAt: new Date(+start + 30 * 60_000) };
  };
  const booking = (t: Tenant, s: { startAt: Date; endAt: Date }, key?: string) => ({
    businessId: t.businessId, contactId: t.contactId, serviceId: t.serviceId, resourceId: t.resourceId, bookingType: 'APPOINTMENT',
    ...s, timezone: 'Asia/Kolkata', customerName: 'Rahul', customerPhone: '+919811112222', source: 'AI_WHATSAPP' as const,
    createdByType: 'AI' as const, aiAgentId: t.agentId, idempotencyKey: key, confirm: true,
  });

  it(`${N} simultaneous attempts for the same resource/time: exactly one succeeds`, async () => {
    const s = slot(1);
    const results = await Promise.all(Array.from({ length: N }, (_, i) =>
      h.services.bookingsWorker.createBooking(asWorker(A), booking(A, s, `run-${uuidv7()}:call-${i}`))));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.reason === 'SLOT_UNAVAILABLE')).toHaveLength(N - 1);
  });

  it('overlapping (not identical) slots are also rejected; adjacent slots are allowed', async () => {
    const s = slot(2);
    expect((await h.services.bookingsWorker.createBooking(asWorker(A), booking(A, s))).ok).toBe(true);
    const overlap = { startAt: new Date(+s.startAt + 15 * 60_000), endAt: new Date(+s.endAt + 15 * 60_000) };
    expect(await h.services.bookingsWorker.createBooking(asWorker(A), booking(A, overlap))).toEqual({ ok: false, reason: 'SLOT_UNAVAILABLE' });
    const adjacent = { startAt: s.endAt, endAt: new Date(+s.endAt + 30 * 60_000) };
    expect((await h.services.bookingsWorker.createBooking(asWorker(A), booking(A, adjacent))).ok).toBe(true);
  });

  it('a retried AI tool call (same idempotency key) returns the same booking instead of a second one', async () => {
    const key = `run-${uuidv7()}:toolu_01`;
    const results = await Promise.all(Array.from({ length: N }, () => h.services.bookingsWorker.createBooking(asWorker(A), booking(A, slot(3), key))));
    const ids = new Set(results.map((r) => (r.ok ? r.bookingId : r.reason)));
    expect(ids.size).toBe(1);
    expect(results.every((r) => r.ok)).toBe(true);
    const n = await h.owner.query('SELECT count(*)::int AS n FROM app.bookings WHERE idempotency_key = $1', [key]);
    expect(n.rows[0].n).toBe(1);
  });

  it('a cancelled booking frees the slot', async () => {
    const s = slot(4);
    const first = await h.services.bookingsWorker.createBooking(asWorker(A), booking(A, s));
    expect(first.ok).toBe(true);
    await h.workerTx.inTenant((db) => h.repos.bookings.cancel(db, (first as { bookingId: string }).bookingId), asWorker(A));
    expect((await h.services.bookingsWorker.createBooking(asWorker(A), booking(A, s))).ok).toBe(true);
  });

  it('bookings outside availability rules are refused before touching the calendar', async () => {
    await h.owner.query(`INSERT INTO app.availability_exceptions (organization_id, business_id, resource_id, start_at, end_at, type, reason)
                         VALUES ($1, $2, $3, $4, $5, 'LEAVE', 'conference')`,
      [A.orgId, A.businessId, A.resourceId, slot(5).startAt, new Date(+slot(5).startAt + 86_400_000)]);
    expect(await h.services.bookingsWorker.createBooking(asWorker(A), booking(A, slot(5)))).toEqual({ ok: false, reason: 'OUTSIDE_AVAILABILITY' });
  });
});

describe('WhatsApp session ownership', () => {
  it('two workers racing to claim the same instance: exactly one wins', async () => {
    const workers = await Promise.all(Array.from({ length: N }, (_, i) => registerWorker(h, `gw-race-${i}`)));
    const tokens = await Promise.all(workers.map((w) => h.workerTx.run({}, (db) => h.repos.whatsapp.claimLease(db, B.instanceId, w, 60))));
    expect(tokens.filter((t) => t !== null)).toHaveLength(1);
    const winner = workers[tokens.findIndex((t) => t !== null)];
    const row = await h.owner.query('SELECT worker_id FROM app.whatsapp_instances WHERE id = $1', [B.instanceId]);
    expect(row.rows[0].worker_id).toBe(winner);
    // Renewal by the owner keeps the token; release frees it for others.
    const renewed = await h.workerTx.run({}, (db) => h.repos.whatsapp.claimLease(db, B.instanceId, winner, 60));
    expect(renewed).toBe(tokens.find((t) => t !== null));
    expect(await h.workerTx.run({}, (db) => h.repos.whatsapp.releaseLease(db, B.instanceId, winner, renewed!))).toBe(true);
    const next = await h.workerTx.run({}, (db) => h.repos.whatsapp.claimLease(db, B.instanceId, workers.find((w) => w !== winner)!, 60));
    expect(next).toBe(renewed! + 1);
  });
});

describe('AI responder races', () => {
  it('two (or more) AI workers on the same inbound message: one run, one reply', async () => {
    const { messageId } = await h.services.ingestion.ingest(inbound(A, `AI${Date.now()}`, 'Do you have a slot tomorrow?'));
    const claims = await Promise.all(Array.from({ length: N }, (_, i) => h.services.ai.claim(A.orgId, messageId, `ai-worker-${i}`)));
    const won = claims.filter((c) => c.claimed);
    expect(won).toHaveLength(1);
    expect(claims.filter((c) => !c.claimed && c.reason === 'ALREADY_CLAIMED')).toHaveLength(N - 1);

    const runId = (won[0] as { runId: string }).runId;
    const reply = { text: 'Yes - 11:00 is free.', inputTokens: 900, outputTokens: 40, latencyMs: 812 };
    const done = await Promise.all([h.services.ai.complete(A.orgId, runId, reply), h.services.ai.complete(A.orgId, runId, reply)]);
    expect(done[0].messageId).toBe(done[1].messageId);
    const out = await h.owner.query(`SELECT count(*)::int AS n FROM app.messages WHERE idempotency_key = $1`, [`ai-run:${runId}`]);
    expect(out.rows[0].n).toBe(1);
    const run = await h.owner.query('SELECT status, response_message_id FROM app.ai_runs WHERE id = $1', [runId]);
    expect(run.rows[0]).toEqual({ status: 'SUCCEEDED', response_message_id: done[0].messageId });
    const usage = await h.owner.query(`SELECT event_type, quantity FROM app.usage_events WHERE resource_id = $1 ORDER BY event_type`, [runId]);
    expect(usage.rows).toEqual([
      { event_type: 'AI_INPUT_TOKENS', quantity: 900 }, { event_type: 'AI_OUTPUT_TOKENS', quantity: 40 }, { event_type: 'AI_RUN', quantity: 1 }]);
  });

  it('AI tool execution is recorded once and the model only sees the backend result', async () => {
    const { messageId } = await h.services.ingestion.ingest(inbound(A, `AITOOL${Date.now()}`, 'Book me for tomorrow 11am'));
    const claim = await h.services.ai.claim(A.orgId, messageId, 'ai-tool-worker');
    expect(claim.claimed).toBe(true);
    const runId = (claim as { runId: string }).runId;
    let executions = 0;
    const s = { startAt: new Date(Date.UTC(2031, 5, 1, 5, 30)), endAt: new Date(Date.UTC(2031, 5, 1, 6, 0)) };
    const exec = async () => {
      executions++;
      const r = await h.services.bookingsWorker.createBooking(asWorker(A), {
        businessId: A.businessId, contactId: A.contactId, resourceId: A.resourceId, serviceId: A.serviceId, bookingType: 'APPOINTMENT', ...s,
        timezone: 'Asia/Kolkata', customerName: 'Rahul', customerPhone: '+919811112222', source: 'AI_WHATSAPP', createdByType: 'AI',
        aiAgentId: A.agentId, idempotencyKey: `${runId}:toolu_1`, confirm: true });
      return r.ok ? { ok: true, summary: { booking_id: r.bookingId } } : { ok: false, summary: { reason: r.reason } };
    };
    const first = await h.services.ai.runTool(A.orgId, runId, 'toolu_1', 'CREATE_BOOKING', { start_at: s.startAt.toISOString() }, exec);
    const replay = await h.services.ai.runTool(A.orgId, runId, 'toolu_1', 'CREATE_BOOKING', { start_at: s.startAt.toISOString() }, exec);
    expect(first.ok).toBe(true);
    expect(replay).toEqual({ ok: true, summary: first.summary });
    expect(executions).toBe(1);
  });

  it('no AI run when a human has taken over the conversation', async () => {
    await h.owner.query(`UPDATE app.conversations SET handling_mode = 'HUMAN' WHERE organization_id = $1`, [B.orgId]);
    const { messageId } = await h.services.ingestion.ingest(inbound(B, `HUMAN${Date.now()}`));
    expect(await h.services.ai.claim(B.orgId, messageId, 'w')).toEqual({ claimed: false, reason: 'HUMAN_HANDLING' });
  });
});

describe('webhook delivery races', () => {
  it('two dispatchers never claim the same delivery; every delivery is claimed exactly once', async () => {
    await h.services.webhooksApp.createEndpoint(asUser(A), { name: 'org-wide', url: `https://hooks.example.test/${uuidv7()}`, eventTypes: ['MESSAGE_RECEIVED'] });
    const total = 30;
    for (let i = 0; i < total; i++) {
      await h.services.webhooksWorker.fanOut(A.orgId, { eventType: 'MESSAGE_RECEIVED', businessId: A.businessId, instanceId: A.instanceId,
        resourceType: 'MESSAGE', resourceId: uuidv7(), payload: { i }, idempotencyKey: `race-${i}-${uuidv7()}` });
    }
    const [c1, c2, c3] = await Promise.all(['w1', 'w2', 'w3'].map((w) => h.workerTx.run({}, (db) => h.repos.webhooks.claimDue(db, w, 20))));
    const ids = [...c1, ...c2, ...c3].map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(total);
    // A dispatcher whose visibility timeout lapsed cannot overwrite the new owner's result.
    const stolen = c1[0];
    expect(await h.workerTx.inTenant((db) => h.repos.webhooks.recordOutcome(db, { id: stolen.id, workerId: 'someone-else', delivered: true }), asWorker(A))).toBe(false);
  });

  it('fan-out is idempotent and follows the precedence rules (same URL at several scopes -> one delivery via most specific endpoint)', async () => {
    const url = `https://hooks.example.test/dup-${uuidv7()}`;
    const orgEp = await h.services.webhooksApp.createEndpoint(asUser(B), { name: 'org', url, eventTypes: ['MESSAGE_SENT'] });
    const instEp = await h.services.webhooksApp.createEndpoint(asUser(B), { name: 'inst', url, businessId: B.businessId, instanceId: B.instanceId, eventTypes: ['MESSAGE_SENT'] });
    const other = await h.services.webhooksApp.createEndpoint(asUser(B), { name: 'biz', url: `${url}-other`, businessId: B.businessId, eventTypes: ['MESSAGE_SENT'] });
    const ev = { eventType: 'MESSAGE_SENT', businessId: B.businessId, instanceId: B.instanceId, resourceType: 'MESSAGE', resourceId: uuidv7(),
                 payload: { hello: 'world' }, idempotencyKey: `outbox:${uuidv7()}` };
    const counts = await Promise.all([1, 2, 3].map(() => h.services.webhooksWorker.fanOut(B.orgId, ev)));
    expect(counts.reduce((a, b) => a + b, 0)).toBe(2);
    const targets = await h.owner.query(
      `SELECT d.webhook_endpoint_id FROM app.webhook_deliveries d JOIN app.webhook_events e ON e.id = d.webhook_event_id
        WHERE e.idempotency_key = $1 ORDER BY 1`, [ev.idempotencyKey]);
    expect(targets.rows.map((r) => r.webhook_endpoint_id).sort()).toEqual([instEp.id, other.id].sort());
    expect(targets.rows.map((r) => r.webhook_endpoint_id)).not.toContain(orgEp.id);
  });

  it('dispatch signs, delivers, and schedules retries without affecting ingestion', async () => {
    const sent: Array<{ url: string; headers: Record<string, string> }> = [];
    let fail = true;
    const http = { post: async (url: string, _body: string, headers: Record<string, string>) => {
      sent.push({ url, headers });
      if (fail) throw new Error('ECONNREFUSED');
      return { status: 200, body: 'ok' };
    } };
    await h.owner.query(`UPDATE app.webhook_deliveries SET status = 'DEAD', next_retry_at = NULL WHERE status <> 'DELIVERED'`);
    await h.services.webhooksWorker.fanOut(A.orgId, { eventType: 'MESSAGE_RECEIVED', businessId: A.businessId, instanceId: A.instanceId,
      resourceType: 'MESSAGE', resourceId: uuidv7(), payload: { x: 1 }, idempotencyKey: `dispatch-${uuidv7()}` });
    expect(await h.services.webhooksWorker.dispatchBatch('disp-1', http)).toBe(1);
    const failed = await h.owner.query(`SELECT status, attempt_number, next_retry_at > now() AS later FROM app.webhook_deliveries WHERE locked_by IS NULL AND status = 'RETRYING'`);
    expect(failed.rows).toEqual([{ status: 'RETRYING', attempt_number: 1, later: true }]);
    // Phase 2 public signature scheme (docs/webhook-events.md).
    expect(sent[0].headers['x-webhook-signature']).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(sent[0].headers['x-webhook-id']).toMatch(/^evt_/);
    expect(sent[0].headers['x-webhook-timestamp']).toMatch(/^\d+$/);

    fail = false;
    await h.owner.query(`UPDATE app.webhook_deliveries SET next_retry_at = now() WHERE status = 'RETRYING'`);
    // Ingestion keeps working regardless of webhook state.
    expect((await h.services.ingestion.ingest(inbound(A, `WH${Date.now()}`))).status).toBe('CREATED');
    expect(await h.services.webhooksWorker.dispatchBatch('disp-2', http)).toBe(1);
    const ok = await h.owner.query(`SELECT count(*)::int AS n FROM app.webhook_deliveries WHERE status = 'DELIVERED' AND attempt_number = 2`);
    expect(ok.rows[0].n).toBe(1);
  });
});

describe('outbox relay', () => {
  it('parallel relays process each event exactly once and handlers run under the event tenant', async () => {
    await h.owner.query(`UPDATE app.outbox_events SET status = 'PROCESSED', processed_at = now() WHERE status <> 'PROCESSED'`);
    for (let i = 0; i < 12; i++) {
      await h.services.ingestion.ingest(inbound(i % 2 ? A : B, `RELAY${i}-${Date.now()}`));
    }
    const seen: string[] = [];
    const orgs = new Set<string>();
    h.services.relay.on('MESSAGE_RECEIVED', async (e) => {
      seen.push(e.id);
      // Handler reads under the event's own tenant only.
      const r = await h.workerTx.inTenant((db) => db.query('SELECT organization_id FROM app.messages WHERE id = $1', [e.aggregateId]),
        { organizationId: e.organizationId! });
      expect(r.rows[0].organization_id).toBe(e.organizationId);
      orgs.add(e.organizationId!);
    });
    const processed = await Promise.all(['r1', 'r2', 'r3'].map((w) => h.services.relay.relayBatch(w, 10)));
    expect(processed.reduce((a, b) => a + b, 0)).toBe(12);
    expect(new Set(seen).size).toBe(seen.length);
    expect(orgs).toEqual(new Set([A.orgId, B.orgId]));
    const pending = await h.owner.query(`SELECT count(*)::int AS n FROM app.outbox_events WHERE status <> 'PROCESSED'`);
    expect(pending.rows[0].n).toBe(0);
  });
});
