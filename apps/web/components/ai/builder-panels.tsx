'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button, Card, DataTable, EmptyState, Field, Input, InstanceStatus, MetricCard, Notice, Select, StatusBadge, Textarea, cx } from '@/components/ui';
import { api, friendlyMessage } from '@/lib/api';
import { dateTime, timeAgo } from '@/lib/format';
import type { Assistant, AssistantActivity, Capability, Instance, InstructionIssue, KnowledgeSource, Readiness } from '@/lib/types';
import { LANGUAGES } from './visuals';
import { t as tr, msg } from '@/lib/i18n';

export const assistantKey = (org: string, id: string) => ['org', org, 'ai-assistant', id] as const;

function useSave(orgId: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: object) => api<Assistant>(`/v1/ai/assistants/${id}`, { method: 'PATCH', body }),
    onSuccess: (a) => { qc.setQueryData(assistantKey(orgId, id), a); void qc.invalidateQueries({ queryKey: [...assistantKey(orgId, id), 'readiness'] }); },
  });
}

// ------------------------------------------------------------------ readiness
export function ReadinessCard({ r, compact }: { r: Readiness; compact?: boolean }) {
  const missing = r.checks.filter((c) => !c.ok);
  return (
    <Card title={tr("Assistant readiness")}>
      <div className="flex items-center gap-4">
        <div className="relative h-16 w-16 shrink-0" aria-hidden>
          <svg viewBox="0 0 36 36" className="h-16 w-16 -rotate-90"><circle cx="18" cy="18" r="15.5" fill="none" stroke="#e2e8f0" strokeWidth="4" />
            <circle cx="18" cy="18" r="15.5" fill="none" stroke={r.score >= 80 ? '#047857' : r.score >= 50 ? '#d97706' : '#dc2626'} strokeWidth="4" strokeDasharray={`${r.score * 0.974} 100`} strokeLinecap="round" /></svg>
          <span className="absolute inset-0 flex items-center justify-center text-sm font-semibold">{r.score}%</span>
        </div>
        <p className="text-sm text-slate-700"><span className="sr-only">{tr("Readiness")}{' '}{r.score} {tr("percent.")}{' '}</span>{r.publishable ? tr("Ready to publish.") : tr("Some items need attention before publishing.")}</p>
      </div>
      {missing.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{tr("Missing")}</p>
          <ul className="mt-1 space-y-1 text-sm">
            {missing.slice(0, compact ? 4 : 20).map((c) => <li key={c.key}><span className={c.severity === 'REQUIRED' ? 'text-red-700' : 'text-amber-700'}>{c.severity === 'REQUIRED' ? '●' : '○'}</span> {c.href ? <Link className="underline decoration-slate-300 hover:text-emerald-800" href={c.href}>{tr(c.label)}</Link> : tr(c.label)}{c.fix && !compact && <span className="block pl-4 text-xs text-slate-500">{tr(c.fix)}{c.href && <> · <Link className="font-medium text-emerald-800 underline" href={c.href}>{tr("Set up now →")}</Link></>}</span>}</li>)}
          </ul>
        </div>
      )}
      {r.capabilityErrors.length > 0 && <ul className="mt-2 text-xs text-red-700">{r.capabilityErrors.map((e) => <li key={e}>{e}</li>)}</ul>}
      {r.instructionIssues.filter((i) => i.severity === 'ERROR').map((i) => <p key={i.code} className="mt-2 text-xs text-red-700">{tr("Instructions:")}{' '}{i.message}</p>)}
    </Card>
  );
}

