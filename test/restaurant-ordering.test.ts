import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { aiProvidersFromEnv } from '../src/ai/model/providers-from-env.js';
import { OrderingService } from '../src/ordering/ordering.service.js';
import { waText } from './fakes/fake-baileys-socket.js';
import { FakeOpenAI } from './fakes/fake-openai.js';
import { orderingBrain } from './fakes/ordering-brain.js';
import { makeHarness, seedTenant, type Harness, type Tenant } from './helpers.js';
import { startApi, type Api } from './saas-helpers.js';
import { drainRouted, makeGateway, settle, type GatewayRig } from './whatsapp-helpers.js';

let h: Harness;
let api: Api;
let fake: FakeOpenAI;
let rig: GatewayRig;
let A: Tenant;
let B: Tenant;
let instanceId: string;
let assistantId: string;
const OWNER = '919900066611';
const CUSTOMER = '919811155501';
const as = (t: Tenant) => <T extends import('supertest').Test>(r: T) => api.as(t.userId, t.orgId)(r);
const biz = (p: string) => `/v1/businesses/${A.businessId}${p}`;
const sock = () => rig.fake.last;
const menu: Record<string, string> = {};

async function pump(rounds = 8) {
  for (let i = 0; i < rounds; i++) {
    await settle(rig, instanceId);
    const a = await rig.worker.relay.relayBatch('relay-order', 200);
    const b = await rig.worker.assistant!.processOnce();
    await drainRouted(rig);
    const c = await rig.worker.relay.relayBatch('relay-order', 200);
    if (a + b + c === 0 && i > 1) return;
  }
}
async function say(text: string, from = CUSTOMER) { sock().upsert([waText(from, text)]); await pump(); }
const replies = (to = CUSTOMER) => sock().sent.filter((s) => s.jid.startsWith(to)).map((s) => String(s.content.text));
const lastReply = (to = CUSTOMER) => replies(to).at(-1) ?? '';
const q = async (sql: string, p: unknown[] = []) => (await h.owner.query(sql, p)).rows;

beforeAll(async () => {
  fake = await new FakeOpenAI().start();
  fake.brain = orderingBrain();
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.OPENAI_BASE_URL = fake.url;
  h = makeHarness();
  api = await startApi();
  A = await seedTenant(h, 'order-a');
  B = await seedTenant(h, 'order-b');
  await h.owner.query(`UPDATE app.businesses SET name = 'Hariom Dhaba', business_hours = $2 WHERE id = $1`,
    [A.businessId, JSON.stringify(Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [['00:00', '24:00']]])))]);
  rig = makeGateway(h, { bus: api.bus, ai: aiProvidersFromEnv(), config: { staleAfterMs: 600_000 } });
  await rig.worker.start({ loops: false });
  instanceId = (await as(A)(api.http.post('/v1/whatsapp/instances')).send({ businessId: A.businessId, name: 'Dhaba WhatsApp' })).body.id;
  await as(A)(api.http.post(`/v1/whatsapp/instances/${instanceId}/connect`)).expect(202);
  await drainRouted(rig);
  sock().qr();
  sock().mutateCreds((c) => { c.me = { id: `${OWNER}:3@s.whatsapp.net` }; c.registered = true; });
  sock().open(OWNER);
  await settle(rig, instanceId);
});
afterAll(async () => {
  const own = await q('SELECT id FROM app.whatsapp_instances WHERE organization_id = $1 AND id <> $2 AND deleted_at IS NULL', [A.orgId, A.instanceId]);
  for (const i of own) await as(A)(api.http.delete(`/v1/whatsapp/instances/${i.id}`));
  await drainRouted(rig);
  await rig.worker.stop(); await api.app.close(); await h.close(); await fake.stop();
});
beforeEach(() => { fake.requests.length = 0; });

