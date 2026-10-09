import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { bff, connectedInstance, control, signUp } from './fixtures';

/**
 * AI assistants end-to-end on the real stack. The model is the stack's
 * deterministic TEST script (never a real LLM); everything else is real:
 * API, worker runtime, tool gate, PostgreSQL, WhatsApp gateway (fake socket).
 * Also captures the review screens into docs/screenshots/.
 */
const SHOTS = '../../docs/screenshots';
mkdirSync(SHOTS, { recursive: true });
test.use({ viewport: { width: 1440, height: 900 } });

test('template marketplace -> install -> configure -> knowledge -> WhatsApp -> test -> publish -> live reply -> human takeover', async ({ page }) => {
  test.setTimeout(180_000);
  const owner = await signUp(page, 'ai');
  await control(`/orgs/${owner.orgId}/business-data`, { businessId: owner.businessId });

  // SCREEN 1 - marketplace
  await page.goto('/ai-assistants/templates');
  await expect(page.getByRole('heading', { name: 'AI Assistants' })).toBeVisible();
  await expect(page.getByText('Choose a ready-made AI assistant for your business.')).toBeVisible();
  const cards = page.getByRole('list', { name: 'Assistant templates' }).getByRole('listitem').filter({ has: page.getByRole('link', { name: 'Use Template' }) });
  await expect(cards.first()).toBeVisible();
  expect(await cards.count()).toBeGreaterThanOrEqual(8);
  await expect(page.getByText('Demo preview').first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/01-template-marketplace.png`, fullPage: true });
  await page.getByRole('button', { name: 'Appointments' }).click();
  await expect(page.getByRole('heading', { name: 'Restaurant Reservation Assistant' })).toHaveCount(0);

  // SCREEN 2 - preview
  await page.getByRole('listitem').filter({ hasText: 'Doctor Appointment Assistant' }).getByRole('link', { name: 'Preview' }).click();
  await expect(page.getByRole('heading', { name: 'Doctor Appointment Assistant' })).toBeVisible();
  await expect(page.getByText('What it can do')).toBeVisible();
  await expect(page.getByText('Required setup')).toBeVisible();
  await expect(page.getByText('Kal Dr Sharma available hain?')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/02-template-preview.png`, fullPage: true });

  // Wizard 2-4
  await page.getByRole('button', { name: 'Use Template' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Assistant name').fill('ABC Dental Receptionist');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('switch', { name: 'Send payment links' })).toBeDisabled();
  await page.getByRole('button', { name: 'Create assistant' }).click();
  await page.waitForURL(/\/ai-assistants\/[\w-]+\?setup=1/);
  const assistantId = /ai-assistants\/([\w-]+)/.exec(page.url())![1];
  await expect(page.getByRole('heading', { name: 'ABC Dental Receptionist', exact: true })).toBeVisible();

  // SCREEN 4 - knowledge & setup
  await page.getByRole('button', { name: 'Add FAQ' }).click();
  await page.getByLabel('Question 1').fill('Cancellation policy?');
  await page.getByLabel('Answer 1').fill('Please cancel at least 2 hours before your appointment.');
  await page.getByRole('form', { name: 'Add FAQ' }).getByRole('button', { name: 'Add' }).click();
  await expect(page.getByRole('list', { name: 'Knowledge sources' }).getByText('READY')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('list', { name: 'Setup progress' }).last().getByText(/Knowledge ✓/)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/04-knowledge-setup.png`, fullPage: true });

  // SCREEN 3 - capabilities + settings drawer
  await page.getByRole('tab', { name: 'Capabilities' }).click();
  await page.getByRole('switch', { name: 'Notify staff' }).click();
  await expect(page.getByRole('switch', { name: 'Notify staff' })).toBeChecked();
  await page.getByRole('button', { name: 'Book appointments settings' }).click();
  const drawer = page.getByRole('dialog', { name: 'Book appointments settings' });
  await drawer.getByLabel('Maximum advance booking (days)').fill('30');
  await drawer.getByLabel('Minimum notice (minutes)').fill('120');
  await page.screenshot({ path: `${SHOTS}/03-assistant-builder-capabilities.png` });
  await drawer.getByRole('button', { name: 'Save' }).click();
  await expect(drawer).toHaveCount(0);

  // WhatsApp channel
  const instanceId = await connectedInstance(page, owner, '919900055566', 'ABC Dental Main Number');
  await page.getByRole('tab', { name: 'WhatsApp' }).click();
  await page.getByRole('radio', { name: /ABC Dental Main Number/ }).click();
  await expect(page.getByRole('radio', { name: /ABC Dental Main Number/ })).toBeChecked();

  // SCREEN 5 - Test Assistant (safe test: nothing sent or booked)
  const sentBefore = (await control<unknown[]>(`/instances/${instanceId}/sent`)).length;
  await page.goto(`/ai-assistants/${assistantId}/test`);
  const box = page.getByLabel('Message as the customer');
  await expect(box).toBeEnabled();
  await box.fill('Mujhe cleaning ke liye kal appointment chahiye');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText(/Available slots/)).toBeVisible();
  await expect(page.getByText('CHECK_AVAILABILITY')).toBeVisible();
  await box.fill('2 baje book kar do');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText(/^Waiting for confirmation: Book/)).toBeVisible();
  await expect(page.getByText(/Confirm karein: Book/)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/05-test-simulator.png` });
  expect((await control<unknown[]>(`/instances/${instanceId}/sent`)).length).toBe(sentBefore);
  const api = bff(page, owner.orgId);
  expect((await api.get('/v1/conversations')).items).toEqual([]); // the sandbox never creates conversations

  // Publish
  await page.goto(`/ai-assistants/${assistantId}`);
  await page.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText(/Published version 1/)).toBeVisible();
  await expect(page.locator('#main').getByText('Live', { exact: true })).toBeVisible();

  // Live: a real inbound WhatsApp message is answered through our gateway.
  const customer = '919811177788';
  await control(`/instances/${instanceId}/inbound`, { from: customer, text: 'Kal Dr Sharma available hain?' });
  await expect.poll(async () => (await control<Array<{ jid: string; text: string }>>(`/instances/${instanceId}/sent`)).filter((s) => s.jid.startsWith(customer)).length,
    { timeout: 30_000 }).toBe(1);
  await page.goto('/inbox');
  await page.getByRole('button', { name: /Kal Dr Sharma available hain\?|Available slots/ }).or(page.getByRole('link', { name: /Kal Dr Sharma|Available slots/ })).first().click();
  const conv = page.getByLabel('Conversation');
  await expect(conv.getByText('AI Assistant').first()).toBeVisible();
  await expect(conv.getByText(/AI replying · ABC Dental Receptionist/)).toBeVisible();
  // Human takeover pauses the assistant for this chat.
  await conv.getByRole('button', { name: 'Take over' }).click();
  await expect(conv.getByText('Team handling · AI paused')).toBeVisible();
  await control(`/instances/${instanceId}/inbound`, { from: customer, text: 'Hello?' });
  await page.waitForTimeout(6_000);
  expect((await control<Array<{ jid: string }>>(`/instances/${instanceId}/sent`)).filter((s) => s.jid.startsWith(customer)).length).toBe(1);

  // SCREEN 6 - live assistant overview
  await page.goto(`/ai-assistants/${assistantId}`);
  await expect(page.getByText('Conversations handled today')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pause Assistant' })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/06-live-assistant.png`, fullPage: true });
});
