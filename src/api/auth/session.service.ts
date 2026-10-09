import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { isUuid } from '../../common/uuid.js';
import type { SessionVerifier } from '../../tenancy/tenant-context.middleware.js';

/**
 * Dashboard (SaaS user) session tokens: "hs1.<base64url(JSON {sub, exp})>.<base64url(HMAC-SHA256)>".
 * Deliberately separate from API keys (machine access with scopes).
 * A token only proves WHO the user is; WHICH organization they may act for is
 * decided per request by membership (middleware + RLS), never by the token.
 * Production may replace this with an IdP (OIDC) behind the same SessionVerifier port.
 */
@Injectable()
export class HmacSessionService implements SessionVerifier {
  private readonly secret: Buffer;
  private readonly ttlSeconds: number;

  constructor() {
    const s = process.env.SESSION_SECRET;
    if (!s || s.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
    this.secret = Buffer.from(s, 'utf8');
    this.ttlSeconds = Number(process.env.SESSION_TTL_SECONDS ?? 12 * 3600);
  }

  issue(userId: string, now = Date.now()): string {
    const body = Buffer.from(JSON.stringify({ sub: userId, exp: Math.floor(now / 1000) + this.ttlSeconds }), 'utf8').toString('base64url');
    const sig = createHmac('sha256', this.secret).update(`hs1.${body}`).digest('base64url');
    return `hs1.${body}.${sig}`;
  }

  async verify(token: string): Promise<{ userId: string } | null> {
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'hs1') return null;
    const expected = createHmac('sha256', this.secret).update(`hs1.${parts[1]}`).digest();
    const given = Buffer.from(parts[2], 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    try {
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { sub?: unknown; exp?: unknown };
      if (!isUuid(claims.sub) || typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) return null;
      return { userId: claims.sub };
    } catch {
      return null;
    }
  }
}
