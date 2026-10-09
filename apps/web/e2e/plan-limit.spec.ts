import { expect, test } from '@playwright/test';
import { bff, signUp } from './fixtures';

test('plan limit: second WhatsApp number blocked with a clear message; concurrent creates cannot exceed the limit', async ({ page }) => {
  const owner = await signUp(page, 'limit'); // new organizations start on TRIAL: 1 WhatsApp number

  await page.goto('/whatsapp/instances');
  await page.getByRole('button', { name: '+ Connect WhatsApp' }).click();
  await page.getByLabel('Name').fill('First');
  await page.getByRole('button', { name: 'Create and connect' }).click();
  await page.waitForURL(/\/whatsapp\/instances\/[\w-]+/);

  await page.goto('/whatsapp/instances');
  await page.getByRole('button', { name: '+ Connect WhatsApp' }).click();
  await page.getByLabel('Name').fill('Second');
  await page.getByRole('button', { name: 'Create and connect' }).click();
  await expect(page.getByText(/WhatsApp number limit is reached/)).toBeVisible();
  await expect(page).toHaveURL(/\/whatsapp\/instances$/);

  // Race: a fresh org fires 6 creates at once -> exactly one wins (advisory-locked check, not check-then-insert).
  const racePage = await page.context().browser()!.newPage();
  const racer = await signUp(racePage, 'race');
  const api = bff(racePage, racer.orgId);
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => api.post('/v1/whatsapp/instances', { businessId: racer.businessId, name: `R${i}` })));
  expect(results.filter((r) => r.status === 201)).toHaveLength(1);
  expect(results.filter((r) => r.status !== 201).every((r) => r.body?.error?.code === 'WHATSAPP_INSTANCE_LIMIT_REACHED' || r.body?.error?.code === 'PLAN_LIMIT_REACHED')).toBe(true);
  expect(await api.get('/v1/whatsapp/instances')).toHaveLength(1);
  expect(await bff(page, owner.orgId).get('/v1/whatsapp/instances')).toHaveLength(1);
  await racePage.close();
});
