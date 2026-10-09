'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BRAND } from '@/lib/brand';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Button, Field, Input, Notice, Select } from '@/components/ui';
import { api, friendlyMessage, setApiOrganization } from '@/lib/api';
import { browserTimezone, COUNTRIES, CURRENCIES, INDUSTRIES, timezones } from '@/lib/options';
import type { Business, Instance, Me } from '@/lib/types';
import { t } from '@/lib/i18n';

type Step = 'org' | 'business' | 'whatsapp';
const PROGRESS_KEY = 'hs.onboarding';

interface Progress { slug?: string; orgId?: string; step?: Step }
function readProgress(): Progress { try { return JSON.parse(sessionStorage.getItem(PROGRESS_KEY) ?? '{}'); } catch { return {}; } }
function saveProgress(p: Progress): void { try { sessionStorage.setItem(PROGRESS_KEY, JSON.stringify(p)); } catch { /* ignore */ } }

function slugify(name: string): string {
  const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'workspace';
  return `${base}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Onboarding steps 2-4 (step 1 = /register). Resumable and refresh-safe:
 * the org slug of this attempt is kept in sessionStorage (not a secret), and
 * the backend treats a repeated create with the same slug by the same user as
 * "already created" - so a refresh never makes a duplicate organization.
 */
export function Onboarding() {
  const router = useRouter();
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/v1/account/me', { org: null }) });
  const [step, setStep] = useState<Step>('org');
  const [orgId, setOrgId] = useState<string | null>(null);
  const [businessId, setBusinessId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tzs = useMemo(() => timezones(), []);
  const tz = useMemo(() => browserTimezone(), []);

  // Resume: an owned org without a business -> continue at the business step.
  useEffect(() => {
    if (!me.data) return;
    const p = readProgress();
    const resumable = me.data.organizations.find((o) => o.id === p.orgId) ?? me.data.organizations.find((o) => o.role === 'OWNER' && o.businessCount === 0);
    if (resumable) {
      setOrgId(resumable.id);
      setApiOrganization(resumable.id);
      setStep(resumable.businessCount === 0 ? 'business' : p.step === 'whatsapp' ? 'whatsapp' : 'business');
    } else if (me.data.organizations.length > 0 && !p.orgId) {
      router.replace('/dashboard');
    }
  }, [me.data, router]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (err) { setError(friendlyMessage(err)); } finally { setBusy(false); }
  }

  const createOrg = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    void run(async () => {
      const p = readProgress();
      const slug = p.slug ?? slugify(String(f.get('name')));
      saveProgress({ ...p, slug });
      const r = await api<{ organizationId: string }>('/v1/account/organizations', { method: 'POST', org: null, body: {
        name: f.get('name'), slug, countryCode: f.get('country'), timezone: f.get('timezone'), currency: f.get('currency') } });
      saveProgress({ slug, orgId: r.organizationId, step: 'business' });
      try { localStorage.setItem('hs.org', r.organizationId); } catch { /* ignore */ }
      setApiOrganization(r.organizationId);
      setOrgId(r.organizationId);
      await qc.invalidateQueries({ queryKey: ['me'] });
      setStep('business');
    });
  };

  const createBusiness = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    void run(async () => {
      const line1 = String(f.get('line1') ?? ''); const city = String(f.get('city') ?? '');
      const org = me.data?.organizations.find((o) => o.id === orgId);
      const b = await api<Business>('/v1/businesses', { method: 'POST', org: orgId, body: {
        name: f.get('name'), industry: f.get('industry') || undefined, phone: f.get('phone') || undefined, email: f.get('email') || undefined,
        timezone: f.get('timezone'), countryCode: org?.countryCode ?? undefined, currency: org?.currency ?? undefined,
        address: line1 || city ? { ...(line1 ? { line1 } : {}), ...(city ? { city } : {}) } : undefined } });
      setBusinessId(b.id);
      saveProgress({ ...readProgress(), step: 'whatsapp' });
      await qc.invalidateQueries({ queryKey: ['me'] });
      setStep('whatsapp');
    });
  };

  const connectNow = () => void run(async () => {
    const biz = businessId ?? (await api<Business[]>('/v1/businesses', { org: orgId }))[0]?.id;
    const inst = await api<Instance>('/v1/whatsapp/instances', { method: 'POST', org: orgId, body: { businessId: biz, name: 'Main WhatsApp' } });
    sessionStorage.removeItem(PROGRESS_KEY);
    router.push(`/whatsapp/instances/${inst.id}?connect=1`);
  });

  const skip = () => { sessionStorage.removeItem(PROGRESS_KEY); router.push('/dashboard'); };

  const accept = (org: string) => void run(async () => {
    await api(`/v1/account/invitations/${org}/accept`, { method: 'POST', org: null });
    try { localStorage.setItem('hs.org', org); } catch { /* ignore */ }
    router.push('/dashboard');
  });

  if (me.isLoading) return <Shell><p role="status">{t("Loading…")}</p></Shell>;
  const stepNo = step === 'org' ? 2 : step === 'business' ? 3 : 4;

  return (
    <Shell>
      <p className="text-sm text-slate-500">{t("Step")}{' '}{stepNo} {t("of 4")}</p>
      {error && <div className="mt-3"><Notice tone="error">{error}</Notice></div>}

      {step === 'org' && (
        <>
          {!!me.data?.invitations.length && (
            <div className="mt-3 space-y-2">
              <Notice>{t("You have been invited to join an existing workspace.")}</Notice>
              {me.data.invitations.map((i) => (
                <div key={i.organizationId} className="flex items-center justify-between rounded-md p-3 ring-1 ring-slate-200">
                  <span className="text-sm"><strong>{i.organizationName}</strong> {t("as")}{' '}{i.role.toLowerCase()}</span>
                  <Button size="sm" onClick={() => accept(i.organizationId)} loading={busy}>{t("Join")}</Button>
                </div>
              ))}
              <p className="text-xs text-slate-500">{t("…or create your own workspace below.")}</p>
            </div>
          )}
          <h1 className="mt-2 text-lg font-semibold">{t("Create your workspace")}</h1>
          <p className="text-sm text-slate-600">{t("Your organization holds your businesses, team and billing.")}</p>
          <form onSubmit={createOrg} className="mt-4 space-y-4">
            <Field label={t("Organization name")}>{(id) => <Input id={id} name="name" required maxLength={200} placeholder={t("Ayush Ventures")} />}</Field>
            <Field label={t("Country")}>{(id) => <Select id={id} name="country" defaultValue="IN">{COUNTRIES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</Select>}</Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t("Timezone")}>{(id) => <Select id={id} name="timezone" defaultValue={tzs.includes(tz) ? tz : 'UTC'}>{tzs.map((t) => <option key={t}>{t}</option>)}</Select>}</Field>
              <Field label={t("Currency")}>{(id) => <Select id={id} name="currency" defaultValue="INR">{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</Select>}</Field>
            </div>
            <Button type="submit" className="w-full" loading={busy}>{t("Continue")}</Button>
          </form>
        </>
      )}

      {step === 'business' && (
        <>
          <h1 className="mt-2 text-lg font-semibold">{t("Add your first business")}</h1>
          <p className="text-sm text-slate-600">{t("For example “ABC Dental”. You can add more businesses later.")}</p>
          <form onSubmit={createBusiness} className="mt-4 space-y-4">
            <Field label={t("Business name")}>{(id) => <Input id={id} name="name" required maxLength={200} />}</Field>
            <Field label={t("Industry")}>{(id) => <Select id={id} name="industry" defaultValue="">{[['', 'Select…'], ...INDUSTRIES].map(([v, n]) => <option key={v} value={v}>{n}</option>)}</Select>}</Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t("Phone")}>{(id) => <Input id={id} name="phone" type="tel" placeholder="+91 98123 45678" />}</Field>
              <Field label={t("Email (optional)")}>{(id) => <Input id={id} name="email" type="email" />}</Field>
            </div>
            <Field label={t("Timezone")}>{(id) => <Select id={id} name="timezone" defaultValue={tzs.includes(tz) ? tz : 'UTC'}>{tzs.map((t) => <option key={t}>{t}</option>)}</Select>}</Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t("Address (optional)")}>{(id) => <Input id={id} name="line1" maxLength={200} />}</Field>
              <Field label={t("City")}>{(id) => <Input id={id} name="city" maxLength={100} />}</Field>
            </div>
            <Button type="submit" className="w-full" loading={busy}>{t("Continue")}</Button>
          </form>
        </>
      )}

      {step === 'whatsapp' && (
        <>
          <h1 className="mt-2 text-lg font-semibold">{t("Connect WhatsApp")}</h1>
          <p className="mt-1 text-sm text-slate-600">{t("Link your business WhatsApp by scanning a QR code with your phone, just like WhatsApp Web.")}</p>
          <div className="mt-6 flex flex-col gap-2">
            <Button onClick={connectNow} loading={busy}>{t("Connect WhatsApp")}</Button>
            <Button variant="secondary" onClick={skip}>{t("Skip for now")}</Button>
          </div>
        </>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-lg">
        <p className="mb-6 text-center text-lg font-semibold text-emerald-800">{BRAND}</p>
        <div className="rounded-lg bg-white p-6 shadow-sm ring-1 ring-slate-200">{children}</div>
      </div>
    </main>
  );
}
