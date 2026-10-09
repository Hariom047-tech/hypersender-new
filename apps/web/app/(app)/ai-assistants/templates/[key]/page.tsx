'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { LANGUAGES, TemplateIcon, WhatsAppChat } from '@/components/ai/visuals';
import { WizardStepper, type WizardStep } from '@/components/ai/wizard-steps';
import { Button, Card, ErrorState, Field, Input, LoadingSkeleton, Notice, Select, cx } from '@/components/ui';
import { api, friendlyMessage } from '@/lib/api';
import { can } from '@/lib/permissions';
import type { AssistantTemplate } from '@/lib/types';
import { useWorkspace } from '@/lib/workspace';
import { t as tr } from '@/lib/i18n';

type Draft = { businessId: string; name: string; tone: string; emoji: string; primaryLanguage: string; supportedLanguages: string[]; capabilities: Record<string, boolean> };

/** Screen 2 (preview) + install wizard steps 1-4. Steps 5-8 continue in the assistant builder. */
export default function TemplatePage() {
  const { key } = useParams<{ key: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const { orgId, role, businesses, businessId } = useWorkspace();
  const [step, setStep] = useState<WizardStep>(search.get('use') === '1' ? 'Business' : 'Preview'); // i18n-ignore (step ids)
  const [demo, setDemo] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const q = useQuery({ queryKey: ['org', orgId, 'ai-template', key], queryFn: () => api<AssistantTemplate>(`/v1/ai/templates/${key}`) });
  const create = useMutation({
    mutationFn: (d: Draft) => api<{ id: string }>('/v1/ai/assistants', { method: 'POST', body: {
      templateKey: key, businessId: d.businessId, name: d.name, primaryLanguage: d.primaryLanguage, supportedLanguages: d.supportedLanguages,
      tone: { tone: d.tone, emoji: d.emoji }, capabilities: d.capabilities } }),
    onSuccess: (r) => router.push(`/ai-assistants/${r.id}?setup=1`),
  });
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <LoadingSkeleton />;
  const t = q.data;
  const d: Draft = draft ?? { businessId: businessId ?? businesses[0]?.id ?? '', name: `${businesses.find((b) => b.id === (businessId ?? businesses[0]?.id))?.name ?? 'My'} ${t.name.replace(/ Assistant$/, '')}`.slice(0, 100),
    tone: 'FRIENDLY', emoji: 'LIGHT', primaryLanguage: t.supportedLanguages[0] ?? 'en', supportedLanguages: t.supportedLanguages,
    capabilities: Object.fromEntries(t.capabilities.map((c) => [c.key, c.defaultEnabled && c.available])) };
  const set = (patch: Partial<Draft>) => setDraft({ ...d, ...patch });
  const writable = can(role, 'assistants:manage');
  const included = t.capabilities.filter((c) => c.name && c.defaultEnabled);
  const optional = t.capabilities.filter((c) => c.name && !c.defaultEnabled);

  return (
    <>
      <nav className="mb-3 text-sm text-slate-500"><Link href="/ai-assistants/templates" className="underline">{tr("Templates")}</Link> / {tr(t.name)}</nav>
      <WizardStepper current={step} />
      {step === 'Preview' && (
        <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
          <div className="space-y-5">
            <div className="flex items-start gap-4">
              <TemplateIcon iconKey={t.iconKey} size="lg" />
              <div>
                <h1 className="text-2xl font-semibold text-slate-900">{tr(t.name)}</h1>
                <p className="mt-1 text-slate-600">{t.shortDescription}</p>
              </div>
            </div>
            {t.longDescription && <p className="text-sm leading-6 text-slate-700">{tr(t.longDescription)}</p>}
            <Card title={tr("What it can do")}>
              <ul className="grid gap-2 sm:grid-cols-2">
                {included.map((c) => <li key={c.key} className="flex gap-2 text-sm"><span aria-hidden className="text-emerald-700">✓</span><span><span className="font-medium">{tr(c.name ?? '')}</span>{c.required && <span className="ml-1 text-xs text-slate-500">{tr("(always on)")}</span>}</span></li>)}
              </ul>
              {optional.length > 0 && (
                <>
                  <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-slate-500">{tr("Optional")}</p>
                  <ul className="mt-2 grid gap-2 sm:grid-cols-2">
                    {optional.map((c) => <li key={c.key} className="flex gap-2 text-sm text-slate-600"><span aria-hidden>☐</span>{tr(c.name ?? '')}{!c.available && <span className="text-xs text-slate-400">{tr("(coming soon)")}</span>}</li>)}
                  </ul>
                </>
              )}
            </Card>
            <div className="grid gap-4 sm:grid-cols-2">
              <Card title={tr("Required setup")}>
                <ul className="space-y-1.5 text-sm">
                  {t.setupRequirements.map((r) => <li key={r.key} className="flex justify-between gap-2"><span>{tr(r.label)}</span><span className="text-xs text-slate-500">{r.severity === 'REQUIRED' ? tr("Required") : tr("Recommended")}</span></li>)}
                </ul>
              </Card>
              <Card title={tr("Good to know")}>
                <dl className="space-y-1.5 text-sm">
                  <div className="flex justify-between gap-2"><dt className="text-slate-500">{tr("Recommended for")}</dt><dd className="text-right">{t.recommendedFor.map((x) => tr(x)).join(', ')}</dd></div>
                  <div className="flex justify-between gap-2"><dt className="text-slate-500">{tr("Setup time")}</dt><dd>{t.setupMinutes ? tr("~{setupMinutes} minutes", { setupMinutes: t.setupMinutes }) : '—'}</dd></div>
                  <div className="flex justify-between gap-2"><dt className="text-slate-500">{tr("Languages")}</dt><dd>{t.supportedLanguages.map((l) => LANGUAGES.find(([c]) => c === l)?.[1] ?? l).join(', ')}</dd></div>
                </dl>
              </Card>
            </div>
            {writable ? (
              <div className="flex gap-2">
                {/* i18n-ignore (step ids) */}
                <Button variant="secondary" onClick={() => setStep('Business')}>{tr("Customize Template")}</Button>
                <Button onClick={() => setStep('Business' /* i18n-ignore */)}>{tr("Use Template")}</Button>
              </div>
            ) : <Notice>{tr("Ask an owner, admin or manager to create assistants.")}</Notice>}
          </div>
          <div>
            {t.demoConversations.length > 1 && (
              <div role="tablist" aria-label={tr("Example conversations")} className="mb-2 flex flex-wrap gap-1">
                {t.demoConversations.map((c, i) => (
                  <button key={c.title} role="tab" aria-selected={demo === i} onClick={() => setDemo(i)}
                    className={cx('rounded-full px-2.5 py-1 text-xs ring-1 ring-inset', demo === i ? 'bg-emerald-600 text-white ring-emerald-600' : 'bg-white text-slate-700 ring-slate-300')}>{tr(c.title)}</button>
                ))}
              </div>
            )}
            <WhatsAppChat title={tr(t.name)} subtitle={tr("Example conversation")} label={tr("Demo preview")} messages={t.demoConversations[demo]?.messages ?? []} className="h-[460px]" />
            <p className="mt-2 text-xs text-slate-500">{tr("Demo data for illustration. Your assistant uses your own services, prices and availability.")}</p>
          </div>
        </div>
      )}

      {step !== 'Preview' && (
          <form className="max-w-2xl space-y-5" onSubmit={(e: FormEvent) => { e.preventDefault(); /* i18n-ignore (step ids) */ if (step === 'Business') setStep('Configure'); else if (step === 'Configure') setStep('Capabilities'); else create.mutate(d); }}>
          <div className="flex items-center gap-3"><TemplateIcon iconKey={t.iconKey} size="sm" /><h1 className="text-lg font-semibold">{tr(t.name)}</h1></div>
          {create.isError && <Notice tone="error">{friendlyMessage(create.error)}</Notice>}
          {step === 'Business' && (
            <Card title={tr("Choose business")}>
              {businesses.length === 0 ? <Notice tone="warn">{tr("Create a business first (Settings → Business).")}</Notice> : (
                <Field label={tr("Business")} hint={tr("The assistant answers with this business's services, prices and hours.")}>{(id, h) => (
                  <Select id={id} aria-describedby={h} value={d.businessId} onChange={(e) => set({ businessId: e.target.value })}>
                    {businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </Select>)}</Field>
              )}
            </Card>
          )}
          {step === 'Configure' && (
            <Card title={tr("Configure assistant")}>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="sm:col-span-2"><Field label={tr("Assistant name")} hint={tr("What customers see, e.g. \"Priya from ABC Dental\".")}>{(id, h) => <Input id={id} aria-describedby={h} value={d.name} maxLength={100} required onChange={(e) => set({ name: e.target.value })} />}</Field></div>
                <Field label={tr("Tone")}>{(id) => <Select id={id} value={d.tone} onChange={(e) => set({ tone: e.target.value })}><option value="FRIENDLY">{tr("Friendly")}</option><option value="PROFESSIONAL">{tr("Professional")}</option><option value="WARM">{tr("Warm")}</option><option value="CASUAL">{tr("Casual")}</option></Select>}</Field>
                <Field label={tr("Emojis")}>{(id) => <Select id={id} value={d.emoji} onChange={(e) => set({ emoji: e.target.value })}><option value="NONE">{tr("None")}</option><option value="LIGHT">{tr("A few")}</option><option value="EXPRESSIVE">{tr("Expressive")}</option></Select>}</Field>
                <Field label={tr("Main language")}>{(id) => <Select id={id} value={d.primaryLanguage} onChange={(e) => set({ primaryLanguage: e.target.value, supportedLanguages: Array.from(new Set([e.target.value, ...d.supportedLanguages])) })}>{LANGUAGES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</Select>}</Field>
                <fieldset><legend className="text-sm font-medium text-slate-800">{tr("Also replies in")}</legend>
                  <div className="mt-1 flex flex-wrap gap-3">{LANGUAGES.slice(0, 4).map(([c, n]) => (
                    <label key={c} className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={d.supportedLanguages.includes(c)} disabled={c === d.primaryLanguage}
                      onChange={(e) => set({ supportedLanguages: e.target.checked ? [...d.supportedLanguages, c] : d.supportedLanguages.filter((x) => x !== c) })} />{n}</label>))}</div>
                </fieldset>
              </div>
            </Card>
          )}
          {step === 'Capabilities' && (
            <Card title={tr("Capabilities")}>
              <ul className="divide-y divide-slate-100">
                {t.capabilities.filter((c) => c.name).map((c) => (
                  <li key={c.key} className="flex items-center justify-between gap-3 py-2.5">
                    <div><p className="text-sm font-medium">{tr(c.name ?? '')}</p><p className="text-xs text-slate-500">{tr(c.description ?? '')}{!c.available && tr(" · Coming soon")}</p></div>
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" role="switch" aria-label={tr(c.name ?? c.key)} checked={Boolean(d.capabilities[c.key])} disabled={c.required || !c.available}
                        onChange={(e) => set({ capabilities: { ...d.capabilities, [c.key]: e.target.checked } })} />
                      {c.required ? tr("Always on") : d.capabilities[c.key] ? tr("On") : tr("Off")}
                    </label>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-slate-500">{tr("You can change capabilities and their settings any time. Nothing goes live until you publish.")}</p>
            </Card>
          )}
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={() => setStep(step === 'Business' ? 'Preview' /* i18n-ignore */ : step === 'Configure' ? 'Business' : 'Configure')}>{tr("Back")}</Button>
            <Button type="submit" loading={create.isPending} disabled={!d.businessId}>{step === 'Capabilities' ? tr("Create assistant") : tr("Continue")}</Button>
          </div>
        </form>
      )}
    </>
  );
}