describe('owner sets up the restaurant from the dashboard APIs', () => {
  it('branch with map pin, menu (categories, sizes, add-ons), ordering settings, coupon; template publishes', async () => {
    await as(A)(api.http.post(biz('/locations'))).send({ name: 'Main branch', address: { line1: '12 MG Road', city: 'Indore', postalCode: '452001' },
      latitude: 22.7196, longitude: 75.8577, isPrimary: true }).expect(201);
    const cat = async (name: string) => (await as(A)(api.http.post(biz('/menu/categories'))).send({ name }).expect(201)).body.id;
    const [burgers, pizza, drinks] = [await cat('Burgers'), await cat('Pizza'), await cat('Beverages')];
    const burgerAddons = (await as(A)(api.http.post(biz('/menu/modifier-groups'))).send({ name: 'Burger add-ons', minSelect: 0, maxSelect: 3,
      modifiers: [{ name: 'Extra Cheese', kind: 'ADD', priceDeltaMinor: 3000 }, { name: 'No Onion', kind: 'REMOVE' }] }).expect(201)).body.id;
    const pizzaOptions = (await as(A)(api.http.post(biz('/menu/modifier-groups'))).send({ name: 'Pizza options', maxSelect: 3,
      modifiers: [{ name: 'No Onion', kind: 'REMOVE' }, { name: 'Extra Cheese', kind: 'ADD', priceDeltaMinor: 6000 }] }).expect(201)).body.id;
    menu.cheeseBurger = (await as(A)(api.http.post(biz('/menu/items'))).send({ name: 'Cheese Burger', categoryId: burgers, foodType: 'VEG', basePriceMinor: 14900,
      modifierGroupIds: [burgerAddons] }).expect(201)).body.id;
    menu.paneerBurger = (await as(A)(api.http.post(biz('/menu/items'))).send({ name: 'Paneer Burger', categoryId: burgers, foodType: 'VEG', basePriceMinor: 16900 }).expect(201)).body.id;
    menu.pizza = (await as(A)(api.http.post(biz('/menu/items'))).send({ name: 'Farmhouse Pizza', categoryId: pizza, foodType: 'VEG',
      variants: [{ name: 'Regular', priceMinor: 29900, isDefault: true }, { name: 'Large', priceMinor: 44900 }], modifierGroupIds: [pizzaOptions] }).expect(201)).body.id;
    menu.coffee = (await as(A)(api.http.post(biz('/menu/items'))).send({ name: 'Cold Coffee', categoryId: drinks, foodType: 'VEG', basePriceMinor: 9900 }).expect(201)).body.id;
    // validation: two default sizes, foreign add-on group
    expect((await as(A)(api.http.post(biz('/menu/items'))).send({ name: 'X', basePriceMinor: 100, variants: [{ name: 'S', priceMinor: 1, isDefault: true }, { name: 'L', priceMinor: 2, isDefault: true }] })).status).toBe(400);
    expect((await as(A)(api.http.post(biz('/menu/items'))).send({ name: 'X', basePriceMinor: 100, modifierGroupIds: [crypto.randomUUID()] })).status).toBe(400);
    // delivery requires COD
    expect((await as(A)(api.http.put(biz('/ordering-settings'))).send({ enabled: true, fulfillmentModes: ['DELIVERY'], paymentMethods: ['PAY_AT_PICKUP'] })).status).toBe(400);
    await as(A)(api.http.put(biz('/ordering-settings'))).send({ enabled: true, fulfillmentModes: ['DELIVERY', 'PICKUP'], paymentMethods: ['COD', 'PAY_AT_PICKUP'],
      taxRateBps: 500, packagingFeeMinor: 1000, deliveryFeeMinor: 4000, freeDeliveryAboveMinor: 100000, deliveryPincodes: ['452010'] }).expect(200);
    await as(A)(api.http.post(biz('/coupons'))).send({ code: 'save10', discountType: 'PERCENT', discountValue: 1000, maxDiscountMinor: 5000, minOrderMinor: 30000 }).expect(201);
    expect((await as(A)(api.http.post(biz('/coupons'))).send({ code: 'SAVE10', discountType: 'FLAT', discountValue: 100 })).status).toBe(409);
    const m = (await as(A)(api.http.get(biz('/menu'))).expect(200)).body;
    expect(m.items.find((i: any) => i.name === 'Farmhouse Pizza').variants.map((v: any) => v.name)).toEqual(['Regular', 'Large']);

    assistantId = (await as(A)(api.http.post('/v1/ai/assistants')).send({ templateKey: 'RESTAURANT_ORDERING', businessId: A.businessId, name: 'Hariom Dhaba Assistant' }).expect(201)).body.id;
    await as(A)(api.http.patch(`/v1/ai/assistants/${assistantId}`)).send({ responseWaitMs: 0 }).expect(200);
    await as(A)(api.http.put(`/v1/ai/assistants/${assistantId}/whatsapp`)).send({ whatsappInstanceId: instanceId }).expect(200);
    const r = (await as(A)(api.http.get(`/v1/ai/assistants/${assistantId}/readiness`))).body;
    for (const k of ['MENU', 'ORDERING_SETTINGS', 'BUSINESS_HOURS', 'LOCATION', 'DELIVERY_AREA']) expect(r.checks.find((c: any) => c.key === k), k).toMatchObject({ ok: true });
    expect((await as(A)(api.http.post(`/v1/ai/assistants/${assistantId}/publish`)).expect(200)).body.published).toBe(true);
  });
});

