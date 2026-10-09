import { expect, test } from '@playwright/test';
import { API, bff, browserStorage, control, setPlan, signUp } from './fixtures';

test('API keys: gated by plan; plaintext shown once, gone after refresh; revoke works', async ({ page }) => {
  const owner = await signUp(page, 'keys');
  await page.goto('/developers/api-keys');
  await page.getByRole('button', { name: '+ Create key' }).click();
  await page.getByLabel('Name').fill('CRM integration');
  await page.getByRole('button', { name: 'Create key', exact: true }).click();
  await expect(page.getByRole('form', { name: 'Create API key' }).getByText(/plan/i)).toBeVisible(); // TRIAL has no API access

  await setPlan(owner.orgId, 'GROWTH');
  await page.getByRole('button', { name: 'Create key', exact: true }).click();
  const shown = page.getByRole('alert').filter({ hasText: 'Copy this key now' });
  await expect(shown).toBeVisible();
  const plaintext = (await shown.locator('code').innerText()).trim();
  expect(plaintext.length).toBeGreaterThan(20);
  expect(await browserStorage(page)).not.toContain(plaintext);

  // The key works against the public API...
  const ok = await fetch(`${API}/v1/whatsapp/instances`, { headers: { 'x-api-key': plaintext } });
  expect(ok.status).toBe(200);
  // ...and is never shown again.
  await page.reload();
  await expect(page.getByText('Copy this key now')).toHaveCount(0);
  expect(await page.content()).not.toContain(plaintext);
  const list = await bff(page, owner.orgId).get('/v1/api-keys');
  expect(JSON.stringify(list)).not.toContain(plaintext);
  await expect(page.getByRole('cell', { name: 'CRM integration' })).toBeVisible();

  await page.getByRole('button', { name: 'Revoke' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByText('revoked')).toBeVisible();
  expect((await fetch(`${API}/v1/whatsapp/instances`, { headers: { 'x-api-key': plaintext } })).status).toBe(401);
  const scan = await control<{ logs: boolean; tables: string[] }>('/scan', { needle: plaintext });
  expect(scan).toEqual({ logs: false, tables: [] }); // only the hash is stored
});

test('webhooks: create (secret once), reject private targets, test delivery, edit, delete', async ({ page }) => {
  const owner = await signUp(page, 'hooks');
  await page.goto('/developers/webhooks');

  // SSRF: private/loopback targets rejected with a clear message.
  await page.getByRole('button', { name: '+ Add webhook' }).click();
  const form = page.getByRole('form', { name: 'Add webhook' });
  await form.getByLabel('Name').fill('Internal');
  await form.getByLabel('Endpoint URL').fill('https://127.0.0.1/hook');
  await form.getByRole('button', { name: 'Add webhook' }).click();
  await expect(form.getByText(/rejected/i)).toBeVisible();

  await form.getByLabel('Name').fill('CRM');
  await form.getByLabel('Endpoint URL').fill('https://example.com/hooks/whatsapp');
  await form.getByRole('button', { name: 'Add webhook' }).click();
  const secretBox = page.getByRole('alert').filter({ hasText: 'Copy the signing secret now' });
  await expect(secretBox).toBeVisible();
  const secret = (await secretBox.locator('code', { hasText: 'whsec_' }).innerText()).trim();
  await page.reload();
  expect(await page.content()).not.toContain(secret);

  await page.getByRole('cell', { name: 'CRM' }).click();
  await page.waitForURL(/developers\/webhooks\/[\w-]+/);
  const callsBefore = (await control<unknown[]>('/webhook-calls')).length;
  await page.getByRole('button', { name: 'Send test event' }).click();
  await expect.poll(async () => (await control<unknown[]>('/webhook-calls')).length, { timeout: 15_000 }).toBeGreaterThan(callsBefore);
  const calls = await control<Array<{ url: string; body: string }>>('/webhook-calls');
  expect(calls.at(-1)!.url).toBe('https://example.com/hooks/whatsapp');
  expect(calls.at(-1)!.body).not.toContain(secret);
  await expect(page.getByText(/delivered|succeeded|200/i).first()).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Name').fill('CRM production');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: 'CRM production' })).toBeVisible();

  await page.getByRole('button', { name: 'Delete' }).click();
  const dialog = page.getByRole('dialog');
  const typed = dialog.getByRole('textbox');
  if (await typed.count()) await typed.fill('CRM production');
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await page.waitForURL('**/developers/webhooks');
  await expect(page.getByText('No webhooks yet')).toBeVisible();
  expect(await bff(page, owner.orgId).get('/v1/webhooks')).toEqual([]);
});
