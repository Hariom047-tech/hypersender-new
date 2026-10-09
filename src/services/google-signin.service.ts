import { WhatsAppError } from '../whatsapp/domain/whatsapp-errors.js';

/*
 * "Continue with Google" for the dashboard.
 *
 * The web BFF starts the flow (state + PKCE verifier in HttpOnly cookies) and
 * receives Google's redirect on its own origin. It then hands the one-time
 * `code` and the PKCE verifier to the API, which exchanges them with the client
 * secret (never leaves the server) and reads the VERIFIED email. The redirect
 * URI is fixed server-side, so a caller cannot point the flow elsewhere.
 */
export interface GoogleSignInConfig {
  clientId?: string;
  clientSecret?: string;
  redirectUri: string;
  authUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
}

export function googleSignInConfigFromEnv(): GoogleSignInConfig {
  const web = (process.env.WEB_APP_URL ?? 'http://localhost:3200').replace(/\/$/, '');
  return {
    clientId: process.env.GOOGLE_CLIENT_ID || undefined,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || undefined,
    redirectUri: process.env.GOOGLE_SIGNIN_REDIRECT_URI ?? `${web}/api/auth/google/callback`,
    authUrl: process.env.GOOGLE_OAUTH_AUTH_URL ?? 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: process.env.GOOGLE_OAUTH_TOKEN_URL ?? 'https://oauth2.googleapis.com/token',
    userInfoUrl: process.env.GOOGLE_USERINFO_URL ?? 'https://openidconnect.googleapis.com/v1/userinfo',
  };
}

export interface GoogleProfile { email: string; firstName: string | null; lastName: string | null }

const B64URL = /^[A-Za-z0-9_-]{43,128}$/;

export class GoogleSignInService {
  constructor(private readonly cfg: GoogleSignInConfig = googleSignInConfigFromEnv(), private readonly http: typeof fetch = fetch) {}

  get configured(): boolean { return Boolean(this.cfg.clientId && this.cfg.clientSecret); }

  private need() {
    if (!this.configured) throw new WhatsAppError('CONFLICT', 'Google sign-in is not set up yet');
  }

  /** Google consent URL for the web BFF (state + S256 PKCE challenge come from the BFF's cookies). */
  authorizeUrl(state: string, codeChallenge: string, loginHint?: string): string {
    this.need();
    if (!B64URL.test(state) || !B64URL.test(codeChallenge)) throw new WhatsAppError('VALIDATION_FAILED', 'invalid state or code challenge');
    const u = new URL(this.cfg.authUrl);
    u.search = new URLSearchParams({
      client_id: this.cfg.clientId!, redirect_uri: this.cfg.redirectUri, response_type: 'code', scope: 'openid email profile',
      state, code_challenge: codeChallenge, code_challenge_method: 'S256', prompt: 'select_account',
      ...(loginHint ? { login_hint: loginHint } : {}),
    }).toString();
    return u.toString();
  }

  /** Exchanges the one-time code and returns the Google account's verified email and name. */
  async profile(code: string, codeVerifier: string): Promise<GoogleProfile> {
    this.need();
    if (!code || code.length > 2048 || !B64URL.test(codeVerifier)) throw new WhatsAppError('VALIDATION_FAILED', 'invalid Google response');
    const tok = await this.http(this.cfg.tokenUrl, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, code_verifier: codeVerifier, client_id: this.cfg.clientId!, client_secret: this.cfg.clientSecret!,
        redirect_uri: this.cfg.redirectUri, grant_type: 'authorization_code' }),
      signal: AbortSignal.timeout(10_000),
    });
    const t = (await tok.json().catch(() => ({}))) as { access_token?: string };
    if (!tok.ok || !t.access_token) throw new WhatsAppError('UNAUTHENTICATED', 'Google sign-in failed, please try again');
    const me = await this.http(this.cfg.userInfoUrl, { headers: { authorization: `Bearer ${t.access_token}` }, signal: AbortSignal.timeout(10_000) });
    const p = (await me.json().catch(() => ({}))) as { email?: string; email_verified?: boolean | string; given_name?: string; family_name?: string };
    if (!me.ok || !p.email || !(p.email_verified === true || p.email_verified === 'true')) {
      throw new WhatsAppError('UNAUTHENTICATED', 'Your Google account email is not verified');
    }
    return { email: p.email.trim().slice(0, 320), firstName: p.given_name?.slice(0, 100) || null, lastName: p.family_name?.slice(0, 100) || null };
  }
}