describe('WhatsApp ordering journey (spec example conversation)', () => {
  it('adds, customises one of two burgers, clarifies an ambiguous removal, bills from the backend, applies a coupon', async () => {
    await say('bhai 2 cheese burger aur ek large farmhouse pizza');
    expect(lastReply()).toMatch(/Done ✅ 2 Cheese Burgers aur 1 Large Farmhouse Pizza/);
    // The runtime sent the template prompt with the restaurant's own name filled in.
    expect(fake.requests[0].instructions).toContain('official AI Restaurant Assistant for Hariom Dhaba');
    expect(fake.requests[0].instructions).not.toContain('{{RESTAURANT_NAME}}');

    await say('ek burger me extra cheese aur pizza me onion mat dalna');
    const lines = await q(`SELECT i.name, ci.quantity, array_length(ci.modifier_ids, 1) AS mods FROM app.cart_items ci JOIN app.menu_items i ON i.id = ci.item_id
                            JOIN app.carts c ON c.id = ci.cart_id WHERE c.business_id = $1 AND c.status = 'ACTIVE' AND c.contact_id IS NOT NULL ORDER BY i.name, mods NULLS FIRST`, [A.businessId]);
    expect(lines).toEqual([{ name: 'Cheese Burger', quantity: 1, mods: null }, { name: 'Cheese Burger', quantity: 1, mods: 1 }, { name: 'Farmhouse Pizza', quantity: 1, mods: 1 }]);
    expect(lastReply()).toMatch(/1 Cheese Burger – normal/);
    expect(lastReply()).toMatch(/1 Cheese Burger – \+Extra Cheese/);

    const before = lines.length;
    await say('ek burger hata do');
    expect(lastReply()).toMatch(/Kaunsa remove karu/);
    expect((await q(`SELECT count(*)::int AS n FROM app.cart_items ci JOIN app.carts c ON c.id = ci.cart_id WHERE c.business_id = $1 AND c.status = 'ACTIVE' AND c.contact_id IS NOT NULL`, [A.businessId]))[0].n).toBe(before);
    await say('normal wala');
    expect(lastReply()).toMatch(/Normal Cheese Burger remove kar diya/);

    await say('bill');
    // 1 x Cheese Burger + Extra Cheese (149+30) + 1 x Large Farmhouse Pizza no onion (449) = 628; packaging 10; 5% tax on 638 = 31.90
    // Backend-rendered POS-style bill in a monospace block that fits a phone chat bubble.
    expect(lastReply()).toMatch(/```[\s\S]*Item total +628\.00[\s\S]*Packaging +10\.00[\s\S]*GST 5% +31\.90[\s\S]*TO PAY +669\.90[\s\S]*```/);
    expect(lastReply()).toMatch(/Total: ₹669\.90/);
    const mono = lastReply().split('```')[1].split('\n').filter(Boolean);
    expect(mono.every((l) => l.length <= 28)).toBe(true);

    await say('SAVE10 coupon laga do');
    expect(lastReply()).toMatch(/Coupon SAVE10 laga diya/);
  });

  it('delivery + address + COD -> final summary -> explicit "haan" -> exactly one order; repeated "haan" never duplicates', async () => {
    await say('delivery chahiye, Flat 12 Vijay Nagar Indore 452010, COD');
    const summary = lastReply();
    expect(summary).toMatch(/Final order:/);
    expect(summary).toMatch(/Discount \(SAVE10\) +-50\.00/);
    expect(summary).toMatch(/Delivery fee +40\.00/);
    expect(summary).toMatch(/Total to pay: ₹657\.40/);
    expect(summary).toMatch(/📍 Flat 12, Vijay Nagar, Indore, 452010/);
    expect(summary).toMatch(/💵 Cash on delivery/i); // 628 - 50 + 10 + 40 + 5% of 588 (29.40)
    expect(summary).toMatch(/Order place kar du\?/);
    expect(await q(`SELECT * FROM app.orders WHERE business_id = $1`, [A.businessId])).toEqual([]);

    await say('haan place kar do');
    expect(lastReply()).toMatch(/Order placed ✅ Order #1001, Total: ₹657\.40, Payment: Cash on delivery/);
    const orders = await q(`SELECT order_number, status, total_minor, discount_minor, delivery_fee_minor, tax_minor, payment_method, payment_status, fulfillment_mode, address, coupon_code
                              FROM app.orders WHERE business_id = $1`, [A.businessId]);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ order_number: 1001, status: 'PLACED', total_minor: 65740, discount_minor: 5000, delivery_fee_minor: 4000, tax_minor: 2940,
      payment_method: 'COD', payment_status: 'PENDING', fulfillment_mode: 'DELIVERY', coupon_code: 'SAVE10' });
    expect(orders[0].address).toMatchObject({ house: 'Flat 12', pincode: '452010' });
    const items = await q(`SELECT name, variant_name, quantity, modifiers FROM app.order_items oi JOIN app.orders o ON o.id = oi.order_id WHERE o.business_id = $1 ORDER BY position`, [A.businessId]);
    expect(items.map((i) => [i.name, i.variant_name, i.quantity, i.modifiers.map((m: any) => m.name)])).toEqual([
      ['Cheese Burger', null, 1, ['Extra Cheese']], ['Farmhouse Pizza', 'Large', 1, ['No Onion']]]);
    expect((await q(`SELECT count(*)::int AS n FROM app.notifications WHERE organization_id = $1 AND type = 'NEW_ORDER'`, [A.orgId]))[0].n).toBeGreaterThan(0);

    await say('haan');
    await say('haan confirm');
    expect((await q(`SELECT count(*)::int AS n FROM app.orders WHERE business_id = $1`, [A.businessId]))[0].n).toBe(1);
  });

  it('tracking; the owner accepts on the dashboard and the customer is told on WhatsApp (never a human takeover)', async () => {
    await say('mera order kaha hai?');
    expect(lastReply()).toBe('Order #1001: PLACED');
    const order = (await as(A)(api.http.get(`/v1/orders?businessId=${A.businessId}`)).expect(200)).body[0];
    expect(order).toMatchObject({ orderNumber: 1001, status: 'PLACED', total: '₹657.40', items: '1 x Cheese Burger, 1 x Farmhouse Pizza (Large)' });
    const detail = (await as(A)(api.http.get(`/v1/orders/${order.id}`)).expect(200)).body;
    expect(detail.nextStatuses).toEqual(['ACCEPTED', 'REJECTED', 'CANCELLED']);
    expect((await as(A)(api.http.post(`/v1/orders/${order.id}/status`)).send({ status: 'DELIVERED' })).status).toBe(409);
    await as(A)(api.http.post(`/v1/orders/${order.id}/status`)).send({ status: 'ACCEPTED' }).expect(200);
    await pump();
    expect(lastReply()).toMatch(/order #1001 restaurant ne accept kar liya/i);
    const conv = (await q(`SELECT c.handling_mode FROM app.conversations c JOIN app.contacts ct ON ct.id = c.contact_id WHERE ct.phone_e164 = $1 AND c.organization_id = $2`, [`+${CUSTOMER}`, A.orgId]))[0];
    expect(conv.handling_mode).toBe('AI');
    const sysMsg = await q(`SELECT origin FROM app.messages WHERE organization_id = $1 AND text_body LIKE '%accept kar liya%'`, [A.orgId]);
    expect(sysMsg[0].origin).toBe('SYSTEM');
  });

  it('cancellation after acceptance becomes a request; the owner approves; the customer is told', async () => {
    await say('order cancel kar do');
    expect(lastReply()).toMatch(/Cancel order #1001.*Confirm karein/);
    await say('haan');
    expect(lastReply()).toMatch(/Cancellation request restaurant ko bhej di/);
    expect((await q(`SELECT status FROM app.orders WHERE business_id = $1`, [A.businessId]))[0].status).toBe('ACCEPTED');
    const order = (await as(A)(api.http.get(`/v1/orders?businessId=${A.businessId}`))).body[0];
    expect(order.pendingRequests).toBe(1);
    const detail = (await as(A)(api.http.get(`/v1/orders/${order.id}`))).body;
    await as(A)(api.http.post(`/v1/order-requests/${detail.requests[0].id}/resolve`)).send({ approve: true }).expect(200);
    await pump();
    expect((await q(`SELECT status FROM app.orders WHERE business_id = $1`, [A.businessId]))[0].status).toBe('CANCELLED');
    expect(lastReply()).toMatch(/Order #1001 cancel kar diya gaya hai/);
  });

  it('memory: saved address + stated preference are remembered; "last time wala" rebuilds the cart at today\'s prices', async () => {
    const contact = (await q(`SELECT id FROM app.contacts WHERE phone_e164 = $1 AND business_id = $2`, [`+${CUSTOMER}`, A.businessId]))[0].id;
    expect(await q(`SELECT address->>'house' AS house FROM app.customer_addresses WHERE contact_id = $1`, [contact])).toEqual([{ house: 'Flat 12' }]);
    await say('main pure veg hoon');
    expect((await q(`SELECT food_preference FROM app.customer_profiles WHERE contact_id = $1`, [contact]))[0].food_preference).toBe('VEG');
    await as(A)(api.http.patch(biz(`/menu/items/${menu.cheeseBurger}`))).send({ name: 'Cheese Burger', basePriceMinor: 15900, foodType: 'VEG',
      modifierGroupIds: (await as(A)(api.http.get(biz('/menu')))).body.items.find((i: any) => i.id === menu.cheeseBurger).modifierGroupIds }).expect(200);
    await say('last time wala order repeat kar do');
    expect(lastReply()).toMatch(/Pichhla order cart mein daal diya: 1 x Cheese Burger, 1 x Farmhouse Pizza/);
    const ctx = await h.workerTx.inTenant((db) => new OrderingService().memory(db, A.businessId, contact), { organizationId: A.orgId });
    expect(ctx).toMatchObject({ preferences: { food: 'VEG' }, savedAddresses: [{ text: expect.stringContaining('Vijay Nagar') }], recentOrders: [{ orderNumber: 1001, status: 'CANCELLED' }] });
    // the next turn tells the model what the backend remembers
    await say('menu dikhao');
    expect(fake.requests.filter((r) => r.instructions.includes('PLATFORM RULES')).at(-1)!.instructions).toMatch(/Customer memory .*food preference VEG.*1 saved address.*1 previous order/);
  });

  it('a changed cart invalidates the quote: an old summary can never become an order', async () => {
    const contact = (await q(`SELECT id FROM app.contacts WHERE phone_e164 = $1 AND business_id = $2`, [`+${CUSTOMER}`, A.businessId]))[0].id;
    const svc = new OrderingService();
    const scope = { businessId: A.businessId, owner: { contactId: contact } };
    const run = <T>(fn: (db: any) => Promise<T>) => h.workerTx.inTenant(fn, { organizationId: A.orgId });
    await run((db) => svc.setFulfillment(db, scope, { mode: 'PICKUP' }));
    const quote = await run((db) => svc.createQuote(db, scope));
    expect(quote.ok).toBe(true);
    await run((db) => svc.addItem(db, scope, { itemId: menu.coffee, quantity: 1 }));
    const r = await run((db) => svc.placeOrder(db, scope, (quote as any).quoteId, { source: 'AI_WHATSAPP' }));
    expect(r).toMatchObject({ ok: false, errorCode: 'QUOTE_STALE' });
  });

  it('prices cannot be talked down: coupons are the only discounts and unknown codes are refused', async () => {
    const contact = (await q(`SELECT id FROM app.contacts WHERE phone_e164 = $1 AND business_id = $2`, [`+${CUSTOMER}`, A.businessId]))[0].id;
    const r = await h.workerTx.inTenant((db) => new OrderingService().applyCoupon(db, { businessId: A.businessId, owner: { contactId: contact } }, 'FREEFOOD'),
      { organizationId: A.orgId });
    expect(r).toMatchObject({ ok: false, errorCode: 'COUPON_INVALID' });
    const tools = await q(`SELECT key, input_schema::text AS s FROM app.ai_tools WHERE category = 'ORDERING'`);
    expect(tools.filter((t) => /price_minor|total|discount_value|set_price/.test(t.s))).toEqual([]);
  });
});

describe('Test Assistant ordering is a sandbox', () => {
  it('uses a test-session cart and a dry-run order: no real order, no real customer cart', async () => {
    const ordersBefore = (await q(`SELECT count(*)::int AS n FROM app.orders WHERE business_id = $1`, [A.businessId]))[0].n;
    const sid = (await as(A)(api.http.post(`/v1/ai/assistants/${assistantId}/test-sessions`)).send({ customerName: 'Tester' }).expect(201)).body.id;
    const send = async (text: string) => (await as(A)(api.http.post(`/v1/ai/assistants/${assistantId}/test-sessions/${sid}/messages`)).send({ text }).expect(200)).body;
    expect((await send('bhai 2 cheese burger aur ek large farmhouse pizza')).reply).toMatch(/Done ✅/);
    expect((await send('delivery chahiye, Flat 1 Vijay Nagar 452010, COD')).reply).toMatch(/Order place kar du\?/);
    const done = await send('haan');
    expect(done.trace.toolsUsed.find((t: any) => t.tool === 'CONFIRM_PENDING_ACTION').status).toBe('DRY_RUN');
    expect((await q(`SELECT count(*)::int AS n FROM app.orders WHERE business_id = $1`, [A.businessId]))[0].n).toBe(ordersBefore);
    expect((await q(`SELECT count(*)::int AS n FROM app.carts WHERE test_session_id = $1`, [sid]))[0].n).toBe(1);
  });
});

describe('tenant isolation and the reservation template setup (owner screenshot case)', () => {
  it('another tenant cannot read or use this menu, orders or setup', async () => {
    expect((await as(B)(api.http.get(biz('/menu')))).status).toBe(404);
    expect((await as(B)(api.http.get(`/v1/orders?businessId=${A.businessId}`))).body).toEqual([]);
    const aOrder = (await q(`SELECT id FROM app.orders WHERE business_id = $1`, [A.businessId]))[0].id;
    expect((await as(B)(api.http.post(`/v1/orders/${aOrder}/status`)).send({ status: 'ACCEPTED' })).status).toBe(404);
    expect((await as(B)(api.http.post(biz('/menu/items'))).send({ name: 'pwn', basePriceMinor: 1 })).status).toBe(404);
    const r = await h.workerTx.inTenant((db) => new OrderingService().addItem(db, { businessId: B.businessId, owner: { contactId: B.contactId } }, { itemId: menu.coffee, quantity: 1 }),
      { organizationId: B.orgId });
    expect(r).toMatchObject({ ok: false });
  });

  it('reservation template: "Tables (with seats)" and "Reservation hours" become ready through the new setup APIs', async () => {
    const id = (await as(B)(api.http.post('/v1/ai/assistants')).send({ templateKey: 'RESTAURANT_RESERVATION', businessId: B.businessId, name: 'Table bot' }).expect(201)).body.id;
    const check = async (k: string) => (await as(B)(api.http.get(`/v1/ai/assistants/${id}/readiness`))).body.checks.find((c: any) => c.key === k);
    // the seeded tenant has a DOCTOR and business-wide 24h rules; clear rules to reproduce "Reservation hours" missing
    await h.owner.query('DELETE FROM app.availability_rules WHERE business_id = $1', [B.businessId]);
    expect(await check('RESOURCES')).toMatchObject({ ok: false, href: '/setup/resources' });
    expect(await check('AVAILABILITY')).toMatchObject({ ok: false, href: '/setup/availability' });
    const bb = (p: string) => `/v1/businesses/${B.businessId}${p}`;
    const t1 = (await as(B)(api.http.post(bb('/resources'))).send({ resourceType: 'TABLE', name: 'Table 1', capacity: 4 }).expect(201)).body.id;
    await as(B)(api.http.post(bb('/resources'))).send({ resourceType: 'TABLE', name: 'Table 2', capacity: 6 }).expect(201);
    expect((await as(B)(api.http.put(bb('/availability'))).send({ weekly: { mon: [['12:00', '15:00'], ['14:00', '23:00']] } })).status).toBe(400); // overlap
    await as(B)(api.http.put(bb('/availability'))).send({ weekly: Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [['12:00', '15:30'], ['19:00', '23:30']]])) }).expect(200);
    await as(B)(api.http.post(bb('/availability-exceptions'))).send({ type: 'HOLIDAY', startAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
      endAt: new Date(Date.now() + 6 * 86_400_000).toISOString(), reason: 'Diwali' }).expect(201);
    expect(await check('RESOURCES')).toMatchObject({ ok: true });
    expect(await check('AVAILABILITY')).toMatchObject({ ok: true });
    const res = (await as(B)(api.http.get(bb('/resources')))).body;
    expect(res.find((r: any) => r.id === t1)).toMatchObject({ resourceType: 'TABLE', capacity: 4 });
    const av = (await as(B)(api.http.get(bb('/availability')))).body;
    expect(av.weekly.sat).toEqual([['12:00', '15:30'], ['19:00', '23:30']]);
  });

  it('a reservation assistant created before the menu tools existed gets them (owner screenshot: "menu uplabdh nahi hai")', async () => {
    const id = (await as(A)(api.http.post('/v1/ai/assistants')).send({ templateKey: 'RESTAURANT_RESERVATION', businessId: A.businessId, name: 'Old table bot' }).expect(201)).body.id;
    // Simulate an assistant created before the template gained SEARCH_MENU / GET_MENU_ITEM.
    await h.owner.query(`DELETE FROM app.ai_agent_tools WHERE ai_agent_id = $1 AND tool_id IN (SELECT id FROM app.ai_tools WHERE key IN ('SEARCH_MENU','GET_MENU_ITEM'))`, [id]);
    const caps = (await as(A)(api.http.get(`/v1/ai/assistants/${id}`)).expect(200)).body.capabilities;
    expect(caps.filter((c: any) => ['SEARCH_MENU', 'GET_MENU_ITEM'].includes(c.key)).map((c: any) => [c.key, c.enabled])).toEqual([['SEARCH_MENU', true], ['GET_MENU_ITEM', true]]);
    // An owner's explicit choice is never overwritten by the sync.
    await as(A)(api.http.put(`/v1/ai/assistants/${id}/capabilities/GET_MENU_ITEM`)).send({ enabled: false }).expect(200);
    const again = (await as(A)(api.http.get(`/v1/ai/assistants/${id}`)).expect(200)).body.capabilities;
    expect(again.find((c: any) => c.key === 'GET_MENU_ITEM').enabled).toBe(false);
    // Browsing works even for a restaurant that does not take WhatsApp orders.
    await h.owner.query('UPDATE app.ordering_settings SET enabled = false WHERE business_id = $1', [A.businessId]);
    const r = await h.workerTx.inTenant((db) => new OrderingService().searchMenu(db, A.businessId, {}), { organizationId: A.orgId });
    await h.owner.query('UPDATE app.ordering_settings SET enabled = true WHERE business_id = $1', [A.businessId]);
    expect(r).toMatchObject({ ok: true, orderingAvailable: false });
    expect((r as any).display).toMatch(/🍽️ \*.* — Menu\*/);
    await as(A)(api.http.post(`/v1/ai/assistants/${id}/archive`)).expect(200);
  });

  it('an owner can paste a full custom system prompt (35k chars) that replaces the template instructions', async () => {
    const prompt = readFileSync(new URL('./fixtures/restaurant-owner-prompt.txt', import.meta.url), 'utf8');
    await as(A)(api.http.patch(`/v1/ai/assistants/${assistantId}`)).send({ customInstructions: prompt, instructionsMode: 'CUSTOM_PROMPT' }).expect(200);
    const review = (await as(A)(api.http.post(`/v1/ai/assistants/${assistantId}/instructions/validate`)).send({ text: prompt }).expect(200)).body.issues;
    expect(review.filter((i: any) => i.severity === 'ERROR')).toEqual([]);
    expect((await as(A)(api.http.post(`/v1/ai/assistants/${assistantId}/publish`)).expect(200)).body.published).toBe(true);
    await say('menu dikhao');
    const instr = fake.requests.filter((r) => r.instructions.includes('PLATFORM RULES')).at(-1)!.instructions;
    // Long chats also get a rolling memory summary (separate model call, facts only).
    const st = await q(`SELECT s.summary FROM app.ai_conversation_states s JOIN app.conversations c ON c.id = s.conversation_id JOIN app.contacts ct ON ct.id = c.contact_id
                         WHERE ct.phone_e164 = $1 AND c.organization_id = $2`, [`+${CUSTOMER}`, A.orgId]);
    expect(st[0].summary).toBeTruthy();
    expect(instr).toMatch(/custom prompt written by the business owner/);
    expect(instr).toContain('Main Hariom Dhaba ka ordering assistant hoon');
    expect(instr.indexOf('PLATFORM RULES')).toBeLessThan(instr.indexOf('custom prompt written by the business owner'));
  });
});
