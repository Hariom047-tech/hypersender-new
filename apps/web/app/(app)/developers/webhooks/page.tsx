'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect } from 'react';
import { DataTable, EmptyState, ErrorState, Notice, PageHeader, StatusBadge } from '@/components/ui';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { can } from '@/lib/permissions';
import type { Webhook } from '@/lib/types';
import { useWorkspace } from '@/lib/workspace';
import { t } from '@/lib/i18n';

export default function WebhooksPage() {
  return <Suspense><Webhooks /></Suspense>;
}

const addCls = 'rounded-md bg-emerald-700 px-3.5 py-2 text-sm font-medium text-white hover:bg-emerald-800';

function Webhooks() {
  const { orgId, role } = useWorkspace();
  const router = useRouter();
  // Old links (?instanceId=...) open the create page for that number.
  const presetInstance = useSearchParams().get('instanceId');
  useEffect(() => { if (presetInstance) router.replace(`/developers/webhooks/create?instanceId=${presetInstance}`); }, [presetInstance, router]);
  const allowed = can(role, 'webhooks:manage');
  const q = useQuery({ queryKey: ['org', orgId, 'webhooks'], queryFn: () => api<Webhook[]>('/v1/webhooks'), enabled: allowed });
  if (!allowed) return <><PageHeader title={t("Webhooks")} /><Notice>{t("Only owners and admins can manage webhooks.")}</Notice></>;

  return (
    <>
      <PageHeader title={t("Webhooks")} description={t("Receive signed HTTPS notifications when WhatsApp events happen.")}
        actions={<><Link href="/developers/webhook-logs" className="rounded-md px-3.5 py-2 text-sm font-medium text-slate-800 ring-1 ring-inset ring-slate-300 hover:bg-slate-50">{t("Webhook Logs")}</Link>
          <Link href="/developers/webhooks/create" className={addCls}>{t("+ Add webhook")}</Link></>} />
      {q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
        <DataTable caption={t("Webhooks")} loading={q.isLoading} rows={q.data} rowKey={(r) => r.id} onRowClick={(r) => router.push(`/developers/webhooks/${r.id}`)}
          empty={<EmptyState title={t("No webhooks yet")} body={t("Add an HTTPS endpoint to receive message and connection events.")}
            action={<Link href="/developers/webhooks/create" className={addCls}>{t("+ Add webhook")}</Link>} />}
          columns={[
            { key: 'name', header: t("Name"), cell: (r) => <span className="font-medium">{r.name}</span> },
            { key: 'url', header: 'URL', cell: (r) => <span className="block max-w-xs truncate text-xs" title={r.url}>{r.url}</span> },
            { key: 'scope', header: t("Instance"), cell: (r) => (r.scope === 'ORGANIZATION' ? t("Whole organization") : r.scope === 'BUSINESS' ? r.businessName : r.instanceName) },
            { key: 'events', header: t("Events"), cell: (r) => <span className="text-xs">{r.events.length} {t("selected")}</span> },
            { key: 'auth', header: t("Authorization"), cell: (r) => (r.hasAuthHeader ? <StatusBadge tone="green">{t("Set")}</StatusBadge> : <span className="text-slate-400">—</span>) },
            { key: 'status', header: t("Status"), cell: (r) => <StatusBadge tone={r.enabled ? 'green' : 'slate'}>{r.enabled ? t("Enabled") : t("Disabled")}</StatusBadge> },
            { key: 'ok', header: t("Last success"), cell: (r) => timeAgo(r.lastSuccessAt) },
            { key: 'fail', header: t("Last failure"), cell: (r) => (r.lastFailureAt ? <span className="text-red-700">{timeAgo(r.lastFailureAt)}</span> : '—') },
          ]} />
      )}
    </>
  );
}
