'use client';

import { useQuery } from '@tanstack/react-query';
import { Card, DataTable, ErrorState, LoadingSkeleton, Notice, PageHeader, StatusBadge } from '@/components/ui';
import { api } from '@/lib/api';
import { dateTime, money } from '@/lib/format';
import { can } from '@/lib/permissions';
import { useWorkspace } from '@/lib/workspace';
import { t, msg } from '@/lib/i18n';

interface Billing {
  subscription: { status: string; planCode: string; planName: string; priceMinorUnits: number; currency: string; interval: string; periodStart: string; periodEnd: string; trialEnd: string | null; cancelAtPeriodEnd: boolean } | null;
  entitlements: Array<{ feature: string; enabled: boolean; limit: number | null; used?: number }>;
  invoices: Array<{ id: string; number: string | null; status: string; currency: string; totalMinorUnits: number; issuedAt: string | null; paidAt: string | null }>;
  paymentsEnabled: boolean; paymentsNote: string;
}

const FEATURE_TEXT: Record<string, string> = {
  MAX_WHATSAPP_INSTANCES: msg("WhatsApp numbers"), TEAM_MEMBERS: msg("Team members"), WEBHOOKS: msg("Webhooks"), API_ACCESS: msg("API access"),
  MAX_AI_AGENTS: msg("AI assistants"), MONTHLY_MESSAGES: msg("Messages / month"), MONTHLY_AI_MESSAGES: msg("AI messages / month"), KNOWLEDGE_STORAGE_MB: msg("Knowledge storage (MB)"),
};

export default function BillingPage() {
  const { orgId, role } = useWorkspace();
  const q = useQuery({ queryKey: ['org', orgId, 'billing'], queryFn: () => api<Billing>('/v1/billing'), enabled: can(role, 'billing:view') });
  if (!can(role, 'billing:view')) return <><PageHeader title={t("Billing")} /><Notice>{t("Only owners and admins can view billing.")}</Notice></>;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <LoadingSkeleton />;
  const s = q.data.subscription;
  return (
    <>
      <PageHeader title={t("Billing")} description={t("Your plan and what it includes.")} />
      <div className="mb-6"><Notice tone="warn">{q.data.paymentsNote} {t("To change plans, contact support. We never collect card details on this page.")}</Notice></div>
      <div className="grid gap-6 lg:grid-cols-3">
        <Card title={t("Current plan")}>
          {!s ? <p className="text-sm text-slate-500">{t("No subscription.")}</p> : (
            <dl className="space-y-2 text-sm">
              <div><dt className="text-xs text-slate-500">{t("Plan")}</dt><dd className="text-base font-semibold">{s.planName}</dd></div>
              <div><dt className="text-xs text-slate-500">{t("Status")}</dt><dd><StatusBadge tone={s.status === 'ACTIVE' || s.status === 'TRIALING' ? 'green' : 'red'}>{s.status.toLowerCase()}</StatusBadge></dd></div>
              <div><dt className="text-xs text-slate-500">{t("Price")}</dt><dd>{money(s.priceMinorUnits, s.currency)} / {s.interval.toLowerCase()}</dd></div>
              {s.trialEnd && <div><dt className="text-xs text-slate-500">{t("Trial ends")}</dt><dd>{dateTime(s.trialEnd)}</dd></div>}
              <div><dt className="text-xs text-slate-500">{t("Current period ends")}</dt><dd>{dateTime(s.periodEnd)}</dd></div>
            </dl>
          )}
        </Card>
        <Card title={t("Plan limits")} className="lg:col-span-2">
          <ul className="divide-y divide-slate-100 text-sm">
            {q.data.entitlements.map((e) => (
              <li key={e.feature} className="flex items-center justify-between py-2">
                <span>{t(FEATURE_TEXT[e.feature] ?? e.feature)}</span>
                <span className="text-slate-600">
                  {!e.enabled ? <StatusBadge tone="slate">{t("Not included")}</StatusBadge>
                    : e.limit === null ? (e.used !== undefined ? t("{used} used · unlimited", { used: e.used }) : t("Included"))
                    : e.used !== undefined ? `${e.used} / ${e.limit}` : `${e.limit}`}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
      <h2 className="mb-3 mt-8 text-sm font-semibold">{t("Invoices")}</h2>
      <DataTable caption={t("Invoices")} rows={q.data.invoices} rowKey={(r) => r.id}
        empty={<p className="rounded-lg bg-white p-4 text-sm text-slate-500 ring-1 ring-slate-200">{t("No invoices yet.")}</p>}
        columns={[
          { key: 'n', header: t("Invoice"), cell: (r) => r.number ?? r.id.slice(0, 8) },
          { key: 's', header: t("Status"), cell: (r) => r.status.toLowerCase() },
          { key: 't', header: t("Total"), cell: (r) => money(r.totalMinorUnits, r.currency) },
          { key: 'i', header: t("Issued"), cell: (r) => dateTime(r.issuedAt) },
          { key: 'p', header: t("Paid"), cell: (r) => dateTime(r.paidAt) },
        ]} />
    </>
  );
}
