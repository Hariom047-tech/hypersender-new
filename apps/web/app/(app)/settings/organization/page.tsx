'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useMemo, useState, type FormEvent } from 'react';
import { Button, Card, ErrorState, Field, Input, LoadingSkeleton, Notice, PageHeader, Select } from '@/components/ui';
import { api, friendlyMessage } from '@/lib/api';
import { COUNTRIES, CURRENCIES, timezones } from '@/lib/options';
import { can } from '@/lib/permissions';
import { useWorkspace } from '@/lib/workspace';
import { t } from '@/lib/i18n';

interface Org { id: string; name: string; slug: string; status: string; timezone: string; countryCode: string | null; currency: string; myRole: string }

export default function OrganizationSettingsPage() {
  const { orgId, role } = useWorkspace();
  const qc = useQueryClient();
  const tzs = useMemo(() => timezones(), []);
  const [saved, setSaved] = useState(false);
  const q = useQuery({ queryKey: ['org', orgId, 'organization'], queryFn: () => api<Org>('/v1/organization') });
  const m = useMutation({
    mutationFn: (body: object) => api<Org>('/v1/organization', { method: 'PATCH', body }),
    onSuccess: () => { setSaved(true); void qc.invalidateQueries({ queryKey: ['org', orgId, 'organization'] }); void qc.invalidateQueries({ queryKey: ['me'] }); },
  });
  const editable = can(role, 'settings:manage');
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <LoadingSkeleton />;
  const o = q.data;
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSaved(false);
    const f = new FormData(e.currentTarget);
    m.mutate({ name: f.get('name'), timezone: f.get('timezone'), countryCode: f.get('countryCode') || undefined, currency: f.get('currency') });
  };
  return (
    <>
      <PageHeader title={t("Organization")} description={t("Workspace address: {slug}", { slug: o.slug })} />
      {!editable && <div className="mb-4"><Notice>{t("Only owners and admins can change organization settings.")}</Notice></div>}
      {m.isError && <div className="mb-4"><Notice tone="error">{friendlyMessage(m.error)}</Notice></div>}
      {saved && <div className="mb-4"><Notice tone="success">{t("Saved.")}</Notice></div>}
      <form onSubmit={submit}>
        <fieldset disabled={!editable}>
          <Card title={t("Details")}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("Name")}>{(id) => <Input id={id} name="name" defaultValue={o.name} required maxLength={200} />}</Field>
              <Field label={t("Timezone")} hint={t("Used for “today” on the dashboard and monthly usage.")}>{(id, d) => <Select id={id} aria-describedby={d} name="timezone" defaultValue={o.timezone}>{tzs.map((t) => <option key={t}>{t}</option>)}</Select>}</Field>
              <Field label={t("Country")}>{(id) => <Select id={id} name="countryCode" defaultValue={o.countryCode ?? ''}><option value="">—</option>{COUNTRIES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</Select>}</Field>
              <Field label={t("Default currency")}>{(id) => <Select id={id} name="currency" defaultValue={o.currency}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</Select>}</Field>
            </div>
            {editable && <Button type="submit" className="mt-4" loading={m.isPending}>{t("Save changes")}</Button>}
          </Card>
        </fieldset>
      </form>
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <Card title={t("Members")}><p className="text-sm text-slate-600">{t("Manage who can access this organization.")}</p><Link href="/team" className="mt-2 inline-block text-sm text-emerald-800 underline">{t("Open team")}</Link></Card>
        {can(role, 'billing:view') && <Card title={t("Subscription")}><p className="text-sm text-slate-600">{t("Plan, limits and invoices.")}</p><Link href="/billing" className="mt-2 inline-block text-sm text-emerald-800 underline">{t("Open billing")}</Link></Card>}
      </div>
    </>
  );
}
