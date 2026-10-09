import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeHarness, type Harness } from './helpers.js';
import { startApi, type Api } from './saas-helpers.js';

/*
 * "Continue with Google" and the sign-up form's mobile number: the API side of
 * the flow (authorize URL with PKCE, code exchange against a fake Google,
 * sign in or create the account for a VERIFIED email only).
 */
let h: Harness;
let api: Api;
let google: Server;
let profile: Record<string, unknown> = {};
let lastToken: Record<string, string> = {};
const b64 = () => randomBytes(32).toString('base64url');

beforeAll(async () => {
  google = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/token') {
        lastToken = Object.fromEntries(new URLSearchParams(body));
        if (lastToken.code === 'bad') { res.statusCode = 400; res.end('{"error":"invalid_grant"}'); return; }
        res.end(JSON.stringify({ access_token: 'g-access', expires_in: 3600 }));
        return;
      }
      if (req.url === '/userinfo') { res.end(JSON.stringify(profile)); return; }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise<void>((r) => google.listen(0, r));
  const port = (google.address() as { port: number }).port;
  h = makeHarness();
  api = await startApi({
    GOOGLE_CLIENT_ID: 'test-client-id', GOOGLE_CLIENT_SECRET: 'test-client-secret', WEB_APP_URL: 'http://web.test',
    GOOGLE_OAUTH_TOKEN_URL: `http://127.0.0.1:${port}/token`, GOOGLE_USERINFO_URL: `http://127.0.0.1:${port}/userinfo`,
  });
});
afterAll(async () => { await api.app.close(); await h.close(); await new Promise((r) => google.close(r)); });

describe('Continue with Google', () => {
  it('builds the consent URL with PKCE and a fixed redirect back to the web app', async () => {
    const state = b64();
    const challenge = b64();
    const r = (await api.http.post('/v1/auth/google/authorize-url').send({ state, codeChallenge: challenge }).expect(200)).body;
    const u = new URL(r.url);
    expect(u.searchParams.get('client_id')).toBe('test-client-id');
    expect(u.searchParams.get('redirect_uri')).toBe('http://web.test/api/auth/google/callback');
    expect(u.searchParams.get('state')).toBe(state);
    expect(u.searchParams.get('code_challenge')).toBe(challenge);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('scope')).toBe('openid email profile');
    expect(r.url).not.toContain('test-client-secret');
    expect((await api.http.post('/v1/auth/google/authorize-url').send({ state: 'x', codeChallenge: challenge })).status).toBe(400);
  });

  it('creates an account for a new verified Google email, then signs the same account in', async () => {
    const email = `g-${randomBytes(4).toString('hex')}@gmail.test`;
    profile = { email, email_verified: true, given_name: 'Rahul', family_name: 'Sharma' };
    const verifier = b64();
    const first = (await api.http.post('/v1/auth/google').send({ code: 'code-1', codeVerifier: verifier }).expect(200)).body;
    expect(first.created).toBe(true);
    expect(first.token).toBeTruthy();
    expect(first.organizations).toEqual([]);
    // The secret and the PKCE verifier went to Google's token endpoint, with the fixed redirect.
    expect(lastToken).toMatchObject({ code: 'code-1', code_verifier: verifier, client_secret: 'test-client-secret', redirect_uri: 'http://web.test/api/auth/google/callback' });
    const u = (await h.owner.query(`SELECT first_name, last_name, password_hash, email_verified_at IS NOT NULL AS verified FROM app.users WHERE id = $1`, [first.userId])).rows[0];
    expect(u).toEqual({ first_name: 'Rahul', last_name: 'Sharma', password_hash: null, verified: true });
    // A Google-only account has no password: password login never works for it.
    expect((await api.http.post('/v1/auth/login').send({ email, password: 'anything-at-all' })).status).toBe(401);

    const again = (await api.http.post('/v1/auth/google').send({ code: 'code-2', codeVerifier: b64() }).expect(200)).body;
    expect(again).toMatchObject({ created: false, userId: first.userId });
    const me = await api.http.get('/v1/account/me').set('authorization', `Bearer ${again.token}`);
    expect(me.status).toBe(200);
  });

  it('signs in an existing email/password account with the same (case-insensitive) email', async () => {
    const email = `both-${randomBytes(4).toString('hex')}@example.test`;
    const reg = (await api.http.post('/v1/auth/register').send({ email, password: 'correct horse battery', firstName: 'Asha' }).expect(201)).body;
    profile = { email: email.toUpperCase(), email_verified: 'true' };
    const r = (await api.http.post('/v1/auth/google').send({ code: 'code-3', codeVerifier: b64() }).expect(200)).body;
    expect(r).toMatchObject({ created: false, userId: reg.userId });
  });

  it('refuses unverified emails, failed exchanges and suspended accounts', async () => {
    profile = { email: 'unverified@example.test', email_verified: false };
    expect((await api.http.post('/v1/auth/google').send({ code: 'code-4', codeVerifier: b64() })).status).toBe(401);
    expect((await api.http.post('/v1/auth/google').send({ code: 'bad', codeVerifier: b64() })).status).toBe(401);
    expect((await api.http.post('/v1/auth/google').send({ code: 'code-5', codeVerifier: 'short' })).status).toBe(400);

    const email = `sus-${randomBytes(4).toString('hex')}@example.test`;
    const reg = (await api.http.post('/v1/auth/register').send({ email, password: 'correct horse battery' }).expect(201)).body;
    await h.owner.query(`UPDATE app.users SET status = 'SUSPENDED' WHERE id = $1`, [reg.userId]);
    profile = { email, email_verified: true };
    expect((await api.http.post('/v1/auth/google').send({ code: 'code-6', codeVerifier: b64() })).status).toBe(401);
  });
});

describe('sign-up form', () => {
  it('stores the mobile number in international format and rejects invalid numbers', async () => {
    const email = `ph-${randomBytes(4).toString('hex')}@example.test`;
    expect((await api.http.post('/v1/auth/register').send({ email, password: 'correct horse battery', phone: '12' })).status).toBe(400);
    const r = (await api.http.post('/v1/auth/register').send({ email, password: 'correct horse battery', firstName: 'Ravi', phone: '+919876543210' }).expect(201)).body;
    expect((await h.owner.query(`SELECT phone_e164 FROM app.users WHERE id = $1`, [r.userId])).rows[0].phone_e164).toBe('+919876543210');
  });
});
