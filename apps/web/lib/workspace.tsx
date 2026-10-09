'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, setApiOrganization } from './api';
import { t } from './i18n';
import type { Business, Me, Role } from './types';

/**
 * Active organization / business for the dashboard.
 *
 * - The org id is only a SELECTION; the backend re-checks membership on every
 *   request (and RLS enforces it), so a tampered id yields 403/404, never data.
 * - Only ids are remembered (localStorage): no tokens, no tenant data, no QR.
 * - Every tenant cache key starts with ['org', orgId]. Switching org or
 *   business REMOVES those caches and remounts the page tree (keyed by
 *   org+business), so data of the previous tenant can never flash on screen.
 */
export const qk = {
  me: ['me'] as const,
  org: (org: string) => ['org', org] as const,
  businesses: (org: string) => ['org', org, 'businesses'] as const,
  scoped: (org: string, biz: string | null, ...rest: unknown[]) => ['org', org, 'biz', biz ?? 'all', ...rest] as const,
  conversation: (org: string, id: string) => ['org', org, 'conversation', id] as const,
  messages: (org: string, id: string) => ['org', org, 'conversation', id, 'messages'] as const,
  instance: (org: string, id: string) => ['org', org, 'instance', id] as const,
};

interface WorkspaceValue {
  me: Me;
  orgId: string;
  org: Me['organizations'][number];
  role: Role;
  businesses: Business[];
  businessId: string | null;
  business: Business | null;
  switchOrg(id: string): void;
  switchBusiness(id: string | null): void;
}

const Ctx = createContext<WorkspaceValue | null>(null);

function read(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function write(key: string, v: string | null): void {
  try { if (v === null) window.localStorage.removeItem(key); else window.localStorage.setItem(key, v); } catch { /* storage unavailable */ }
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const qc = useQueryClient();
  const me = useQuery({ queryKey: qk.me, queryFn: () => api<Me>('/v1/account/me', { org: null }) });
  const [orgId, setOrgId] = useState<string | null>(null);
  const [businessId, setBusinessId] = useState<string | null>(null);

  // Resolve the selection against the user's REAL memberships.
  useEffect(() => {
    if (!me.data) return;
    if (me.data.organizations.length === 0) { router.replace('/onboarding'); return; }
    const remembered = read('hs.org');
    const chosen = me.data.organizations.find((o) => o.id === (orgId ?? remembered)) ?? me.data.organizations[0];
    if (chosen.id !== orgId) {
      setApiOrganization(chosen.id);
      setOrgId(chosen.id);
      setBusinessId(read(`hs.biz.${chosen.id}`));
    }
  }, [me.data, orgId, router]);

  const businesses = useQuery({
    queryKey: qk.businesses(orgId ?? 'none'),
    queryFn: () => api<Business[]>('/v1/businesses'),
    enabled: Boolean(orgId),
  });

  // Drop a remembered business that no longer exists / is not visible.
  useEffect(() => {
    if (businesses.data && businessId && !businesses.data.some((b) => b.id === businessId)) {
      setBusinessId(null);
      if (orgId) write(`hs.biz.${orgId}`, null);
    }
  }, [businesses.data, businessId, orgId]);

  const switchOrg = useCallback((id: string) => {
    if (id === orgId) return;
    qc.removeQueries({ queryKey: ['org'] }); // no cross-tenant flash
    setApiOrganization(id);
    write('hs.org', id);
    setOrgId(id);
    setBusinessId(read(`hs.biz.${id}`));
    router.push('/dashboard');
  }, [orgId, qc, router]);

  const switchBusiness = useCallback((id: string | null) => {
    if (!orgId || id === businessId) return;
    qc.removeQueries({ queryKey: ['org', orgId, 'biz'] });
    write(`hs.biz.${orgId}`, id);
    setBusinessId(id);
  }, [orgId, businessId, qc]);

  const value = useMemo<WorkspaceValue | null>(() => {
    if (!me.data || !orgId) return null;
    const org = me.data.organizations.find((o) => o.id === orgId);
    if (!org) return null;
    const list = businesses.data ?? [];
    return { me: me.data, orgId, org, role: org.role, businesses: list, businessId, business: list.find((b) => b.id === businessId) ?? null, switchOrg, switchBusiness };
  }, [me.data, orgId, businesses.data, businessId, switchOrg, switchBusiness]);

  if (me.isError) return <FullPageMessage title={t('Could not load your account')} body={t('Please refresh the page or sign in again.')} />;
  if (!value || businesses.isLoading) return <FullPageMessage title={t('Loading workspace…')} />;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWorkspace(): WorkspaceValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useWorkspace must be used inside WorkspaceProvider');
  return v;
}

function FullPageMessage({ title, body }: { title: string; body?: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-6" role="status" aria-live="polite">
      <div className="text-center">
        <p className="text-base font-medium text-slate-900">{title}</p>
        {body && <p className="mt-1 text-sm text-slate-500">{body}</p>}
      </div>
    </div>
  );
}