// ------------------------------------------------------------------- overview
export function OverviewPanel({ a, orgId, readiness }: { a: Assistant; orgId: string; readiness?: Readiness }) {
  const act = useQuery({ queryKey: [...assistantKey(orgId, a.id), 'activity'], queryFn: () => api<AssistantActivity>(`/v1/ai/assistants/${a.id}/activity`), refetchInterval: 30_000 });
  const t = act.data?.today;
  const enabled = a.capabilities.filter((c) => c.enabled);
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard label={tr("Conversations handled today")} value={t?.conversations ?? '—'} />
          <MetricCard label={tr("Resolved automatically")} value={t?.replied ?? '—'} hint={tr("Turns answered without a handoff")} />
          <MetricCard label={tr("Human handoffs")} value={t?.handoffs ?? '—'} tone={t && t.handoffs > 0 ? 'warn' : undefined} />
          <MetricCard label={tr("Bookings created")} value={t?.bookings ?? '—'} />
        </div>
        <Card title={tr("WhatsApp")}>
          {a.whatsapp ? (
            <div className="flex flex-wrap items-center gap-3 text-sm"><span className="font-medium">{a.whatsapp.name}</span>{a.whatsapp.phone && <span className="text-slate-600">{a.whatsapp.phone}</span>}<InstanceStatus status={a.whatsapp.status} />
              <Link href="/inbox" className="ml-auto text-sm font-medium text-emerald-800 underline">{tr("Open Inbox")}</Link></div>
          ) : <p className="text-sm text-slate-600">{tr("No WhatsApp number selected yet.")}</p>}
        </Card>
        <Card title={tr('Capabilities · {n} active', { n: enabled.length })}>
          <ul className="flex flex-wrap gap-1.5">{enabled.map((c) => <li key={c.key} className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-800 ring-1 ring-inset ring-emerald-200">{tr(c.name)}</li>)}</ul>
        </Card>
        {a.template?.updateAvailable && (
          <Notice>{tr("A newer version of the “")}{a.template.name}{tr("” template is available (v")}{a.template.latestVersion}{tr("). Your assistant keeps its current behaviour (v")}{a.template.installedVersion}{tr(") until you choose to update. Reviewing and applying template updates is coming soon.")}</Notice>
        )}
      </div>
      <div className="space-y-4">
        {readiness && <ReadinessCard r={readiness} compact />}
        <Card title={tr("Details")}>
          <dl className="space-y-1.5 text-sm">
            <div className="flex justify-between"><dt className="text-slate-500">{tr("Template")}</dt><dd>{a.template ? `${a.template.name} v${a.template.installedVersion}` : tr("Custom")}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">{tr("Business")}</dt><dd>{a.businessName}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">{tr("Published")}</dt><dd>{a.publishedVersion ? `v${a.publishedVersion} · ${timeAgo(a.publishedAt)}` : tr("Not yet")}</dd></div>
          </dl>
        </Card>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- instructions
const STRUCTURED = [['about', msg("About your business")], ['do', msg("Always do")], ['dont', msg("Never do")], ['handoff', msg("When to hand over to your team")]] as const;
function toStructured(text: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  const parts = (text ?? '').split(/^## /m);
  for (const p of parts) {
    const [head, ...rest] = p.split('\n');
    const hit = STRUCTURED.find(([, label]) => label === head.trim());
    if (hit) out[hit[0]] = rest.join('\n').trim();
  }
  return out;
}

export function InstructionsPanel({ a, orgId, editable }: { a: Assistant; orgId: string; editable: boolean }) {
  const save = useSave(orgId, a.id);
  const [mode, setMode] = useState<'SIMPLE' | 'ADVANCED' | 'CUSTOM_PROMPT'>(a.instructionsMode);
  const [text, setText] = useState(a.customInstructions ?? '');
  const [structured, setStructured] = useState<Record<string, string>>(() => toStructured(a.customInstructions));
  const [issues, setIssues] = useState<InstructionIssue[] | null>(null);
  const [saved, setSaved] = useState(false);
  const composed = mode !== 'ADVANCED' ? text : STRUCTURED.filter(([k]) => structured[k]?.trim()).map(([k, label]) => `## ${label}\n${structured[k].trim()}`).join('\n\n');
  const review = useMutation({ mutationFn: () => api<{ issues: InstructionIssue[] }>(`/v1/ai/assistants/${a.id}/instructions/validate`, { method: 'POST', body: { text: composed } }),
    onSuccess: (r) => setIssues(r.issues) });

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSaved(false);
    const f = new FormData(e.currentTarget);
    const n = (k: string) => String(f.get(k) ?? '');
    save.mutate({
      name: n('name'), customInstructions: composed || null, instructionsMode: mode,
      tone: { tone: n('tone'), formality: n('formality'), responseLength: n('responseLength'), emoji: n('emoji'), languageMode: n('languageMode') },
      primaryLanguage: n('primaryLanguage'), supportedLanguages: Array.from(new Set([n('primaryLanguage'), ...f.getAll('langs').map(String)])),
      welcome: { enabled: f.get('welcomeEnabled') === 'on', style: n('welcomeStyle'), guidedOptions: n('guided').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 6) },
      handoff: { takeover: n('takeover'), resume: n('resume'), resumeAfterMinutes: Number(n('resumeAfter') || 120), ...(n('fallback') ? { fallbackMessage: n('fallback') } : {}) },
      responseWaitMs: Math.round(Number(n('wait') || 4) * 1000),
    }, { onSuccess: () => { setSaved(true); review.mutate(); } });
  };
  return (
    <form onSubmit={submit} className="space-y-6">
      {save.isError && <Notice tone="error">{friendlyMessage(save.error)}</Notice>}
      {saved && <Notice tone="success">{tr("Saved. Publish to apply the changes to live WhatsApp chats.")}</Notice>}
      <fieldset disabled={!editable} className="space-y-6">
        <Card title={tr("Identity & style")}>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="sm:col-span-3"><Field label={tr("Assistant name")}>{(id) => <Input id={id} name="name" defaultValue={a.name} required maxLength={100} />}</Field></div>
            <Field label={tr("Tone")}>{(id) => <Select id={id} name="tone" defaultValue={a.tone.tone}><option value="FRIENDLY">{tr("Friendly")}</option><option value="PROFESSIONAL">{tr("Professional")}</option><option value="WARM">{tr("Warm")}</option><option value="CASUAL">{tr("Casual")}</option></Select>}</Field>
            <Field label={tr("Formality")}>{(id) => <Select id={id} name="formality" defaultValue={a.tone.formality}><option value="FORMAL">{tr("Formal")}</option><option value="NEUTRAL">{tr("Neutral")}</option><option value="INFORMAL">{tr("Informal")}</option></Select>}</Field>
            <Field label={tr("Reply length")}>{(id) => <Select id={id} name="responseLength" defaultValue={a.tone.responseLength}><option value="SHORT">{tr("Short")}</option><option value="MEDIUM">{tr("Medium")}</option><option value="DETAILED">{tr("Detailed")}</option></Select>}</Field>
            <Field label={tr("Emojis")}>{(id) => <Select id={id} name="emoji" defaultValue={a.tone.emoji}><option value="NONE">{tr("None")}</option><option value="LIGHT">{tr("A few")}</option><option value="EXPRESSIVE">{tr("Expressive")}</option></Select>}</Field>
            <Field label={tr("Main language")}>{(id) => <Select id={id} name="primaryLanguage" defaultValue={a.primaryLanguage}>{LANGUAGES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</Select>}</Field>
            <Field label={tr("Language choice")}>{(id) => <Select id={id} name="languageMode" defaultValue={a.tone.languageMode}><option value="AUTO">{tr("Follow the customer")}</option><option value="FIXED">{tr("Always main language")}</option></Select>}</Field>
            <fieldset className="sm:col-span-3"><legend className="text-sm font-medium text-slate-800">{tr("Also replies in")}</legend>
              <div className="mt-1 flex flex-wrap gap-3">{LANGUAGES.map(([c, n]) => <label key={c} className="flex items-center gap-1.5 text-sm"><input type="checkbox" name="langs" value={c} defaultChecked={a.supportedLanguages.includes(c)} />{n}</label>)}</div>
            </fieldset>
          </div>
        </Card>
        <Card title={tr("Instructions")} actions={
          <div role="group" aria-label={tr("Editor mode")} className="flex rounded-md ring-1 ring-slate-300">
            {(['SIMPLE', 'ADVANCED', 'CUSTOM_PROMPT'] as const).map((m) => <button key={m} type="button" aria-pressed={mode === m} onClick={() => { setMode(m); setIssues(null); }} className={cx('px-2.5 py-1 text-xs', mode === m ? 'bg-slate-900 text-white' : 'text-slate-700')}>{m === 'SIMPLE' ? tr("Simple") : m === 'ADVANCED' ? tr("Advanced") : tr("Full custom prompt")}</button>)}
          </div>}>
          <p className="mb-3 text-sm text-slate-600">{tr("Tell the assistant how your business likes to talk to customers. Built-in safety rules always apply and cannot be changed here.")}</p>
          {mode === 'CUSTOM_PROMPT' ? (
            <div className="space-y-2">
              <Notice>{tr("Your prompt")}{' '}<strong>{tr("replaces the template's role prompt")}</strong> {tr("(e.g. the restaurant ordering flow). Built-in safety rules, real tools, prices from your menu and your business details are still added automatically - the assistant can never invent prices or skip order confirmation. Use")}{' '}{tr("{{RESTAURANT_NAME}}")} / {tr("{{BUSINESS_NAME}}")} / {tr("{{ASSISTANT_NAME}}")} {tr("to insert your details. Leave empty to use the template default.")}</Notice>
              <Field label={tr("System prompt")} hint={tr('{n} / 40,000 characters', { n: text.length.toLocaleString('en-IN') })}>{(id, h) => (
                <Textarea id={id} aria-describedby={h} rows={22} maxLength={40000} className="font-mono text-xs" value={text} onChange={(e) => { setText(e.target.value); setIssues(null); }}
                  placeholder={tr("You are the WhatsApp ordering assistant for {{RESTAURANT_NAME}}...")} />)}</Field>
            </div>
          ) : mode === 'SIMPLE' ? (
            <Field label={tr("Your instructions")} hint={tr("Example: Customers ko friendly Hindi me reply kare. Price negotiate na kare. Emergency cases staff ko bheje.")}>{(id, h) => (
              <Textarea id={id} aria-describedby={h} rows={6} maxLength={8000} value={text} onChange={(e) => { setText(e.target.value); setIssues(null); }} />)}</Field>
          ) : (
            <div className="grid gap-4">{STRUCTURED.map(([k, label]) => (
              <Field key={k} label={label}>{(id) => <Textarea id={id} rows={3} maxLength={2000} value={structured[k] ?? ''} onChange={(e) => { setStructured({ ...structured, [k]: e.target.value }); setIssues(null); }} />}</Field>))}</div>
          )}
          <div className="mt-3 flex items-center gap-2">
            <Button type="button" size="sm" variant="secondary" loading={review.isPending} onClick={() => review.mutate()}>{tr("Check instructions")}</Button>
            <span className="text-xs text-slate-500">{tr("We only point out problems - your text is never rewritten.")}</span>
          </div>
          {issues && (issues.length === 0 ? <p className="mt-2 text-sm text-emerald-800">{tr("Looks good.")}</p> : (
            <ul className="mt-3 space-y-2">{issues.map((i) => (
              <li key={i.code}><Notice tone={i.severity === 'ERROR' ? 'error' : i.severity === 'WARNING' ? 'warn' : 'info'}>{i.message}</Notice></li>))}</ul>
          ))}
        </Card>
        <div className="grid gap-6 lg:grid-cols-2">
          <Card title={tr("Welcome")}>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="welcomeEnabled" defaultChecked={a.welcome.enabled} /> {tr("Greet customers at the start of a chat")}</label>
            <div className="mt-3 space-y-3">
              <Field label={tr("Greeting style")} hint={tr("Written naturally by the assistant - not sent to every message.")}>{(id, h) => <Input id={id} aria-describedby={h} name="welcomeStyle" maxLength={300} defaultValue={a.welcome.style ?? ''} />}</Field>
              <Field label={tr("Quick options (one per line, max 6)")} hint={tr("Offered only when a customer just says hello. Free text always works.")}>{(id, h) => <Textarea id={id} aria-describedby={h} name="guided" rows={4} defaultValue={a.welcome.guidedOptions.join('\n')} />}</Field>
            </div>
          </Card>
          <Card title={tr("Human takeover")}>
            <div className="space-y-3">
              <Field label={tr("When your team replies (dashboard or phone)")}>{(id) => <Select id={id} name="takeover" defaultValue={a.handoff.takeover}><option value="PAUSE_AI">{tr("Pause the assistant in that chat")}</option><option value="KEEP_AI">{tr("Keep the assistant replying")}</option></Select>}</Field>
              <Field label={tr("Resume the assistant")}>{(id) => <Select id={id} name="resume" defaultValue={a.handoff.resume}><option value="MANUAL">{tr("Only when someone clicks “Resume AI”")}</option><option value="AUTO_AFTER">{tr("Automatically after the team goes quiet")}</option><option value="UNTIL_RESOLVED">{tr("When the chat is resolved")}</option></Select>}</Field>
              <Field label={tr("Auto-resume after (minutes)")}>{(id) => <Input id={id} name="resumeAfter" type="number" min={5} max={10080} defaultValue={a.handoff.resumeAfterMinutes} />}</Field>
              <Field label={tr("Wait for the customer to finish typing (seconds)")} hint={tr("Messages sent within this window are answered together.")}>{(id, h) => <Input id={id} aria-describedby={h} name="wait" type="number" min={0} max={30} step={0.5} defaultValue={a.responseWaitMs / 1000} />}</Field>
              <Field label={tr("Fallback message (optional)")} hint={tr("Sent if the assistant cannot answer safely; the chat then goes to your team.")}>{(id, h) => <Textarea id={id} aria-describedby={h} name="fallback" rows={2} maxLength={500} defaultValue={a.handoff.fallbackMessage ?? ''} />}</Field>
            </div>
          </Card>
        </div>
        {editable && <Button type="submit" loading={save.isPending}>{tr("Save changes")}</Button>}
      </fieldset>
    </form>
  );
}

// ---------------------------------------------------------------- capabilities
const SETTING_LABELS: Record<string, string> = {
  bookingWindowDays: msg('Maximum advance booking (days)'), minNoticeMinutes: msg('Minimum notice (minutes)'), allowSameDay: msg('Allow same-day'),
  requireConfirmation: msg('Confirmation required'), autoConfirm: msg('Auto-confirm bookings'), slotIntervalMinutes: msg('Slot interval (minutes)'), maxSlots: msg('Slots to offer'),
  defaultDurationMinutes: msg('Default duration (minutes)'), requireCustomerName: msg('Ask for the customer’s name'), notifyTeamOnHot: msg('Alert team about hot leads'),
  notifyTeam: msg('Notify team on handover'), defaultMinutes: msg('Pause for (minutes)'), maxResults: msg('Knowledge results per answer'),
  autoReminders: msg('Send reminders automatically'),
};

export function CapabilitiesPanel({ a, orgId, editable }: { a: Assistant; orgId: string; editable: boolean }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState<Capability | null>(null);
  const m = useMutation({
    mutationFn: (p: { key: string; body: object }) => api<Assistant>(`/v1/ai/assistants/${a.id}/capabilities/${p.key}`, { method: 'PUT', body: p.body }),
    onSuccess: (x) => { qc.setQueryData(assistantKey(orgId, a.id), x); setOpen(null); void qc.invalidateQueries({ queryKey: [...assistantKey(orgId, a.id), 'readiness'] }); },
  });
  return (
    <>
      {m.isError && <div className="mb-4"><Notice tone="error">{friendlyMessage(m.error)}</Notice></div>}
      <Card title={tr("Capabilities")} actions={<span className="text-xs text-slate-500">{tr("Changes to live behaviour apply after publishing; turning a capability OFF applies immediately.")}</span>}>
        <ul className="divide-y divide-slate-100">
          {a.capabilities.map((c) => (
            <li key={c.key} className="flex flex-wrap items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-slate-900">{tr(c.name)}{c.required && <span className="ml-2 text-xs font-normal text-slate-500">{tr("Required by template")}</span>}</p>
                <p className="text-xs text-slate-500">{tr(c.description)}{!c.available && tr(" · Coming soon")}</p>
              </div>
              {Object.keys(c.configSchema.properties ?? {}).length > 0 && (
                <Button size="sm" variant="ghost" onClick={() => setOpen(c)} aria-label={tr('{name} settings', { name: tr(c.name) })}>{tr("Settings")}</Button>
              )}
              <label className="flex w-16 items-center justify-end gap-2 text-sm">
                <span className={c.enabled ? 'font-medium text-emerald-800' : 'text-slate-500'}>{c.enabled ? tr("ON") : tr("OFF")}</span>
                <input type="checkbox" role="switch" aria-label={tr(c.name)} checked={c.enabled} disabled={!editable || c.required || (!c.available && !c.enabled) || m.isPending}
                  onChange={(e) => m.mutate({ key: c.key, body: { enabled: e.target.checked } })} />
              </label>
            </li>
          ))}
        </ul>
      </Card>
      {open && <SettingsDrawer c={open} busy={m.isPending} editable={editable} onClose={() => setOpen(null)} onSave={(configuration) => m.mutate({ key: open.key, body: { configuration } })} />}
    </>
  );
}

function SettingsDrawer({ c, onClose, onSave, busy, editable }: { c: Capability; onClose: () => void; onSave: (cfg: Record<string, unknown>) => void; busy: boolean; editable: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  const props = Object.entries(c.configSchema.properties ?? {});
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const cfg: Record<string, unknown> = {};
    for (const [k, s] of props) cfg[k] = s.type === 'boolean' ? f.get(k) === 'true' : Number(f.get(k));
    onSave(cfg);
  };
  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby="cap-settings-title" className="ml-auto mr-0 h-full max-h-full w-full max-w-md rounded-none p-0 backdrop:bg-slate-900/40">
      <form onSubmit={submit} className="flex h-full flex-col">
        <header className="border-b border-slate-200 p-4"><h2 id="cap-settings-title" className="font-semibold">{tr('{name} settings', { name: tr(c.name) })}</h2><p className="text-xs text-slate-500">{tr(c.description)}</p></header>
        <fieldset disabled={!editable} className="flex-1 space-y-4 overflow-y-auto p-4">
          {props.map(([k, s]) => (
            <Field key={k} label={tr(SETTING_LABELS[k] ?? k)}>{(id) => s.type === 'boolean'
              ? <Select id={id} name={k} defaultValue={String(c.configuration[k] ?? s.default ?? false)}><option value="true">{tr("Yes")}</option><option value="false">{tr("No")}</option></Select>
              : <Input id={id} name={k} type="number" min={s.minimum} max={s.maximum} defaultValue={String(c.configuration[k] ?? s.default ?? '')} required />}</Field>
          ))}
        </fieldset>
        <footer className="flex gap-2 border-t border-slate-200 p-4">
          {editable && <Button type="submit" loading={busy}>{tr("Save")}</Button>}
          <Button type="button" variant="secondary" onClick={() => ref.current?.close()}>{tr("Cancel")}</Button>
        </footer>
      </form>
    </dialog>
  );
}

// ------------------------------------------------------------------- knowledge
export function KnowledgePanel({ a, orgId, editable, readiness }: { a: Assistant; orgId: string; editable: boolean; readiness?: Readiness }) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState<'TEXT' | 'FAQ' | null>(null);
  const [faqs, setFaqs] = useState([{ q: '', a: '' }]);
  const key = [...assistantKey(orgId, a.id), 'knowledge'];
  const q = useQuery({ queryKey: key, queryFn: () => api<KnowledgeSource[]>(`/v1/ai/assistants/${a.id}/knowledge`),
    refetchInterval: (query) => ((query.state.data as KnowledgeSource[] | undefined)?.some((s) => s.status === 'PENDING' || s.status === 'PROCESSING') ? 2000 : false) });
  const add = useMutation({
    mutationFn: (body: object) => api(`/v1/ai/assistants/${a.id}/knowledge`, { method: 'POST', body }),
    onSuccess: () => { setAdding(null); setFaqs([{ q: '', a: '' }]); void qc.invalidateQueries({ queryKey: key }); void qc.invalidateQueries({ queryKey: [...assistantKey(orgId, a.id), 'readiness'] }); },
  });
  const del = useMutation({ mutationFn: (sid: string) => api(`/v1/ai/assistants/${a.id}/knowledge/${sid}`, { method: 'DELETE' }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: key }); void qc.invalidateQueries({ queryKey: [...assistantKey(orgId, a.id), 'readiness'] }); } });
  // Ingestion finishes in the background: refresh readiness whenever the number of READY sources changes.
  const readyCount = (q.data ?? []).filter((s) => s.status === 'READY').length;
  useEffect(() => { void qc.invalidateQueries({ queryKey: [...assistantKey(orgId, a.id), 'readiness'] }); }, [readyCount, qc, orgId, a.id]);
  const check = (k: string) => readiness?.checks.find((c) => c.key === k);
  const progress: Array<[string, boolean | undefined, string?]> = [
    [tr('Business details'), check('BUSINESS_PROFILE')?.ok ?? true], [tr('Services'), check('SERVICES')?.ok, readiness ? `${readiness.counts.services}` : undefined],
    [tr('Staff & resources'), check('RESOURCES')?.ok, readiness ? `${readiness.counts.resources}` : undefined],
    [tr('Knowledge'), (readiness?.counts.knowledgeReady ?? 0) > 0, readiness ? `${readiness.counts.knowledgeReady}/${readiness.counts.knowledgeTotal}` : undefined], ['WhatsApp', check('WHATSAPP')?.ok],
  ];
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    add.mutate(adding === 'FAQ' ? { type: 'FAQ', title: f.get('title'), faqs: faqs.filter((x) => x.q.trim() && x.a.trim()), scope: f.get('scope') }
      : { type: 'TEXT', title: f.get('title'), content: f.get('content'), scope: f.get('scope') });
  };
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
      <div className="space-y-6">
        <h2 className="text-lg font-semibold">{tr("Train")}{' '}{a.name}</h2>
        <ol className="flex flex-wrap gap-2 text-sm" aria-label={tr("Setup progress")}>
          {progress.map(([label, ok, detail]) => (
            <li key={label} className={cx('rounded-full px-3 py-1 ring-1 ring-inset', ok ? 'bg-emerald-50 text-emerald-800 ring-emerald-200' : 'bg-white text-slate-600 ring-slate-300')}>
              {label} {ok ? '✓' : ''}{detail !== undefined && <span className="ml-1 text-xs opacity-80">{detail}</span>}
            </li>))}
        </ol>
        <Card title={tr("Business knowledge")}>
          <p className="mb-3 text-sm text-slate-600">{tr("Add FAQs, policies and explanations. Live facts like prices, availability and bookings always come from your business data.")}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" disabled title={tr("PDF import is coming soon")} aria-label={tr("Upload PDF (coming soon)")}>{tr("Upload PDF · soon")}</Button>
            <Button size="sm" variant="secondary" disabled={!editable} onClick={() => setAdding('FAQ')}>{tr("Add FAQ")}</Button>
            <Button size="sm" variant="secondary" disabled title={tr("Website import is coming soon")} aria-label={tr("Add Website (coming soon)")}>{tr("Add Website · soon")}</Button>
            <Button size="sm" variant="secondary" disabled={!editable} onClick={() => setAdding('TEXT')}>{tr("Add Text")}</Button>
          </div>
          {adding && (
            <form onSubmit={submit} className="mt-4 space-y-3 rounded-md bg-slate-50 p-3 ring-1 ring-slate-200" aria-label={adding === 'FAQ' ? tr("Add FAQ") : tr("Add text")}>
              {add.isError && <Notice tone="error">{friendlyMessage(add.error)}</Notice>}
              <Field label={tr("Title")}>{(id) => <Input id={id} name="title" required maxLength={300} defaultValue={adding === 'FAQ' ? `${a.businessName} FAQ` : ''} />}</Field>
              {adding === 'TEXT' ? <Field label={tr("Text")}>{(id) => <Textarea id={id} name="content" rows={8} required maxLength={500000} />}</Field> : (
                <div className="space-y-3">{faqs.map((x, i) => (
                  <div key={i} className="grid gap-2 sm:grid-cols-2">
                    <Field label={tr('Question {n}', { n: i + 1 })}>{(id) => <Input id={id} value={x.q} maxLength={500} onChange={(e) => setFaqs(faqs.map((y, j) => (j === i ? { ...y, q: e.target.value } : y)))} />}</Field>
                    <Field label={tr('Answer {n}', { n: i + 1 })}>{(id) => <Input id={id} value={x.a} maxLength={3000} onChange={(e) => setFaqs(faqs.map((y, j) => (j === i ? { ...y, a: e.target.value } : y)))} />}</Field>
                  </div>))}
                  <Button type="button" size="sm" variant="ghost" onClick={() => setFaqs([...faqs, { q: '', a: '' }])}>{tr("+ Another question")}</Button>
                </div>
              )}
              <Field label={tr("Available to")}>{(id) => <Select id={id} name="scope" defaultValue="ASSISTANT"><option value="ASSISTANT">{tr("This assistant only")}</option><option value="BUSINESS">{tr("All assistants of")}{' '}{a.businessName}</option></Select>}</Field>
              <div className="flex gap-2"><Button type="submit" loading={add.isPending}>{tr("Add")}</Button><Button type="button" variant="secondary" onClick={() => setAdding(null)}>{tr("Cancel")}</Button></div>
            </form>
          )}
          <ul className="mt-4 divide-y divide-slate-100" aria-label={tr("Knowledge sources")}>
            {(q.data ?? []).map((s) => (
              <li key={s.id} className="flex items-center gap-3 py-2.5 text-sm">
                <span className="min-w-0 flex-1 truncate font-medium">{s.title}</span>
                <span className="text-xs text-slate-500">{s.type}{s.chunks ? tr(' · {n} parts', { n: s.chunks }) : ''}{s.scope === 'BUSINESS' ? tr(" · shared") : ''}</span>
                <StatusBadge tone={s.status === 'READY' ? 'green' : s.status === 'FAILED' ? 'red' : 'amber'}>{s.status === 'READY' ? tr("READY") : s.status === 'FAILED' ? (s.error ? tr('Failed: {error}', { error: tr(s.error) }) : tr('Failed')) : tr("Learning…")}</StatusBadge>
                {editable && <Button size="sm" variant="ghost" onClick={() => del.mutate(s.id)} aria-label={tr('Remove {title}', { title: s.title })}>{tr("Remove")}</Button>}
              </li>))}
            {q.data?.length === 0 && <li className="py-3 text-sm text-slate-500">{tr("No knowledge added yet.")}</li>}
          </ul>
        </Card>
        {readiness && (
          <Card title={tr("Business data")}>
            <dl className="grid grid-cols-3 gap-3 text-center text-sm">
              <div><dt className="text-slate-500">{tr("Services")}</dt><dd className="text-xl font-semibold">{readiness.counts.services}</dd></div>
              <div><dt className="text-slate-500">{tr("Staff & resources")}</dt><dd className="text-xl font-semibold">{readiness.counts.resources}</dd></div>
              <div><dt className="text-slate-500">{tr("Locations")}</dt><dd className="text-xl font-semibold">{readiness.counts.locations}</dd></div>
            </dl>
          </Card>
        )}
      </div>
      <div>{readiness && <ReadinessCard r={readiness} />}</div>
    </div>
  );
}

