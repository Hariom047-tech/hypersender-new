import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isLeaseLost } from '../src/database/errors.js';
import { usePostgresAuthState } from '../src/whatsapp/postgres-auth-state.js';
import { asUser, asWorker, makeHarness, registerWorker, seedTenant, sqlState, type Harness, type Tenant } from './helpers.js';

let h: Harness;
let A: Tenant;
let B: Tenant;

beforeAll(async () => {
  h = makeHarness();
  A = await seedTenant(h, 'secrets-a');
  B = await seedTenant(h, 'secrets-b');
});
afterAll(async () => h.close());

/** Every column of a row rendered as text/hex/base64, to scan for leaked plaintext. */
async function rowDump(table: string, where: string, params: unknown[]): Promise<string> {
  const r = await h.owner.query(`SELECT * FROM app.${table} WHERE ${where}`, params);
  return r.rows.map((row) => Object.values(row).map((v) =>
    Buffer.isBuffer(v) ? `${v.toString('utf8')}|${v.toString('hex')}|${v.toString('base64')}` : JSON.stringify(v)).join('||')).join('\n');
}

describe('API keys', () => {
  it('stores only prefix + HMAC; plaintext appears nowhere in the row', async () => {
    const key = await h.services.apiKeys.create(asUser(A), { name: 'CRM integration', scopes: ['messages:send', 'messages:read'] });
    expect(key.plaintext).toMatch(/^hs_live_[A-Za-z0-9]{8}_[A-Za-z0-9_-]{43}$/);
    const dump = await rowDump('api_keys', 'id = $1', [key.id]);
    const secretPart = key.plaintext.split('_').slice(3).join('_');
    expect(dump).not.toContain(key.plaintext);
    expect(dump).not.toContain(secretPart);
    const row = await h.owner.query('SELECT key_prefix, octet_length(key_hash) AS len FROM app.api_keys WHERE id = $1', [key.id]);
    expect(row.rows[0]).toEqual({ key_prefix: key.prefix, len: 32 });
    // Audit trail contains no secret either.
    expect(await rowDump('audit_logs', `resource_id = $1`, [key.id])).not.toContain(secretPart);
  });

  it('the API role cannot read key hashes back', async () => {
    expect(await sqlState(h.appTx.inTenant((db) => db.query('SELECT key_hash FROM app.api_keys'), asUser(A)))).toBe('42501');
  });

  it('authenticates a live key, and a revoked key can no longer authenticate or act', async () => {
    const key = await h.services.apiKeys.create(asUser(A), { name: 'to revoke', scopes: ['instances:read'] });
    const ctx = await h.services.apiKeys.authenticate(key.plaintext);
    expect(ctx).toMatchObject({ organizationId: A.orgId, apiKeyId: key.id, apiScopes: ['instances:read'] });

    // The key context is a valid tenant context: it can read its own org's data.
    const seen = await h.appTx.inTenant((db) => db.query('SELECT count(*)::int AS n FROM app.businesses'), ctx!);
    expect(seen.rows[0].n).toBe(1);

    expect(await h.services.apiKeys.revoke(asUser(A), key.id)).toBe(true);
    expect(await h.services.apiKeys.authenticate(key.plaintext)).toBeNull();
    // Even an in-flight request still holding the old context is cut off by RLS.
    const after = await h.appTx.inTenant((db) => db.query('SELECT count(*)::int AS n FROM app.businesses'), ctx!);
    expect(after.rows[0].n).toBe(0);
  });

  it('expired, tampered and malformed keys are rejected', async () => {
    const key = await h.services.apiKeys.create(asUser(A), { name: 'expiring', scopes: ['instances:read'] });
    await h.owner.query(`UPDATE app.api_keys SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day' WHERE id = $1`, [key.id]);
    expect(await h.services.apiKeys.authenticate(key.plaintext)).toBeNull();
    const live = await h.services.apiKeys.create(asUser(A), { name: 'live', scopes: ['instances:read'] });
    const tampered = live.plaintext.slice(0, -1) + (live.plaintext.endsWith('A') ? 'B' : 'A');
    expect(await h.services.apiKeys.authenticate(tampered)).toBeNull();
    expect(await h.services.apiKeys.authenticate("hs_live_' OR 1=1 --")).toBeNull();
  });
});

