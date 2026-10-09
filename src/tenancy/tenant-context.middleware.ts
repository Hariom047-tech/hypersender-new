import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import { isUuid } from '../common/uuid.js';
import { runWithTenant, type TenantContext } from '../database/tenant-context.js';
import { APP_TX, TransactionRunner } from '../database/transaction-runner.js';
import { IdentityRepository } from '../repositories/identity.repository.js';
import { looksLikeApiKey } from '../security/api-key-crypto.js';
import { ApiKeyService } from '../services/api-key.service.js';

/** Routes an instance API key may call (its own instance is checked by the controllers). */
export function isInstanceApiPath(url: string): boolean {
  return /^\/api\/(whatsapp|otp)\/v1\//.test(url);
}

/** Verifies a session/JWT and returns the user id (implementation lives in the auth module). */
export interface SessionVerifier {
  verify(bearerToken: string): Promise<{ userId: string } | null>;
}
export const SESSION_VERIFIER = Symbol('SESSION_VERIFIER');

interface Req { headers: Record<string, string | string[] | undefined>; id?: string; tenant?: TenantContext; originalUrl?: string; url?: string }
interface Res { status(code: number): Res; json(body: unknown): void }

function header(req: Req, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Resolves WHO is calling and FOR WHICH TENANT, then runs the rest of the
 * request inside AsyncLocalStorage so every TransactionRunner.inTenant() call
 * picks the context up automatically.
 *
 *  API key  (X-Api-Key)     -> organization is taken from the key itself; any
 *                              X-Organization-Id header is ignored. Also accepted
 *                              as "Authorization: Bearer hs_live_..." (gateway
 *                              style). Instance keys only reach /api/{whatsapp,otp}/v1.
 *  User     (Bearer token)  -> organization comes from X-Organization-Id and is
 *                              accepted only if the user has an ACTIVE membership.
 *
 * Defence in depth: even if this middleware were bypassed or buggy, RLS on
 * hs_app re-validates membership / key liveness on every statement
 * (app.tenant_context_valid()), so a forged organization id yields no rows.
 */
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  constructor(
    @Inject(APP_TX) private readonly tx: TransactionRunner,
    @Inject(IdentityRepository) private readonly identity: IdentityRepository,
    @Inject(ApiKeyService) private readonly apiKeys: ApiKeyService,
    @Inject(SESSION_VERIFIER) private readonly sessions: SessionVerifier,
  ) {}

  async use(req: Req, res: Res, next: (err?: unknown) => void): Promise<void> {
    try {
      const ctx = await this.resolve(req);
      if (!ctx) {
        res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'valid session token or API key required' } });
        return;
      }
      if (ctx !== 'forbidden' && ctx.instanceId && !isInstanceApiPath(req.originalUrl ?? req.url ?? '')) {
        // An instance key is a narrow credential pasted into other products: it never reaches the dashboard API.
        res.status(403).json({ error: { code: 'FORBIDDEN', message: 'instance API keys can only call the instance and OTP API of their instance' } });
        return;
      }
      if (ctx === 'forbidden') {
        // Same response for "org does not exist" and "not a member": no tenant enumeration.
        res.status(403).json({ error: { code: 'FORBIDDEN', message: 'not a member of this organization' } });
        return;
      }
      req.tenant = ctx;
      runWithTenant(ctx, () => next());
    } catch (err) {
      next(err);
    }
  }

  private async resolve(req: Req): Promise<TenantContext | 'forbidden' | null> {
    const requestId = req.id ?? header(req, 'x-request-id');
    const auth = header(req, 'authorization');
    // Gateway-style clients send the API key as a bearer token; session tokens never have the hs_ key shape.
    const bearer = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : undefined;
    const apiKey = header(req, 'x-api-key') ?? (bearer && looksLikeApiKey(bearer) ? bearer : undefined);
    if (apiKey) {
      const ctx = await this.apiKeys.authenticate(apiKey);
      return ctx ? { ...ctx, requestId } : null;
    }

    if (!bearer) return null;
    const session = await this.sessions.verify(bearer);
    if (!session) return null;

    const organizationId = header(req, 'x-organization-id');
    if (!isUuid(organizationId)) return 'forbidden';
    const membership = await this.tx.run({ userId: session.userId },
      (db) => this.identity.findActiveMembership(db, organizationId, session.userId));
    if (!membership) return 'forbidden';
    return { organizationId, userId: session.userId, role: membership.role, requestId };
  }
}
