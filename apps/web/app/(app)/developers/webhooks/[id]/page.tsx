'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button, Card, ConfirmDialog, EmptyState, ErrorState, Field, Input, LoadingSkeleton, Notice, PageHeader, StatusBadge } from '@/components/ui';
import { api, ApiError, friendlyMessage, qs } from '@/lib/api';
import { flatten } from '@/lib/cache-merge';
import { dateTime } from '@/lib/format';
import type { Page, Webhook } from '@/lib/types';
import { useWorkspace } from '@/lib/workspace';
import { EventPicker } from '@/components/webhooks/event-picker';
import { SecretInput } from '@/components/webhooks/secret-input';
import { t } from '@/lib/i18n';

interface Delivery {
  id: string; eventId: string; eventType: string; status: string; attempts: number; httpStatus: number | null; createdAt: string; lastAttemptAt: string | null;
  deliveredAt: string | null; nextRetryAt: string | null; latencyMs: number | null; error: string | null; responseBodySnippet: string | null; payload: unknown; retryable: boolean;
}

export default function WebhookDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { orgId } = useWorkspace();
  const qc = useQueryClient();
  const router = useRouter();
  const key = ['org', orgId, 'webhook', id];
  const w = useQuery({ queryKey: key, queryFn: () => api<Webhook>(`/v1/webhooks/${id}`) });
  const logs = useInfiniteQuery({
    queryKey: [...key, 'deliveries'],
    queryFn: ({ pageParam }) => api<Page<Delivery>>(`/v1/webhooks/${id}/deliveries${qs({ cursor: pageParam })}`),
    initialPageParam: null as string | null, getNextPageParam: (p) => p.nextCursor, refetchInterval: 10_000,
  });
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const refresh = () => { void qc.invalidateQueries({ queryKey: key }); void qc.invalidateQueries({ queryKey: ['org', orgId, 'webhooks'] }); };

  const update = useMutation({ mutationFn: (body: object) => api<Webhook>(`/v1/webhooks/${id}`, { method: 'PATCH', body }), onSuccess: () => { setEditing(false); refresh(); } });
  const test = useMutation({ mutationFn: () => api(`/v1/webhooks/${id}/test`, { method: 'POST' }), onSuccess: () => { setNotice(t("Test event queued. It appears in the log within a few seconds.")); setTimeout(() => void logs.refetch(), 2500); } });
  const retry = useMutation({ mutationFn: (d: string) => api(`/v1/webhooks/${id}/deliveries/${d}/retry`, { method: 'POST' }), onSuccess: () => void logs.refetch() });
  const del = useMutation({ mutationFn: () => api(`/v1/webhooks/${id}`, { method: 'DELETE' }), onSuccess: () => { refresh(); router.push('/developers/webhooks'); } });

  if (w.isError) {
    return w.error instanceof ApiError && w.error.status === 404
      ? <EmptyState title={t("Webhook not found")} action={<Link href="/developers/webhooks"><Button variant="secondary">{t("Back")}</Button></Link>} />
      : <ErrorState error={w.error} onRetry={() => w.refetch()} />;
  }
  if (!w.data) return <LoadingSkeleton />;
  const h = w.data;
  const err = update.error ?? test.error ?? retry.error ?? del.error;

  const save = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const authHeader = String(f.get('authHeader') ?? '').trim();
    update.mutate({ name: f.get('name'), url: f.get('url'), eventTypes: f.getAll('events').map(String),
      // empty = keep the current value; the checkbox removes it
      ...(f.get('removeAuth') === 'on' ? { authorizationHeader: null } : authHeader ? { authorizationHeader: authHeader } : {}) });
  };

  return (
    <>
      <PageHeader title={h.name} description={h.url}
        actions={<>
          <Button variant="secondary" onClick={() => update.mutate({ enabled: !h.enabled })} loading={update.isPending}>{h.enabled ? t("Disable") : t("Enable")}</Button>
          <Button variant="secondary" onClick={() => test.mutate()} loading={test.isPending} disabled={!h.enabled}>{t("Send test event")}</Button>
          <Button variant="secondary" onClick={() => setEditing((v) => !v)}>{t("Edit")}</Button>
          <Button variant="danger" onClick={() => setConfirmDelete(true)}>{t("Delete")}</Button>
        </>} />
      {err && <div className="mb-4"><Notice tone="error">{friendlyMessage(err)}</Notice></div>}
      {notice && <div className="mb-4"><Notice tone="success">{notice}</Notice></div>}

      {editing ? (
        <form onSubmit={save} className="mb-6 space-y-4 rounded-lg bg-white p-4 shadow-sm ring-1 ring-slate-200">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("Name")}>{(fid) => <Input id={fid} name="name" defaultValue={h.name} required maxLength={100} />}</Field>
            <Field label={t("Endpoint URL")}>{(fid) => <Input id={fid} name="url" type="url" defaultValue={h.url} required pattern="https://.*" />}</Field>
          </div>
          <Field label={t("Authorization header (optional)")} hint={h.hasAuthHeader ? t("A value is set. Leave empty to keep it, or type a new one to replace it.") : t("Sent as the Authorization header with every webhook call, e.g. \"Bearer my-secret\". Every call is also signed (X-Webhook-Signature).")}>{(fid, d) => (
            <SecretInput id={fid} aria-describedby={d} name="authHeader" maxLength={500} pattern="[ -~]*" placeholder={h.hasAuthHeader ? "••••••••" : ""} />)}</Field>
          {h.hasAuthHeader && <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="removeAuth" /> {t("Remove the Authorization header")}</label>}
          <EventPicker selected={h.events} />
          <div className="flex gap-2"><Button type="submit" loading={update.isPending}>{t("Save")}</Button><Button type="button" variant="secondary" onClick={() => setEditing(false)}>{t("Cancel")}</Button></div>
        </form>
      ) : (
        <Card title={t("Configuration")} className="mb-6">
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div><dt className="text-xs text-slate-500">{t("Status")}</dt><dd><StatusBadge tone={h.enabled ? 'green' : 'slate'}>{h.enabled ? t("Enabled") : t("Disabled")}</StatusBadge></dd></div>
            <div><dt className="text-xs text-slate-500">{t("Scope")}</dt><dd>{h.scope === 'ORGANIZATION' ? t("Whole organization") : h.scope === 'BUSINESS' ? h.businessName : h.instanceName}</dd></div>
            <div><dt className="text-xs text-slate-500">{t("Signing secret")}</dt><dd>•••• {h.secretLast4 ?? ''} <span className="text-xs text-slate-500">{t("(shown only at creation)")}</span></dd></div>
            <div><dt className="text-xs text-slate-500">{t("Authorization header")}</dt><dd>{h.hasAuthHeader ? <>•••••••• <span className="text-xs text-slate-500">{t("(set, never shown)")}</span></> : t("Not set")}</dd></div>
            <div><dt className="text-xs text-slate-500">{t("Events")}</dt><dd className="text-xs">{h.events.join(', ')}</dd></div>
          </dl>
        </Card>
      )}

      <Card title={t("Delivery log")}>
        {logs.isLoading ? <LoadingSkeleton /> : !flatten(logs.data).length ? <p className="text-sm text-slate-500">{t("No deliveries yet. Send a test event to try it.")}</p> : (
          <ul className="divide-y divide-slate-100">
            {flatten(logs.data).map((d) => (
              <li key={d.id} className="py-2 text-sm">
                <div className="flex flex-wrap items-center gap-3">
                  <button className="font-mono text-xs text-slate-900 underline-offset-2 hover:underline" aria-expanded={open === d.id} onClick={() => setOpen(open === d.id ? null : d.id)}>{d.eventType}</button>
                  <StatusBadge tone={d.status === 'DELIVERED' ? 'green' : d.status === 'DEAD' || d.status === 'FAILED' ? 'red' : 'amber'}>{d.status.toLowerCase()}</StatusBadge>
                  <span className="text-slate-500">{dateTime(d.createdAt)}</span>
                  <span className="text-slate-500">{t("attempts")}{' '}{d.attempts}</span>
                  {d.httpStatus && <span className="text-slate-500">{t("HTTP")}{' '}{d.httpStatus}</span>}
                  {d.retryable && <Button size="sm" variant="secondary" loading={retry.isPending} onClick={() => retry.mutate(d.id)}>{t("Retry")}</Button>}
                </div>
                {open === d.id && (
                  <div className="mt-2 grid gap-3 lg:grid-cols-2">
                    <div><p className="text-xs font-medium text-slate-500">{t("Payload (")}{d.eventId})</p><pre className="mt-1 max-h-64 overflow-auto rounded bg-[#050914] p-2 text-[11px] text-[#d6deeb] ring-1 ring-slate-200">{JSON.stringify(d.payload, null, 2)}</pre></div>
                    <div><p className="text-xs font-medium text-slate-500">{t("Response (first 4 KB)")}</p><pre className="mt-1 max-h-64 overflow-auto rounded bg-slate-100 p-2 text-[11px]">{d.responseBodySnippet ?? d.error ?? '—'}</pre>
                      <p className="mt-1 text-xs text-slate-500">{t("Latency is not recorded yet.")}</p></div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {logs.hasNextPage && <Button variant="secondary" size="sm" className="mt-3" onClick={() => logs.fetchNextPage()}>{t("Load more")}</Button>}
      </Card>
      <ConfirmDialog open={confirmDelete} title={t("Delete webhook?")} body={t("No more events will be sent to this URL.")} confirmLabel={t("Delete")} busy={del.isPending}
        onClose={() => setConfirmDelete(false)} onConfirm={() => del.mutate()} />
    </>
  );
}
