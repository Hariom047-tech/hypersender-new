'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BRAND, SALES_WHATSAPP } from '@/lib/brand';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { can, type Capability } from '@/lib/permissions';
import { RealtimeProvider, useRealtimeState } from '@/lib/realtime';
import { WorkspaceProvider, useWorkspace } from '@/lib/workspace';
import { NavIcon } from './nav-icons';
import { cx, Select } from './ui';
import { LanguageSwitch, msg, t } from '@/lib/i18n';

interface NavItem { href: string; label: string; cap?: Capability; soon?: boolean }
const NAV: Array<{ section?: string; items: NavItem[] }> = [
  { items: [{ href: '/dashboard', label: msg("Dashboard") }, { href: '/inbox', label: msg("Inbox"), cap: 'messages:read' }, { href: '/contacts', label: msg("Contacts"), cap: 'messages:read' }] },
  { section: 'WhatsApp', items: [{ href: '/whatsapp/instances', label: msg("Instances"), cap: 'instances:read' }] },
  { section: msg('Marketing'), items: [{ href: '/campaigns', label: msg("Campaigns"), cap: 'messages:read' }] },
  { section: msg('Automation'), items: [{ href: '/ai-assistants', label: msg("AI Assistants"), cap: 'assistants:read' }] },
  { section: msg('Developers'), items: [{ href: '/developers/api-keys', label: msg("API Keys"), cap: 'apiKeys:manage' }, { href: '/developers/webhooks', label: msg("Webhooks"), cap: 'webhooks:manage' },
    { href: '/developers/webhook-logs', label: msg("Webhook Logs"), cap: 'webhooks:manage' }] },
  { section: msg('Billing'), items: [{ href: '/subscriptions', label: msg("Subscriptions"), cap: 'billing:view' }, { href: '/transactions', label: msg("Transactions"), cap: 'billing:view' },
    { href: '/billing', label: msg("Plan & limits"), cap: 'billing:view' }, { href: '/usage', label: msg("Usage"), cap: 'usage:view' }] },
  { section: msg('Workspace'), items: [{ href: '/team', label: msg("Team") }] },
  { section: msg('Settings'), items: [{ href: '/settings/business', label: msg("Business") }, { href: '/settings/organization', label: msg("Organization") }, { href: '/settings/audit-log', label: msg("Audit log"), cap: 'audit:view' }] },
];

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <WorkspaceProvider>
      <RealtimeProvider>
        <Frame>{children}</Frame>
      </RealtimeProvider>
    </WorkspaceProvider>
  );
}