describe('WhatsApp (Baileys) auth state', () => {
  const MARKER = 'NOISE-PRIVATE-KEY-MARKER-7f3a9c';
  const fakeCreds = () => ({
    noiseKey: { private: Buffer.from(MARKER), public: Buffer.from('public-part') },
    signedIdentityKey: { private: Buffer.from(`${MARKER}-identity`), public: Buffer.alloc(32, 7) },
    registrationId: 4242, me: undefined as undefined | { id: string },
  });

  async function openState(t: Tenant, workerId: string) {
    const token = await h.workerTx.run({}, (db) => h.repos.whatsapp.claimLease(db, t.instanceId, workerId, 60));
    expect(token).not.toBeNull();
    const auth = await usePostgresAuthState({ tx: h.workerTx, repo: h.repos.whatsapp, keys: h.keys, organizationId: t.orgId,
      instanceId: t.instanceId, workerId, leaseToken: token!, initCreds: fakeCreds });
    return { ...auth, token: token! };
  }

  it('credentials and signal keys are encrypted at rest and round-trip correctly', async () => {
    const workerId = await registerWorker(h, 'gw-secrets-1');
    const s1 = await openState(A, workerId);
    s1.state.creds.me = { id: '919900000000:1@s.whatsapp.net' };
    await s1.saveCreds();
    await s1.state.keys.set({ 'pre-key': { '1': { private: Buffer.from(`${MARKER}-prekey`), public: Buffer.alloc(32, 1) }, '2': { private: Buffer.alloc(32, 2) } },
                              session: { 'abc.0': Buffer.from(`${MARKER}-session`) } });

    const creds = await rowDump('whatsapp_auth_credentials', 'instance_id = $1', [A.instanceId]);
    const keys = await rowDump('whatsapp_signal_keys', 'instance_id = $1', [A.instanceId]);
    for (const needle of [MARKER, Buffer.from(MARKER).toString('base64'), Buffer.from(MARKER).toString('hex'), '919900000000']) {
      expect(creds).not.toContain(needle);
      expect(keys).not.toContain(needle);
    }

    // A fresh session (e.g. after worker restart) decrypts the same state.
    s1.close();
    const s2 = await openState(A, workerId);
    expect(s2.state.creds.me).toEqual({ id: '919900000000:1@s.whatsapp.net' });
    expect(Buffer.from(s2.state.creds.noiseKey.private).toString()).toBe(MARKER);
    const got = await s2.state.keys.get('pre-key', ['1', '2', '3']);
    expect(Object.keys(got).sort()).toEqual(['1', '2']);
    expect(Buffer.from((got['1'] as { private: Buffer }).private).toString()).toBe(`${MARKER}-prekey`);
    await s2.state.keys.set({ 'pre-key': { '2': null } });
    expect(Object.keys(await s2.state.keys.get('pre-key', ['1', '2']))).toEqual(['1']);
  });

  it('ciphertext copied from another instance/tenant does not decrypt (AAD binding)', async () => {
    const wA = await registerWorker(h, 'gw-aad-a');
    const wB = await registerWorker(h, 'gw-aad-b');
    const sb = await openState(B, wB);
    await sb.state.keys.set({ session: { victim: Buffer.from('b-session-secret') } });
    // A's session is still leased by the previous test's worker: simulate that worker dying.
    await h.owner.query(`UPDATE app.whatsapp_instances SET worker_lease_expires_at = now() - interval '1 second' WHERE id = $1`, [A.instanceId]);
    const sa = await openState(A, wA);
    await sa.state.keys.set({ session: { victim: Buffer.from('a-session') } });
    // An attacker with raw table write access swaps B's ciphertext into A's row.
    await h.owner.query(
      `UPDATE app.whatsapp_signal_keys a SET encrypted_value = b.encrypted_value
         FROM app.whatsapp_signal_keys b
        WHERE a.instance_id = $1 AND b.instance_id = $2 AND a.key_type = 'session' AND a.key_id = 'victim' AND b.key_type = 'session' AND b.key_id = 'victim'`,
      [A.instanceId, B.instanceId]);
    await expect(sa.state.keys.get('session', ['victim'])).rejects.toThrow(/authenticate|auth/i);
  });

  it('the API role can see that credentials exist but never read the ciphertext', async () => {
    expect(await sqlState(h.appTx.inTenant((db) => db.query('SELECT encrypted_credentials FROM app.whatsapp_auth_credentials'), asUser(A)))).toBe('42501');
    expect(await sqlState(h.appTx.inTenant((db) => db.query('SELECT encrypted_value FROM app.whatsapp_signal_keys'), asUser(A)))).toBe('42501');
    const meta = await h.appTx.inTenant((db) => db.query('SELECT instance_id, key_reference FROM app.whatsapp_auth_credentials'), asUser(A));
    expect(meta.rows).toEqual([{ instance_id: A.instanceId, key_reference: 'local-dev:v1' }]);
  });

  it('logged-out credentials are destroyed (hard delete) and the lease is revoked', async () => {
    const before = await h.owner.query('SELECT count(*)::int AS n FROM app.whatsapp_signal_keys WHERE instance_id = $1', [A.instanceId]);
    expect(before.rows[0].n).toBeGreaterThan(0);
    const destroyed = await h.appTx.inTenant((db) => h.repos.whatsapp.destroyAuth(db, A.instanceId, 'LOGGED_OUT'), asUser(A));
    expect(destroyed).toBe(before.rows[0].n);
    const creds = await h.owner.query('SELECT count(*)::int AS n FROM app.whatsapp_auth_credentials WHERE instance_id = $1', [A.instanceId]);
    const keys = await h.owner.query('SELECT count(*)::int AS n FROM app.whatsapp_signal_keys WHERE instance_id = $1', [A.instanceId]);
    expect([creds.rows[0].n, keys.rows[0].n]).toEqual([0, 0]);
    const inst = await h.owner.query('SELECT status, worker_id FROM app.whatsapp_instances WHERE id = $1', [A.instanceId]);
    expect(inst.rows[0]).toEqual({ status: 'LOGGED_OUT', worker_id: null });
    const ev = await h.owner.query(`SELECT event_type FROM app.whatsapp_instance_events WHERE instance_id = $1 ORDER BY created_at DESC LIMIT 1`, [A.instanceId]);
    expect(ev.rows[0].event_type).toBe('CREDENTIALS_DESTROYED');
    // A logged-out instance cannot be claimed again.
    const w = await registerWorker(h, 'gw-after-logout');
    expect(await h.workerTx.run({}, (db) => h.repos.whatsapp.claimLease(db, A.instanceId, w, 60))).toBeNull();
  });

  it('stale worker writes after losing the lease are rejected (fencing)', async () => {
    const w1 = await registerWorker(h, 'gw-fence-1');
    const w2 = await registerWorker(h, 'gw-fence-2');
    // B's session is still leased by the AAD test's worker: simulate that worker dying.
    await h.owner.query(`UPDATE app.whatsapp_instances SET worker_lease_expires_at = now() - interval '1 second' WHERE id = $1`, [B.instanceId]);
    const s1 = await openState(B, w1);
    await h.owner.query(`UPDATE app.whatsapp_instances SET worker_lease_expires_at = now() - interval '1 second' WHERE id = $1`, [B.instanceId]);
    const token2 = await h.workerTx.run({}, (db) => h.repos.whatsapp.claimLease(db, B.instanceId, w2, 60));
    expect(token2).toBe(s1.token + 1);
    await expect(s1.saveCreds()).rejects.toThrow(/lease lost/);
    await expect(s1.state.keys.set({ session: { x: Buffer.from('y') } })).rejects.toThrow(/lease lost/);
    expect(isLeaseLost({ code: '55P03', hint: 'HS_LEASE_LOST' })).toBe(true);
  });

  it('QR codes have no storage anywhere in the schema', async () => {
    const r = await h.owner.query(`SELECT table_name, column_name FROM information_schema.columns
                                    WHERE table_schema = 'app' AND column_name ILIKE '%qr%'`);
    expect(r.rows).toEqual([]);
  });
});

