'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent, type ReactNode } from 'react';
import { Button, Field, Input, LoadingSkeleton, Notice, Select, cx } from '@/components/ui';
import { EventPicker } from '@/components/webhooks/event-picker';
import { SecretInput } from '@/components/webhooks/secret-input';
import { Copy } from '@/components/whatsapp/instance-api';
import { api, friendlyMessage } from '@/lib/api';
import { can } from '@/lib/permissions';
import type { Instance } from '@/lib/types';
import { qk, useWorkspace } from '@/lib/workspace';
import { t } from '@/lib/i18n';

export default function CreateWebhookPage() {
  return <Suspense><CreateWebhook /></Suspense>;
}

function Section({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cx('rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200', className)}>{children}</section>;
}

/** Gateway-style "Create Webhook": one WhatsApp instance, a URL, an optional Authorization secret and the events. */
function CreateWebhook() {
  const { orgId, businessId, role } = useWorkspace();
  const router = useRouter();
  const preset = useSearchParams().get('instanceId');
  const qc = useQueryClient();
  const [enabled, setEnabled] = useState(true);
  const [local, setLocal] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; secret: string } | null>(null);
  const instances = useQuery({ queryKey: qk.scoped(orgId, businessId, 'instances'), queryFn: () => api<Instance[]>('/v1/whatsapp/instances') });
  const m = useMutation({
    mutationFn: async (v: { body: Record<string, unknown>; enabled: boolean }) => {
      const r = await api<{ id: string; secret: string }>('/v1/webhooks', { method: 'POST', body: v.body });
      if (!v.enabled) await api(`/v1/webhooks/${r.id}`, { method: 'PATCH', body: { enabled: false } });
      return r;
    },
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['org', orgId, 'webhooks'] }); setCreated(r); window.scrollTo({ top: 0 }); },
  });

  if (!can(role, 'webhooks:manage')) return <Notice>{t("Only owners and admins can manage webhooks.")}</Notice>;

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLocal(null);
    const f = new FormData(e.currentTarget);
    const inst = instances.data?.find((i) => i.id === f.get('instanceId'));
    const events = f.getAll('events').map(String);
    if (!inst) return setLocal(t("Select an instance."));
    if (!events.length) return setLocal(t("Select at least one event."));
    m.mutate({ enabled, body: {
      name: String(f.get('name')).trim(), url: String(f.get('url')).trim(), eventTypes: events, businessId: inst.businessId, instanceId: inst.id,
      authorizationHeader: String(f.get('authHeader') ?? '').trim() || undefined,
    } });
  };

  if (created) {
    return (
      <>
        <Header />
        <Section className="space-y-4">
          <Notice tone="success">{t("Webhook created. We start sending the selected events to your URL right away.")}</Notice>
          <div className="rounded-lg bg-amber-50 p-4 ring-1 ring-amber-300" role="alert">
            <p className="text-sm font-semibold text-amber-900">{t("Copy the signing secret now. It will not be shown again.")}</p>
            <p className="mt-1 text-xs text-amber-900">{t("Optional: use it to verify the X-Webhook-Signature header on your server (in addition to your Authorization secret).")}</p>
            <div className="mt-2 flex items-center gap-2"><Copy value={created.secret} icon label={t("Copy")} /><code className="break-all text-xs">{created.secret}</code></div>
          </div>
          <div className="flex gap-2">
            <Button onClick={() => router.push(`/developers/webhooks/${created.id}`)}>{t("Open webhook")}</Button>
            <Button variant="secondary" onClick={() => router.push('/developers/webhooks')}>{t("Back to webhooks")}</Button>
          </div>
        </Section>
      </>
    );
  }

  return (
    <>
      <Header />
      <form onSubmit={submit} className="space-y-6" aria-label={t("Create Webhook")}>
        <Section className="grid gap-5 md:grid-cols-2">
          <div className="flex items-center gap-3">
            <button type="button" role="switch" aria-checked={enabled} onClick={() => setEnabled((v) => !v)}
              className={cx('relative inline-flex h-7 w-12 shrink-0 rounded-full transition', enabled ? 'bg-emerald-600' : 'bg-slate-300')}>
              <span className={cx('absolute top-1 h-5 w-5 rounded-full bg-white shadow transition', enabled ? 'left-6' : 'left-1')} />
              <span className="sr-only">{t("Enabled")}</span>
            </button>
            <span className="text-sm font-medium text-slate-900">{enabled ? t("Enabled") : t("Disabled")}</span>
          </div>
          <Field label={`${t("Name")} *`}>{(id) => <Input id={id} name="name" required maxLength={100} placeholder={t("Ex. Marketing Webhook")} />}</Field>
        </Section>

        <Section className="grid gap-5 md:grid-cols-2">
          <Field label={`${t("Service Type")} *`}>{(id) => <Select id={id} name="service" defaultValue="WHATSAPP"><option value="WHATSAPP">{t("WhatsApp")}</option></Select>}</Field>
          <Field label={`${t("Instance")} *`}>{(id) => instances.isLoading ? <LoadingSkeleton rows={1} /> : (
            <Select id={id} name="instanceId" required defaultValue={preset ?? ''}>
              <option value="" disabled>{t("Select an instance")}</option>
              {(instances.data ?? []).map((i) => <option key={i.id} value={i.id}>{i.name}{i.phoneNumber ? ` · ${i.phoneNumber}` : ''}</option>)}
            </Select>
          )}</Field>
        </Section>

        <Section className="space-y-5">
          <Field label={`${t("Webhook URL")} *`} hint={t("The URL where you want to receive the messages and events. Must be a public HTTPS URL; you can change it later.")}>{(id, d) => (
            <Input id={id} aria-describedby={d} name="url" type="url" required pattern="https://.*" maxLength={2048} placeholder={t("Ex. https://example.com/webhook")} />)}</Field>
          <Field label={t("Authorization Secret (optional)")} hint={t("We include this value in the Authorization header of every webhook call, e.g. \"Bearer my-secret\". It is stored encrypted and never shown again.")}>{(id, d) => (
            <SecretInput id={id} aria-describedby={d} name="authHeader" maxLength={500} pattern="[ -~]*" />)}</Field>
        </Section>

        <Section className="space-y-4 p-0">
          <p className="rounded-t-xl bg-emerald-700 px-5 py-3 text-sm font-semibold text-white">{t("Enable the events you want to receive for this URL. Every call is listed in Webhook Logs.")}</p>
          <div className="px-5 pb-5"><EventPicker selected={['MESSAGE_RECEIVED']} /></div>
        </Section>

        {(local || m.isError) && <Notice tone="error">{local ?? friendlyMessage(m.error)}</Notice>}
        <div className="flex gap-2">
          <Button type="submit" loading={m.isPending}>{t("Create")}</Button>
          <Link href="/developers/webhooks" className="rounded-md px-3.5 py-2 text-sm font-medium text-slate-800 ring-1 ring-inset ring-slate-300 hover:bg-slate-50">{t("Cancel")}</Link>
        </div>
      </form>
    </>
  );
}

function Header() {
  return (
    <div className="mb-6">
      <nav aria-label={t("Breadcrumb")} className="mb-1 flex items-center gap-2 text-sm text-slate-500">
        <Link href="/developers/webhooks" className="hover:underline">{t("Webhooks")}</Link><span aria-hidden>›</span><span className="text-slate-700">{t("Create Webhook")}</span>
      </nav>
      <h1 className="text-2xl font-bold text-slate-900 sm:text-3xl">{t("Create Webhook")}</h1>
    </div>
  );
}
