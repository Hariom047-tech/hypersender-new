import { timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { backendUrl, SESSION_COOKIE, sessionCookieOptions } from '@/lib/server/backend';
import { G_STATE, G_VERIFIER, googleCookie } from '@/lib/server/google';

export const dynamic = 'force-dynamic';

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * "Continue with Google", step 2: Google returns here. The state must match the
 * cookie set in step 1; the API exchanges the one-time code (with the PKCE
 * verifier and the client secret) and returns a session, stored HttpOnly.
 */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const fail = (why: string) => Response.redirect(`${url.origin}/login?error=${why}`, 303);
  const jar = await cookies();
  const state = jar.get(G_STATE)?.value ?? '';
  const verifier = jar.get(G_VERIFIER)?.value ?? '';
  jar.set(G_STATE, '', { ...googleCookie, maxAge: 0 });
  jar.set(G_VERIFIER, '', { ...googleCookie, maxAge: 0 });

  if (url.searchParams.get('error')) return fail('google_cancelled');
  const code = url.searchParams.get('code') ?? '';
  const got = url.searchParams.get('state') ?? '';
  if (!code || !state || !verifier || !same(state, got)) return fail('google_failed');

  try {
    const res = await fetch(backendUrl('/v1/auth/google'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, codeVerifier: verifier }), cache: 'no-store',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || typeof data.token !== 'string') return fail(res.status === 401 ? 'google_denied' : 'google_failed');
    jar.set(SESSION_COOKIE, data.token, sessionCookieOptions);
    return Response.redirect(`${url.origin}${data.organizations?.length ? '/dashboard' : '/onboarding'}`, 303);
  } catch {
    return fail('google_failed');
  }
}
