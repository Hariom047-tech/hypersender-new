import { expect, type Page } from '@playwright/test';

export const CONTROL = 'http://127.0.0.1:3102';
export const API = `http://127.0.0.1:${process.env.E2E_API_PORT ?? '3101'}`;
export const APP = 'http://localhost:3200';

/** Drives the fake WhatsApp phone/servers (test-only control server, loopback). */
export async function control<T = any>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${CONTROL}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(`control ${path}: ${json.error}`);
  return json as T;
}

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export interface Owner { email: string; password: string; orgId: string; orgName: string; businessId: string; businessName: string }

/** Real onboarding through the UI: register -> organization -> business -> skip WhatsApp -> dashboard. */
export async function signUp(page: Page, label: string): Promise<Owner> {
  const id = uniq();
  const email = `e2e-${label}-${id}@example.test`;
  const password = `pw-${id}-Secure!`;
  const orgName = `${label} Org ${id}`;
  const businessName = `${label} Clinic ${id}`;
  await page.goto('/register');
  await page.getByLabel('First name').fill(label);
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Create your workspace' })).toBeVisible();
  await page.getByLabel('Organization name').fill(orgName);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Add your first business' })).toBeVisible();
  await page.getByLabel('Business name').fill(businessName);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await page.waitForURL('**/dashboard');
  const me = await (await page.request.get('/api/v1/account/me')).json();
  const org = me.organizations.find((o: { name: string }) => o.name === orgName);
  const businesses = await bff(page, org.id).get('/v1/businesses');
  const biz = businesses.find((b: { name: string }) => b.name === businessName);
  return { email, password, orgId: org.id, orgName, businessId: biz.id, businessName };
}

/** Same-origin calls through the BFF, exactly like the app does (cookie + CSRF header + Origin). */
export function bff(page: Page, orgId: string) {
  const headers = { 'x-organization-id': orgId, 'x-hs-csrf': '1', origin: APP };
  const call = async (method: string, path: string, data?: unknown) => {
    const res = await page.request.fetch(`/api${path}`, { method, headers, data });
    const body = await res.json().catch(() => null);
    return { status: res.status(), body };
  };
  return {
    call,
    get: async (path: string) => { const r = await call('GET', path); expect(r.status, `GET ${path}`).toBe(200); return r.body; },
    post: (path: string, data?: unknown) => call('POST', path, data ?? {}),
  };
}

/** Creates an instance via the app API and links it with the fake phone. Returns the instance id. */
export async function connectedInstance(page: Page, owner: Owner, phone: string, name = 'Reception'): Promise<string> {
  const api = bff(page, owner.orgId);
  const created = await api.post('/v1/whatsapp/instances', { businessId: owner.businessId, name });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.id as string;
  expect((await api.post(`/v1/whatsapp/instances/${id}/connect`)).status).toBe(202);
  await control(`/instances/${id}/qr`, {});
  await control(`/instances/${id}/open`, { phone });
  await expect.poll(async () => (await api.get(`/v1/whatsapp/instances/${id}`)).status, { timeout: 15_000 }).toBe('CONNECTED');
  return id;
}

export const setPlan = (orgId: string, code: 'TRIAL' | 'STARTER' | 'GROWTH') => control(`/orgs/${orgId}/plan`, { code });

/** Every browser-side persistence the app could leak into. */
export async function browserStorage(page: Page): Promise<string> {
  return page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, url: location.href, cookie: document.cookie }));
}
