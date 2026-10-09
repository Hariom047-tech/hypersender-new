'use client';

import { useQuery } from '@tanstack/react-query';
import { useDeferredValue, useState } from 'react';
import { BillingHeader, PaymentMethod, SearchInput, SubscriptionStatus } from '@/components/billing/common';
import { EmptyState, ErrorState, LoadingSkeleton, Notice, StatusBadge, cx } from '@/components/ui';
import { Copy } from '@/components/whatsapp/instance-api';
import { api } from '@/lib/api';
import { BRAND, SALES_WHATSAPP } from '@/lib/brand';
import { dateTime, money } from '@/lib/format';
import { can } from '@/lib/permissions';
import { useWorkspace } from '@/lib/workspace';
import { msg, t } from '@/lib/i18n';

type Group = 'ACTIVE' | 'PENDING' | 'INACTIVE';
interface Subscription {
  id: string; service: string; tier: string; planCode: string; status: string; instances: { used: number | null; limit: number | null };
  paymentMethod: string | null; priceMinorUnits: number; currency: string; interval: string; subscribedAt: string; endsAt: string; trialEnd: string | null;
  cancelAtPeriodEnd: boolean;
}
interface Resp { counts: { active: number; pending: number; inactive: number }; items: Subscription[] }

const GROUPS: Array<{ id: Group; label: string; key: keyof Resp['counts']; tone: string }> = [
  { id: 'ACTIVE', label: msg('Active'), key: 'active', tone: 'text-emerald-700 ring-emerald-300' },
  { id: 'PENDING', label: msg('Pending'), key: 'pending', tone: 'text-amber-700 ring-amber-300' },
  { id: 'INACTIVE', label: msg('Inactive'), key: 'inactive', tone: 'text-slate-600 ring-slate-300' },
];

export default function SubscriptionsPage() {
  const { orgId, role } = useWorkspace();
  const [group, setGroup] = useState<Group>('ACTIVE');
  const [search, setSearch] = useState('');
  const q = useDeferredValue(search.trim());
  const allowed = can(role, 'billing:view');
  const r = useQuery({ queryKey: ['org', orgId, 'billing', 'subscriptions', group, q], enabled: allowed, placeholderData: (p) => p,
    queryFn: () => api<Resp>(`/v1/billing/subscriptions?group=${group}${q ? `&q=${encodeURIComponent(q)}` : ''}`) });
  const order = `https://wa.me/${SALES_WHATSAPP}?text=${encodeURIComponent(t("Hi, I want to upgrade my {brand} plan.", { brand: BRAND }))}`;

  if (!allowed) return <><BillingHeader crumb={t("Subscriptions")} title={t("Subscriptions")} /><Notice>{t("Only owners and admins can view billing.")}</Notice></>;
  return (
    <>
      <BillingHeader crumb={t("List")} title={t("Subscriptions")} actions={
        <a href={order} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800">
          <span aria-hidden>⊕</span>{t("Order New Service")}</a>} />

      <div className="mb-6 flex justify-center">
        <div role="tablist" aria-label={t("Subscription status")} className="inline-flex gap-1 rounded-xl bg-white p-1.5 shadow-sm ring-1 ring-slate-200">
          {GROUPS.map((g) => (
            <button key={g.id} role="tab" aria-selected={group === g.id} onClick={() => setGroup(g.id)}
              className={cx('flex items-center gap-2 rounded-lg px-4 py-1.5 text-sm font-medium', group === g.id ? 'bg-emerald-50 text-emerald-800' : 'text-slate-600 hover:bg-slate-50')}>
              {t(g.label)}<span className={cx('rounded px-1.5 text-xs font-semibold ring-1 ring-inset', g.tone)}>{r.data?.counts[g.key] ?? '–'}</span>
            </button>
          ))}
        </div>
      </div>

      {r.isError ? <ErrorState error={r.error} onRetry={() => r.refetch()} /> : (
        <div className="overflow-x-auto rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
          <table className="min-w-full text-sm">
            <caption className="sr-only">{t("Subscriptions")}</caption>
            <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-600">
              <tr>{[t("UUID"), t("Service"), t("Tier"), t("Instances"), t("Status"), t("Payment Method"), t("Price"), t("Currency"), t("Subscribed At"), t("Ends At")]
                .map((h) => <th key={h} scope="col" className="whitespace-nowrap px-4 py-3">{h}</th>)}</tr>
              <tr className="border-t border-slate-200 bg-white"><th colSpan={10} className="px-4 py-2 font-normal normal-case"><div className="max-w-sm"><SearchInput value={search} onChange={setSearch} label={t("Search subscriptions")} /></div></th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {!r.data ? <tr><td colSpan={10} className="p-4"><LoadingSkeleton rows={2} /></td></tr>
                : !r.data.items.length ? <tr><td colSpan={10} className="p-4"><EmptyState title={t("No subscriptions here")} body={group === 'ACTIVE' ? t("Order a plan to start using WhatsApp numbers.") : undefined} /></td></tr>
                : r.data.items.map((s) => (
                  <tr key={s.id} className="whitespace-nowrap">
                    <td className="px-4 py-3"><span className="flex items-center gap-2"><Copy value={s.id} icon label={t("Copy subscription ID")} /><code className="text-xs text-slate-900">{s.id}</code></span></td>
                    <td className="px-4 py-3"><StatusBadge tone="green">{t("WhatsApp")}</StatusBadge></td>
                    <td className="px-4 py-3"><StatusBadge tone="green">{s.tier}</StatusBadge></td>
                    <td className="px-4 py-3"><StatusBadge tone={s.instances.limit !== null && (s.instances.used ?? 0) >= s.instances.limit ? 'red' : 'slate'}>
                      {s.instances.used ?? '–'} / {s.instances.limit ?? '∞'}</StatusBadge></td>
                    <td className="px-4 py-3"><SubscriptionStatus status={s.status} />{s.cancelAtPeriodEnd && <span className="ml-1 text-xs text-amber-700">{t("ends at period end")}</span>}</td>
                    <td className="px-4 py-3"><PaymentMethod method={s.paymentMethod} /></td>
                    <td className="px-4 py-3 font-medium">{money(s.priceMinorUnits, s.currency)}<span className="text-xs text-slate-500"> / {s.interval === 'YEAR' ? t("year") : t("month")}</span></td>
                    <td className="px-4 py-3">{s.currency}</td>
                    <td className="px-4 py-3">{dateTime(s.subscribedAt)}</td>
                    <td className="px-4 py-3">{dateTime(s.status === 'TRIALING' && s.trialEnd ? s.trialEnd : s.endsAt)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
