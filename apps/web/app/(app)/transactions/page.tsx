'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useDeferredValue, useState, type ReactNode } from 'react';
import { BillingHeader, PaymentMethod, SearchInput, TransactionStatus, TX_STATUS_OPTIONS, methodLabel, txStatusLabel } from '@/components/billing/common';
import { downloadInvoice } from '@/components/billing/invoice';
import { Button, EmptyState, ErrorState, LoadingSkeleton, Notice, Select, StatusBadge, cx } from '@/components/ui';
import { Copy } from '@/components/whatsapp/instance-api';
import { api, friendlyMessage } from '@/lib/api';
import { dateTime, money } from '@/lib/format';
import { can } from '@/lib/permissions';
import { useWorkspace } from '@/lib/workspace';
import { t } from '@/lib/i18n';

interface Tx {
  id: string; invoiceNumber: string | null; subscriptionId: string | null; type: 'SUBSCRIPTION' | 'ONE_TIME'; totalMinorUnits: number; currency: string;
  paymentMethod: string | null; status: string; billedAt: string | null; paidAt: string | null; createdAt: string; invoiceAvailable: boolean;
}
interface Resp { summary: { total: number; successful: number; failed: number; paidMinorUnits: number; currency: string }; items: Tx[]; nextCursor: string | null }

function Stat({ icon, title, value, note, tone }: { icon: ReactNode; title: string; value: number; note: string; tone: string }) {
  return (
    <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
      <p className="flex items-center gap-2 text-sm text-slate-600"><span aria-hidden>{icon}</span>{title}</p>
      <p className="mt-2 text-3xl font-bold text-slate-900">{value}</p>
      <p className={cx('mt-2 text-sm', tone)}>{note}</p>
    </div>
  );
}

const csvCell = (v: unknown) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

