'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { ActivityPanel, assistantKey, CapabilitiesPanel, InstructionsPanel, KnowledgePanel, OverviewPanel, WhatsAppPanel } from '@/components/ai/builder-panels';
import { AssistantStatusBadge, TemplateIcon } from '@/components/ai/visuals';
import { HAVAN_SECTIONS, HavanPanel, isHavanAssistant, type HavanSection } from '@/components/havan/havan-panel';
import { WizardStepper, type WizardStep } from '@/components/ai/wizard-steps';
import { Button, Card, ConfirmDialog, ErrorState, LoadingSkeleton, Notice, Tabs } from '@/components/ui';
import { api, friendlyMessage } from '@/lib/api';
import { can } from '@/lib/permissions';
import type { Assistant, Readiness } from '@/lib/types';
import { useWorkspace } from '@/lib/workspace';
import { t } from '@/lib/i18n';

type Tab = 'overview' | 'havan' | 'instructions' | 'capabilities' | 'knowledge' | 'whatsapp' | 'test' | 'activity';

/** Screen 3 (builder), Screen 4 (knowledge & setup), Screen 6 (live assistant overview). */
export default function AssistantBuilderPage() {
  const { id } = useParams<{ id: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const { orgId, role } = useWorkspace();
  const qc = useQueryClient();
  const setup = search.get('setup') === '1';
  // The open tab lives in the URL so readiness "fix" links (?tab=...) and the Google Calendar return land on the right section.
  const tab = (search.get('tab') as Tab | null) ?? (setup ? 'knowledge' : 'overview');
  const havanSection = HAVAN_SECTIONS.find((s) => s === search.get('section')) ?? 'callbacks';
  const go = (next: Tab, section?: HavanSection) => {
    const p = new URLSearchParams(search.toString());
    p.set('tab', next);
    if (section) p.set('section', section); else p.delete('section');
    router.replace(`?${p.toString()}`, { scroll: false });
  };
  const [publishResult, setPublishResult] = useState<{ published: boolean; readiness: Readiness; version?: number } | null>(null);
  const [confirm, setConfirm] = useState<'pause' | 'archive' | null>(null);
  const editable = can(role, 'assistants:manage');
  const q = useQuery({ queryKey: assistantKey(orgId, id), queryFn: () => api<Assistant>(`/v1/ai/assistants/${id}`) });
  const readiness = useQuery({ queryKey: [...assistantKey(orgId, id), 'readiness'], queryFn: () => api<Readiness>(`/v1/ai/assistants/${id}/readiness`) });
  const refresh = () => { void qc.invalidateQueries({ queryKey: assistantKey(orgId, id) }); void qc.invalidateQueries({ queryKey: ['org', orgId, 'biz'] }); };
  const publish = useMutation({ mutationFn: () => api<{ published: boolean; readiness: Readiness; version?: number }>(`/v1/ai/assistants/${id}/publish`, { method: 'POST' }),
    onSuccess: (r) => { setPublishResult(r); refresh(); } });
  const status = useMutation({ mutationFn: (action: 'pause' | 'resume' | 'archive') => api<Assistant>(`/v1/ai/assistants/${id}/${action}`, { method: 'POST' }),
    onSuccess: (a, action) => { setConfirm(null); qc.setQueryData(assistantKey(orgId, id), a); if (action === 'archive') router.push('/ai-assistants'); } });

  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <LoadingSkeleton />;
  const a = q.data;
  const r = readiness.data;
  const stepDone: WizardStep[] = ['Preview', 'Business', 'Configure', 'Capabilities'];
  if (r && r.counts.knowledgeReady > 0) stepDone.push('Knowledge');
  if (a.whatsapp) stepDone.push('WhatsApp');
  if (a.publishedVersion) stepDone.push('Test', 'Publish');
  const havan = isHavanAssistant(a);
  const current: WizardStep = tab === 'whatsapp' ? 'WhatsApp' : tab === 'test' ? 'Test' : a.publishedVersion ? 'Publish' : 'Knowledge';

  return (
    <>
      <nav className="mb-3 text-sm text-slate-500"><Link href="/ai-assistants" className="underline">{t("AI Assistants")}</Link> / {a.name}</nav>
      {(setup || !a.publishedVersion) && <WizardStepper current={current} done={stepDone} />}
      <header className="mb-5 flex flex-wrap items-start gap-4">
        <TemplateIcon iconKey={a.template?.iconKey} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2"><h1 className="text-2xl font-semibold text-slate-900">{a.name}</h1><AssistantStatusBadge status={a.status} /></div>
          <p className="text-sm text-slate-600">{a.template?.name ?? t("Custom assistant")} · {a.businessName}{a.unpublishedChanges && a.publishedVersion ? t(" · Unpublished changes") : ''}</p>
        </div>
        {editable && a.status !== 'ARCHIVED' && (
          <div className="flex flex-wrap gap-2">
            <Link href={`/ai-assistants/${id}/test`} className="rounded-md px-3.5 py-2 text-sm font-medium text-slate-800 ring-1 ring-inset ring-slate-300 hover:bg-slate-50">{t("Test Assistant")}</Link>
            {a.status === 'ACTIVE' && <Button variant="secondary" onClick={() => setConfirm('pause')}>{t("Pause Assistant")}</Button>}
            {a.status === 'PAUSED' && <Button variant="secondary" loading={status.isPending} onClick={() => status.mutate('resume')}>{t("Resume")}</Button>}
            {(a.unpublishedChanges || !a.publishedVersion) && <Button loading={publish.isPending} onClick={() => publish.mutate()}>{a.publishedVersion ? t("Publish changes") : t("Publish")}</Button>}
            <Button variant="ghost" onClick={() => setConfirm('archive')}>{t("Archive")}</Button>
          </div>
        )}
      </header>
      {(publish.isError || status.isError) && <div className="mb-4"><Notice tone="error">{friendlyMessage(publish.error ?? status.error)}</Notice></div>}
      {publishResult && (publishResult.published
        ? <div className="mb-4"><Notice tone="success">{t("Published version")}{' '}{publishResult.version}. {a.whatsapp ? t("The assistant now answers {name}.", { name: a.whatsapp.name }) : ''}</Notice></div>
        : <div className="mb-4"><Notice tone="warn">{t("Not published yet - fix these first:")}{' '}{[...publishResult.readiness.checks.filter((c) => !c.ok && c.severity === 'REQUIRED').map((c) => c.label),
            ...publishResult.readiness.capabilityErrors, ...publishResult.readiness.instructionIssues.filter((i) => i.severity === 'ERROR').map((i) => i.message)].join(' · ')}</Notice></div>)}
      <Tabs label={t("Assistant sections")} value={tab} onChange={(next) => go(next)} tabs={[
        { id: 'overview', label: t("Overview") }, ...(havan ? [{ id: 'havan' as const, label: t("Havan") }] : []), { id: 'instructions', label: t("Instructions") }, { id: 'capabilities', label: t("Capabilities") },
        { id: 'knowledge', label: t("Knowledge") }, { id: 'whatsapp', label: t("WhatsApp") }, { id: 'test', label: t("Test") }, { id: 'activity', label: t("Activity") }]} />
      <div className="mt-6">
        {tab === 'overview' && <OverviewPanel a={a} orgId={orgId} readiness={r} />}
        {tab === 'havan' && havan && <HavanPanel a={a} orgId={orgId} section={havanSection} onSection={(s) => go('havan', s)} />}
        {tab === 'instructions' && <InstructionsPanel key={a.updatedAt} a={a} orgId={orgId} editable={editable} />}
        {tab === 'capabilities' && <CapabilitiesPanel a={a} orgId={orgId} editable={editable} />}
        {tab === 'knowledge' && <KnowledgePanel a={a} orgId={orgId} editable={editable} readiness={r} />}
        {tab === 'whatsapp' && <WhatsAppPanel a={a} orgId={orgId} editable={editable} />}
        {tab === 'test' && (
          <Card title={t("Test Assistant")}>
            <p className="text-sm text-slate-600">{t("Chat with your assistant exactly like a customer would on WhatsApp. It uses your real services, prices and availability, but nothing is booked, saved or sent - actions are simulated.")}</p>
            <Link href={`/ai-assistants/${id}/test`} className="mt-3 inline-block rounded-md bg-emerald-700 px-3.5 py-2 text-sm font-medium text-white hover:bg-emerald-800">{t("Open Test Assistant")}</Link>
          </Card>
        )}
        {tab === 'activity' && <ActivityPanel a={a} orgId={orgId} />}
      </div>
      <ConfirmDialog open={confirm === 'pause'} title={t("Pause assistant?")} body={t("Customers stop receiving automatic replies on this WhatsApp number until you resume. Your team can still reply from the Inbox.")}
        confirmLabel={t("Pause")} tone="primary" busy={status.isPending} onClose={() => setConfirm(null)} onConfirm={() => status.mutate('pause')} />
      <ConfirmDialog open={confirm === 'archive'} title={t("Archive this assistant?")}
        body={t("{name} stops replying for good and is disconnected from {name2}. Past chats, bookings and orders stay. This frees the slot on your plan so you can create another assistant. An archived assistant cannot be restored.", { name: a.name, name2: a.whatsapp?.name ?? t('its WhatsApp number') })}
        confirmLabel={t("Archive")} busy={status.isPending} onClose={() => setConfirm(null)} onConfirm={() => status.mutate('archive')} />
    </>
  );
}
