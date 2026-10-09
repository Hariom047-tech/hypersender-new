'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { rupees } from '@/components/setup/common';
import { Button, EmptyState, ErrorState, LoadingSkeleton, Notice, PageHeader, StatusBadge, Tabs, Textarea, cx } from '@/components/ui';
import { api, friendlyMessage } from '@/lib/api';
import { dateTime, timeAgo } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';
import { t as tr, msg } from '@/lib/i18n';

type Tone = 'green' | 'amber' | 'slate' | 'blue' | 'red';
interface OrderRow {
  id: string; orderNumber: number; status: string; fulfillmentMode: string; paymentMethod: string; paymentStatus: string; totalMinor: number; total: string; currency: string;
  customerName: string | null; customerPhone: string | null; placedAt: string; scheduledFor: string | null; businessName: string; items: string; pendingRequests: number; conversationId: string | null;
}
interface OrderDetail {
  id: string; orderNumber: number; status: string; businessName: string; fulfillmentMode: string; scheduledFor: string | null; address: Record<string, string> | null;
  customerName: string | null; customerPhone: string | null; paymentMethodLabel: string; paymentStatus: string; couponCode: string | null; currency: string;
  subtotalMinor: number; discountMinor: number; packagingMinor: number; deliveryFeeMinor: number; taxMinor: number; totalMinor: number; cancelReason: string | null;
  placedAt: string; conversationId: string | null; nextStatuses: string[];
  items: Array<{ name: string; variantName: string | null; modifiers: Array<{ name: string; kind?: string }> | null; instructions: string | null; quantity: number; lineTotalMinor: number }>;
  events: Array<{ from: string | null; to: string; actor: string; note: string | null; at: string }>;
  requests: Array<{ id: string; kind: string; details: string | null; status: string; createdAt: string; resolutionNote: string | null }>;
}
interface Ticket { id: string; category: string; description: string; priority: string; status: string; createdAt: string; conversationId: string | null; orderNumber: number | null; customer: string | null }

const STATUS: Record<string, { text: string; tone: Tone }> = {
  PLACED: { text: msg("New"), tone: 'red' }, ACCEPTED: { text: msg("Accepted"), tone: 'blue' }, PREPARING: { text: msg("Preparing"), tone: 'amber' }, READY: { text: msg("Ready"), tone: 'green' },
  OUT_FOR_DELIVERY: { text: msg("Out for delivery"), tone: 'blue' }, DELIVERED: { text: msg("Delivered"), tone: 'green' }, COMPLETED: { text: msg("Completed"), tone: 'slate' },
  CANCELLED: { text: msg("Cancelled"), tone: 'slate' }, REJECTED: { text: msg("Rejected"), tone: 'slate' },
};
const ACTION: Record<string, string> = {
  ACCEPTED: msg("Accept order"), REJECTED: msg("Reject"), PREPARING: msg("Start preparing"), READY: msg("Mark ready"), OUT_FOR_DELIVERY: msg("Out for delivery"), DELIVERED: msg("Mark delivered"), COMPLETED: msg("Complete"), CANCELLED: msg("Cancel order"),
};
const MODE: Record<string, string> = { DELIVERY: msg("🛵 Delivery"), PICKUP: msg("🥡 Pickup"), DINE_IN: msg("🍽️ Dine-in") };

