'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type ReactNode } from 'react';
import { ConnectionPanel } from '@/components/whatsapp/connection-panel';
import { ApiDocs, ApiKeyField, Copy } from '@/components/whatsapp/instance-api';
import { Activity } from '@/components/whatsapp/activity';
import { Button, Card, ConfirmDialog, EmptyState, ErrorState, InstanceStatus, LoadingSkeleton, Notice, StatusBadge } from '@/components/ui';
import { api, ApiError, friendlyMessage } from '@/lib/api';
import { dateTime, timeAgo } from '@/lib/format';
import { can } from '@/lib/permissions';
import type { Instance, InstanceHealth, Webhook } from '@/lib/types';
import { qk, useWorkspace } from '@/lib/workspace';
import { t, msg } from '@/lib/i18n';

export default function InstancePage() {
  return <Suspense><InstanceDetail /></Suspense>;
}

/**
 * One "connect instance" page (gateway style): details + credentials on the left, the live connection
 * (QR, or a big "connected" check with Stop / Restart / Logout) on the right, then the API documentation,
 * webhooks and connection history below.
 */
function InstanceDetail() {
  const { id } = useParams<{ id: string }>();
  const search = useSearchParams();
  const { orgId, role, businesses } = useWorkspace();
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const inst = useQuery({ queryKey: qk.instance(orgId, id), queryFn: () => api<Instance>(`/v1/whatsapp/instances/${id}`) });
  const health = useQuery({ queryKey: [...qk.instance(orgId, id), 'status'], queryFn: () => api<InstanceHealth>(`/v1/whatsapp/instances/${id}/status`), refetchInterval: 30_000 });

  if (inst.isError) {
    return inst.error instanceof ApiError && inst.error.status === 404
      ? <EmptyState title={t("Instance not found")} body={t("It does not exist or you do not have access to it.")} action={<Link href="/whatsapp/instances"><Button variant="secondary">{t("Back to instances")}</Button></Link>} />
      : <ErrorState error={inst.error} onRetry={() => inst.refetch()} />;
  }
  if (!inst.data) return <LoadingSkeleton />;
  const i = inst.data;
  const h = health.data;
  const status = h?.status ?? i.status;
  const connected = status === 'CONNECTED';
  const phone = h?.phoneNumber ?? i.phoneNumber;
  const chatId = phone ? `${phone.replace(/^\+/, '')}@c.us` : null;
  const businessName = businesses.find((b) => b.id === i.businessId)?.name;

  return (
    <>
      <nav aria-label={t("Breadcrumb")} className="mb-2 flex items-center gap-2 text-sm text-slate-500">
        <Link href="/whatsapp/instances" className="hover:text-slate-800 hover:underline">{t("Instances")}</Link><span aria-hidden>›</span><span className="text-slate-700">{i.name}</span>
      </nav>
      <h1 className="mb-6 text-2xl font-bold text-slate-900 sm:text-3xl">{t("Connect Instance")}</h1>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card>
          <dl className="space-y-6">
            <Detail label={t("Instance ID")}>
              <span className="flex items-center gap-2"><Copy value={i.id} icon label={t("Copy Instance ID")} /><code className="break-all text-sm text-slate-900">{i.id}</code></span>
            </Detail>
            <Detail label={t("Api Key (Bearer Token)")}><ApiKeyField id={id} fresh={freshKey} onFresh={setFreshKey} /></Detail>
            <div className="grid gap-6 sm:grid-cols-3">
              <div className="flex items-center gap-3">
                <span aria-hidden className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-lg font-semibold text-emerald-800">
                  {(h?.displayName ?? i.displayName ?? i.name).trim().charAt(0).toUpperCase()}
                </span>
                <span className="text-xs text-slate-500">{t("WhatsApp Profile")}</span>
              </div>
              <Detail label={t("WhatsApp Name")}>{h?.displayName ?? i.displayName ?? '—'}</Detail>
              <Detail label={t("WhatsApp ID")}>
                {chatId ? <span className="flex items-center gap-2"><span className="break-all">{chatId}</span><Copy value={chatId} icon label={t("Copy WhatsApp ID")} /></span> : '—'}
              </Detail>
              <Detail label={t("Instance Name")}>{i.name}</Detail>
              <Detail label={t("Service Type")}><StatusBadge tone="green">{t("WhatsApp")}</StatusBadge></Detail>
              <Detail label={t("Status")}>
                {connected
                  ? <StatusBadge tone={h?.worker.healthy === false ? 'amber' : 'green'}>{h?.worker.healthy === false ? t("Recovering") : t("Working")}</StatusBadge>
                  : <InstanceStatus status={status} />}
              </Detail>
            </div>
            <div className="grid gap-6 border-t border-slate-100 pt-4 sm:grid-cols-3">
              <Detail label={t("Business")}>{businessName ?? '—'}</Detail>
              <Detail label={t("Connected at")}>{dateTime(h?.connectedAt ?? i.connectedAt)}</Detail>
              <Detail label={t("Last seen")}>{timeAgo(h?.lastSeenAt ?? i.lastSeenAt)}</Detail>
            </div>
          </dl>
        </Card>

        <ConnectionSide i={i} status={status} autoConnect={search.get('connect') === '1'} canWrite={can(role, 'instances:write')} />
      </div>

      <section className="mt-8"><ApiDocs id={id} connected={connected} fresh={freshKey} /></section>
      <section className="mt-6"><WebhooksTab i={i} /></section>
      <section className="mt-6"><Activity id={id} /></section>
    </>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-sm font-semibold text-slate-900">{label}</dt>
      <dd className="mt-1.5 text-sm text-slate-700">{children}</dd>
    </div>
  );
}

