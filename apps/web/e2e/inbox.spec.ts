import { expect, test } from '@playwright/test';
import { bff, connectedInstance, control, signUp, type Owner } from './fixtures';

const OWNER_PHONE = '919900022233';
const CUSTOMER = '919811100044';

test.describe.configure({ mode: 'serial' });

let owner: Owner;
let instanceId: string;

test('inbox: live inbound, reply QUEUED -> SENT -> DELIVERED -> READ, no duplicates', async ({ page }) => {
  owner = await signUp(page, 'inbox');
  instanceId = await connectedInstance(page, owner, OWNER_PHONE);
  await page.goto('/inbox');
  await expect(page.getByText('Select a conversation')).toBeVisible();

  // Customer writes: the thread appears live, without a reload.
  await control(`/instances/${instanceId}/inbound`, { from: CUSTOMER, text: 'Kal 4 baje appointment milega?' });
  const thread = page.getByRole('button', { name: /Kal 4 baje appointment milega\?/ }).or(page.getByRole('link', { name: /Kal 4 baje appointment milega\?/ }));
  await expect(thread.first()).toBeVisible();
  await thread.first().click();
  const conversation = page.getByLabel('Conversation');
  await expect(conversation.getByText('Kal 4 baje appointment milega?')).toBeVisible();

  // Reply; a double-submit (double click) must still create exactly one message.
  const reply = 'Haan, 4 PM slot available hai.';
  await page.getByPlaceholder('Type a message').fill(reply);
  await page.getByRole('button', { name: 'Send' }).dblclick();
  await expect(conversation.getByText(reply)).toHaveCount(1);

  // Worker sends once over the (fake) socket.
  await expect.poll(async () => (await control<Array<{ text: string }>>(`/instances/${instanceId}/sent`)).filter((s) => s.text === reply).length).toBe(1);
  const bubble = conversation.locator('li, article, div').filter({ hasText: reply }).last();
  await expect(bubble).toContainText(/Sent/);

  await control(`/instances/${instanceId}/receipt`, { text: reply, status: 'DELIVERED' });
  await expect(bubble).toContainText(/Delivered/);
  await control(`/instances/${instanceId}/receipt`, { text: reply, status: 'READ' });
  await expect(bubble).toContainText(/Read/);
  // A late DELIVERED receipt never downgrades READ.
  await control(`/instances/${instanceId}/receipt`, { text: reply, status: 'DELIVERED' });
  await page.waitForTimeout(500);
  await expect(bubble).toContainText(/Read/);
  await expect(conversation.getByText(reply)).toHaveCount(1);

  // After a refresh the server state matches: one message, READ.
  await page.reload();
  await expect(page.getByLabel('Conversation').getByText(reply)).toHaveCount(1);
  const convs = await bff(page, owner.orgId).get('/v1/conversations');
  const msgs = await bff(page, owner.orgId).get(`/v1/conversations/${convs.items[0].id}/messages`);
  const mine = msgs.items.filter((m: { text: string }) => m.text === reply);
  expect(mine).toHaveLength(1);
  expect(mine[0]).toMatchObject({ status: 'READ', direction: 'OUTBOUND', origin: 'DASHBOARD' });
  expect((await control<unknown[]>(`/instances/${instanceId}/sent`)).length).toBe(1);
});

test('manual message typed on the phone shows once as "Sent from phone" and is never re-sent', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(owner.email);
  await page.getByLabel('Password').fill(owner.password);
  await page.getByRole('button', { name: /Sign in/ }).click();
  await page.waitForURL('**/dashboard');
  await page.goto('/inbox');
  await page.getByRole('button', { name: /appointment|4 PM/ }).or(page.getByRole('link', { name: /appointment|4 PM/ })).first().click();
  const conversation = page.getByLabel('Conversation');
  const sentBefore = (await control<unknown[]>(`/instances/${instanceId}/sent`)).length;

  const text = 'Main 5 min mein call karta hoon';
  await control(`/instances/${instanceId}/from-me`, { owner: OWNER_PHONE, to: CUSTOMER, text, twice: true }); // echo delivered twice
  await expect(conversation.getByText(text)).toHaveCount(1);
  await expect(conversation.getByText('Sent from phone')).toBeVisible();
  await page.waitForTimeout(1_000); // give the worker a chance to (wrongly) send it
  expect((await control<unknown[]>(`/instances/${instanceId}/sent`)).length).toBe(sentBefore);
  await page.reload();
  await expect(page.getByLabel('Conversation').getByText(text)).toHaveCount(1);
});
