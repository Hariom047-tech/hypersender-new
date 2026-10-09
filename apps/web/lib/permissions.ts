import type { Role } from './types';

/**
 * UI mirror of the backend's role -> scope mapping (src/api/auth/permissions.ts).
 * Used only to hide/disable controls. The backend remains authoritative.
 */
export type Scope = 'instances:read' | 'instances:write' | 'messages:send' | 'messages:read' | 'webhooks:manage' | 'assistants:read' | 'assistants:manage';

const ROLE_SCOPES: Record<Role, Scope[]> = {
  OWNER: ['instances:read', 'instances:write', 'messages:send', 'messages:read', 'webhooks:manage', 'assistants:read', 'assistants:manage'],
  ADMIN: ['instances:read', 'instances:write', 'messages:send', 'messages:read', 'webhooks:manage', 'assistants:read', 'assistants:manage'],
  MANAGER: ['instances:read', 'instances:write', 'messages:send', 'messages:read', 'assistants:read', 'assistants:manage'],
  AGENT: ['instances:read', 'messages:send', 'messages:read', 'assistants:read'],
  VIEWER: ['instances:read', 'messages:read', 'assistants:read'],
};

export type Capability = Scope | 'team:manage' | 'apiKeys:manage' | 'settings:manage' | 'billing:view' | 'usage:view' | 'audit:view';

export function can(role: Role | undefined, cap: Capability): boolean {
  if (!role) return false;
  switch (cap) {
    case 'team:manage':
    case 'apiKeys:manage':
    case 'settings:manage':
    case 'billing:view':
    case 'audit:view':
      return role === 'OWNER' || role === 'ADMIN';
    case 'usage:view':
      return role === 'OWNER' || role === 'ADMIN' || role === 'MANAGER';
    default:
      return ROLE_SCOPES[role].includes(cap);
  }
}
