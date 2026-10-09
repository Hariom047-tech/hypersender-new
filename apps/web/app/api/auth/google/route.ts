import { createHash, randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { backendUrl } from '@/lib/server/backend';
import { G_STATE, G_VERIFIER, googleCookie } from '@/lib/server/google';

export const dynamic = 'force-dynamic';


/**
 * "Continue with Google", step 1: a random state (CSRF) and a PKCE verifier are
 * kept in short-lived HttpOnly cookies, then the browser goes to Google.
 */
export async function GET(req: Request): Promise<Response> {
  const origin = new URL(req.url).origin;
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  try {
    const res = await fetch(backendUrl('/v1/auth/google/authorize-url'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state, codeChallenge: challenge }), cache: 'no-store',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || typeof data.url !== 'string') return Response.redirect(`${origin}/login?error=google_unavailable`, 303);
    const jar = await cookies();
    jar.set(G_STATE, state, googleCookie);
    jar.set(G_VERIFIER, verifier, googleCookie);
    return Response.redirect(data.url, 303);
  } catch {
    return Response.redirect(`${origin}/login?error=google_unavailable`, 303);
  }
}