type Action = 'RESTART' | 'DISCONNECT' | 'LOGOUT' | 'DELETE';
const ACTION_COPY: Record<Action, { label: string; title: string; body: string; path: string; method: string; tone: 'danger' | 'primary' }> = {
  RESTART: { label: msg("Restart"), title: msg("Restart connection?"), body: msg("The connection is closed and reopened. Your WhatsApp stays linked — no QR needed."), path: 'restart', method: 'POST', tone: 'primary' },
  DISCONNECT: { label: msg("Stop"), title: msg("Disconnect temporarily?"), body: msg("We stop receiving and sending messages until you reconnect. Your WhatsApp stays linked, so reconnecting does not need a QR."), path: 'disconnect', method: 'POST', tone: 'primary' },
  LOGOUT: { label: msg("Logout"), title: msg("Log out this WhatsApp?"), body: msg("The linked device is removed from your phone and stored credentials are destroyed. To use this number again you must scan a new QR code."), path: 'logout', method: 'POST', tone: 'danger' },
  DELETE: { label: msg("Delete instance"), title: msg("Delete this instance?"), body: msg("The instance is removed from the platform and logged out. Past messages are kept according to your retention policy. This cannot be undone."), path: '', method: 'DELETE', tone: 'danger' },
};
const ACTION_STYLE: Record<Exclude<Action, 'DELETE'>, string> = {
  DISCONNECT: 'bg-amber-500 text-white hover:bg-amber-600', RESTART: 'bg-blue-600 text-white hover:bg-blue-700', LOGOUT: 'bg-red-600 text-white hover:bg-red-700',
};

