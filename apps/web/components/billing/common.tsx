'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { StatusBadge } from '@/components/ui';
import { msg, t } from '@/lib/i18n';

type Tone = 'green' | 'amber' | 'red' | 'slate' | 'blue';

const SUB_STATUS: Record<string, { label: string; tone: Tone }> = {
  ACTIVE: { label: msg("Active"), tone: 'green' }, TRIALING: { label: msg("Trial"), tone: 'blue' }, PAST_DUE: { label: msg("Payment due"), tone: 'amber' },
  CANCELLED: { label: msg("Cancelled"), tone: 'slate' }, EXPIRED: { label: msg("Expired"), tone: 'slate' },
};
const TX_STATUS: Record<string, { label: string; tone: Tone }> = {
  COMPLETED: { label: msg("Completed"), tone: 'green' }, PENDING: { label: msg("Pending"), tone: 'amber' }, PAST_DUE: { label: msg("Past due"), tone: 'red' },
  CANCELLED: { label: msg("Cancelled"), tone: 'slate' }, FAILED: { label: msg("Failed"), tone: 'red' },
};
const METHOD: Record<string, string> = {
  CARD: msg("Card"), UPI: msg("UPI"), NETBANKING: msg("Netbanking"), WALLET: msg("Wallet"), BANK_TRANSFER: msg("Bank transfer"), OTHER: msg("Other"),
  TRIAL: msg("Free trial"), MANUAL: msg("Manual"),
};

export function SubscriptionStatus({ status }: { status: string }) {
  const s = SUB_STATUS[status] ?? { label: status, tone: 'slate' as const };
  return <StatusBadge tone={s.tone}>{t(s.label)}</StatusBadge>;
}
export function TransactionStatus({ status }: { status: string }) {
  const s = TX_STATUS[status] ?? { label: status, tone: 'slate' as const };
  return <StatusBadge tone={s.tone}>{t(s.label)}</StatusBadge>;
}
export function PaymentMethod({ method }: { method: string | null }) {
  return <StatusBadge tone={method ? 'green' : 'slate'}>{method ? t(METHOD[method] ?? method) : t("Unknown")}</StatusBadge>;
}
export const TX_STATUS_OPTIONS = Object.keys(TX_STATUS);
export const txStatusLabel = (s: string) => t(TX_STATUS[s]?.label ?? s);
export const methodLabel = (m: string | null) => (m ? t(METHOD[m] ?? m) : t("Unknown"));

/** "Billing › Subscriptions" style breadcrumb + big title + actions (gateway dashboards look). */
export function BillingHeader({ crumb, title, actions }: { crumb: string; title: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <nav aria-label={t("Breadcrumb")} className="mb-1 flex items-center gap-2 text-sm text-slate-500">
          <Link href="/subscriptions" className="hover:underline">{t("Billing")}</Link><span aria-hidden>›</span><span className="text-slate-700">{crumb}</span>
        </nav>
        <h1 className="text-2xl font-bold text-slate-900 sm:text-3xl">{title}</h1>
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function SearchInput({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <label className="relative block">
      <span className="sr-only">{label}</span>
      <svg aria-hidden viewBox="0 0 24 24" className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
      <input type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={t("Search")}
        className="w-full min-w-[12rem] rounded-md border-0 bg-white py-1.5 pl-8 pr-2 text-sm text-slate-900 ring-1 ring-inset ring-slate-300 placeholder:text-slate-400 focus:ring-2 focus:ring-inset focus:ring-emerald-600" />
    </label>
  );
}
