'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Button, DataTable, EmptyState, ErrorState, Field, Input, Notice, PageHeader, Select, StatusBadge } from '@/components/ui';
import { api, friendlyMessage } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';
import { t, msg } from '@/lib/i18n';

interface Booking {
  id: string; status: string; startAt: string; endAt: string; timezone: string; bookingType: string | null; partySize: number | null; customerName: string | null;
  customerPhone: string | null; notes: string | null; source: string | null; createdBy: string | null; serviceName: string | null; resourceName: string | null;
  businessName: string; conversationId: string | null; assistantName: string | null;
}
type Tone = 'green' | 'amber' | 'slate' | 'blue' | 'red';
const STATUS: Record<string, { text: string; tone: Tone }> = {
  PENDING: { text: msg("Pending"), tone: 'amber' }, CONFIRMED: { text: msg("Confirmed"), tone: 'green' }, COMPLETED: { text: msg("Completed"), tone: 'slate' },
  CANCELLED: { text: msg("Cancelled"), tone: 'slate' }, NO_SHOW: { text: msg("No-show"), tone: 'red' }, RESCHEDULED: { text: msg("Rescheduled"), tone: 'blue' },
};
const day = (offset: number) => { const d = new Date(Date.now() + offset * 86_400_000); return d.toISOString().slice(0, 10); };

/** Appointments and table reservations made by the assistant or the team. */
export default function BookingsPage() {
  const { orgId, businessId, role } = useWorkspace();
  const qc = useQueryClient();
  const canAct = ['OWNER', 'ADMIN', 'MANAGER', 'AGENT'].includes(role ?? '');
  const [from, setFrom] = useState(day(0));
  const [to, setTo] = useState(day(14));
  const [status, setStatus] = useState('');
  const params = new URLSearchParams({ from: new Date(`${from}T00:00:00`).toISOString(), to: new Date(`${to}T23:59:59`).toISOString(), ...(status ? { status } : {}), ...(businessId ? { businessId } : {}) });
  const q = useQuery({ queryKey: ['org', orgId, 'bookings', params.toString()], refetchInterval: 30_000, queryFn: () => api<Booking[]>(`/v1/bookings?${params}`) });
  const set = useMutation({ mutationFn: (p: { id: string; status: string }) => api(`/v1/bookings/${p.id}/status`, { method: 'POST', body: { status: p.status } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['org', orgId, 'bookings'] }) });
  const act = (b: Booking, s: string, label: string, variant: 'secondary' | 'ghost' | 'danger' = 'secondary') => (
    <Button key={s} size="sm" variant={variant} disabled={set.isPending} onClick={(e) => { e.stopPropagation(); if (s === 'CANCELLED' && !window.confirm(t("Cancel this booking?"))) return; set.mutate({ id: b.id, status: s }); }}>{label}</Button>
  );
  return (
    <>
      <PageHeader title={t("Bookings")} description={t("Appointments and table reservations. The assistant books only free slots from your Staff & tables and Timings.")} />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label={t("From")}>{(id) => <Input id={id} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label={t("To")}>{(id) => <Input id={id} type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />}</Field>
        <Field label={t("Status")}>{(id) => <Select id={id} value={status} onChange={(e) => setStatus(e.target.value)}><option value="">{t("All")}</option>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.text}</option>)}</Select>}</Field>
      </div>
      {set.isError && <div className="mb-3"><Notice tone="error">{friendlyMessage(set.error)}</Notice></div>}
      {q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
        <DataTable caption={t("Bookings")} loading={q.isLoading} rows={q.data} rowKey={(b) => b.id}
          empty={<EmptyState title={t("No bookings in this period")} body={t("Bookings made on WhatsApp by your assistant appear here.")} />}
          columns={[
            { key: 'when', header: t("When"), cell: (b) => <span className="whitespace-nowrap text-sm">{dateTime(b.startAt)}</span> },
            { key: 'who', header: t("Customer"), cell: (b) => <span className="text-sm"><span className="font-medium">{b.customerName ?? '—'}</span> <span className="block text-xs text-slate-500">{b.customerPhone}</span></span> },
            { key: 'what', header: t("Booking"), cell: (b) => <span className="text-sm">{[b.serviceName, b.resourceName, b.partySize ? `${b.partySize} people` : null].filter(Boolean).join(' · ') || b.bookingType || '—'}
              {b.notes && <span className="block text-xs text-slate-500">{b.notes}</span>}</span> },
            { key: 'src', header: t("By"), cell: (b) => <span className="text-xs">{b.assistantName ? `🤖 ${b.assistantName}` : b.createdBy === 'USER' ? t("Team") : b.source ?? '—'}
              {b.conversationId && <Link className="block text-emerald-800 underline" href={`/inbox?c=${b.conversationId}`}>{t("chat")}</Link>}</span> },
            { key: 'st', header: t("Status"), cell: (b) => <StatusBadge tone={STATUS[b.status]?.tone ?? 'slate'}>{STATUS[b.status]?.text ?? b.status}</StatusBadge> },
            { key: 'x', header: '', cell: (b) => (canAct && ['PENDING', 'CONFIRMED'].includes(b.status) ? (
              <div className="flex flex-wrap gap-1">
                {b.status === 'PENDING' && act(b, 'CONFIRMED', t('Confirm'))}
                {new Date(b.startAt) < new Date() && act(b, 'COMPLETED', t('Completed'))}
                {new Date(b.startAt) < new Date() && act(b, 'NO_SHOW', t('No-show'), 'ghost')}
                {act(b, 'CANCELLED', t('Cancel'), 'ghost')}
              </div>) : null) },
          ]} />
      )}
    </>
  );
}
