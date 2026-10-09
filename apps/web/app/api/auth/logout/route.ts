import { cookies } from 'next/headers';
import { csrfOk, jsonError, SESSION_COOKIE } from '@/lib/server/backend';

export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  if (!csrfOk(req)) return jsonError(403, 'FORBIDDEN', 'invalid request origin');
  (await cookies()).delete(SESSION_COOKIE);
  return Response.json({ ok: true });
}
