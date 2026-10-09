import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Logger } from 'pino';
import type { DbContext } from '../database/tenant-context.js';
import type { Db, TransactionRunner } from '../database/transaction-runner.js';
import type { ClaimedOutboxEvent, OpsRepository } from '../repositories/ops.repository.js';
import { aad, aesGcmDecrypt, aesGcmEncrypt } from '../security/crypto/aes-gcm.js';
import type { KeyProvider } from '../security/crypto/key-provider.js';
import type { OutboxRelayService } from '../services/outbox-relay.service.js';

/*
 * Google Calendar for Pandit Ji (one calendar per business).
 *
 *  connect:   dashboard -> authUrl (signed, 15-minute state) -> Google consent ->
 *             GET /v1/oauth/google/callback -> code exchanged for a refresh token,
 *             envelope-encrypted and stored -> browser back to the dashboard.
 *  read:      freeBusy() - busy time on the calendar hides havan slots and blocks
 *             a booking at that time (checked live, never cached in the DB).
 *  write:     bookings enqueue CALENDAR_SYNC in their own transaction; the worker
 *             creates / moves / deletes the event (no network I/O inside a tx).
 *
 * Scopes are the narrowest that work: calendar.freebusy (see busy blocks, not
 * event contents) + calendar.events (write our own events) + email (to show
 * which account is connected).
 */

export const CALENDAR_SYNC_EVENT = 'CALENDAR_SYNC';
const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar.freebusy', 'https://www.googleapis.com/auth/calendar.events'];
const STATE_TTL_MS = 15 * 60_000;

export interface GoogleCalendarConfig {
  clientId?: string;
  clientSecret?: string;
  redirectUri: string;
  webAppUrl: string;
  stateSecret: string;
  authUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  apiBase: string;
  revokeUrl: string;
}

