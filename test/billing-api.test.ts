import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { HmacSessionService } from '../src/api/auth/session.service.js';
import { uuidv7 } from '../src/common/uuid.js';
import { makeHarness, seedTenant, TEST_DB, type Harness, type Tenant } from './helpers.js';

let h: Harness;
let A: Tenant;
let B: Tenant;
let app: NestExpressApplication;
let http: ReturnType<typeof request>;
let tokenA: string;
let tokenB: string;
const inv: Record<string, string> = {};

const asA = (r: request.Test) => r.set('authorization', `Bearer ${tokenA}`).set('x-organization-id', A.orgId);
const asB = (r: request.Test) => r.set('authorization', `Bearer ${tokenB}`).set('x-organization-id', B.orgId);

async function invoice(t: Tenant, status: string, o: { total?: number; due?: string; paid?: boolean; method?: string; payStatus?: string; ago?: number } = {}) {
  const id = uuidv7();
  const sub = (await h.owner.query('SELECT id FROM app.subscriptions WHERE organization_id = $1 LIMIT 1', [t.orgId])).rows[0].id;
  const total = o.total ?? 117900;
  await h.owner.query(
    `INSERT INTO app.invoices (id, organization_id, subscription_id, provider, invoice_number, status, currency, subtotal_minor, tax_minor, total_minor,
                               amount_paid_minor, issued_at, due_at, paid_at, created_at)
     VALUES ($1, $2, $3, 'RAZORPAY', $4, $5, 'INR', $6, 0, $6, $7, now(), $8, $9, now() - make_interval(mins => $10))`,
    [id, t.orgId, sub, `INV-${id.slice(-8)}`, status, total, o.paid ? total : 0, o.due ?? null, o.paid ? new Date() : null, o.ago ?? 0]);
  if (o.method) {
    await h.owner.query(
      `INSERT INTO app.payments (organization_id, invoice_id, provider, provider_payment_id, amount_minor, currency, status, method_type, paid_at)
       VALUES ($1, $2, 'RAZORPAY', $3, $4, 'INR', $5, $6, now())`, [t.orgId, id, `pay_${id.slice(-10)}`, total, o.payStatus ?? 'CAPTURED', o.method]);
  }
  return id;
}

beforeAll(async () => {
  process.env.DB_NAME = TEST_DB;
  process.env.REALTIME_BUS = 'memory';
  process.env.SESSION_SECRET ??= 'test-session-secret-0123456789-abcdefghij';
  h = makeHarness();
  A = await seedTenant(h, 'bill-a');
  B = await seedTenant(h, 'bill-b');
  inv.paid = await invoice(A, 'PAID', { paid: true, method: 'CARD', ago: 5 });
  inv.open = await invoice(A, 'OPEN', { due: new Date(Date.now() + 86_400_000).toISOString(), ago: 4 });
  inv.pastDue = await invoice(A, 'OPEN', { due: new Date(Date.now() - 86_400_000).toISOString(), method: 'UPI', payStatus: 'FAILED', ago: 3 });
  inv.void = await invoice(A, 'VOID', { ago: 2 });
  inv.draft = await invoice(A, 'DRAFT', { ago: 1 });
  inv.other = await invoice(B, 'PAID', { paid: true, method: 'UPI' });
  const { createApiApp } = await import('../src/api/app-factory.js');
  app = await createApiApp({ swagger: false });
  await app.init();
  http = request(app.getHttpServer());
  const sessions = app.get(HmacSessionService);
  tokenA = sessions.issue(A.userId);
  tokenB = sessions.issue(B.userId);
});
afterAll(async () => { await app?.close(); await h?.close(); });

describe('subscriptions', () => {
  it('groups the trial as ACTIVE with plan, instance usage and period end', async () => {
    const r = await asA(http.get('/v1/billing/subscriptions'));
    expect(r.status).toBe(200);
    expect(r.body.counts).toEqual({ active: 1, pending: 0, inactive: 0 });
    expect(r.body.items[0]).toMatchObject({ service: 'WHATSAPP', planCode: 'GROWTH', status: 'TRIALING', instances: { used: 1 }, paymentMethod: 'CARD' });
    expect((await asA(http.get('/v1/billing/subscriptions?group=INACTIVE'))).body.items).toEqual([]);
    expect((await asA(http.get('/v1/billing/subscriptions?group=nope'))).status).toBe(400);
  });
});

describe('transactions', () => {
  it('lists issued invoices only, with owner-facing status, method and summary', async () => {
    const r = await asA(http.get('/v1/billing/transactions'));
    expect(r.status).toBe(200);
    expect(r.body.summary).toMatchObject({ total: 4, successful: 1, failed: 2, paidMinorUnits: 117900 });
    const byId = Object.fromEntries(r.body.items.map((x: { id: string }) => [x.id, x]));
    expect(byId[inv.draft]).toBeUndefined();
    expect(byId[inv.other]).toBeUndefined();
    expect(byId[inv.paid]).toMatchObject({ status: 'COMPLETED', paymentMethod: 'CARD', type: 'SUBSCRIPTION', totalMinorUnits: 117900 });
    expect(byId[inv.open].status).toBe('PENDING');
    expect(byId[inv.pastDue]).toMatchObject({ status: 'PAST_DUE', paymentMethod: 'UPI' });
    expect(byId[inv.void].status).toBe('CANCELLED');
  });

  it('filters, searches and paginates', async () => {
    expect((await asA(http.get('/v1/billing/transactions?status=COMPLETED'))).body.items.map((x: { id: string }) => x.id)).toEqual([inv.paid]);
    expect((await asA(http.get(`/v1/billing/transactions?q=${inv.void.slice(0, 13)}`))).body.items.map((x: { id: string }) => x.id)).toEqual([inv.void]);
    const p1 = await asA(http.get('/v1/billing/transactions?limit=3'));
    expect(p1.body.items).toHaveLength(3);
    const p2 = await asA(http.get(`/v1/billing/transactions?limit=3&cursor=${p1.body.nextCursor}`));
    expect(p2.body.items.map((x: { id: string }) => x.id)).toEqual([inv.paid]);
    expect(p2.body.nextCursor).toBeNull();
    expect((await asA(http.get('/v1/billing/transactions/export'))).body).toHaveLength(4);
  });

  it('invoice detail is tenant-isolated and never shows drafts', async () => {
    const r = await asA(http.get(`/v1/billing/invoices/${inv.paid}`));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'COMPLETED', totalMinorUnits: 117900, organizationName: 'bill-a org', payments: [{ method: 'CARD', status: 'CAPTURED' }] });
    expect((await asA(http.get(`/v1/billing/invoices/${inv.draft}`))).status).toBe(404);
    expect((await asB(http.get(`/v1/billing/invoices/${inv.paid}`))).status).toBe(404);
    expect((await asB(http.get('/v1/billing/transactions'))).body.summary.total).toBe(1);
  });
});
