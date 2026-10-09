'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type FormEvent } from 'react';
import { Button, Card, Field, Input, Notice, PageHeader, Select, Textarea } from '@/components/ui';
import { api, friendlyMessage } from '@/lib/api';
import { COUNTRIES, CURRENCIES, INDUSTRIES, timezones } from '@/lib/options';
import { can } from '@/lib/permissions';
import type { Business } from '@/lib/types';
import { useWorkspace } from '@/lib/workspace';
import { t, msg } from '@/lib/i18n';

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const DAY_LABEL: Record<(typeof DAYS)[number], string> = { mon: msg("Monday"), tue: msg("Tuesday"), wed: msg("Wednesday"), thu: msg("Thursday"), fri: msg("Friday"), sat: msg("Saturday"), sun: msg("Sunday") };

export default function BusinessSettingsPage() {
  const { businesses, businessId, role, orgId } = useWorkspace();
  const [selected, setSelected] = useState<string | 'new'>(businessId ?? businesses[0]?.id ?? 'new');
  const b = businesses.find((x) => x.id === selected) ?? null;
  const editable = can(role, 'settings:manage');
  return (
    <>
      <PageHeader title={t("Business settings")} description={t("Details your team and (later) your AI assistant use.")}
        actions={editable ? <Button variant="secondary" onClick={() => setSelected('new')}>{t("+ Add business")}</Button> : undefined} />
      {businesses.length > 1 && selected !== 'new' && (
        <div className="mb-4 max-w-xs"><Select aria-label={t("Business")} value={selected} onChange={(e) => setSelected(e.target.value)}>{businesses.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></div>
      )}
      {!editable && <div className="mb-4"><Notice>{t("Only owners and admins can edit business settings.")}</Notice></div>}
      <BusinessForm key={`${orgId}:${selected}`} business={b} editable={editable} onSaved={(id) => setSelected(id)} />
    </>
  );
}

function BusinessForm({ business, editable, onSaved }: { business: Business | null; editable: boolean; onSaved: (id: string) => void }) {
  const { orgId, org } = useWorkspace();
  const qc = useQueryClient();
  const tzs = useMemo(() => timezones(), []);
  const [saved, setSaved] = useState(false);
  const hours = (business?.businessHours ?? {}) as Record<string, Array<[string, string]>>;
  const m = useMutation({
    mutationFn: (body: object) => api<Business>(business ? `/v1/businesses/${business.id}` : '/v1/businesses', { method: business ? 'PATCH' : 'POST', body }),
    onSuccess: (r) => { setSaved(true); void qc.invalidateQueries({ queryKey: ['org', orgId, 'businesses'] }); onSaved(r.id); },
  });

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSaved(false);
    const f = new FormData(e.currentTarget);
    const s = (k: string) => String(f.get(k) ?? '').trim();
    const businessHours: Record<string, Array<[string, string]>> = {};
    for (const d of DAYS) if (f.get(`${d}-open`) === 'on' && s(`${d}-from`) && s(`${d}-to`)) businessHours[d] = [[s(`${d}-from`), s(`${d}-to`)]];
    m.mutate({
      name: s('name'), industry: s('industry'), description: s('description') || undefined, phone: s('phone'), email: s('email'), website: s('website'),
      timezone: s('timezone'), currency: s('currency'), countryCode: s('countryCode') || undefined,
      address: Object.fromEntries(['line1', 'line2', 'city', 'state', 'postalCode'].map((k) => [k, s(k)]).filter(([, v]) => v)), businessHours,
    });
  };

  return (
    <form onSubmit={submit} className="space-y-6">
      {m.isError && <Notice tone="error">{friendlyMessage(m.error)}</Notice>}
      {saved && <Notice tone="success">{t("Saved.")}</Notice>}
      <fieldset disabled={!editable} className="space-y-6">
        <Card title={business ? t("Profile") : t("New business")}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("Business name")}>{(id) => <Input id={id} name="name" defaultValue={business?.name} required maxLength={200} />}</Field>
            <Field label={t("Industry")}>{(id) => <Select id={id} name="industry" defaultValue={business?.industry ?? ''}>{[['', '—'], ...INDUSTRIES].map(([v, n]) => <option key={v} value={v}>{n}</option>)}</Select>}</Field>
            <Field label={t("Phone")} hint={t("International format, e.g. +91 98123 45678.")}>{(id, d) => <Input id={id} aria-describedby={d} name="phone" type="tel" defaultValue={business?.phone ?? ''} />}</Field>
            <Field label={t("Email")}>{(id) => <Input id={id} name="email" type="email" defaultValue={business?.email ?? ''} />}</Field>
            <Field label={t("Website")}>{(id) => <Input id={id} name="website" type="url" defaultValue={business?.website ?? ''} placeholder={t("https://")} />}</Field>
            <Field label={t("Timezone")}>{(id) => <Select id={id} name="timezone" defaultValue={business?.timezone ?? org.timezone}>{tzs.map((t) => <option key={t}>{t}</option>)}</Select>}</Field>
            <Field label={t("Currency")}>{(id) => <Select id={id} name="currency" defaultValue={business?.currency ?? org.currency}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</Select>}</Field>
            <Field label={t("Country")}>{(id) => <Select id={id} name="countryCode" defaultValue={business?.countryCode ?? org.countryCode ?? ''}><option value="">—</option>{COUNTRIES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</Select>}</Field>
          </div>
          <div className="mt-4"><Field label={t("Description")}>{(id) => <Textarea id={id} name="description" rows={3} defaultValue={business?.description ?? ''} maxLength={2000} />}</Field></div>
        </Card>
        <Card title={t("Address")}>
          <div className="grid gap-4 sm:grid-cols-2">
            {[['line1', 'Address line 1'], ['line2', 'Address line 2'], ['city', 'City'], ['state', 'State'], ['postalCode', 'Postal code']].map(([k, l]) => (
              <Field key={k} label={l}>{(id) => <Input id={id} name={k} defaultValue={business?.address?.[k] ?? ''} maxLength={200} />}</Field>
            ))}
          </div>
        </Card>
        <Card title={t("Business hours")}>
          <div className="space-y-2">
            {DAYS.map((d) => {
              const slot = hours[d]?.[0];
              return (
                <div key={d} className="grid grid-cols-[7rem_auto_1fr_1fr] items-center gap-3 text-sm">
                  <span>{t(DAY_LABEL[d])}</span>
                  <label className="flex items-center gap-1.5"><input type="checkbox" name={`${d}-open`} defaultChecked={Boolean(slot)} /> {t("Open")}</label>
                  <Input aria-label={t("{day} opens", { day: t(DAY_LABEL[d]) })} type="time" name={`${d}-from`} defaultValue={slot?.[0] ?? '09:00'} />
                  <Input aria-label={t("{day} closes", { day: t(DAY_LABEL[d]) })} type="time" name={`${d}-to`} defaultValue={slot?.[1] ?? '18:00'} />
                </div>
              );
            })}
          </div>
        </Card>
        {editable && <Button type="submit" loading={m.isPending}>{business ? t("Save changes") : t("Create business")}</Button>}
      </fieldset>
    </form>
  );
}
