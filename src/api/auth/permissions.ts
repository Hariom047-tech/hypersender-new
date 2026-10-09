import type { MemberRole, TenantContext } from '../../database/tenant-context.js';
import { WhatsAppError } from '../../whatsapp/domain/whatsapp-errors.js';

export type Scope = 'instances:read' | 'instances:write' | 'messages:send' | 'messages:read' | 'webhooks:manage' | 'assistants:read' | 'assistants:manage';

/** Dashboard roles -> equivalent scopes. API keys carry explicit scopes instead. */
const ROLE_SCOPES: Record<MemberRole, ReadonlySet<Scope>> = {
  OWNER:   new Set(['instances:read', 'instances:write', 'messages:send', 'messages:read', 'webhooks:manage', 'assistants:read', 'assistants:manage']),
  ADMIN:   new Set(['instances:read', 'instances:write', 'messages:send', 'messages:read', 'webhooks:manage', 'assistants:read', 'assistants:manage']),
  MANAGER: new Set(['instances:read', 'instances:write', 'messages:send', 'messages:read', 'assistants:read', 'assistants:manage']),
  AGENT:   new Set(['instances:read', 'messages:send', 'messages:read', 'assistants:read']),
  VIEWER:  new Set(['instances:read', 'messages:read', 'assistants:read']),
};

/**
 * Authorisation check shared by both principals. Tenant isolation itself is
 * enforced by RLS regardless of this check; this decides WHAT a valid
 * principal may do inside its own tenant.
 */
export function requireScope(ctx: TenantContext, scope: Scope): void {
  if (ctx.apiKeyId) {
    if (!ctx.apiScopes?.includes(scope)) throw new WhatsAppError('FORBIDDEN', `API key lacks scope ${scope}`);
    return;
  }
  if (!ctx.role || !ROLE_SCOPES[ctx.role].has(scope)) throw new WhatsAppError('FORBIDDEN', `role lacks permission ${scope}`);
}

export function requireUser(ctx: TenantContext, roles: MemberRole[]): void {
  if (!ctx.userId || !ctx.role || !roles.includes(ctx.role)) throw new WhatsAppError('FORBIDDEN', 'requires a dashboard user with sufficient role');
}

/** API keys restricted to one business may only touch that business's instances. */
export function assertBusinessScope(ctx: TenantContext, businessId: string): void {
  // (instance keys also carry their instance's business, so this check covers them too)
  if (ctx.businessId && ctx.businessId !== businessId) throw new WhatsAppError('WHATSAPP_INSTANCE_NOT_FOUND');
}

/** Instance API keys may only touch their own instance (same error as "does not exist": no enumeration). */
export function assertInstanceScope(ctx: TenantContext, instanceId: string): void {
  if (ctx.instanceId && ctx.instanceId !== instanceId) throw new WhatsAppError('WHATSAPP_INSTANCE_NOT_FOUND');
}
