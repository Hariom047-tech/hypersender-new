import { createServer, type Server } from 'node:http';

/**
 * TEST-ONLY stand-in for Google OAuth + Calendar v3 (token, userinfo, freeBusy,
 * events insert/patch/delete, revoke). The production GoogleCalendarService
 * talks to it over real HTTP via the GOOGLE_* endpoint overrides.
 */
export class FakeGoogle {
  readonly requests: Array<{ method: string; path: string; body: any }> = [];
  busy: Array<{ start: string; end: string }> = [];
  events = new Map<string, any>();
  revoked = false;
  refreshToken = 'refresh-token-SECRET-123';
  private server!: Server;
  url = '';
  private n = 0;

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const u = new URL(req.url ?? '/', 'http://x');
        const ctype = String(req.headers['content-type'] ?? '');
        const body = !raw ? {} : ctype.includes('json') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
        this.requests.push({ method: req.method ?? 'GET', path: u.pathname, body });
        const json = (status: number, b: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(b)); };
        if (u.pathname === '/token') {
          if (body.client_secret !== 'test-google-secret') return json(401, { error: 'invalid_client' });
          if (this.revoked) return json(400, { error: 'invalid_grant' });
          if (body.grant_type === 'authorization_code') return json(200, { access_token: 'access-1', refresh_token: this.refreshToken, expires_in: 3600 });
          if (body.grant_type === 'refresh_token' && body.refresh_token === this.refreshToken) return json(200, { access_token: 'access-2', expires_in: 3600 });
          return json(400, { error: 'invalid_grant' });
        }
        if (u.pathname === '/userinfo') return json(200, { email: 'pandit.ji@example.com' });
        if (u.pathname === '/revoke') { this.revoked = true; return json(200, {}); }
        if (!String(req.headers.authorization ?? '').startsWith('Bearer access-')) return json(401, { error: 'unauthorized' });
        if (u.pathname === '/calendar/freeBusy') {
          return json(200, { calendars: { [body.items[0].id]: { busy: this.busy.filter((b) => b.end > body.timeMin && b.start < body.timeMax) } } });
        }
        const m = /^\/calendar\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(u.pathname);
        if (m) {
          const id = m[2] ? decodeURIComponent(m[2]) : null;
          if (req.method === 'POST') { const e = { ...body, id: `evt${++this.n}` }; this.events.set(e.id, e); return json(200, e); }
          if (req.method === 'PATCH' && id && this.events.has(id)) { const e = { ...this.events.get(id), ...body }; this.events.set(id, e); return json(200, e); }
          if (req.method === 'DELETE' && id) { this.events.delete(id); res.writeHead(204).end(); return; }
          return json(404, {});
        }
        json(404, {});
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
    return this;
  }

  /** Points the service's GOOGLE_* endpoints at this fake. */
  env(): Record<string, string> {
    return { GOOGLE_CLIENT_ID: 'test-google-client', GOOGLE_CLIENT_SECRET: 'test-google-secret', GOOGLE_OAUTH_AUTH_URL: `${this.url}/auth`,
      GOOGLE_OAUTH_TOKEN_URL: `${this.url}/token`, GOOGLE_USERINFO_URL: `${this.url}/userinfo`, GOOGLE_CALENDAR_API_BASE: `${this.url}/calendar`,
      GOOGLE_OAUTH_REVOKE_URL: `${this.url}/revoke`, WEB_APP_URL: 'http://web.test' };
  }

  async stop(): Promise<void> { await new Promise<void>((r) => this.server.close(() => r())); }
}