export function googleCalendarConfigFromEnv(): GoogleCalendarConfig {
  const api = (process.env.API_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 3100}`).replace(/\/$/, '');
  return {
    clientId: process.env.GOOGLE_CLIENT_ID || undefined,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || undefined,
    redirectUri: process.env.GOOGLE_OAUTH_REDIRECT_URI ?? `${api}/v1/oauth/google/callback`,
    webAppUrl: (process.env.WEB_APP_URL ?? 'http://localhost:3200').replace(/\/$/, ''),
    stateSecret: process.env.SESSION_SECRET ?? '',
    authUrl: process.env.GOOGLE_OAUTH_AUTH_URL ?? 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: process.env.GOOGLE_OAUTH_TOKEN_URL ?? 'https://oauth2.googleapis.com/token',
    userInfoUrl: process.env.GOOGLE_USERINFO_URL ?? 'https://openidconnect.googleapis.com/v1/userinfo',
    apiBase: (process.env.GOOGLE_CALENDAR_API_BASE ?? 'https://www.googleapis.com/calendar/v3').replace(/\/$/, ''),
    revokeUrl: process.env.GOOGLE_OAUTH_REVOKE_URL ?? 'https://oauth2.googleapis.com/revoke',
  };
}

export class CalendarError extends Error {
  constructor(readonly code: 'NOT_CONFIGURED' | 'BAD_STATE' | 'NO_REFRESH_TOKEN' | 'GOOGLE_ERROR' | 'REVOKED', message: string) { super(message); }
}

export interface BusyInterval { start: Date; end: Date }
export interface CalendarStatus { configured: boolean; connected: boolean; email: string | null; calendarId: string | null; status: string | null; lastError: string | null; lastSyncedAt: string | null }

const b64url = (b: Buffer) => b.toString('base64url');
const keyContext = (orgId: string, businessId: string) => ({ organization_id: orgId, business_id: businessId, purpose: 'google-calendar' });

export class GoogleCalendarService {
  private readonly tokens = new Map<string, { token: string; expires: number }>();

  constructor(private readonly cfg: GoogleCalendarConfig, private readonly keys: KeyProvider, private readonly fetchImpl: typeof fetch = fetch) {}

  get configured(): boolean { return Boolean(this.cfg.clientId && this.cfg.clientSecret && this.cfg.stateSecret.length >= 32); }
  get webAppUrl(): string { return this.cfg.webAppUrl; }

  // ------------------------------------------------------------- connect ---
  /** Google consent URL. The state is signed and names the org, business and user who asked. */
  authorizationUrl(p: { organizationId: string; businessId: string; userId: string }): string {
    if (!this.configured) throw new CalendarError('NOT_CONFIGURED', 'Google Calendar is not configured on this server.');
    const payload = b64url(Buffer.from(JSON.stringify({ o: p.organizationId, b: p.businessId, u: p.userId, e: Date.now() + STATE_TTL_MS, n: b64url(randomBytes(12)) })));
    const state = `${payload}.${this.sign(payload)}`;
    const q = new URLSearchParams({ client_id: this.cfg.clientId!, redirect_uri: this.cfg.redirectUri, response_type: 'code', scope: SCOPES.join(' '),
      access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state });
    return `${this.cfg.authUrl}?${q}`;
  }

  verifyState(state: string): { organizationId: string; businessId: string; userId: string } {
    const [payload, sig] = String(state ?? '').split('.');
    if (!payload || !sig) throw new CalendarError('BAD_STATE', 'invalid state');
    const want = Buffer.from(this.sign(payload));
    const got = Buffer.from(sig);
    if (want.length !== got.length || !timingSafeEqual(want, got)) throw new CalendarError('BAD_STATE', 'invalid state');
    const s = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { o: string; b: string; u: string; e: number };
    if (!s.e || s.e < Date.now()) throw new CalendarError('BAD_STATE', 'The connect link expired. Please try again.');
    return { organizationId: s.o, businessId: s.b, userId: s.u };
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.cfg.stateSecret).update(`google-calendar:${payload}`).digest('base64url');
  }

  /** OAuth callback: exchange the code, encrypt and store the refresh token. Returns the connected account email. */
  async completeConnection(tx: TransactionRunner, code: string, state: string): Promise<{ businessId: string; email: string | null }> {
    const s = this.verifyState(state);
    const tok = await this.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: this.cfg.redirectUri });
    if (!tok.refresh_token) throw new CalendarError('NO_REFRESH_TOKEN', 'Google did not return offline access. Remove the app from your Google account and connect again.');
    let email: string | null = null;
    try {
      const r = await this.fetchImpl(this.cfg.userInfoUrl, { headers: { authorization: `Bearer ${tok.access_token}` }, signal: AbortSignal.timeout(10_000) });
      if (r.ok) email = ((await r.json()) as { email?: string }).email ?? null;
    } catch { email = null; }
    const dek = await this.keys.generateDataKey(keyContext(s.organizationId, s.businessId));
    const enc = aesGcmEncrypt(dek.plaintext, Buffer.from(tok.refresh_token, 'utf8'), aad('google-calendar', s.organizationId, s.businessId));
    dek.plaintext.fill(0);
    await tx.inTenant(async (db) => {
      const b = (await db.query('SELECT id FROM app.businesses WHERE id = $1 AND deleted_at IS NULL', [s.businessId])).rows[0];
      if (!b) throw new CalendarError('BAD_STATE', 'business not found');
      await db.query(
        `INSERT INTO app.calendar_connections (business_id, organization_id, account_email, calendar_id, refresh_token_enc, wrapped_key, key_reference, status, connected_by_user_id)
         VALUES ($1, app.current_org_id(), $2, 'primary', $3, $4, $5, 'ACTIVE', $6)
         ON CONFLICT (business_id) DO UPDATE SET account_email = EXCLUDED.account_email, calendar_id = 'primary', refresh_token_enc = EXCLUDED.refresh_token_enc,
           wrapped_key = EXCLUDED.wrapped_key, key_reference = EXCLUDED.key_reference, status = 'ACTIVE', last_error = NULL,
           connected_by_user_id = EXCLUDED.connected_by_user_id`,
        [s.businessId, email, enc, dek.wrapped, dek.keyReference, s.userId]);
    }, { organizationId: s.organizationId, userId: s.userId });
    this.tokens.delete(`${s.organizationId}:${s.businessId}`);
    return { businessId: s.businessId, email };
  }

  async status(db: Db, businessId: string): Promise<CalendarStatus> {
    const r = (await db.query(
      `SELECT account_email, calendar_id, status, last_error, last_synced_at FROM app.calendar_connections WHERE business_id = $1`, [businessId])).rows[0];
    return { configured: this.configured, connected: Boolean(r), email: r?.account_email ?? null, calendarId: r?.calendar_id ?? null, status: r?.status ?? null,
      lastError: r?.last_error ?? null, lastSyncedAt: r?.last_synced_at ?? null };
  }

  /** Removes the connection (and revokes the token at Google, best effort). */
  async disconnect(tx: TransactionRunner, ctx: DbContext & { organizationId: string }, businessId: string): Promise<boolean> {
    const row = await tx.inTenant(async (db) => {
      const r = (await db.query(`DELETE FROM app.calendar_connections WHERE business_id = $1 RETURNING refresh_token_enc, wrapped_key, key_reference`, [businessId])).rows[0];
      return r ?? null;
    }, ctx);
    this.tokens.delete(`${ctx.organizationId}:${businessId}`);
    if (!row) return false;
    try {
      const refresh = await this.decryptRefresh(ctx.organizationId, businessId, row);
      await this.fetchImpl(`${this.cfg.revokeUrl}?token=${encodeURIComponent(refresh)}`, { method: 'POST', signal: AbortSignal.timeout(10_000) });
    } catch { /* already revoked or offline: the row is gone either way */ }
    return true;
  }

  // ----------------------------------------------------------------- read ---
  /**
   * Busy intervals on Pandit Ji's calendar. null = no calendar connected.
   * Throws CalendarError('GOOGLE_ERROR' | 'REVOKED') when Google cannot be read.
   */
  async freeBusy(tx: TransactionRunner, ctx: DbContext & { organizationId: string }, businessId: string, from: Date, to: Date): Promise<BusyInterval[] | null> {
    const conn = await this.connection(tx, ctx, businessId);
    if (!conn) return null;
    const token = await this.accessToken(tx, ctx, businessId, conn);
    const r = await this.fetchImpl(`${this.cfg.apiBase}/freeBusy`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, signal: AbortSignal.timeout(8_000),
      body: JSON.stringify({ timeMin: from.toISOString(), timeMax: to.toISOString(), items: [{ id: conn.calendar_id }] }),
    });
    if (!r.ok) throw new CalendarError('GOOGLE_ERROR', `Google freeBusy failed (${r.status})`);
    const body = (await r.json()) as { calendars?: Record<string, { busy?: Array<{ start: string; end: string }>; errors?: unknown[] }> };
    const cal = body.calendars?.[conn.calendar_id];
    if (!cal || cal.errors?.length) throw new CalendarError('GOOGLE_ERROR', 'Google could not read this calendar');
    return (cal.busy ?? []).map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
  }

  // ---------------------------------------------------------------- write ---
  /** Worker: create / update / delete the event of one booking. Idempotent. */
  async sync(tx: TransactionRunner, organizationId: string, p: { bookingId: string; action: 'UPSERT' | 'DELETE' }, logger?: Logger): Promise<void> {
    const ctx = { organizationId };
    const data = await tx.inTenant(async (db) => {
      const b = (await db.query(
        `SELECT b.id, b.business_id, b.status, b.start_at, b.end_at, b.timezone, b.customer_name, b.customer_phone, b.notes,
                d.tier, d.participation_mode, d.yajman_name, d.city, d.gotra, d.sankalp, d.dakshina_status, s.name AS service, hs.temple_name, l.provider_event_id, l.calendar_id AS link_calendar
           FROM app.bookings b LEFT JOIN app.havan_booking_details d ON d.booking_id = b.id LEFT JOIN app.services s ON s.id = b.service_id
           LEFT JOIN app.havan_settings hs ON hs.business_id = b.business_id LEFT JOIN app.calendar_event_links l ON l.booking_id = b.id
          WHERE b.id = $1`, [p.bookingId])).rows[0];
      return b ?? null;
    }, ctx, { readOnly: true });
    if (!data) return;
    const conn = await this.connection(tx, ctx, data.business_id);
    if (!conn) return;
    try {
      const token = await this.accessToken(tx, ctx, data.business_id, conn);
      const cal = encodeURIComponent(data.link_calendar ?? conn.calendar_id);
      const active = ['PENDING', 'CONFIRMED'].includes(data.status);
      if (p.action === 'DELETE' || !active) {
        if (data.provider_event_id) {
          const r = await this.fetchImpl(`${this.cfg.apiBase}/calendars/${cal}/events/${encodeURIComponent(data.provider_event_id)}?sendUpdates=none`,
            { method: 'DELETE', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
          if (!r.ok && r.status !== 404 && r.status !== 410) throw new CalendarError('GOOGLE_ERROR', `Google delete failed (${r.status})`);
          await tx.inTenant((db) => db.query('DELETE FROM app.calendar_event_links WHERE booking_id = $1', [data.id]), ctx);
        }
      } else {
        const event = eventBody(data);
        const url = data.provider_event_id
          ? `${this.cfg.apiBase}/calendars/${cal}/events/${encodeURIComponent(data.provider_event_id)}?sendUpdates=none`
          : `${this.cfg.apiBase}/calendars/${cal}/events?sendUpdates=none`;
        const r = await this.fetchImpl(url, { method: data.provider_event_id ? 'PATCH' : 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(event), signal: AbortSignal.timeout(10_000) });
        if (!r.ok) throw new CalendarError('GOOGLE_ERROR', `Google event write failed (${r.status})`);
        const created = (await r.json()) as { id: string };
        await tx.inTenant((db) => db.query(
          `INSERT INTO app.calendar_event_links (booking_id, organization_id, business_id, provider_event_id, calendar_id)
           VALUES ($1, app.current_org_id(), $2, $3, $4) ON CONFLICT (booking_id) DO UPDATE SET provider_event_id = EXCLUDED.provider_event_id`,
          [data.id, data.business_id, created.id, data.link_calendar ?? conn.calendar_id]), ctx);
      }
      await this.markHealthy(tx, ctx, data.business_id);
    } catch (err) {
      await this.markError(tx, ctx, data.business_id, (err as Error).message);
      logger?.warn({ event_name: 'calendar.sync_failed', booking_id: p.bookingId, err: { message: String((err as Error).message).slice(0, 200) } });
      if (err instanceof CalendarError && err.code === 'REVOKED') return; // nothing to retry until reconnected
      throw err; // the outbox retries with back-off
    }
  }

  // -------------------------------------------------------------- helpers ---
  private async connection(tx: TransactionRunner, ctx: DbContext & { organizationId: string }, businessId: string) {
    return tx.inTenant(async (db) => (await db.query(
      `SELECT calendar_id, refresh_token_enc, wrapped_key, key_reference FROM app.calendar_connections WHERE business_id = $1`, [businessId])).rows[0] ?? null,
    ctx, { readOnly: true });
  }

  private async decryptRefresh(orgId: string, businessId: string, row: { refresh_token_enc: Buffer; wrapped_key: Buffer; key_reference: string }): Promise<string> {
    const key = await this.keys.decryptDataKey(row.wrapped_key, row.key_reference, keyContext(orgId, businessId));
    try {
      return aesGcmDecrypt(key, row.refresh_token_enc, aad('google-calendar', orgId, businessId)).toString('utf8');
    } finally { key.fill(0); }
  }

  private async accessToken(tx: TransactionRunner, ctx: DbContext & { organizationId: string }, businessId: string,
                            row: { refresh_token_enc: Buffer; wrapped_key: Buffer; key_reference: string }): Promise<string> {
    const k = `${ctx.organizationId}:${businessId}`;
    const hit = this.tokens.get(k);
    if (hit && hit.expires > Date.now() + 60_000) return hit.token;
    const refresh = await this.decryptRefresh(ctx.organizationId, businessId, row);
    try {
      const t = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh });
      this.tokens.set(k, { token: t.access_token, expires: Date.now() + (t.expires_in ?? 3600) * 1000 });
      return t.access_token;
    } catch (err) {
      if (err instanceof CalendarError && err.code === 'REVOKED') await this.markError(tx, ctx, businessId, 'Access was removed in Google. Please reconnect the calendar.');
      throw err;
    }
  }

  private async tokenRequest(body: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
    if (!this.configured) throw new CalendarError('NOT_CONFIGURED', 'Google Calendar is not configured on this server.');
    const r = await this.fetchImpl(this.cfg.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({ ...body, client_id: this.cfg.clientId!, client_secret: this.cfg.clientSecret! }) });
    if (!r.ok) {
      const e = (await r.json().catch(() => ({}))) as { error?: string };
      if (e.error === 'invalid_grant') throw new CalendarError('REVOKED', 'Google access was revoked or expired.');
      throw new CalendarError('GOOGLE_ERROR', `Google token request failed (${r.status})`);
    }
    return (await r.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
  }

  private markHealthy(tx: TransactionRunner, ctx: DbContext & { organizationId: string }, businessId: string) {
    return tx.inTenant((db) => db.query(`UPDATE app.calendar_connections SET status = 'ACTIVE', last_error = NULL, last_synced_at = now() WHERE business_id = $1`, [businessId]), ctx);
  }
  private markError(tx: TransactionRunner, ctx: DbContext & { organizationId: string }, businessId: string, message: string) {
    return tx.inTenant((db) => db.query(`UPDATE app.calendar_connections SET status = 'ERROR', last_error = left($2, 300) WHERE business_id = $1`, [businessId, message]), ctx)
      .catch(() => undefined);
  }
}

const TIER: Record<string, string> = { SAMANYA: 'Samanya Havan', VISHESH: 'Vishesh Havan', MAHA_VISHESH: 'Maha Vishesh Havan' };
const MODE: Record<string, string> = { NALKHEDA_IN_PERSON: 'Nalkheda mein swayam', ONLINE_SANKALP: 'Online (video call se sankalp)' };

function eventBody(d: any) {
  const title = `🔥 ${d.tier ? TIER[d.tier] : d.service ?? 'Havan'} – ${d.yajman_name ?? d.customer_name}`;
  const lines = [
    `Yajman: ${d.yajman_name ?? d.customer_name}${d.city ? `, ${d.city}` : ''}`, `Phone: ${d.customer_phone}`, d.participation_mode ? `Mode: ${MODE[d.participation_mode]}` : null,
    d.gotra ? `Gotra: ${d.gotra}` : null, d.sankalp ? `Sankalp: ${d.sankalp}` : null,
    `Dakshina: ${d.dakshina_status === 'AGREED_ON_CALL' ? 'call par tay ho chuki' : 'call par tay honi hai'}`, '', 'HyperSender se booking',
  ].filter((x) => x !== null);
  return { summary: title.slice(0, 250), description: lines.join('\n'), location: d.temple_name ?? undefined,
    start: { dateTime: new Date(d.start_at).toISOString(), timeZone: d.timezone }, end: { dateTime: new Date(d.end_at).toISOString(), timeZone: d.timezone },
    reminders: { useDefault: true }, extendedProperties: { private: { hypersenderBookingId: d.id } } };
}

/** Enqueue (inside the booking's tenant transaction) a calendar write, only when a calendar is connected. */
export async function enqueueCalendarSync(db: Db, ops: OpsRepository, organizationId: string, businessId: string, bookingId: string, action: 'UPSERT' | 'DELETE', key: string): Promise<boolean> {
  const connected = (await db.query('SELECT 1 FROM app.calendar_connections WHERE business_id = $1', [businessId])).rows.length > 0;
  if (!connected) return false;
  await ops.enqueueOutbox(db, { organizationId, eventType: CALENDAR_SYNC_EVENT, aggregateType: 'BOOKING', aggregateId: bookingId,
    payload: { booking_id: bookingId, action }, dedupeKey: `calendar:${action}:${bookingId}:${key}` });
  return true;
}

/** Worker: registers the CALENDAR_SYNC handler on the general outbox relay. */
export function registerCalendarSync(relay: OutboxRelayService, tx: TransactionRunner, calendar: GoogleCalendarService, logger?: Logger): void {
  relay.on(CALENDAR_SYNC_EVENT, async (e: ClaimedOutboxEvent) => {
    if (!e.organizationId) return;
    const p = e.payload as { booking_id: string; action: 'UPSERT' | 'DELETE' };
    await calendar.sync(tx, e.organizationId, { bookingId: p.booking_id, action: p.action }, logger);
  });
}

/** Removes slots that overlap a busy interval (slot = [start, start + duration)). */
export function withoutBusy<T extends { start_at: string }>(slots: T[], busy: BusyInterval[], durationMinutes: number): T[] {
  return slots.filter((s) => {
    const a = Date.parse(s.start_at);
    const b = a + durationMinutes * 60_000;
    return !busy.some((x) => a < x.end.getTime() && b > x.start.getTime());
  });
}
