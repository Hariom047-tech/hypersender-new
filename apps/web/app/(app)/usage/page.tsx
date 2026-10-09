'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ErrorState, LoadingSkeleton, MetricCard, Notice, PageHeader, Tabs } from '@/components/ui';
import { api } from '@/lib/api';
import { bytes } from '@/lib/format';
import { can } from '@/lib/permissions';
import { useWorkspace } from '@/lib/workspace';
import { t as tr } from '@/lib/i18n';

interface Usage { period: string; timezone: string; from: string; to: string; totals: Record<string, number>; aiEnabled: boolean }

export default function UsagePage() {
  const { orgId, role } = useWorkspace();
  const [period, setPeriod] = useState<'current' | 'previous'>('current');
  const q = useQuery({ queryKey: ['org', orgId, 'usage', period], queryFn: () => api<Usage>(`/v1/usage?period=${period}`), enabled: can(role, 'usage:view') });
  if (!can(role, 'usage:view')) return <><PageHeader title={tr("Usage")} /><Notice>{tr("Only owners, admins and managers can view usage.")}</Notice></>;
  const t = q.data?.totals ?? {};
  return (
    <>
      <PageHeader title={tr("Usage")} description={tr("From the usage ledger — the same numbers billing uses.")} />
      <Tabs label={tr("Period")} value={period} onChange={setPeriod} tabs={[{ id: 'current', label: tr("Current month") }, { id: 'previous', label: tr("Previous month") }]} />
      <div className="mt-6">
        {q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data ? <LoadingSkeleton rows={2} /> : (
          <>
            <p className="mb-4 text-sm text-slate-500">{new Date(q.data.from).toLocaleDateString()} – {new Date(new Date(q.data.to).getTime() - 1).toLocaleDateString()} ({q.data.timezone})</p>
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <MetricCard label={tr("WhatsApp messages received")} value={t.WHATSAPP_MESSAGE_IN ?? 0} />
              <MetricCard label={tr("WhatsApp messages sent")} value={t.WHATSAPP_MESSAGE_OUT ?? 0} />
              <MetricCard label={tr("Media stored")} value={bytes(t.MEDIA_BYTES ?? 0) || '0 B'} />
              <MetricCard label={tr("Bookings created")} value={t.BOOKING_CREATED ?? 0} />
              <MetricCard label={tr("AI replies")} value="0" hint={tr("AI assistants are not enabled yet")} />
            </div>
            <p className="mt-4 text-xs text-slate-500">{tr("API request counts are not metered yet.")}</p>
          </>
        )}
      </div>
    </>
  );
}
