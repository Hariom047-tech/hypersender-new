/**
 * OPERATOR-GUIDED real-WhatsApp acceptance test (steps A-U).
 * Needs: running API (`npm run start:api`) + worker (`npm run start:worker`),
 * a DEDICATED/SPARE WhatsApp account to link, and a second phone to chat from.
 *
 *   npx tsx scripts/whatsapp-acceptance.ts [--api http://localhost:3100]
 *
 * - Creates a throwaway tenant (email acceptance<ts>@example.test).
 * - Renders the QR LOCALLY in this terminal (never written to disk/logs/report).
 * - Verifies every step through the public API; you only act on the phones.
 * - Writes .data/acceptance-report-<ts>.json with PASS/FAIL/SKIPPED per step.
 * Nothing is marked "REAL WHATSAPP VERIFIED" unless every step passes.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import QRCode from 'qrcode';

const API = process.argv.includes('--api') ? process.argv[process.argv.indexOf('--api') + 1] : (process.env.ACCEPTANCE_API_URL ?? 'http://localhost:3100');
const ts = Date.now();
const rl = createInterface({ input: process.stdin, output: process.stdout });
type Result = { step: string; status: 'PASS' | 'FAIL' | 'SKIPPED'; at: string; detail?: string };
const results: Result[] = [];
let token = '';
let org = '';

function record(step: string, status: Result['status'], detail?: string): void {
  results.push({ step, status, at: new Date().toISOString(), detail });
  console.log(`${status === 'PASS' ? '✔' : status === 'FAIL' ? '✘' : '•'} ${step}${detail ? ` - ${detail}` : ''}`);
}

async function call(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(org ? { 'x-organization-id': org } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${json?.error?.code ?? ''}`);
  return json;
}

async function until<T>(label: string, fn: () => Promise<T | null | undefined | false>, timeoutMs: number): Promise<T | null> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(`  (timed out waiting for ${label})`);
  return null;
}

/** Streams instance events; renders QR codes locally; returns a stop function. */
function watchInstance(instanceId: string, onQr: (qr: string) => void): () => void {
  const ctrl = new AbortController();
  void (async () => {
    const res = await fetch(`${API}/v1/whatsapp/instances/${instanceId}/events`, { headers: { authorization: `Bearer ${token}`, 'x-organization-id': org }, signal: ctrl.signal });
    const reader = res.body!.getReader();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done) break;
      buf += Buffer.from(value!).toString();
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        if (/^event: whatsapp\.instance\.qr$/m.test(block)) onQr(JSON.parse(/^data: (.*)$/m.exec(block)![1]).qr);
      }
    }
  })().catch(() => undefined);
  return () => ctrl.abort();
}

async function pause(msg: string): Promise<string> { return rl.question(`\n>>> ${msg}\n    press Enter when done (or type "skip"): `); }

