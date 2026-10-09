'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Button, EmptyState, ErrorState, LoadingSkeleton, Notice, Select, StatusBadge, cx } from '@/components/ui';
import { api, friendlyMessage, qs } from '@/lib/api';
import { flatten } from '@/lib/cache-merge';
import { dateTime } from '@/lib/format';
import { can } from '@/lib/permissions';
import { WEBHOOK_EVENTS, type Instance, type Page, type Webhook } from '@/lib/types';
import { qk, useWorkspace } from '@/lib/workspace';
import { msg, t } from '@/lib/i18n';

interface Log {
  id: string; eventId: string; eventType: string; status: string; httpStatus: number | null; latencyMs: number | null; attempts: number; retries: number;
  endpoint: { id: string; name: string; url: string }; instance: { id: string; name: string } | null; createdAt: string; lastAttemptAt: string | null;
  deliveredAt: string | null; nextRetryAt: string | null; error: string | null; retryable: boolean; payload?: unknown; responseBodySnippet?: string | null;
}
type Status = '' | 'SUCCESS' | 'FAILED' | 'PENDING';
const STATUS_TEXT: Record<Exclude<Status, ''>, string> = { SUCCESS: msg("Success"), FAILED: msg("Failed"), PENDING: msg("Pending") };
const DELIVERY_TEXT: Record<string, string> = {
  DELIVERED: msg("Delivered"), RETRYING: msg("Will retry"), FAILED: msg("Failed"), DEAD: msg("Gave up"), PENDING: msg("Queued"), PROCESSING: msg("Sending"),
};
const eventLabel = (e: string) => e.toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

function HttpBadge({ l }: { l: Log }) {
  if (l.httpStatus) return <StatusBadge tone={l.httpStatus >= 200 && l.httpStatus < 300 ? 'green' : 'red'}>{String(l.httpStatus)}</StatusBadge>;
  return <StatusBadge tone={l.status === 'DELIVERED' ? 'green' : l.status === 'PENDING' || l.status === 'PROCESSING' ? 'amber' : 'red'}>{t(DELIVERY_TEXT[l.status] ?? l.status)}</StatusBadge>;
}