// -------------------------------------------------------------------- whatsapp
export function WhatsAppPanel({ a, orgId, editable }: { a: Assistant; orgId: string; editable: boolean }) {
  const qc = useQueryClient();
  const inst = useQuery({ queryKey: ['org', orgId, 'biz', a.businessId, 'instances'], queryFn: () => api<Instance[]>(`/v1/whatsapp/instances?businessId=${a.businessId}`) });
  const m = useMutation({
    mutationFn: (whatsappInstanceId: string | null) => api<Assistant>(`/v1/ai/assistants/${a.id}/whatsapp`, { method: 'PUT', body: { whatsappInstanceId } }),
    onSuccess: (x) => { qc.setQueryData(assistantKey(orgId, a.id), x); void qc.invalidateQueries({ queryKey: [...assistantKey(orgId, a.id), 'readiness'] }); },
  });
  const options = (inst.data ?? []).filter((i) => i.businessId === a.businessId);
  return (
    <Card title={tr("WhatsApp connection")}>
      <p className="mb-3 text-sm text-slate-600">{tr("Choose which WhatsApp number this assistant answers. One number can have only one active assistant.")}</p>
      {m.isError && <div className="mb-3"><Notice tone="error">{friendlyMessage(m.error)}</Notice></div>}
      {options.length === 0 ? <EmptyState title={tr("No WhatsApp number for this business")} action={<Link className="text-sm font-medium text-emerald-800 underline" href="/whatsapp/instances">{tr("Connect WhatsApp")}</Link>} /> : (
        <ul className="space-y-2" aria-label={tr("WhatsApp numbers")}>
          {options.map((i) => (
            <li key={i.id} className="flex items-center gap-3 rounded-md p-3 ring-1 ring-slate-200">
              <input type="radio" name="wa" id={`wa-${i.id}`} checked={a.whatsapp?.id === i.id} disabled={!editable || m.isPending} onChange={() => m.mutate(i.id)} />
              <label htmlFor={`wa-${i.id}`} className="flex-1 text-sm"><span className="font-medium">{i.name}</span> {i.phoneNumber && <span className="text-slate-500">{i.phoneNumber}</span>}</label>
              <InstanceStatus status={i.status} />
            </li>))}
        </ul>
      )}
      {a.whatsapp && editable && <Button className="mt-3" size="sm" variant="ghost" onClick={() => m.mutate(null)}>{tr("Detach number")}</Button>}
      {a.whatsapp && a.whatsapp.status !== 'CONNECTED' && <div className="mt-3"><Notice tone="warn">{tr("This number is not connected right now. You can publish; replies start once it connects.")}</Notice></div>}
    </Card>
  );
}

