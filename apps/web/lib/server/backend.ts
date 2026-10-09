import 'server-only';

/** Server-only BFF helpers. Nothing here is ever bundled for the browser. */
export const SESSION_COOKIE = 'hs_session';
export const SESSION_MAX_AGE = 12 * 3600;

export function backendUrl(path: string): string {
  const base = (process.env.HS_API_URL ?? 'http://localhost:3100').replace(/\/$/, '');
  return `${base}${path}`;
}

export const sessionCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
  maxAge: SESSION_MAX_AGE,
};

/**
 * CSRF defence for state-changing requests: the session cookie is SameSite=Lax
 * AND every mutating request must (a) come from our own origin (Origin header)
 * and (b) carry the custom `x-hs-csrf` header, which cross-site forms cannot set.
 */
export function csrfOk(req: Request): boolean {
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  if (req.headers.get('x-hs-csrf') !== '1') return false;
  const origin = req.headers.get('origin');
  if (!origin) return false;
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}