/** Right column: QR / pairing while not linked; a big check + Stop / Restart / Logout once connected. */
function ConnectionSide({ i, status, autoConnect, canWrite }: { i: Instance; status: Instance['status']; autoConnect: boolean; canWrite: boolean }) {
  const { orgId } = useWorkspace();
  const qc = useQueryClient();
  const router = useRouter();
  const [pending, setPending] = useState<Action | null>(null);
  const m = useMutation({
    mutationFn: (a: Action) => api(`/v1/whatsapp/instances/${i.id}${ACTION_COPY[a].path ? `/${ACTION_COPY[a].path}` : ''}`, { method: ACTION_COPY[a].method }),
    onSuccess: (_d, a) => {
      setPending(null);
      void qc.invalidateQueries({ queryKey: ['org', orgId] });
      if (a === 'DELETE') router.push('/whatsapp/instances');
    },
  });
  const connected = status === 'CONNECTED';
  const available: Array<Exclude<Action, 'DELETE'>> = [
    ...(['CONNECTED', 'RECONNECTING', 'WAITING_FOR_QR', 'PAIRING'].includes(status) ? ['DISCONNECT' as const] : []),
    ...(['CONNECTED', 'RECONNECTING', 'DISCONNECTED', 'ERROR'].includes(status) ? ['RESTART' as const] : []),
    ...(status !== 'LOGGED_OUT' && status !== 'CREATED' ? ['LOGOUT' as const] : []),
  ];
  const cur = pending ? ACTION_COPY[pending] : null;
  return (
    <div className="flex flex-col items-center p-2 text-center">
      <a href="https://faq.whatsapp.com/1313491802751163" target="_blank" rel="noreferrer" className="mb-4 text-sm text-emerald-800 underline">🛡️ {t("WhatsApp Block Prevention Guide")}</a>
      {connected ? (
        <>
          <p className="text-lg font-semibold text-slate-900">{t("Instance is Connected")}</p>
          <svg viewBox="0 0 120 120" className="my-6 h-40 w-40 text-emerald-500" role="img" aria-label={t("Connected")}>
            <circle cx="60" cy="60" r="52" fill="none" stroke="currentColor" strokeWidth="8" />
            <path d="M36 62 L53 78 L86 44" fill="none" stroke="currentColor" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </>
      ) : (
        <div className="w-full"><ConnectionPanel instanceId={i.id} status={status} canWrite={canWrite} autoConnect={autoConnect} compact /></div>
      )}
      {canWrite && available.length > 0 && (
        <div className="mt-4 flex flex-wrap justify-center gap-3">
          {available.map((a) => (
            <button key={a} type="button" onClick={() => setPending(a)}
              className={`rounded-md px-4 py-2 text-sm font-semibold shadow-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 ${ACTION_STYLE[a]}`}>
              {t(ACTION_COPY[a].label)}
            </button>
          ))}
        </div>
      )}
      {connected && <p className="mt-4 max-w-xs text-xs text-slate-500">{t("Stop keeps your WhatsApp linked. Logout unlinks it (new QR needed).")}</p>}
      {canWrite && <button type="button" onClick={() => setPending('DELETE')} className="mt-6 text-xs text-slate-500 underline hover:text-red-700">{t("Delete instance")}</button>}
      {m.isError && <div className="mt-3 w-full"><Notice tone="error">{friendlyMessage(m.error)}</Notice></div>}
      <ConfirmDialog open={Boolean(pending)} title={cur ? t(cur.title) : ''} body={cur ? t(cur.body) : ''} confirmLabel={cur ? t(cur.label) : ''} tone={cur?.tone}
        confirmText={pending === 'DELETE' ? i.name : undefined} busy={m.isPending} onClose={() => setPending(null)} onConfirm={() => pending && m.mutate(pending)} />
    </div>
  );
}

function WebhooksTab({ i }: { i: Instance }) {
  const { orgId, role } = useWorkspace();
  const q = useQuery({ queryKey: ['org', orgId, 'webhooks'], queryFn: () => api<Webhook[]>('/v1/webhooks'), enabled: can(role, 'webhooks:manage') });
  if (!can(role, 'webhooks:manage')) return <Notice>{t("Only owners and admins can view webhooks.")}</Notice>;
  const applies = (q.data ?? []).filter((w) => w.scope === 'ORGANIZATION' || (w.scope === 'BUSINESS' && w.businessId === i.businessId) || w.instanceId === i.id);
  return (
    <Card title={t("Webhooks receiving this instance’s events")} actions={<span className="flex gap-3"><Link href={`/developers/webhooks/create?instanceId=${i.id}`} className="text-sm font-medium text-emerald-800 underline">{t("+ Connect a webhook")}</Link><Link href="/developers/webhooks" className="text-sm text-slate-600 underline">{t("Manage webhooks")}</Link></span>}>
      {q.isLoading ? <LoadingSkeleton rows={2} /> : !applies.length ? <p className="text-sm text-slate-500">{t("No webhooks configured.")}</p> : (
        <ul className="divide-y divide-slate-100">
          {applies.map((w) => (
            <li key={w.id} className="flex items-center justify-between py-2 text-sm">
              <Link href={`/developers/webhooks/${w.id}`} className="font-medium text-slate-900 hover:underline">{w.name}</Link>
              <span className="text-slate-500">{w.scope.toLowerCase()} · {w.enabled ? t("enabled") : t("disabled")}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
