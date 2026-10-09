'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Activity } from '@/components/whatsapp/activity';
import { canManageApi, Copy } from '@/components/whatsapp/instance-api';
import { Button, ConfirmDialog, EmptyState, ErrorState, Field, Input, InstanceStatus, LoadingSkeleton, Notice, Select, StatusBadge, cx } from '@/components/ui';
import { api, friendlyMessage } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { can } from '@/lib/permissions';
import type { Instance } from '@/lib/types';
import { qk, useWorkspace } from '@/lib/workspace';
import { msg, t } from '@/lib/i18n';

export default function InstancesPage() {
  return <Suspense><Instances /></Suspense>;
}

type View = 'ALL' | 'CONNECTED' | 'OTHER';
const VIEWS: Array<{ id: View; label: string }> = [{ id: 'ALL', label: msg("All Instances") }, { id: 'CONNECTED', label: msg("Connected") }, { id: 'OTHER', label: msg("Not connected") }];

function Instances() {
  const { orgId, businessId, businesses, role } = useWorkspace();
  const router = useRouter();
  const params = useSearchParams();
  const [creating, setCreating] = useState(params.get('new') === '1');
  const [view, setView] = useState<View>('ALL');
  const [idSearch, setIdSearch] = useState('');
  const [nameSearch, setNameSearch] = useState('');
  const [perPage, setPerPage] = useState(10);
  const [page, setPage] = useState(0);
  const q = useQuery({ queryKey: qk.scoped(orgId, businessId, 'instances'), queryFn: () => api<Instance[]>('/v1/whatsapp/instances') });
  const writable = can(role, 'instances:write');
  const all = (q.data ?? []).filter((i) => !businessId || i.businessId === businessId);
  const count = (v: View) => all.filter((i) => v === 'ALL' || (v === 'CONNECTED') === (i.status === 'CONNECTED')).length;
  const rows = all
    .filter((i) => view === 'ALL' || (view === 'CONNECTED') === (i.status === 'CONNECTED'))
    .filter((i) => !idSearch.trim() || i.id.includes(idSearch.trim().toLowerCase()))
    .filter((i) => !nameSearch.trim() || `${i.name} ${i.phoneNumber ?? ''} ${i.displayName ?? ''}`.toLowerCase().includes(nameSearch.trim().toLowerCase()))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const pages = Math.max(1, Math.ceil(rows.length / perPage));
  const shown = rows.slice(Math.min(page, pages - 1) * perPage, Math.min(page, pages - 1) * perPage + perPage);
  const bizName = (id: string) => businesses.find((b) => b.id === id)?.name ?? '—';

  return (
    <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <nav aria-label={t("Breadcrumb")} className="mb-1 flex items-center gap-2 text-sm text-slate-500"><span>{t("Instances")}</span><span aria-hidden>›</span><span className="text-slate-700">{t("List")}</span></nav>
          <h1 className="text-2xl font-bold text-slate-900 sm:text-3xl">{t("Instances")}</h1>
        </div>
        {writable && <Button onClick={() => setCreating(true)}>{t("Create Instance")}</Button>}
      </div>
      {creating && <CreateInstance onDone={(id) => (id ? router.push(`/whatsapp/instances/${id}?connect=1`) : setCreating(false))} />}

      <div className="mb-6 flex justify-center">
        <div role="tablist" aria-label={t("Instance filter")} className="inline-flex gap-1 rounded-xl bg-white p-1.5 shadow-sm ring-1 ring-slate-200">
          {VIEWS.map((v) => (
            <button key={v.id} role="tab" aria-selected={view === v.id} onClick={() => { setView(v.id); setPage(0); }}
              className={cx('rounded-lg px-4 py-1.5 text-sm font-medium', view === v.id ? 'bg-emerald-50 text-emerald-800' : 'text-slate-600 hover:bg-slate-50')}>
              {t(v.label)} <span className="ml-1 text-xs text-slate-500">{q.data ? count(v.id) : ''}</span>
            </button>
          ))}
        </div>
      </div>

      {q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
        <div className="rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <caption className="sr-only">{t("Instances")}</caption>
              <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-600">
                <tr>{[t("UUID"), t("Instance Name"), t("Business"), t("WhatsApp number"), t("Service Type"), t("Status"), t("Created At"), '']
                  .map((h, i) => <th key={i} scope="col" className="whitespace-nowrap px-4 py-3">{h}</th>)}</tr>
                <tr className="border-t border-slate-200 bg-white font-normal normal-case">
                  <th className="px-4 py-2"><Search value={idSearch} onChange={(v) => { setIdSearch(v); setPage(0); }} label={t("Search by instance ID")} /></th>
                  <th className="px-4 py-2"><Search value={nameSearch} onChange={(v) => { setNameSearch(v); setPage(0); }} label={t("Search by name or number")} /></th>
                  <th colSpan={6} />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {q.isLoading ? <tr><td colSpan={8} className="p-4"><LoadingSkeleton rows={3} /></td></tr>
                  : !shown.length ? (
                    <tr><td colSpan={8} className="p-4">
                      {all.length ? <p className="py-6 text-center text-sm text-slate-500">{t("No instance matches these filters.")}</p>
                        : <EmptyState title={t("No WhatsApp connected yet.")} body={t("Create an instance, then scan the QR code with the WhatsApp app on your business phone.")}
                            action={writable ? <Button onClick={() => setCreating(true)}>{t("Create Instance")}</Button> : undefined} />}
                    </td></tr>
                  ) : shown.map((i) => (
                    <tr key={i.id} className="whitespace-nowrap">
                      <td className="px-4 py-3"><span className="flex items-center gap-2"><Copy value={i.id} icon label={t("Copy Instance ID")} />
                        <Link href={`/whatsapp/instances/${i.id}`} className="font-mono text-xs text-slate-900 hover:underline">{i.id}</Link></span></td>
                      <td className="px-4 py-3"><Link href={`/whatsapp/instances/${i.id}`} className="font-medium text-slate-900 hover:underline">{i.name}</Link>
                        {i.description && <span className="block max-w-[14rem] truncate text-xs text-slate-500">{i.description}</span>}</td>
                      <td className="px-4 py-3">{bizName(i.businessId)}</td>
                      <td className="px-4 py-3">{i.phoneNumber ?? '—'}{i.displayName && <span className="block text-xs text-slate-500">{i.displayName}</span>}</td>
                      <td className="px-4 py-3"><StatusBadge tone="green">{t("WhatsApp")}</StatusBadge></td>
                      <td className="px-4 py-3">{i.status === 'CONNECTED' ? <StatusBadge tone="green">{t("Working")}</StatusBadge> : <InstanceStatus status={i.status} />}</td>
                      <td className="px-4 py-3">{dateTime(i.createdAt)}</td>
                      <td className="px-4 py-3"><RowActions i={i} writable={writable} /></td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 p-4 text-sm">
            <span className="font-medium text-slate-700">{rows.length === 1 ? t("Showing 1 result") : t("Showing {n} results", { n: rows.length })}</span>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-2 text-slate-600">{t("Per page")}
                <Select className="w-20" value={String(perPage)} onChange={(e) => { setPerPage(Number(e.target.value)); setPage(0); }}>
                  {[10, 25, 50].map((n) => <option key={n} value={n}>{n}</option>)}
                </Select>
              </label>
              {pages > 1 && <>
                <Button size="sm" variant="secondary" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>{t("Previous")}</Button>
                <span className="text-slate-500">{page + 1} / {pages}</span>
                <Button size="sm" variant="secondary" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>{t("Next")}</Button>
              </>}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Search({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <label className="relative block">
      <span className="sr-only">{label}</span>
      <svg aria-hidden viewBox="0 0 24 24" className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
      <input type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={t("Search")}
        className="w-full min-w-[11rem] rounded-md border-0 bg-white py-1.5 pl-8 pr-2 text-sm text-slate-900 ring-1 ring-inset ring-slate-300 placeholder:text-slate-400 focus:ring-2 focus:ring-inset focus:ring-emerald-600" />
    </label>
  );
}

/** Native <dialog> (focus trap + Esc). */
function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return (
    <dialog ref={ref} onClose={onClose} aria-label={title} className={cx('w-full rounded-xl bg-white p-0 shadow-xl backdrop:bg-slate-900/40', wide ? 'max-w-2xl' : 'max-w-md')}>
      <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
        <button type="button" onClick={() => ref.current?.close()} className="rounded px-2 text-xl text-slate-500 hover:bg-slate-100" aria-label={t("Close")}>×</button>
      </div>
      <div className="max-h-[70vh] overflow-y-auto p-5">{children}</div>
    </dialog>
  );
}

type Pending = 'history' | 'edit' | 'token' | 'restart' | 'logout' | 'delete' | null;

/** Status History · Edit · ⋮ (Regenerate access token, Restart, Logout, Delete) - same as the instance page. */
function RowActions({ i, writable }: { i: Instance; writable: boolean }) {
  const { orgId, role } = useWorkspace();
  const qc = useQueryClient();
  const [pending, setPending] = useState<Pending>(null);
  const [menu, setMenu] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', close);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); };
  }, [menu]);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['org', orgId] });
  const command = useMutation({
    mutationFn: (a: 'restart' | 'logout' | 'delete') => api(`/v1/whatsapp/instances/${i.id}${a === 'delete' ? '' : `/${a}`}`, { method: a === 'delete' ? 'DELETE' : 'POST' }),
    onSuccess: () => { setPending(null); refresh(); },
  });
  const token = useMutation({
    mutationFn: () => api<{ apiKey: string }>(`/v1/whatsapp/instances/${i.id}/api-key`, { method: 'POST' }),
    onSuccess: (r) => { setNewKey(r.apiKey); setPending(null); refresh(); },
  });
  const edit = useMutation({
    mutationFn: (body: object) => api<Instance>(`/v1/whatsapp/instances/${i.id}`, { method: 'PATCH', body }),
    onSuccess: () => { setPending(null); refresh(); },
  });
  const submitEdit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    edit.mutate({ name: String(f.get('name')).trim(), description: String(f.get('description') ?? '').trim() || null });
  };
  const item = 'flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-slate-50';
  const canLogout = !['LOGGED_OUT', 'CREATED'].includes(i.status);
  const canRestart = ['CONNECTED', 'RECONNECTING', 'DISCONNECTED', 'ERROR'].includes(i.status);

  return (
    <div className="flex items-center justify-end gap-3">
      <button type="button" onClick={() => setPending('history')} className="flex items-center gap-1 text-sm font-medium text-emerald-800 hover:underline">🕘 {t("Status History")}</button>
      {writable && <button type="button" onClick={() => setPending('edit')} className="flex items-center gap-1 text-sm font-medium text-emerald-800 hover:underline">✎ {t("Edit")}</button>}
      {writable && (
        <div className="relative" ref={menuRef}>
          <button type="button" aria-haspopup="menu" aria-expanded={menu} aria-label={t("More actions")} onClick={() => setMenu((v) => !v)}
            className="rounded px-2 text-lg leading-none text-slate-600 hover:bg-slate-100">⋮</button>
          {menu && (
            <div role="menu" className="absolute right-0 z-20 mt-1 w-60 rounded-lg bg-white p-1 shadow-lg ring-1 ring-slate-200">
              {canManageApi(role) && <button role="menuitem" type="button" className={cx(item, 'text-amber-700')} onClick={() => { setMenu(false); setPending('token'); }}>⟳ {t("Regenerate Access Token")}</button>}
              {canRestart && <button role="menuitem" type="button" className={cx(item, 'text-blue-700')} onClick={() => { setMenu(false); setPending('restart'); }}>↻ {t("Restart")}</button>}
              {canLogout && <button role="menuitem" type="button" className={cx(item, 'text-red-700')} onClick={() => { setMenu(false); setPending('logout'); }}>⦸ {t("Logout")}</button>}
              <button role="menuitem" type="button" className={cx(item, 'text-red-700')} onClick={() => { setMenu(false); setPending('delete'); }}>🗑 {t("Delete")}</button>
            </div>
          )}
        </div>
      )}

      {pending === 'history' && <Modal title={t("Status History · {name}", { name: i.name })} wide onClose={() => setPending(null)}><Activity id={i.id} bare /></Modal>}
      {pending === 'edit' && (
        <Modal title={t("Edit instance")} onClose={() => setPending(null)}>
          <form onSubmit={submitEdit} className="space-y-4">
            {edit.isError && <Notice tone="error">{friendlyMessage(edit.error)}</Notice>}
            <Field label={t("Instance Name")}>{(id) => <Input id={id} name="name" required maxLength={100} defaultValue={i.name} />}</Field>
            <Field label={t("Description (optional)")}>{(id) => <Input id={id} name="description" maxLength={500} defaultValue={i.description ?? ''} />}</Field>
            <p className="text-xs text-slate-500">{t("Renaming does not disconnect WhatsApp or change the Instance ID and API key.")}</p>
            <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={() => setPending(null)}>{t("Cancel")}</Button><Button type="submit" loading={edit.isPending}>{t("Save")}</Button></div>
          </form>
        </Modal>
      )}
      {newKey && (
        <Modal title={t("New access token")} onClose={() => setNewKey(null)}>
          <p className="text-sm text-slate-700">{t("The old token has stopped working. Paste this one into every app that uses {name}.", { name: i.name })}</p>
          <div className="mt-3 flex items-start gap-2 rounded-lg bg-slate-50 p-3 ring-1 ring-slate-200"><Copy value={newKey} icon label={t("Copy API key")} /><code className="break-all text-xs">{newKey}</code></div>
          <p className="mt-2 text-xs text-slate-500">{t("You can copy it again any time from the instance page.")}</p>
        </Modal>
      )}
      {(command.isError || token.isError) && <span className="max-w-[14rem] whitespace-normal text-xs text-red-700" role="alert">{friendlyMessage(command.error ?? token.error)}</span>}

      <ConfirmDialog open={pending === 'token'} title={t("Regenerate access token?")} body={t("The current API key (Bearer token) of {name} stops working immediately. Apps using it must be updated.", { name: i.name })}
        confirmLabel={t("Regenerate")} tone="danger" busy={token.isPending} onClose={() => setPending(null)} onConfirm={() => token.mutate()} />
      <ConfirmDialog open={pending === 'restart'} title={t("Restart connection?")} body={t("The connection is closed and reopened. Your WhatsApp stays linked — no QR needed.")}
        confirmLabel={t("Restart")} tone="primary" busy={command.isPending} onClose={() => setPending(null)} onConfirm={() => command.mutate('restart')} />
      <ConfirmDialog open={pending === 'logout'} title={t("Log out this WhatsApp?")} body={t("The linked device is removed from your phone and stored credentials are destroyed. To use this number again you must scan a new QR code.")}
        confirmLabel={t("Logout")} busy={command.isPending} onClose={() => setPending(null)} onConfirm={() => command.mutate('logout')} />
      <ConfirmDialog open={pending === 'delete'} title={t("Delete this instance?")} body={t("The instance is removed from the platform and logged out. Past messages are kept according to your retention policy. This cannot be undone.")}
        confirmLabel={t("Delete")} confirmText={i.name} busy={command.isPending} onClose={() => setPending(null)} onConfirm={() => command.mutate('delete')} />
    </div>
  );
}

