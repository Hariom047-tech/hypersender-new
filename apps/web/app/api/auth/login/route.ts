import { cookies } from 'next/headers';
import { backendUrl, csrfOk, jsonError, SESSION_COOKIE, sessionCookieOptions } from '@/lib/server/backend';

export const dynamic = 'force-dynamic';

/** Exchanges credentials for a session. The token goes ONLY into an HttpOnly cookie. */
export async function POST(req: Request): Promise<Response> {
  if (!csrfOk(req)) return jsonError(403, 'FORBIDDEN', 'invalid request origin');
  const body = await req.text();
  const res = await fetch(backendUrl('/v1/auth/login'), { method: 'POST', headers: { 'content-type': 'application/json' }, body, cache: 'no-store' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return Response.json(data, { status: res.status });
  (await cookies()).set(SESSION_COOKIE, data.token, sessionCookieOptions);
  return Response.json({ userId: data.userId, organizations: data.organizations });
}
