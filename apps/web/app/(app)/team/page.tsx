'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Button, ConfirmDialog, DataTable, ErrorState, Field, Input, Notice, PageHeader, Select, StatusBadge } from '@/components/ui';
import { api, friendlyMessage } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { can } from '@/lib/permissions';
import type { Role } from '@/lib/types';
import { useWorkspace } from '@/lib/workspace';
import { t, msg } from '@/lib/i18n';

interface Member { userId: string; role: Role; status: string; joinedAt: string | null; invitedAt: string; email: string; name: string | null }
const ROLES: Role[] = ['OWNER', 'ADMIN', 'MANAGER', 'AGENT', 'VIEWER'];
const ROLE_HELP: Record<Role, string> = {
  OWNER: msg("Everything, including billing and removing owners"), ADMIN: msg("Settings, team, API keys, webhooks"),
  MANAGER: msg("WhatsApp instances and inbox"), AGENT: msg("Reply in the inbox"), VIEWER: msg("Read-only"),
};

export default function TeamPage() {
  const { orgId, role, me } = useWorkspace();
  const qc = useQueryClient();
  const admin = can(role, 'team:manage');
  const q = useQuery({ queryKey: ['org', orgId, 'team'], queryFn: () => api<Member[]>('/v1/team/members') });
  const [remove, setRemove] = useState<Member | null>(null);
  const done = () => void qc.invalidateQueries({ queryKey: ['org', orgId, 'team'] });
  const invite = useMutation({ mutationFn: (b: object) => api<Member[]>('/v1/team/invitations', { method: 'POST', body: b }), onSuccess: done });
  const change = useMutation({ mutationFn: (v: { userId: string; role: Role }) => api(`/v1/team/members/${v.userId}`, { method: 'PATCH', body: { role: v.role } }), onSuccess: done });
  const del = useMutation({ mutationFn: (userId: string) => api(`/v1/team/members/${userId}`, { method: 'DELETE' }), onSuccess: () => { setRemove(null); done(); } });
  const err = invite.error ?? change.error ?? del.error;

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    invite.mutate({ email: f.get('email'), role: f.get('role') }, { onSuccess: () => (e.target as HTMLFormElement).reset() });
  };
  const roleOptions = ROLES.filter((r) => r !== 'OWNER' || role === 'OWNER');

  return (
    <>
      <PageHeader title={t("Team")} description={t("People who can work in this organization.")} />
      {err && <div className="mb-4"><Notice tone="error">{friendlyMessage(err)}</Notice></div>}
      {admin && (
        <form onSubmit={submit} className="mb-6 rounded-lg bg-white p-4 shadow-sm ring-1 ring-slate-200" aria-label={t("Invite a team member")}>
          <div className="grid gap-4 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
            <Field label={t("Email")} hint={t("They must already have an account. They accept the invitation after signing in.")}>{(id, d) => <Input id={id} aria-describedby={d} name="email" type="email" required />}</Field>
            <Field label={t("Role")}>{(id) => <Select id={id} name="role" defaultValue="AGENT">{roleOptions.map((r) => <option key={r} value={r}>{r.toLowerCase()}</option>)}</Select>}</Field>
            <Button type="submit" loading={invite.isPending}>{t("Invite")}</Button>
          </div>
          <p className="mt-2 text-xs text-slate-500">{t("Email invitations for people without an account are not available yet.")}</p>
        </form>
      )}
      {q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
        <DataTable caption={t("Team members")} loading={q.isLoading} rows={q.data} rowKey={(r) => r.userId}
          columns={[
            { key: 'name', header: t("Name"), cell: (r) => <span className="font-medium">{r.name ?? '—'}{r.userId === me.user.id && <span className="ml-1 text-xs text-slate-500">{t("(you)")}</span>}</span> },
            { key: 'email', header: t("Email"), cell: (r) => r.email },
            { key: 'role', header: t("Role"), cell: (r) => (admin && r.userId !== me.user.id && (r.role !== 'OWNER' || role === 'OWNER') ? (
              <Select aria-label={t("Role for {email}", { email: r.email })} value={r.role} onChange={(e) => change.mutate({ userId: r.userId, role: e.target.value as Role })} className="w-36 py-1 text-xs">
                {roleOptions.map((x) => <option key={x} value={x}>{x.toLowerCase()}</option>)}
              </Select>
            ) : <span title={t(ROLE_HELP[r.role])}>{r.role.toLowerCase()}</span>) },
            { key: 'status', header: t("Status"), cell: (r) => <StatusBadge tone={r.status === 'ACTIVE' ? 'green' : 'amber'}>{r.status === 'INVITED' ? t("invited") : r.status.toLowerCase()}</StatusBadge> },
            { key: 'joined', header: t("Joined"), cell: (r) => dateTime(r.joinedAt) },
            { key: 'act', header: '', cell: (r) => (admin && r.userId !== me.user.id && (r.role !== 'OWNER' || role === 'OWNER')
              ? <Button size="sm" variant="ghost" onClick={() => setRemove(r)}>{t("Remove")}</Button> : null) },
          ]} />
      )}
      <div className="mt-6 rounded-lg bg-white p-4 text-sm shadow-sm ring-1 ring-slate-200">
        <p className="font-medium">{t("Roles")}</p>
        <ul className="mt-2 space-y-1 text-slate-600">{ROLES.map((r) => <li key={r}><strong className="text-slate-800">{r.toLowerCase()}</strong> — {t(ROLE_HELP[r])}</li>)}</ul>
      </div>
      <ConfirmDialog open={Boolean(remove)} title={t("Remove member?")} body={t("{email} will lose access to this organization immediately.", { email: remove?.email })} confirmLabel={t("Remove")}
        busy={del.isPending} onClose={() => setRemove(null)} onConfirm={() => remove && del.mutate(remove.userId)} />
    </>
  );
}
