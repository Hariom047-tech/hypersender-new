'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Button, EmptyState, ErrorState, InstanceStatus, LoadingSkeleton, MetricCard, PageHeader } from '@/components/ui';
import { api, qs } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { can } from '@/lib/permissions';
import type { Instance } from '@/lib/types';
import { qk, useWorkspace } from '@/lib/workspace';
import { DOCS_URL, SALES_WHATSAPP } from '@/lib/brand';
import { msg, t } from '@/lib/i18n';
import { NavIcon } from '@/components/nav-icons';

interface Summary {
  timezone: string;
  instances: { total: number; connected: number; needsAttention: number };
  conversations: { open: number; unreadMessages: number };
  messagesToday: { received: number; sent: number; total: number };
  contacts: number; failingWebhooks24h: number; bookingsToday: number;
}

const ACTIONS: Array<{ href: string; icon: string; title: string; body: string; tint: string; external?: boolean }> = [
  { href: '/whatsapp/instances?new=1', icon: '/whatsapp', title: msg('Connect WhatsApp'), body: msg('Link a number with a QR scan'), tint: 'from-emerald-100 text-emerald-800' },
  { href: '/campaigns', icon: '/campaigns', title: msg('New campaign'), body: msg('Send an offer to your customers'), tint: 'from-fuchsia-100 text-fuchsia-800' },
  { href: '/ai-assistants', icon: '/ai-assistants', title: msg('AI assistant'), body: msg('Let AI reply to customers 24×7'), tint: 'from-cyan-100 text-cyan-800' },
  { href: '/developers/api-keys', icon: '/developers/api-keys', title: msg('API keys'), body: msg('Send messages from your app'), tint: 'from-amber-100 text-amber-800' },
  { href: DOCS_URL, icon: '/settings/audit-log', title: msg('API documentation'), body: msg('Every endpoint, try it live'), tint: 'from-sky-100 text-sky-800', external: true },
  { href: `https://wa.me/${SALES_WHATSAPP}`, icon: '/inbox', title: msg('Contact support'), body: msg('Real people on WhatsApp'), tint: 'from-rose-100 text-rose-800', external: true },
];

function QuickActions() {
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-500">{t("Quick actions")}</h2>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {ACTIONS.map((a) => (
          <a key={a.title} href={a.href} {...(a.external ? { target: '_blank', rel: 'noreferrer' } : {})}
            className="group flex items-center gap-4 rounded-xl bg-white p-4 ring-1 ring-slate-200 transition hover:-translate-y-0.5 hover:ring-emerald-300">
            <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-gradient-to-br to-transparent ${a.tint}`}>
              <NavIcon href={a.icon} className="h-5 w-5" />
            </span>
            <span className="min-w-0">
              <span className="block font-semibold text-slate-900">{t(a.title)}</span>
              <span className="block truncate text-sm text-slate-500">{t(a.body)}</span>
            </span>
            <span className="ml-auto text-slate-400 transition group-hover:translate-x-0.5 group-hover:text-emerald-800" aria-hidden>→</span>
          </a>
        ))}
      </div>
    </section>
  );
}

export default function DashboardPage() {
  const { orgId, businessId, business, role } = useWorkspace();
  const summary = useQuery({ queryKey: qk.scoped(orgId, businessId, 'dashboard'), queryFn: () => api<Summary>(`/v1/dashboard/summary${qs({ businessId })}`), refetchInterval: 60_000 });
  const instances = useQuery({ queryKey: qk.scoped(orgId, businessId, 'instances'), queryFn: () => api<Instance[]>('/v1/whatsapp/instances') });
  const list = (instances.data ?? []).filter((i) => !businessId || i.businessId === businessId);
  const s = summary.data;

  return (
    <>
      <PageHeader title={t("Dashboard")} description={business ? business.name : t("All businesses")} />
      <QuickActions />
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-500">{t("Account overview")}</h2>
      {summary.isError ? <ErrorState error={summary.error} onRetry={() => summary.refetch()} /> : !s ? <LoadingSkeleton rows={2} /> : (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <MetricCard label={t("WhatsApp connected")} value={`${s.instances.connected} / ${s.instances.total}`}
            tone={s.instances.total > 0 && s.instances.connected === 0 ? 'bad' : undefined} hint={s.instances.needsAttention ? t("{needsAttention} need attention", { needsAttention: s.instances.needsAttention }) : undefined} />
          <MetricCard label={t("Open conversations")} value={s.conversations.open} />
          <MetricCard label={t("Unread messages")} value={s.conversations.unreadMessages} tone={s.conversations.unreadMessages > 0 ? 'warn' : undefined} />
          <MetricCard label={t("Messages today")} value={s.messagesToday.total} hint={t("{received} received · {sent} sent ({timezone})", { received: s.messagesToday.received, sent: s.messagesToday.sent, timezone: s.timezone })} />
          <MetricCard label={t("Contacts")} value={s.contacts} />
          <MetricCard label={t("Failing webhooks (24h)")} value={s.failingWebhooks24h} tone={s.failingWebhooks24h > 0 ? 'bad' : undefined} />
          <MetricCard label={t("Bookings today")} value={s.bookingsToday} />
        </div>
      )}

      <section className="mt-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500">{t("WhatsApp")}</h2>
          <Link href="/whatsapp/instances" className="text-sm font-medium text-emerald-800 hover:underline">{t("Manage")} →</Link>
        </div>
        {instances.isLoading ? <LoadingSkeleton rows={2} /> : list.length === 0 ? (
          <EmptyState title={t("No WhatsApp connected yet.")} body={t("Connect your business WhatsApp to start receiving customer messages here.")}
            action={can(role, 'instances:write') ? <Link href="/whatsapp/instances?new=1"><Button>{t("Connect WhatsApp")}</Button></Link> : undefined} />
        ) : (
          <ul className="divide-y divide-slate-200 overflow-hidden rounded-xl bg-white ring-1 ring-slate-200">
            {list.map((i) => (
              <li key={i.id}>
                <Link href={`/whatsapp/instances/${i.id}`} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-slate-50">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-900">{i.name}</p>
                    <p className="text-xs text-slate-500">{i.phoneNumber ?? t("No number linked")} {t("· last seen")}{' '}{timeAgo(i.lastSeenAt)}</p>
                  </div>
                  <InstanceStatus status={i.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