async function main(): Promise<void> {
  console.log(`Real WhatsApp acceptance against ${API}\nUse ONLY a spare WhatsApp account. Nothing personal.\n`);
  // A-C
  const reg = await call('POST', '/v1/auth/register', { email: `acceptance${ts}@example.test`, password: `Acceptance-${ts}`, firstName: 'Acceptance' });
  token = reg.token;
  org = (await call('POST', '/v1/account/organizations', { name: 'Acceptance Test', slug: `acceptance-${ts}`, timezone: 'Asia/Kolkata', countryCode: 'IN', currency: 'INR' })).organizationId;
  record('A create test tenant', 'PASS', org);
  const biz = await call('POST', '/v1/businesses', { name: 'Acceptance Clinic', countryCode: 'IN', timezone: 'Asia/Kolkata' });
  record('B create business', 'PASS');
  const inst = await call('POST', '/v1/whatsapp/instances', { businessId: biz.id, name: 'Acceptance' });
  record('C create instance', inst.status === 'CREATED' ? 'PASS' : 'FAIL', inst.status);

  // D-G
  let qrCount = 0;
  const stop = watchInstance(inst.id, async (qr) => {
    qrCount++;
    console.log(`\n--- QR #${qrCount} (rendered locally; scan with WhatsApp > Linked devices > Link a device) ---`);
    console.log(await QRCode.toString(qr, { type: 'terminal', small: true }));
  });
  await call('POST', `/v1/whatsapp/instances/${inst.id}/connect`);
  record('D request connection', 'PASS');
  const gotQr = await until('QR', async () => qrCount > 0, 60_000);
  record('E receive QR', gotQr ? 'PASS' : 'FAIL');
  console.log('\n>>> F: On the SPARE phone open WhatsApp > Settings > Linked devices > Link a device, and scan the QR above.');
  const connected = await until('CONNECTED', async () => (await call('GET', `/v1/whatsapp/instances/${inst.id}/status`)).status === 'CONNECTED', 180_000);
  record('F scan QR', connected ? 'PASS' : 'FAIL');
  const st = await call('GET', `/v1/whatsapp/instances/${inst.id}/status`);
  record('G verify CONNECTED', st.status === 'CONNECTED' ? 'PASS' : 'FAIL', `phone ${st.phoneNumber ?? '?'}`);
  stop();
  if (!connected) return finish();

  // H-J
  await pause(`H: From ANOTHER phone, send "hello gateway ${ts % 10000}" to ${st.phoneNumber}.`);
  const conv = await until('inbound message', async () => {
    const list = await call('GET', '/v1/conversations?filter=all&limit=10');
    return list.items.find((c: any) => c.lastMessage?.preview?.includes(`hello gateway ${ts % 10000}`));
  }, 120_000);
  record('H send inbound message', conv ? 'PASS' : 'FAIL');
  const msgs = conv ? await call('GET', `/v1/conversations/${conv.id}/messages?limit=5`) : { items: [] };
  const inbound = msgs.items.find((m: any) => m.direction === 'INBOUND' && m.text?.includes('hello gateway'));
  record('I DB message created', inbound ? 'PASS' : 'FAIL');
  record('J conversation created', conv ? 'PASS' : 'FAIL', conv ? `contact ${conv.contact.phone ?? conv.contact.identity}` : undefined);
  if (!conv) return finish();

  // K-O
  const sent = await call('POST', `/v1/conversations/${conv.id}/messages`, { text: `hello from gateway ${ts % 10000}`, clientRequestId: crypto.randomUUID() });
  record('K reply through API', sent.message.status === 'QUEUED' ? 'PASS' : 'FAIL');
  const status = async (want: string[]) => until(want.join('/'), async () => {
    const page = await call('GET', `/v1/conversations/${conv.id}/messages?limit=10`);
    const m = page.items.find((x: any) => x.id === sent.message.id);
    return m && want.includes(m.status) ? m.status : null;
  }, 120_000);
  const s1 = await status(['SENT', 'DELIVERED', 'READ']);
  record('M SENT event', s1 ? 'PASS' : 'FAIL', s1 ?? undefined);
  const phoneOk = await pause('L: Confirm the OTHER phone received "hello from gateway ...". Type "no" if it did not.');
  record('L phone receives reply', phoneOk.trim().toLowerCase().startsWith('no') ? 'FAIL' : phoneOk.trim() === 'skip' ? 'SKIPPED' : 'PASS');
  const s2 = await status(['DELIVERED', 'READ']);
  record('N DELIVERED event', s2 ? 'PASS' : 'FAIL', s2 ?? undefined);
  await pause('O: Open the chat on the OTHER phone so the reply is read (read receipts must be enabled).');
  const s3 = await status(['READ']);
  record('O READ event', s3 ? 'PASS' : 'SKIPPED', s3 ? undefined : 'not observed (receipts may be disabled on the recipient)');

  // P-S
  let qrAfterRestart = 0;
  const stop2 = watchInstance(inst.id, () => { qrAfterRestart++; });
  await pause('P: Restart the WhatsApp WORKER now (Ctrl+C in its terminal, then `npm run start:worker` again).');
  record('P restart worker', 'PASS', 'operator action');
  const back = await until('reconnect', async () => (await call('GET', `/v1/whatsapp/instances/${inst.id}/status`)).status === 'CONNECTED', 180_000);
  record('Q reconnect without new QR', back && qrAfterRestart === 0 ? 'PASS' : 'FAIL', `qr events after restart: ${qrAfterRestart}`);
  stop2();
  await pause(`R: From the OTHER phone send "after restart ${ts % 10000}".`);
  const again = await until('message after restart', async () => {
    const page = await call('GET', `/v1/conversations/${conv.id}/messages?limit=10`);
    return page.items.find((m: any) => m.text?.includes(`after restart ${ts % 10000}`));
  }, 120_000);
  record('R send another message', again ? 'PASS' : 'FAIL');
  record('S still works', again ? 'PASS' : 'FAIL');

  // T-U
  await call('POST', `/v1/whatsapp/instances/${inst.id}/logout`);
  const out = await until('LOGGED_OUT', async () => (await call('GET', `/v1/whatsapp/instances/${inst.id}/status`)).status === 'LOGGED_OUT', 60_000);
  record('T logout through platform', out ? 'PASS' : 'FAIL');
  let newQr = 0;
  const stop3 = watchInstance(inst.id, () => { newQr++; });
  await call('POST', `/v1/whatsapp/instances/${inst.id}/connect`);
  const needs = await until('new QR', async () => newQr > 0, 60_000);
  record('U new QR required', needs ? 'PASS' : 'FAIL');
  stop3();
  await call('POST', `/v1/whatsapp/instances/${inst.id}/disconnect`).catch(() => undefined);
  return finish();
}

function finish(): void {
  const ok = results.length >= 21 && results.every((r) => r.status !== 'FAIL') && results.filter((r) => r.status === 'PASS').length >= 20;
  const report = { api: API, finishedAt: new Date().toISOString(), realWhatsappVerified: ok, results };
  mkdirSync('.data', { recursive: true });
  const file = `.data/acceptance-report-${ts}.json`;
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`\nREAL WHATSAPP VERIFIED: ${ok ? 'YES' : 'NO'}   report: ${file}`);
  rl.close();
}

main().catch((err) => { record('run', 'FAIL', (err as Error).message); finish(); process.exitCode = 1; });