function CreateInstance({ onDone }: { onDone: (id?: string) => void }) {
  const { orgId, businesses, businessId } = useWorkspace();
  const qc = useQueryClient();
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => nameRef.current?.focus(), []);
  const m = useMutation({
    mutationFn: (body: { businessId: string; name: string; description?: string }) => api<Instance>('/v1/whatsapp/instances', { method: 'POST', body }),
    onSuccess: (inst) => { void qc.invalidateQueries({ queryKey: ['org', orgId] }); onDone(inst.id); },
  });
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    m.mutate({ businessId: String(f.get('businessId')), name: String(f.get('name')), description: String(f.get('description') || '') || undefined });
  };
  if (!businesses.length) return <Notice tone="warn">{t("Create a business first (Settings → Business).")}</Notice>;
  return (
    <form onSubmit={submit} className="mb-6 space-y-4 rounded-lg bg-white p-4 shadow-sm ring-1 ring-slate-200" aria-label={t("Create WhatsApp instance")}>
      <h2 className="text-sm font-semibold">{t("New WhatsApp instance")}</h2>
      {m.isError && <Notice tone="error">{friendlyMessage(m.error)}</Notice>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("Name")}>{(id) => <Input id={id} ref={nameRef} name="name" required maxLength={100} placeholder={t("Front desk")} />}</Field>
        <Field label={t("Business")}>{(id) => (
          <Select id={id} name="businessId" defaultValue={businessId ?? businesses[0].id}>{businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select>
        )}</Field>
      </div>
      <Field label={t("Description (optional)")}>{(id) => <Input id={id} name="description" maxLength={500} />}</Field>
      <p className="text-xs text-slate-500">{t("The Instance ID and API key are created right away; you can copy them from the instance page.")}</p>
      <div className="flex gap-2">
        <Button type="submit" loading={m.isPending}>{t("Create and connect")}</Button>
        <Button type="button" variant="secondary" onClick={() => onDone()}>{t("Cancel")}</Button>
      </div>
    </form>
  );
}