function Frame({ children }: { children: ReactNode }) {
  const { orgId, businessId, role } = useWorkspace();
  const [menuOpen, setMenuOpen] = useState(false);
  const pathname = usePathname();
  useEffect(() => setMenuOpen(false), [pathname]);

  // Colours below read "inverted" inside .app-dark (see app/theme-dark.css): slate-900 = near white, slate-50 = dark panel.
  const nav = (
    <nav aria-label={t("Main")} className="space-y-6 px-3 pb-6">
      {NAV.map((g, i) => {
        const items = g.items.filter((it) => it.soon || !it.cap || can(role, it.cap));
        if (!items.length) return null;
        return (
          <div key={i}>
            {g.section && <p className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">{t(g.section)}</p>}
            <ul className="space-y-1">
              {items.map((it) => {
                const active = pathname.startsWith(it.href);
                return (
                  <li key={it.label}>
                    {it.soon ? (
                      <span className="flex items-center justify-between rounded-lg px-3 py-2 text-sm text-slate-500" aria-disabled="true">
                        {t(it.label)}<span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">{t("Soon")}</span>
                      </span>
                    ) : (
                      <Link href={it.href} aria-current={active ? 'page' : undefined}
                        className={cx('group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition', active
                          ? 'bg-gradient-to-r from-emerald-100 to-cyan-50 font-semibold text-slate-950 ring-1 ring-inset ring-emerald-200'
                          : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900')}>
                        {active && <span className="absolute inset-y-2 left-0 w-1 rounded-r-full bg-gradient-to-b from-emerald-400 to-cyan-400" aria-hidden />}
                        <NavIcon href={it.href} className={cx('h-5 w-5 shrink-0', active ? 'text-emerald-800' : 'text-slate-400 group-hover:text-slate-700')} />
                        <span className="truncate">{t(it.label)}</span>
                      </Link>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
  const logo = (
    <Link href="/dashboard" className="flex items-center gap-2.5 px-5 py-5" aria-label={BRAND}>
      <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-emerald-400 to-cyan-500 text-[#04110c] shadow-lg shadow-emerald-500/30">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="h-5 w-5" aria-hidden><path d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" /></svg>
      </span>
      <span className="text-lg font-bold tracking-tight text-slate-950">{BRAND}</span>
    </Link>
  );

  return (
    <div className="app-dark flex min-h-screen bg-[#060a14] text-slate-900">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:p-2">{t("Skip to content")}</a>
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 overflow-y-auto border-r border-slate-200/60 bg-[#080d1a] lg:block">
        {logo}
        {nav}
      </aside>
      {menuOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label={t("Menu")}>
          <div className="absolute inset-0 bg-[#02050d]/70 backdrop-blur-sm" onClick={() => setMenuOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 overflow-y-auto border-r border-slate-200/60 bg-[#080d1a]">
            {logo}
            {nav}
          </aside>
        </div>
      )}
      <div className="relative flex min-w-0 flex-1 flex-col">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-[radial-gradient(ellipse_at_top,rgba(16,185,129,0.10),transparent_65%)]" aria-hidden />
        <TopBar onMenu={() => setMenuOpen(true)} />
        {/* Remount the page tree per tenant+business: no stale state from the previous selection. */}
        <main id="main" key={`${orgId}:${businessId ?? 'all'}`} className="relative flex-1 px-4 py-6 sm:px-6 lg:px-10 lg:py-8">{children}</main>
      </div>
    </div>
  );
}

function TopBar({ onMenu }: { onMenu: () => void }) {
  const { me, orgId, switchOrg, businesses, businessId, switchBusiness } = useWorkspace();
  const live = useRealtimeState();
  const router = useRouter();
  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST', headers: { 'x-hs-csrf': '1' } });
    try { localStorage.removeItem('hs.org'); } catch { /* ignore */ }
    router.replace('/login');
  };
  const who = me.user.firstName ?? me.user.email;
  const initials = (me.user.firstName ? `${me.user.firstName[0] ?? ''}${me.user.lastName?.[0] ?? ''}` : me.user.email.slice(0, 2)).toUpperCase();
  return (
    <header className="sticky top-0 z-30 flex flex-wrap items-center gap-2 border-b border-slate-200/60 bg-[#060a14]/80 px-4 py-2.5 backdrop-blur-xl sm:px-6 lg:px-10">
      <button className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 lg:hidden" onClick={onMenu} aria-label={t("Open menu")}>☰</button>
      <label className="sr-only" htmlFor="org-switch">{t("Organization")}</label>
      <Select id="org-switch" className="w-auto max-w-[12rem]" value={orgId} onChange={(e) => switchOrg(e.target.value)} aria-label={t("Organization")}>
        {me.organizations.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </Select>
      {businesses.length > 1 && (
        <Select className="w-auto max-w-[12rem]" value={businessId ?? ''} onChange={(e) => switchBusiness(e.target.value || null)} aria-label={t("Business")}>
          <option value="">{t("All businesses")}</option>
          {businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </Select>
      )}
      <a href={`https://wa.me/${SALES_WHATSAPP}`} target="_blank" rel="noreferrer"
        className="hidden items-center gap-1.5 rounded-lg bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-800 ring-1 ring-inset ring-emerald-200 hover:bg-emerald-100 md:inline-flex">
        💬 {t("Help on WhatsApp")}
      </a>
      <div className="ml-auto flex items-center gap-2 sm:gap-3">
        <span className="hidden items-center gap-1.5 rounded-full bg-slate-50 px-2.5 py-1 text-xs text-slate-600 ring-1 ring-inset ring-slate-200 sm:flex" role="status" aria-live="polite">
          <span className={cx('h-2 w-2 rounded-full', live === 'live' ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.8)]' : live === 'offline' ? 'bg-red-500' : 'bg-amber-400')} aria-hidden />
          {live === 'live' ? t("Live") : live === 'offline' ? t("Offline") : t("Connecting…")}
        </span>
        <LanguageSwitch />
        <NotificationsBell />
        <span className="grid h-9 w-9 place-items-center rounded-full bg-gradient-to-br from-emerald-400 to-cyan-500 text-xs font-bold text-[#04110c]" title={who}>{initials}</span>
        <button onClick={logout} className="rounded-lg px-2 py-1.5 text-sm text-slate-600 hover:bg-slate-100 hover:text-slate-900">{t("Sign out")}</button>
      </div>
    </header>
  );
}

interface NotificationRow { id: string; type: string; title: string; body: string | null; instanceId: string | null; webhookEndpointId: string | null; readAt: string | null; createdAt: string }

function NotificationsBell() {
  const { orgId } = useWorkspace();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const q = useQuery({ queryKey: ['org', orgId, 'notifications'], queryFn: () => api<{ items: NotificationRow[]; unread: number }>('/v1/notifications'), refetchInterval: 120_000 });
  const readAll = useMutation({ mutationFn: () => api('/v1/notifications/read-all', { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['org', orgId, 'notifications'] }) });
  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);
  const unread = q.data?.unread ?? 0;
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="true"
        aria-label={unread ? t('Notifications, {n} unread', { n: unread }) : t('Notifications')} className="relative rounded-md p-2 text-slate-600 hover:bg-slate-100">
        <span aria-hidden>🔔</span>
        {unread > 0 && <span className="absolute -right-0.5 -top-0.5 rounded-full bg-red-600 px-1.5 text-[10px] font-semibold text-white">{unread}</span>}
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-80 rounded-lg bg-white shadow-lg ring-1 ring-slate-200">
          <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
            <p className="text-sm font-semibold">{t("Notifications")}</p>
            {unread > 0 && <button className="text-xs text-emerald-800 underline" onClick={() => readAll.mutate()}>{t("Mark all read")}</button>}
          </div>
          <ul className="max-h-96 overflow-y-auto">
            {!q.data?.items.length && <li className="px-3 py-6 text-center text-sm text-slate-500">{t("You’re all caught up.")}</li>}
            {q.data?.items.map((n) => (
              <li key={n.id} className={cx('border-b border-slate-50 px-3 py-2', !n.readAt && 'bg-emerald-50/40')}>
                <Link href={n.instanceId ? `/whatsapp/instances/${n.instanceId}` : n.webhookEndpointId ? `/developers/webhooks/${n.webhookEndpointId}` : '#'} className="block" onClick={() => setOpen(false)}>
                  <p className="text-sm font-medium text-slate-900">{t(n.title)}</p>
                  {n.body && <p className="text-xs text-slate-600">{t(n.body)}</p>}
                  <p className="mt-0.5 text-[11px] text-slate-400">{timeAgo(n.createdAt)}</p>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
