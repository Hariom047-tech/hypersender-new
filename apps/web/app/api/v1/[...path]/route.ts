import { randomUUID } from 'node:crypto';
import { cookies } from 'next/headers';
import { backendUrl, csrfOk, jsonError, SESSION_COOKIE } from '@/lib/server/backend';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const FORWARD_REQ = ['content-type', 'accept', 'x-organization-id'];
const FORWARD_RES = ['content-type', 'content-disposition', 'cache-control', 'x-content-type-options', 'content-security-policy'];

/**
 * Backend-for-frontend proxy: /api/v1/<path> -> HS_API_URL/v1/<path>.
 *  - attaches the session from the HttpOnly cookie (JS never sees it);
 *  - CSRF check on mutating methods;
 *  - /v1/auth/* is NOT proxied (tokens must never reach the browser);
 *  - streams the response body (Server-Sent Events, media downloads);
 *  - never forwards Set-Cookie from the backend.
 * Tenant authorisation stays in the backend (membership + RLS).
 */
async function proxy(req: Request, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await ctx.params;
  if (path[0] === 'auth') return jsonError(404, 'NOT_FOUND', 'not found');
  if (!csrfOk(req)) return jsonError(403, 'FORBIDDEN', 'invalid request origin');
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const isMediaDownload = path[0] === 'media' && path[1] === 'download';
  if (!token && !isMediaDownload) return jsonError(401, 'UNAUTHENTICATED', 'please sign in');

  const url = new URL(req.url);
  const headers = new Headers();
  for (const h of FORWARD_REQ) { const v = req.headers.get(h); if (v) headers.set(h, v); }
  if (token) headers.set('authorization', `Bearer ${token}`);
  headers.set('x-request-id', req.headers.get('x-request-id') ?? randomUUID());

  let upstream: Response;
  try {
    upstream = await fetch(backendUrl(`/v1/${path.map(encodeURIComponent).join('/')}${url.search}`), {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer(),
      cache: 'no-store',
      signal: req.signal,
      redirect: 'manual',
    });
  } catch {
    // Browser went away (navigation / closed SSE) or the API is unreachable. Never echo internals.
    if (req.signal.aborted) return new Response(null, { status: 499 });
    return jsonError(502, 'UPSTREAM_UNAVAILABLE', 'The service is temporarily unavailable. Please try again.');
  }
  const out = new Headers();
  for (const h of FORWARD_RES) { const v = upstream.headers.get(h); if (v) out.set(h, v); }
  if (out.get('content-type')?.startsWith('text/event-stream')) {
    out.set('cache-control', 'no-cache, no-transform');
    out.set('x-accel-buffering', 'no');
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export { proxy as GET, proxy as POST, proxy as PATCH, proxy as DELETE, proxy as PUT };
