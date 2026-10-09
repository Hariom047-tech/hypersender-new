'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Button, ConfirmDialog, DataTable, EmptyState, ErrorState, Field, Input, Notice, PageHeader, Select, StatusBadge } from '@/components/ui';
import { api, friendlyMessage } from '@/lib/api';
import { dateTime, timeAgo } from '@/lib/format';
import { can } from '@/lib/permissions';
import { API_SCOPES } from '@/lib/types';
import { useWorkspace } from '@/lib/workspace';
import { t } from '@/lib/i18n';

interface KeyRow { id: string; name: string; prefix: string; scopes: string[]; businessId: string | null; createdAt: string; lastUsedAt: string | null; expiresAt: string | null; status: 'ACTIVE' | 'REVOKED' | 'EXPIRED' }

export default function ApiKeysPage() {
  const { orgId, role, businesses } = useWorkspace();
  const qc = useQueryClient();
  const allowed = can(role, 'apiKeys:manage');
  const q = useQuery({ queryKey: ['org', orgId, 'api-keys'], queryFn: () => api<KeyRow[]>('/v1/api-keys'), enabled: allowed });
  // The one-time plaintext lives ONLY in this component's memory (never storage/URL/logs) and is gone on navigation or reload.
  const [created, setCreated] = useState<{ name: string; plaintext: string } | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [revoke, setRevoke] = useState<KeyRow | null>(null);
  const [copied, setCopied] = useState(false);

  const create = useMutation({
    mutationFn: (body: object) => api<{ id: string; prefix: string; plaintext: string }>('/v1/api-keys', { method: 'POST', body }),
    onSuccess: (r, body) => { setCreated({ name: (body as { name: string }).name, plaintext: r.plaintext }); setShowForm(false); setCopied(false); void qc.invalidateQueries({ queryKey: ['org', orgId, 'api-keys'] }); },
  });
  const revokeM = useMutation({
    mutationFn: (id: string) => api(`/v1/api-keys/${id}`, { method: 'DELETE' }),
    onSuccess: () => { setRevoke(null); void qc.invalidateQueries({ queryKey: ['org', orgId, 'api-keys'] }); },
  });

  if (!allowed) return <><PageHeader title={t("API keys")} /><Notice>{t("Only owners and admins can manage API keys.")}</Notice></>;

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const scopes = f.getAll('scopes').map(String);
    create.mutate({ name: f.get('name'), scopes, businessId: f.get('businessId') || undefined,
      expiresAt: f.get('expires') ? new Date(`${f.get('expires')}T23:59:59`).toISOString() : undefined });
  };

  return (
    <>
      <PageHeader title={t("API keys")} description={t("Let your own systems use the WhatsApp gateway API.")}
        actions={<Button onClick={() => { setShowForm(true); setCreated(null); }}>{t("+ Create key")}</Button>} />

      {created && (
        <div className="mb-6 rounded-lg bg-amber-50 p-4 ring-1 ring-amber-300" role="alert">
          <p className="text-sm font-semibold text-amber-900">{t("Copy this key now. It will not be shown again.")}</p>
          <p className="mt-1 text-xs text-amber-900">{t("Key “")}{created.name}{t("”. Store it in your server’s secret manager — never in browser code or a public repository.")}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <code className="break-all rounded bg-white px-2 py-1 text-xs ring-1 ring-amber-200">{created.plaintext}</code>
            <Button size="sm" variant="secondary" onClick={() => { void navigator.clipboard.writeText(created.plaintext); setCopied(true); }}>{copied ? t("Copied") : t("Copy")}</Button>
            <Button size="sm" variant="ghost" onClick={() => setCreated(null)}>{t("I have saved it")}</Button>
          </div>
        </div>
      )}

      {showForm && (
        <form onSubmit={submit} className="mb-6 space-y-4 rounded-lg bg-white p-4 shadow-sm ring-1 ring-slate-200" aria-label={t("Create API key")}>
          {create.isError && <Notice tone="error">{friendlyMessage(create.error)}</Notice>}
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={t("Name")}>{(id) => <Input id={id} name="name" required maxLength={100} placeholder={t("CRM integration")} />}</Field>
            <Field label={t("Business (optional)")}>{(id) => (
              <Select id={id} name="businessId" defaultValue=""><option value="">{t("All businesses")}</option>{businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select>
            )}</Field>
            <Field label={t("Expires (optional)")}>{(id) => <Input id={id} name="expires" type="date" />}</Field>
          </div>
          <fieldset>
            <legend className="text-sm font-medium text-slate-800">{t("Permissions")}</legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              {API_SCOPES.map((s) => (
                <label key={s} className="flex items-center gap-2 text-sm"><input type="checkbox" name="scopes" value={s} defaultChecked={s === 'messages:send' || s === 'instances:read'} /> <code>{s}</code></label>
              ))}
            </div>
          </fieldset>
          <div className="flex gap-2"><Button type="submit" loading={create.isPending}>{t("Create key")}</Button><Button type="button" variant="secondary" onClick={() => setShowForm(false)}>{t("Cancel")}</Button></div>
        </form>
      )}

      {q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
        <DataTable caption={t("API keys")} loading={q.isLoading} rows={q.data} rowKey={(r) => r.id}
          empty={<EmptyState title={t("No API keys yet")} body={t("Create a key to call the API from your own systems. API access depends on your plan.")} />}
          columns={[
            { key: 'name', header: t("Name"), cell: (r) => <span className="font-medium">{r.name}</span> },
            { key: 'prefix', header: t("Key"), cell: (r) => <code className="text-xs">{r.prefix}…</code> },
            { key: 'scopes', header: t("Scopes"), cell: (r) => <span className="text-xs">{r.scopes.join(', ')}</span> },
            { key: 'created', header: t("Created"), cell: (r) => dateTime(r.createdAt) },
            { key: 'used', header: t("Last used"), cell: (r) => timeAgo(r.lastUsedAt) },
            { key: 'exp', header: t("Expires"), cell: (r) => (r.expiresAt ? dateTime(r.expiresAt) : t("Never")) },
            { key: 'status', header: t("Status"), cell: (r) => <StatusBadge tone={r.status === 'ACTIVE' ? 'green' : 'slate'}>{r.status.toLowerCase()}</StatusBadge> },
            { key: 'act', header: '', cell: (r) => (r.status === 'ACTIVE' ? <Button size="sm" variant="danger" onClick={() => setRevoke(r)}>{t("Revoke")}</Button> : null) },
          ]} />
      )}
      <ConfirmDialog open={Boolean(revoke)} title={t("Revoke API key?")} body={t("“{name}” stops working immediately, including requests already in progress.", { name: revoke?.name })}
        confirmLabel={t("Revoke")} busy={revokeM.isPending} onClose={() => setRevoke(null)} onConfirm={() => revoke && revokeM.mutate(revoke.id)} />
    </>
  );
}