export default function TransactionsPage() {
  const { orgId, role } = useWorkspace();
  const allowed = can(role, 'billing:view');
  const [search, setSearch] = useState('');
  const [subSearch, setSubSearch] = useState('');
  const [status, setStatus] = useState('');
  const [limit, setLimit] = useState(10);
  const [cursors, setCursors] = useState<Array<string | null>>([null]); // page history for Previous
  const q = useDeferredValue(search.trim());
  const sq = useDeferredValue(subSearch.trim());
  const cursor = cursors[cursors.length - 1];
  const params = new URLSearchParams({ limit: String(limit), ...(q ? { q } : {}), ...(sq ? { subscription: sq } : {}), ...(status ? { status } : {}), ...(cursor ? { cursor } : {}) });
  const r = useQuery({ queryKey: ['org', orgId, 'billing', 'transactions', params.toString()], enabled: allowed, placeholderData: (p) => p,
    queryFn: () => api<Resp>(`/v1/billing/transactions?${params.toString()}`) });
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setCursors([null]); };
  const exportCsv = useMutation({
    mutationFn: () => api<Tx[]>('/v1/billing/transactions/export'),
    onSuccess: (rows) => {
      const head = ['UUID', 'Invoice', 'Subscription ID', 'Total', 'Currency', 'Payment Method', 'Type', 'Status', 'Billed At', 'Paid At', 'Created At']; // i18n-ignore (CSV columns)
      const lines = rows.map((x) => [x.id, x.invoiceNumber, x.subscriptionId, (x.totalMinorUnits / 100).toFixed(2), x.currency, methodLabel(x.paymentMethod), x.type,
        txStatusLabel(x.status), x.billedAt, x.paidAt, x.createdAt].map(csvCell).join(','));
      const url = URL.createObjectURL(new Blob([[head.join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url; a.download = `transactions-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
      URL.revokeObjectURL(url);
    },
  });
  const invoice = useMutation({ mutationFn: (id: string) => downloadInvoice(id) });

  if (!allowed) return <><BillingHeader crumb={t("Transactions")} title={t("Transactions")} /><Notice>{t("Only owners and admins can view billing.")}</Notice></>;
  const s = r.data?.summary;
  const page = cursors.length;
  const from = r.data?.items.length ? (page - 1) * limit + 1 : 0;
  const to = (page - 1) * limit + (r.data?.items.length ?? 0);

  return (
    <>
      <BillingHeader crumb={t("List")} title={t("Transactions")} />
      <div className="mb-6 grid gap-4 md:grid-cols-3">
        <Stat icon="🧾" title={t("Total Transactions")} value={s?.total ?? 0} note={t("All transactions")} tone="text-slate-600" />
        <Stat icon="✅" title={t("Successful")} value={s?.successful ?? 0} note={s ? t("Completed and paid · {amount}", { amount: money(s.paidMinorUnits, s.currency) }) : t("Completed and paid transactions")} tone="text-emerald-700" />
        <Stat icon="⛔" title={t("Failed")} value={s?.failed ?? 0} note={t("Canceled and past due transactions")} tone="text-red-700" />
      </div>

      <div className="rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 p-4">
          <label className="flex items-center gap-2 text-sm text-slate-600">{t("Status")}
            <Select className="w-44" value={status} onChange={(e) => reset(setStatus)(e.target.value)} aria-label={t("Filter by status")}>
              <option value="">{t("All")}</option>
              {TX_STATUS_OPTIONS.map((x) => <option key={x} value={x}>{txStatusLabel(x)}</option>)}
            </Select>
          </label>
          <Button variant="secondary" loading={exportCsv.isPending} onClick={() => exportCsv.mutate()}>{t("Export Transactions")}</Button>
        </div>
        {(exportCsv.isError || invoice.isError) && <div className="p-4"><Notice tone="error">{friendlyMessage(exportCsv.error ?? invoice.error)}</Notice></div>}
        {r.isError ? <div className="p-4"><ErrorState error={r.error} onRetry={() => r.refetch()} /></div> : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <caption className="sr-only">{t("Transactions")}</caption>
              <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-600">
                <tr>{[t("UUID"), t("Subscription ID"), t("Total Amount"), t("Payment Method"), t("Type"), t("Status"), t("Billed At"), t("Created At"), '']
                  .map((h, i) => <th key={i} scope="col" className="whitespace-nowrap px-4 py-3">{h}</th>)}</tr>
                <tr className="border-t border-slate-200 bg-white font-normal normal-case">
                  <th className="px-4 py-2"><SearchInput value={search} onChange={reset(setSearch)} label={t("Search by transaction or invoice")} /></th>
                  <th className="px-4 py-2"><SearchInput value={subSearch} onChange={reset(setSubSearch)} label={t("Search by subscription ID")} /></th>
                  <th colSpan={7} />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {!r.data ? <tr><td colSpan={9} className="p-4"><LoadingSkeleton rows={3} /></td></tr>
                  : !r.data.items.length ? <tr><td colSpan={9} className="p-4"><EmptyState title={t("No transactions yet")} body={t("Payments for your plan appear here with an invoice you can download.")} /></td></tr>
                  : r.data.items.map((x) => (
                    <tr key={x.id} className="whitespace-nowrap">
                      <td className="px-4 py-3"><span className="flex items-center gap-2"><Copy value={x.id} icon label={t("Copy transaction ID")} /><code className="text-xs text-slate-900">{x.id}</code></span></td>
                      <td className="px-4 py-3"><code className="text-xs">{x.subscriptionId ?? t("N/A")}</code></td>
                      <td className="px-4 py-3 font-medium">{money(x.totalMinorUnits, x.currency)}</td>
                      <td className="px-4 py-3"><PaymentMethod method={x.paymentMethod} /></td>
                      <td className="px-4 py-3"><StatusBadge tone="blue">{x.type === 'SUBSCRIPTION' ? t("Subscription") : t("One-time")}</StatusBadge></td>
                      <td className="px-4 py-3"><TransactionStatus status={x.status} /></td>
                      <td className="px-4 py-3">{dateTime(x.billedAt)}</td>
                      <td className="px-4 py-3">{dateTime(x.createdAt)}</td>
                      <td className="px-4 py-3">{x.invoiceAvailable && (
                        <button type="button" className="font-medium text-emerald-800 hover:underline disabled:opacity-50" disabled={invoice.isPending && invoice.variables === x.id}
                          onClick={() => invoice.mutate(x.id)}>⤓ {t("Download Invoice")}</button>)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 p-4 text-sm">
          <span className="font-medium text-slate-700">{t("Showing {from} to {to}", { from, to })}{s ? ` · ${t("{n} in total", { n: s.total })}` : ''}</span>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 text-slate-600">{t("Per page")}
              <Select className="w-20" value={String(limit)} onChange={(e) => { setLimit(Number(e.target.value)); setCursors([null]); }} aria-label={t("Per page")}>
                {[10, 25, 50].map((n) => <option key={n} value={n}>{n}</option>)}
              </Select>
            </label>
            <Button size="sm" variant="secondary" disabled={page === 1} onClick={() => setCursors((c) => c.slice(0, -1))}>{t("Previous")}</Button>
            <Button size="sm" variant="secondary" disabled={!r.data?.nextCursor} onClick={() => r.data?.nextCursor && setCursors((c) => [...c, r.data!.nextCursor])}>{t("Next")}</Button>
          </div>
        </div>
      </div>
    </>
  );
}