export default function WebhookLogsPage() {
  const { orgId, role, businessId } = useWorkspace();
  const allowed = can(role, 'webhooks:manage');
  const [status, setStatus] = useState<Status>('');
  const [event, setEvent] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [instance, setInstance] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const filters = { status: status || undefined, event: event || undefined, endpoint: endpoint || undefined, instance: instance || undefined };
  const logs = useInfiniteQuery({
    queryKey: ['org', orgId, 'webhook-logs', filters], enabled: allowed, refetchInterval: 10_000,
    queryFn: ({ pageParam }) => api<Page<Log>>(`/v1/webhook-logs${qs({ ...filters, cursor: pageParam })}`),
    initialPageParam: null as string | null, getNextPageParam: (p) => p.nextCursor,
  });
  const endpoints = useQuery({ queryKey: ['org', orgId, 'webhooks'], enabled: allowed, queryFn: () => api<Webhook[]>('/v1/webhooks') });
  const instances = useQuery({ queryKey: qk.scoped(orgId, businessId, 'instances'), enabled: allowed, queryFn: () => api<Instance[]>('/v1/whatsapp/instances') });

  if (!allowed) return <><Header /><Notice>{t("Only owners and admins can manage webhooks.")}</Notice></>;
  const chips: Array<{ label: string; clear: () => void }> = [
    ...(status ? [{ label: `${t("Status")}: ${t(STATUS_TEXT[status])}`, clear: () => setStatus('') }] : []),
    ...(event ? [{ label: `${t("Event")}: ${eventLabel(event)}`, clear: () => setEvent('') }] : []),
    ...(endpoint ? [{ label: `${t("Endpoint")}: ${endpoints.data?.find((e) => e.id === endpoint)?.name ?? '…'}`, clear: () => setEndpoint('') }] : []),
    ...(instance ? [{ label: `${t("Instance")}: ${instances.data?.find((i) => i.id === instance)?.name ?? '…'}`, clear: () => setInstance('') }] : []),
  ];
  const items = flatten(logs.data);

  return (
    <>
      <Header />
      <div className="rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
        <div className="grid gap-3 border-b border-slate-200 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <Select aria-label={t("Status")} value={status} onChange={(e) => setStatus(e.target.value as Status)}>
            <option value="">{t("Status: All")}</option>
            {(['SUCCESS', 'FAILED', 'PENDING'] as const).map((s) => <option key={s} value={s}>{t(STATUS_TEXT[s])}</option>)}
          </Select>
          <Select aria-label={t("Event")} value={event} onChange={(e) => setEvent(e.target.value)}>
            <option value="">{t("All events")}</option>
            {[...WEBHOOK_EVENTS, 'WEBHOOK_TEST'].map((e) => <option key={e} value={e}>{eventLabel(e)}</option>)}
          </Select>
          <Select aria-label={t("Endpoint")} value={endpoint} onChange={(e) => setEndpoint(e.target.value)}>
            <option value="">{t("All endpoints")}</option>
            {(endpoints.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </Select>
          <Select aria-label={t("Instance")} value={instance} onChange={(e) => setInstance(e.target.value)}>
            <option value="">{t("All instances")}</option>
            {(instances.data ?? []).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </Select>
        </div>
        {chips.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-4 py-2.5 text-sm">
            <span className="font-medium text-slate-700">{t("Active filters")}</span>
            {chips.map((c) => (
              <button key={c.label} type="button" onClick={c.clear} className="rounded-md bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800 ring-1 ring-inset ring-emerald-200 hover:bg-emerald-100">
                {c.label} <span aria-hidden>×</span><span className="sr-only">{t("Remove filter")}</span>
              </button>
            ))}
            <button type="button" className="ml-auto text-xs text-slate-500 underline" onClick={() => { setStatus(''); setEvent(''); setEndpoint(''); setInstance(''); }}>{t("Clear all")}</button>
          </div>
        )}
        {logs.isError ? <div className="p-4"><ErrorState error={logs.error} onRetry={() => logs.refetch()} /></div> : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <caption className="sr-only">{t("Webhook Logs")}</caption>
              <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-600">
                <tr>{[t("Time"), t("Endpoint URL"), t("Instance"), t("Event"), t("Status"), t("Response (ms)"), t("Retries"), '']
                  .map((h, i) => <th key={i} scope="col" className="whitespace-nowrap px-4 py-3">{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {logs.isLoading ? <tr><td colSpan={8} className="p-4"><LoadingSkeleton rows={4} /></td></tr>
                  : !items.length ? <tr><td colSpan={8} className="p-4"><EmptyState title={t("No webhook calls yet")} body={t("Every call we make to your webhook URLs shows up here with its response.")}
                      action={<Link href="/developers/webhooks" className="text-sm font-medium text-emerald-800 underline">{t("Manage webhooks")}</Link>} /></td></tr>
                  : items.map((l) => (
                    <tr key={l.id} className="cursor-pointer whitespace-nowrap hover:bg-slate-50" onClick={() => setOpen(l.id)}>
                      <td className="px-4 py-3">{dateTime(l.createdAt)}</td>
                      <td className="max-w-xs truncate px-4 py-3" title={l.endpoint.url}>{l.endpoint.url}</td>
                      <td className="px-4 py-3">{l.instance?.name ?? '—'}</td>
                      <td className="px-4 py-3"><StatusBadge tone="green">{eventLabel(l.eventType)}</StatusBadge></td>
                      <td className="px-4 py-3"><HttpBadge l={l} /></td>
                      <td className="px-4 py-3 tabular-nums">{l.latencyMs ?? '—'}</td>
                      <td className="px-4 py-3"><StatusBadge tone={l.retries ? 'amber' : 'green'}>{String(l.retries)}</StatusBadge></td>
                      <td className="px-4 py-3"><button type="button" className="rounded px-2 text-lg leading-none text-slate-500 hover:bg-slate-100" aria-label={t("Details")}
                        onClick={(e) => { e.stopPropagation(); setOpen(l.id); }}>⋮</button></td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
        {logs.hasNextPage && <div className="border-t border-slate-200 p-4"><Button variant="secondary" size="sm" loading={logs.isFetchingNextPage} onClick={() => logs.fetchNextPage()}>{t("Load more")}</Button></div>}
      </div>
      {open && <LogDetail id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function Header() {
  return (
    <div className="mb-6">
      <nav aria-label={t("Breadcrumb")} className="mb-1 flex items-center gap-2 text-sm text-slate-500">
        <Link href="/developers/webhooks" className="hover:underline">{t("Webhooks")}</Link><span aria-hidden>›</span><span className="text-slate-700">{t("Webhook Logs")}</span>
      </nav>
      <h1 className="text-2xl font-bold text-slate-900 sm:text-3xl">{t("Webhook Logs")}</h1>
      <p className="mt-1 text-sm text-slate-600">{t("Every call we made to your webhook URLs, with the response your server sent. Updates every 10 seconds.")}</p>
    </div>
  );
}

function LogDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { orgId } = useWorkspace();
  const qc = useQueryClient();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  const d = useQuery({ queryKey: ['org', orgId, 'webhook-logs', 'one', id], queryFn: () => api<Log>(`/v1/webhook-logs/${id}`) });
  const retry = useMutation({ mutationFn: () => api(`/v1/webhook-logs/${id}/retry`, { method: 'POST' }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['org', orgId, 'webhook-logs'] }); } });
  const l = d.data;
  return (
    <dialog ref={ref} onClose={onClose} aria-label={t("Webhook call")}
      className="m-0 ml-auto h-full max-h-none w-full max-w-2xl bg-white p-0 shadow-xl backdrop:bg-slate-900/40">
      <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
        <h2 className="text-lg font-semibold text-slate-900">{t("Webhook call")}</h2>
        <button type="button" onClick={() => ref.current?.close()} className="rounded px-2 text-xl text-slate-500 hover:bg-slate-100" aria-label={t("Close")}>×</button>
      </div>
      <div className="space-y-5 overflow-y-auto p-5 text-sm">
        {d.isError ? <ErrorState error={d.error} onRetry={() => d.refetch()} /> : !l ? <LoadingSkeleton rows={6} /> : (
          <>
            <dl className="grid gap-4 sm:grid-cols-2">
              <div><dt className="text-xs text-slate-500">{t("Event")}</dt><dd className="font-medium">{eventLabel(l.eventType)} <code className="text-xs text-slate-500">{l.eventId}</code></dd></div>
              <div><dt className="text-xs text-slate-500">{t("Status")}</dt><dd className="flex items-center gap-2"><HttpBadge l={l} /><span className="text-xs text-slate-500">{t(DELIVERY_TEXT[l.status] ?? l.status)}</span></dd></div>
              <div className="sm:col-span-2"><dt className="text-xs text-slate-500">{t("Endpoint URL")}</dt><dd className="break-all"><Link className="underline" href={`/developers/webhooks/${l.endpoint.id}`}>{l.endpoint.name}</Link> · {l.endpoint.url}</dd></div>
              <div><dt className="text-xs text-slate-500">{t("Instance")}</dt><dd>{l.instance?.name ?? '—'}</dd></div>
              <div><dt className="text-xs text-slate-500">{t("Response (ms)")}</dt><dd>{l.latencyMs ?? '—'}</dd></div>
              <div><dt className="text-xs text-slate-500">{t("Created at")}</dt><dd>{dateTime(l.createdAt)}</dd></div>
              <div><dt className="text-xs text-slate-500">{t("Attempts")}</dt><dd>{l.attempts}{l.nextRetryAt && <span className="text-xs text-slate-500"> · {t("next try")}{' '}{dateTime(l.nextRetryAt)}</span>}</dd></div>
            </dl>
            {l.error && <Notice tone="error">{l.error}</Notice>}
            <div>
              <p className="text-xs font-medium text-slate-500">{t("Payload we sent")}</p>
              <pre className="mt-1 max-h-72 overflow-auto rounded-lg bg-[#050914] p-3 text-xs text-[#d6deeb]">{JSON.stringify(l.payload, null, 2)}</pre>
            </div>
            <div>
              <p className="text-xs font-medium text-slate-500">{t("Response from your server (first 4 KB)")}</p>
              <pre className={cx('mt-1 max-h-48 overflow-auto rounded-lg p-3 text-xs', l.responseBodySnippet ? 'bg-slate-100' : 'bg-slate-50 text-slate-400')}>{l.responseBodySnippet || '—'}</pre>
            </div>
            {retry.isError && <Notice tone="error">{friendlyMessage(retry.error)}</Notice>}
            {retry.isSuccess && <Notice tone="success">{t("Queued for another try.")}</Notice>}
            {l.retryable && <Button loading={retry.isPending} onClick={() => retry.mutate()}>{t("Retry now")}</Button>}
          </>
        )}
      </div>
    </dialog>
  );
}