// -------------------------------------------------------------------- activity
export function ActivityPanel({ a, orgId }: { a: Assistant; orgId: string }) {
  const q = useQuery({ queryKey: [...assistantKey(orgId, a.id), 'activity'], queryFn: () => api<AssistantActivity>(`/v1/ai/assistants/${a.id}/activity`) });
  const OUT: Record<string, string> = { REPLIED: tr('Replied'), HANDOFF: tr('Handed to team'), FALLBACK: tr('Fallback → team'), SKIPPED_HUMAN: tr('Team took over'), NO_REPLY: tr('No reply') };
  return (
    <DataTable caption={tr("Recent assistant replies")} loading={q.isLoading} rows={q.data?.recentRuns} rowKey={(r) => r.id}
      empty={<EmptyState title={tr("No activity yet")} body={tr("Replies to WhatsApp customers will appear here after you publish.")} />}
      columns={[
        { key: 'when', header: tr("When"), cell: (r) => dateTime(r.createdAt) },
        { key: 'out', header: tr("Result"), cell: (r) => <StatusBadge tone={r.outcome === 'REPLIED' ? 'green' : r.outcome === 'FALLBACK' ? 'red' : 'amber'}>{OUT[r.outcome ?? ''] ?? r.status.toLowerCase()}</StatusBadge> },
        { key: 'tools', header: tr("Capabilities used"), cell: (r) => <span className="text-xs">{r.tools.map((t) => `${t.tool.replace(/_/g, ' ').toLowerCase()}${t.status === 'SUCCEEDED' ? ' ✓' : ' ✕'}`).join(', ') || '—'}</span> },
        { key: 'lat', header: tr("Response time"), cell: (r) => (r.latencyMs !== null ? `${(r.latencyMs / 1000).toFixed(1)} s` : '—') },
        { key: 'conv', header: '', cell: (r) => <Link className="text-xs text-emerald-800 underline" href={`/inbox?c=${r.conversationId}`}>{tr("Open chat")}</Link> },
      ]} />
  );
}
