import { expect, test } from '@playwright/test';
import { APP, bff, browserStorage, control, signUp } from './fixtures';

test('instance QR flow: QR rendered locally, never persisted or logged, removed once connected', async ({ page }) => {
  const external: string[] = [];
  page.on('request', (r) => { if (!r.url().startsWith(APP) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) external.push(r.url()); });

  const owner = await signUp(page, 'qr');
  await page.goto('/whatsapp/instances');
  await page.getByRole('button', { name: '+ Connect WhatsApp' }).click();
  await page.getByLabel('Name').fill('Front desk');
  await page.getByRole('button', { name: 'Create and connect' }).click();
  await page.waitForURL(/\/whatsapp\/instances\/[\w-]+\?connect=1/);
  const instanceId = /instances\/([\w-]+)/.exec(page.url())![1];

  // The "phone" asks WhatsApp for a QR; the worker streams it only to this tenant's browser.
  const { qr } = await control<{ qr: string }>(`/instances/${instanceId}/qr`, {});
  const img = page.getByAltText(/WhatsApp linking QR code/);
  await expect(img).toBeVisible();
  expect(await img.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
  expect(await page.content()).not.toContain(qr);
  expect(await browserStorage(page)).not.toContain(qr);
  expect(page.url()).not.toContain(qr);

  // Another tenant cannot fetch this instance's QR or its event stream.
  const intruderCtx = await page.context().browser()!.newContext();
  const intruder = await intruderCtx.newPage();
  const other = await signUp(intruder, 'qr-intruder');
  const asOther = bff(intruder, other.orgId);
  expect((await asOther.call('GET', `/v1/whatsapp/instances/${instanceId}/qr`)).status).toBe(404);
  expect((await asOther.call('GET', `/v1/whatsapp/instances/${instanceId}`)).status).toBe(404);
  expect((await bff(intruder, owner.orgId).call('GET', `/v1/whatsapp/instances/${instanceId}/qr`)).status).toBe(403);
  await intruderCtx.close();

  // Scan -> linked: QR disappears, status goes CONNECTED live.
  await control(`/instances/${instanceId}/open`, { phone: '919900011122' });
  await expect(page.getByText(/WhatsApp is connected/)).toBeVisible();
  await expect(img).toHaveCount(0);
  await page.reload();
  await expect(page.getByAltText(/WhatsApp linking QR code/)).toHaveCount(0);

  // The raw QR never reached the DB, API/worker logs, browser storage, or any third-party host.
  const scan = await control<{ logs: boolean; tables: string[] }>('/scan', { needle: qr });
  expect(scan).toEqual({ logs: false, tables: [] });
  expect(await browserStorage(page)).not.toContain(qr);
  expect(external).toEqual([]);
});
