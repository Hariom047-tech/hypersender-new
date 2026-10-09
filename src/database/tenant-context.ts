import { AsyncLocalStorage } from 'node:async_hooks';

export type MemberRole = 'OWNER' | 'ADMIN' | 'MANAGER' | 'AGENT' | 'VIEWER';

/**
 * Who is acting, on behalf of which tenant. Populated by
 * TenantContextMiddleware (HTTP) or by a worker from the job's
 * organization_id. Carried with AsyncLocalStorage so repositories never take
 * the tenant id from request input.
 */
export interface TenantContext {
  organizationId: string;
  userId?: string;
  apiKeyId?: string;
  role?: MemberRole;
  apiScopes?: string[];
  businessId?: string; // API keys may be restricted to one business
  instanceId?: string; // instance API keys are bound to one WhatsApp instance (instance + OTP API only)
  requestId?: string;
}

/** Database session context. organizationId may be absent for pre-tenant calls. */
export interface DbContext {
  organizationId?: string;
  userId?: string;
  apiKeyId?: string;
}

const storage = new AsyncLocalStorage<TenantContext>();

export function runWithTenant<T>(ctx: TenantContext, fn: () => T): T {
  return storage.run(Object.freeze({ ...ctx }), fn);
}

export function currentTenant(): TenantContext {
  const ctx = storage.getStore();
  if (!ctx) throw new Error('No tenant context: this code path must run inside an authenticated request or tenant job');
  return ctx;
}

export function maybeCurrentTenant(): TenantContext | undefined {
  return storage.getStore();
}
