import { expect, test } from '@playwright/test';
import { bff, browserStorage, connectedInstance, control, signUp } from './fixtures';

test('tenant isolation: another organization sees nothing of ours, live or by guessing ids', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  const A = await signUp(a, 'iso-a');
  const B = await signUp(b, 'iso-b');
  const instA = await connectedInstance(a, A, '919900033344');

  // B keeps its inbox open (live stream) while A receives a customer message.
  await b.goto('/inbox');
  await a.goto('/inbox');
  const secret = `A-only secret ${Date.now()}`;
  await control(`/instances/${instA}/inbound`, { from: '919811100055', text: secret });
  await expect(a.getByText(secret).first()).toBeVisible();
  await b.waitForTimeout(1_500);
  await expect(b.getByText(secret)).toHaveCount(0);

  const apiA = bff(a, A.orgId);
  const conv = (await apiA.get('/v1/conversations')).items[0];
  const contact = conv.contact.id;

  // B, in its own org, guessing A's ids -> 404 (existence not revealed).
  const asB = bff(b, B.orgId);
  for (const path of [`/v1/conversations/${conv.id}`, `/v1/conversations/${conv.id}/messages`, `/v1/contacts/${contact}`,
    `/v1/whatsapp/instances/${instA}`, `/v1/whatsapp/instances/${instA}/health`]) {
    expect((await asB.call('GET', path)).status, path).toBe(404);
  }
  expect((await asB.post(`/v1/conversations/${conv.id}/messages`, { text: 'hijack', clientRequestId: crypto.randomUUID() })).status).toBe(404);
  // B claiming A's organization header -> forbidden.
  const spoof = bff(b, A.orgId);
  expect((await spoof.call('GET', '/v1/conversations')).status).toBe(403);
  expect((await spoof.call('GET', '/v1/realtime/stream')).status).toBe(403);
  // Lists are scoped.
  expect((await asB.get('/v1/conversations')).items).toEqual([]);
  expect(await asB.get('/v1/whatsapp/instances')).toEqual([]);

  // UI: deep links to A's resources show "not found" for B, never A's data.
  await b.goto(`/whatsapp/instances/${instA}`);
  await expect(b.getByText(/not found/i).first()).toBeVisible();
  await b.goto(`/contacts/${contact}`);
  await expect(b.getByText(/not found/i).first()).toBeVisible();
  await expect(b.getByText(secret)).toHaveCount(0);

  // Session token is HttpOnly: never visible to scripts or storage.
  expect(await browserStorage(a)).not.toMatch(/hs_session|Bearer/);
  const cookies = await ctxA.cookies();
  expect(cookies.find((c) => c.name === 'hs_session')).toMatchObject({ httpOnly: true, sameSite: 'Lax' });

  // Direct backend calls without the BFF (no cookie forwarding) are rejected.
  expect((await b.request.get(`http://127.0.0.1:3101/v1/conversations`, { headers: { 'x-organization-id': A.orgId } })).status()).toBe(401);
  // Cross-site mutation through the BFF without CSRF header/origin is rejected.
  expect((await b.request.post('/api/v1/conversations', { headers: { 'x-organization-id': B.orgId }, data: {} })).status()).toBe(403);
  await ctxA.close();
  await ctxB.close();
});