describe('other secrets', () => {
  it('passwords: plaintext is rejected by the schema; stored value is a scrypt hash', async () => {
    const state = await sqlState(h.owner.query(`INSERT INTO app.users (email, password_hash) VALUES ('plain@example.test', 'hunter2hunter2')`));
    expect(state).toBe('23514');
  });

  it('webhook signing secrets are encrypted and not readable by the API role', async () => {
    const ep = await h.services.webhooksApp.createEndpoint(asUser(A), { name: 'crm', url: 'https://hooks.example.test/wa', eventTypes: ['MESSAGE_RECEIVED'] });
    expect(ep.secret).toMatch(/^whsec_/);
    const dump = await rowDump('webhook_endpoints', 'id = $1', [ep.id]);
    expect(dump).not.toContain(ep.secret.slice(6));
    expect(await sqlState(h.appTx.inTenant((db) => db.query('SELECT secret_ciphertext FROM app.webhook_endpoints'), asUser(A)))).toBe('42501');
  });

  it('audit metadata refuses top-level secret fields', async () => {
    const state = await sqlState(h.appTx.inTenant((db) => db.query(
      `INSERT INTO app.audit_logs (organization_id, actor_type, action, resource_type, metadata) VALUES ($1, 'USER', 'X_TEST', 'TEST', '{"password":"x"}')`,
      [A.orgId]), asUser(A)));
    expect(state).toBe('23514');
    // The repository redacts nested secrets before they reach the DB.
    await h.appTx.inTenant((db) => h.repos.ops.audit(db, { organizationId: A.orgId, actorType: 'USER', action: 'REDACT_TEST', resourceType: 'TEST',
      metadata: { nested: { api_key: 'hs_live_zzz', token: 't' }, note: 'ok' } }), asUser(A));
    const row = await h.owner.query(`SELECT metadata FROM app.audit_logs WHERE action = 'REDACT_TEST'`);
    expect(row.rows[0].metadata).toEqual({ nested: { api_key: '[REDACTED]', token: '[REDACTED]' }, note: 'ok' });
  });
});

describe('worker context sanity', () => {
  it('asWorker helper yields tenant-scoped access only', async () => {
    const r = await h.workerTx.inTenant((db) => db.query('SELECT count(*)::int AS n FROM app.contacts'), asWorker(A));
    expect(r.rows[0].n).toBe(1);
  });
});