/** Live order board for WhatsApp orders. Status changes notify the customer on WhatsApp. */
export default function OrdersPage() {
  const { orgId, businessId } = useWorkspace();
  const [view, setView] = useState<'ACTIVE' | 'DONE' | 'CANCELLED' | 'TICKETS'>('ACTIVE');
  const [openId, setOpenId] = useState<string | null>(null);
  const qs = businessId ? `&businessId=${businessId}` : '';
  const orders = useQuery({ queryKey: ['org', orgId, 'orders', view, businessId], enabled: view !== 'TICKETS', refetchInterval: 10_000,
    queryFn: () => api<OrderRow[]>(`/v1/orders?view=${view}${qs}`) });
  const tickets = useQuery({ queryKey: ['org', orgId, 'support-tickets', businessId], enabled: view === 'TICKETS', refetchInterval: 30_000,
    queryFn: () => api<Ticket[]>(`/v1/support-tickets?open=true${qs}`) });
  const fresh = orders.data?.filter((o) => o.status === 'PLACED').length ?? 0;
  const prev = useRef(0);
  useEffect(() => { if (view === 'ACTIVE' && fresh > prev.current && typeof document !== 'undefined') document.title = tr('({n}) New orders', { n: fresh }); prev.current = fresh; }, [fresh, view]);
  return (
    <>
      <PageHeader title={tr("Orders")} description={tr("WhatsApp orders from your assistant. Updates refresh every 10 seconds; each status change is sent to the customer on WhatsApp.")} />
      <Tabs label={tr("Order views")} value={view} onChange={setView} tabs={[{ id: 'ACTIVE', label: `Active${view === 'ACTIVE' && orders.data ? ` (${orders.data.length})` : ''}` },
        { id: 'DONE', label: tr("Completed") }, { id: 'CANCELLED', label: tr("Cancelled") }, { id: 'TICKETS', label: tr("Complaints") }]} />
      <div className="mt-4">
        {view === 'TICKETS' ? <TicketList q={tickets} orgId={orgId} /> : orders.isLoading ? <LoadingSkeleton rows={5} /> : orders.isError ? <ErrorState error={orders.error} onRetry={() => orders.refetch()} /> : (
          orders.data?.length === 0 ? <EmptyState title={view === 'ACTIVE' ? tr("No active orders") : tr("Nothing here yet")} body={view === 'ACTIVE' ? tr("New WhatsApp orders appear here automatically.") : undefined} /> : (
            <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" aria-label={tr("Orders")}>
              {orders.data?.map((o) => (
                <li key={o.id}>
                  <button type="button" onClick={() => setOpenId(o.id)} className={cx('w-full rounded-lg bg-white p-4 text-left ring-1 transition hover:shadow-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600',
                    o.status === 'PLACED' ? 'ring-2 ring-red-300' : 'ring-slate-200')}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold">#{o.orderNumber}</span>
                      <StatusBadge tone={STATUS[o.status]?.tone ?? 'slate'}>{STATUS[o.status]?.text ?? o.status}</StatusBadge>
                    </div>
                    <p className="mt-1 text-sm">{o.customerName ?? tr("Customer")} <span className="text-slate-500">{o.customerPhone}</span></p>
                    <p className="mt-1 line-clamp-2 text-sm text-slate-700">{o.items}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600">
                      <span>{tr(MODE[o.fulfillmentMode] ?? o.fulfillmentMode)}</span><span className="font-semibold text-slate-900">{o.total}</span>
                      <span>{o.paymentStatus === 'PAID' ? tr("✅ Paid") : o.paymentMethod === 'COD' ? tr("Cash on delivery") : tr("Pay at counter")}</span>
                      <span>{timeAgo(o.placedAt)}</span>
                      {o.scheduledFor && <span className="text-amber-700">⏰ {dateTime(o.scheduledFor)}</span>}
                      {o.pendingRequests > 0 && <StatusBadge tone="amber">{o.pendingRequests} {tr("request")}</StatusBadge>}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )
        )}
      </div>
      {openId && <OrderDrawer id={openId} orgId={orgId} onClose={() => setOpenId(null)} />}
    </>
  );
}

function OrderDrawer({ id, orgId, onClose }: { id: string; orgId: string | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const qc = useQueryClient();
  const { role } = useWorkspace();
  const canAct = ['OWNER', 'ADMIN', 'MANAGER', 'AGENT'].includes(role ?? '');
  const [note, setNote] = useState('');
  useEffect(() => { ref.current?.showModal(); }, []);
  const q = useQuery({ queryKey: ['org', orgId, 'order', id], queryFn: () => api<OrderDetail>(`/v1/orders/${id}`), refetchInterval: 15_000 });
  const done = (o: OrderDetail) => { qc.setQueryData(['org', orgId, 'order', id], o); void qc.invalidateQueries({ queryKey: ['org', orgId, 'orders'] }); setNote(''); };
  const status = useMutation({ mutationFn: (s: string) => api<OrderDetail>(`/v1/orders/${id}/status`, { method: 'POST', body: { status: s, ...(note.trim() ? { note: note.trim() } : {}) } }), onSuccess: done });
  const paid = useMutation({ mutationFn: () => api<OrderDetail>(`/v1/orders/${id}/paid`, { method: 'POST' }), onSuccess: done });
  const resolve = useMutation({ mutationFn: (p: { rid: string; approve: boolean }) => api<OrderDetail>(`/v1/order-requests/${p.rid}/resolve`, { method: 'POST', body: { approve: p.approve, ...(note.trim() ? { note: note.trim() } : {}) } }),
    onSuccess: done });
  const o = q.data;
  const err = status.error ?? paid.error ?? resolve.error;
  const m = (v: number) => rupees(v, o?.currency);
  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby="order-title" className="ml-auto mr-0 h-full max-h-full w-full max-w-xl rounded-none p-0 backdrop:bg-slate-900/40">
      <div className="flex h-full flex-col">
        <header className="flex items-center justify-between border-b border-slate-200 p-4">
          <div><h2 id="order-title" className="font-semibold">{tr("Order")}{' '}{o ? `#${o.orderNumber}` : ''}</h2>{o && <p className="text-xs text-slate-500">{o.businessName} · {dateTime(o.placedAt)}</p>}</div>
          <Button variant="ghost" size="sm" onClick={() => ref.current?.close()} aria-label={tr("Close")}>✕</Button>
        </header>
        <div className="flex-1 space-y-5 overflow-y-auto p-4">
          {q.isLoading ? <LoadingSkeleton rows={6} /> : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : o && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge tone={STATUS[o.status]?.tone ?? 'slate'}>{STATUS[o.status]?.text ?? o.status}</StatusBadge>
                <span className="text-sm">{tr(MODE[o.fulfillmentMode])}</span>
                {o.scheduledFor && <span className="text-sm text-amber-700">{tr("⏰ for")}{' '}{dateTime(o.scheduledFor)}</span>}
              </div>
              <section aria-label={tr("Customer")} className="text-sm">
                <p className="font-medium">{o.customerName ?? tr("Customer")} <span className="font-normal text-slate-500">{o.customerPhone}</span></p>
                {o.address && <p className="mt-1 text-slate-700">📍 {[o.address.house, o.address.building, o.address.street, o.address.locality, o.address.landmark && `near ${o.address.landmark}`, o.address.city, o.address.pincode].filter(Boolean).join(', ')}
                  {o.address.latitude && <> · <a className="text-emerald-800 underline" target="_blank" rel="noopener noreferrer" href={`https://maps.google.com/?q=${o.address.latitude},${o.address.longitude}`}>{tr("map")}</a></>}</p>}
                {o.conversationId && <Link className="mt-1 inline-block text-xs text-emerald-800 underline" href={`/inbox?c=${o.conversationId}`}>{tr("Open WhatsApp chat")}</Link>}
              </section>
              <section aria-label={tr("Items")}>
                <ul className="divide-y divide-slate-100 text-sm">
                  {o.items.map((i, k) => (
                    <li key={k} className="flex justify-between gap-3 py-2">
                      <span><span className="font-medium">{i.quantity} × {i.name}</span>{i.variantName && ` (${i.variantName})`}
                        {i.modifiers && i.modifiers.length > 0 && <span className="block text-xs text-slate-500">{i.modifiers.map((x) => (x.kind === 'REMOVE' ? `no ${x.name}` : x.name)).join(', ')}</span>}
                        {i.instructions && <span className="block text-xs text-amber-800">“{i.instructions}”</span>}</span>
                      <span>{m(i.lineTotalMinor)}</span>
                    </li>
                  ))}
                </ul>
                <dl className="mt-2 space-y-1 border-t border-slate-200 pt-2 text-sm">
                  {[['Items', o.subtotalMinor], o.discountMinor ? [`Discount${o.couponCode ? ` (${o.couponCode})` : ''}`, -o.discountMinor] : null, o.packagingMinor ? ['Packaging', o.packagingMinor] : null,
                    ['GST', o.taxMinor], o.fulfillmentMode === 'DELIVERY' ? ['Delivery', o.deliveryFeeMinor] : null].filter(Boolean).map((r) => {
                    const [k, v] = r as [string, number];
                    return <div key={k} className="flex justify-between"><dt className="text-slate-600">{k}</dt><dd>{v < 0 ? `− ${m(-v)}` : m(v)}</dd></div>;
                  })}
                  <div className="flex justify-between font-semibold"><dt>{tr("Total")}</dt><dd>{m(o.totalMinor)}</dd></div>
                  <div className="flex justify-between text-xs"><dt className="text-slate-600">{tr("Payment")}</dt><dd>{o.paymentMethodLabel} · {o.paymentStatus === 'PAID' ? tr("✅ Paid") : tr("Not paid yet")}</dd></div>
                </dl>
              </section>
              {o.requests.length > 0 && (
                <section aria-label={tr("Customer requests")} className="space-y-2">
                  <h3 className="text-sm font-semibold">{tr("Customer requests")}</h3>
                  {o.requests.map((r) => (
                    <div key={r.id} className={cx('rounded-lg p-3 text-sm ring-1', r.status === 'PENDING' ? 'bg-amber-50 ring-amber-200' : 'ring-slate-200')}>
                      <p><span className="font-medium">{r.kind === 'CANCEL' ? tr("Cancel request") : tr("Change request")}</span> · {timeAgo(r.createdAt)} · {r.status.toLowerCase()}</p>
                      {r.details && <p className="mt-1 text-slate-700">“{r.details}”</p>}
                      {r.status === 'PENDING' && canAct && (
                        <div className="mt-2 flex gap-2">
                          <Button size="sm" loading={resolve.isPending} onClick={() => resolve.mutate({ rid: r.id, approve: true })}>{r.kind === 'CANCEL' ? tr("Approve & cancel order") : tr("Mark done")}</Button>
                          <Button size="sm" variant="secondary" loading={resolve.isPending} onClick={() => resolve.mutate({ rid: r.id, approve: false })}>{tr("Decline")}</Button>
                        </div>
                      )}
                    </div>
                  ))}
                </section>
              )}
              {o.cancelReason && <Notice>{tr("Reason:")}{' '}{o.cancelReason}</Notice>}
              <section aria-label={tr("History")}>
                <h3 className="text-sm font-semibold">{tr("History")}</h3>
                <ol className="mt-1 space-y-1 text-xs text-slate-600">
                  {o.events.map((e, k) => <li key={k}>{dateTime(e.at)} · {STATUS[e.to]?.text ?? e.to} <span className="text-slate-400">{tr("by")}{' '}{e.actor.toLowerCase()}</span>{e.note && ` - ${e.note}`}</li>)}
                </ol>
              </section>
            </>
          )}
        </div>
        {o && canAct && (o.nextStatuses.length > 0 || o.paymentStatus !== 'PAID') && (
          <footer className="space-y-2 border-t border-slate-200 p-4">
            {err && <Notice tone="error">{friendlyMessage(err)}</Notice>}
            {o.nextStatuses.some((s) => s === 'REJECTED' || s === 'CANCELLED') && (
              <Textarea aria-label={tr("Note for the customer (optional)")} rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder={tr("Optional reason / note sent to the customer (e.g. item not available)")} />
            )}
            <div className="flex flex-wrap gap-2">
              {o.nextStatuses.map((s) => (
                <Button key={s} size="sm" variant={s === 'REJECTED' || s === 'CANCELLED' ? 'danger' : 'primary'} loading={status.isPending && status.variables === s}
                  onClick={() => { if ((s === 'REJECTED' || s === 'CANCELLED') && !window.confirm(tr("{action}? The customer will be told on WhatsApp.", { action: tr(ACTION[s]) }))) return; status.mutate(s); }}>{tr(ACTION[s] ?? s)}</Button>
              ))}
              {o.paymentStatus !== 'PAID' && !['CANCELLED', 'REJECTED'].includes(o.status) && <Button size="sm" variant="secondary" loading={paid.isPending} onClick={() => paid.mutate()}>{tr("Mark paid")}</Button>}
            </div>
          </footer>
        )}
      </div>
    </dialog>
  );
}

function TicketList({ q, orgId }: { q: ReturnType<typeof useQuery<Ticket[]>>; orgId: string | null }) {
  const qc = useQueryClient();
  const set = useMutation({ mutationFn: (p: { id: string; status: string }) => api(`/v1/support-tickets/${p.id}/status`, { method: 'POST', body: { status: p.status } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['org', orgId, 'support-tickets'] }) });
  if (q.isLoading) return <LoadingSkeleton rows={4} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data?.length) return <EmptyState title={tr("No open complaints")} body={tr("When a customer reports a problem (late, wrong item, quality), the assistant files it here.")} />;
  return (
    <ul className="space-y-2">
      {q.data.map((t) => (
        <li key={t.id} className="rounded-lg bg-white p-4 ring-1 ring-slate-200">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <StatusBadge tone={t.priority === 'HIGH' ? 'red' : 'amber'}>{t.category.replace(/_/g, ' ').toLowerCase()}</StatusBadge>
            <span className="font-medium">{t.customer ?? tr("Customer")}</span>{t.orderNumber && <span className="text-slate-500">{tr("order #")}{t.orderNumber}</span>}
            <span className="text-xs text-slate-500">{timeAgo(t.createdAt)} · {t.status.replace('_', ' ').toLowerCase()}</span>
          </div>
          <p className="mt-1 text-sm text-slate-700">{t.description}</p>
          <div className="mt-2 flex gap-2">
            {t.conversationId && <Link className="text-xs text-emerald-800 underline" href={`/inbox?c=${t.conversationId}`}>{tr("Open chat")}</Link>}
            {t.status === 'OPEN' && <Button size="sm" variant="secondary" onClick={() => set.mutate({ id: t.id, status: 'IN_PROGRESS' })}>{tr("Working on it")}</Button>}
            <Button size="sm" variant="secondary" onClick={() => set.mutate({ id: t.id, status: 'RESOLVED' })}>{tr("Resolved")}</Button>
          </div>
        </li>
      ))}
    </ul>
  );
}
