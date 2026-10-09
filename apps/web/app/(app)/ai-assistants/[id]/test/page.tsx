'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { assistantKey } from '@/components/ai/builder-panels';
import { AssistantStatusBadge, ChatLine, WhatsAppChat } from '@/components/ai/visuals';
import { Button, Card, ErrorState, Field, Input, LoadingSkeleton, Notice, StatusBadge, cx } from '@/components/ui';
import { api, friendlyMessage } from '@/lib/api';
import type { Assistant, TestTurnResult, TraceEntry } from '@/lib/types';
import { useWorkspace } from '@/lib/workspace';
import { t, msg, t as tx } from '@/lib/i18n';

type Line = { from: 'customer' | 'assistant' | 'tool'; text?: string; label?: string };

const TOOL_LABEL: Record<string, string> = {
  GET_BUSINESS_INFO: msg("Business info"), SEARCH_KNOWLEDGE: msg("Searched knowledge"), GET_BUSINESS_HOURS: msg("Checked hours"), GET_BUSINESS_LOCATION: msg("Looked up location"),
  GET_SERVICES: msg("Looked up services"), GET_SERVICE_DETAILS: msg("Service details"), GET_SERVICE_PRICE: msg("Looked up price"), GET_RESOURCES: msg("Looked up staff"),
  CHECK_AVAILABILITY: msg("Checked availability"), CREATE_BOOKING: msg("Booking"), GET_BOOKING: msg("Looked up bookings"), RESCHEDULE_BOOKING: msg("Reschedule"), CANCEL_BOOKING: msg("Cancellation"),
  GET_CUSTOMER_CONTEXT: msg("Customer context"), CREATE_LEAD: msg("Saved enquiry"), UPDATE_LEAD: msg("Updated enquiry"), GET_LEAD: msg("Looked up enquiry"), HUMAN_HANDOFF: msg("Transfer to team"),
  PAUSE_AUTOMATION: msg("Pause replies"), NOTIFY_TEAM: msg("Notified team"), CONFIRM_PENDING_ACTION: msg("Customer confirmation"),
  SEARCH_BAGLAMUKHI_KNOWLEDGE: msg('Searched Baglamukhi knowledge'), GET_TEMPLE_INFORMATION: msg('Temple information'), GET_HAVAN_SERVICE_DETAILS: msg('Havan types'),
  GET_DAKSHINA_POLICY: msg('Dakshina policy'), GET_FESTIVAL_CONTEXT: msg('Festival calendar'), GET_YAJMAN_LEAD: msg('Looked up yajman'), UPDATE_YAJMAN_LEAD: msg('Updated yajman enquiry'),
  CHECK_PANDIT_AVAILABILITY: msg('Checked a date'), GET_AVAILABLE_SLOTS: msg('Found free slots'), CREATE_HAVAN_BOOKING: msg('Havan booking'), GET_HAVAN_BOOKING: msg('Looked up havan bookings'),
  RESCHEDULE_HAVAN_BOOKING: msg('Moved havan booking'), CANCEL_HAVAN_BOOKING: msg('Cancelled havan booking'), CREATE_YAJMAN_REMINDER: msg('Yajman reminder'),
  CREATE_PANDIT_REMINDER: msg('Pandit Ji reminder'), REQUEST_PANDIT_HANDOFF: msg('Pandit Ji call-back / handoff'),
};
const STATUS_TEXT: Record<TraceEntry['status'], string> = { SUCCEEDED: '✓', DRY_RUN: msg("✓ simulated"), CONFIRMATION_REQUIRED: msg("asked to confirm"), FAILED: '✕', REJECTED: msg("✕ blocked") };

/** Derived, operational "intent" from the capabilities used - never model reasoning. */
function intentOf(t: TestTurnResult['trace']): string {
  const k = t.toolsUsed.map((x) => x.tool);
  if (k.some((x) => x === 'HUMAN_HANDOFF')) return tx('Handoff');
  if (k.some((x) => /BOOKING|AVAILABILITY|CONFIRM_PENDING|HAVAN/.test(x))) return tx('Booking');
  if (k.some((x) => /LEAD/.test(x))) return tx('Enquiry');
  if (k.some((x) => /PRICE|SERVICE|DAKSHINA/.test(x))) return tx('Services & prices');
  if (k.some((x) => /KNOWLEDGE/.test(x))) return tx('Question (knowledge)');
  if (k.some((x) => /HOURS|LOCATION|BUSINESS_INFO|TEMPLE|FESTIVAL/.test(x))) return tx('Business info');
  return tx('Conversation');
}

export default function TestAssistantPage() {
  const { id } = useParams<{ id: string }>();
  const { orgId } = useWorkspace();
  const q = useQuery({ queryKey: assistantKey(orgId, id), queryFn: () => api<Assistant>(`/v1/ai/assistants/${id}`) });
  const [customer, setCustomer] = useState(() => t('Test customer'));
  const [session, setSession] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [last, setLast] = useState<TestTurnResult | null>(null);
  const [text, setText] = useState('');
  const bottom = useRef<HTMLDivElement>(null);
  const start = useMutation({ mutationFn: () => api<{ id: string }>(`/v1/ai/assistants/${id}/test-sessions`, { method: 'POST', body: { customerName: customer } }),
    onSuccess: (s) => { setSession(s.id); setLines([]); setLast(null); } });
  const send = useMutation({
    mutationFn: (t: string) => api<TestTurnResult>(`/v1/ai/assistants/${id}/test-sessions/${session}/messages`, { method: 'POST', body: { text: t } }),
    onSuccess: (r) => {
      setLast(r);
      setLines((l) => [...l, ...r.trace.toolsUsed.filter((x) => x.tool !== 'REPLY_GUARD').map((x) => ({ from: 'tool' as const,
        label: `${t(TOOL_LABEL[x.tool] ?? x.tool)} ${t(STATUS_TEXT[x.status])}` })), ...(r.reply ? [{ from: 'assistant' as const, text: r.reply }] : [])]);
    },
  });
  useEffect(() => { if (!session && !start.isPending && !start.isError) start.mutate(); }, [session, start]);
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [lines, send.isPending]);
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <LoadingSkeleton />;
  const a = q.data;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t || !session || send.isPending) return;
    setLines((l) => [...l, { from: 'customer', text: t }]);
    setText('');
    send.mutate(t);
  };
  const waiting = last?.trace.waitingFor ? t('Waiting for confirmation: {what}', { what: last.trace.waitingFor }) : last?.outcome === 'HANDOFF' ? t('Handed to your team')
    : last?.outcome === 'FALLBACK' ? t('Safe fallback (would go to your team)') : last?.reply?.trim().endsWith('?') ? t('Waiting for customer information') : last ? t('Answered') : '—';

  return (
    <>
      <nav className="mb-3 text-sm text-slate-500"><Link href="/ai-assistants" className="underline">{t("AI Assistants")}</Link> / <Link href={`/ai-assistants/${id}`} className="underline">{a.name}</Link> {t("/ Test")}</nav>
      <h1 className="mb-4 text-2xl font-semibold text-slate-900">{t("Test Assistant")}</h1>
      <div className="grid gap-5 xl:grid-cols-[260px_1fr_320px]">
        <aside className="space-y-4">
          <Card title={t("Configuration")}>
            <dl className="space-y-2 text-sm">
              <div><dt className="text-slate-500">{t("Assistant")}</dt><dd className="font-medium">{a.name} <AssistantStatusBadge status={a.status} /></dd></div>
              <div><dt className="text-slate-500">{t("Mode")}</dt><dd><StatusBadge tone="blue">{t("Safe Test")}</StatusBadge></dd></div>
              <div><dt className="text-slate-500">{t("WhatsApp")}</dt><dd>{t("Not sending real messages")}</dd></div>
              <div><dt className="text-slate-500">{t("Actions")}</dt><dd>{t("Simulated - nothing is booked or saved")}</dd></div>
              <div><dt className="text-slate-500">{t("Uses")}</dt><dd>{t("Your current (draft) settings")}</dd></div>
            </dl>
          </Card>
          <Card title={t("Test customer")}>
            <Field label={t("Customer name")}>{(fid) => <Input id={fid} value={customer} maxLength={60} onChange={(e) => setCustomer(e.target.value)} />}</Field>
            <Button className="mt-3" size="sm" variant="secondary" loading={start.isPending} onClick={() => start.mutate()}>{t("Start new chat")}</Button>
          </Card>
        </aside>
        <div>
          {start.isError && <Notice tone="error">{friendlyMessage(start.error)}</Notice>}
          <WhatsAppChat title={a.name} subtitle={a.whatsapp ? t("{name} · test", { name: a.whatsapp.name }) : t("test chat")} label={t("Live test")} className="h-[560px]"
            footer={
              <form onSubmit={submit} className="flex gap-2 bg-[#1f2c34] p-2">
                <label htmlFor="test-msg" className="sr-only">{t("Message as the customer")}</label>
                <input id="test-msg" value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} placeholder={t("Type a message as the customer")}
                  className="flex-1 rounded-full border-0 px-4 py-2 text-sm ring-1 ring-slate-300 focus:ring-2 focus:ring-emerald-600" disabled={!session} />
                <Button type="submit" loading={send.isPending} disabled={!session || !text.trim()}>{t("Send")}</Button>
              </form>}>
            {lines.length === 0 && <p className="py-10 text-center text-sm text-slate-500">{t("Say hi, ask a price, or try to book - like a real customer.")}</p>}
            {lines.map((m, i) => <ChatLine key={i} m={m} />)}
            {send.isPending && <p className="text-xs text-slate-500" role="status">{t("Assistant is typing…")}</p>}
            {send.isError && <Notice tone="error">{friendlyMessage(send.error)}</Notice>}
            <div ref={bottom} />
          </WhatsAppChat>
        </div>
        <aside>
          <Card title={t("Test trace")}>
            {!last ? <p className="text-sm text-slate-500">{t("Send a message to see what the assistant did.")}</p> : (
              <dl className="space-y-3 text-sm">
                <div><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t("Intent")}</dt><dd>{intentOf(last.trace)}</dd></div>
                <div><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t("Capabilities used")}</dt>
                  <dd>{last.trace.toolsUsed.length === 0 ? t("None") : (
                    <ul className="mt-1 space-y-1.5">{last.trace.toolsUsed.map((u, i) => (
                      <li key={i} className={cx('rounded-md p-2 ring-1', u.status === 'FAILED' || u.status === 'REJECTED' ? 'bg-red-50 ring-red-200' : 'bg-slate-50 ring-slate-200')}>
                        <p className="font-mono text-xs">{u.tool} <span className="font-sans">{t(STATUS_TEXT[u.status])}</span></p>
                        <p className="text-xs text-slate-600">{describe(u)}</p>
                      </li>))}</ul>)}</dd></div>
                <div><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t("Knowledge")}</dt><dd>{last.trace.knowledgeUsed ? t("Business knowledge used") : t("No document required")}</dd></div>
                <div><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t("Status")}</dt><dd>{waiting}</dd></div>
                <div><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t("Response time")}</dt><dd>{(last.latencyMs / 1000).toFixed(1)} {t("s ·")}{' '}{last.trace.tokens.input + last.trace.tokens.output} {t("tokens")}</dd></div>
                <p className="text-xs text-slate-500">{t("Operational trace only - the assistant’s internal reasoning is never stored or shown.")}</p>
              </dl>
            )}
          </Card>
        </aside>
      </div>
    </>
  );
}

function describe(t: TraceEntry): string {
  const s = t.summary as Record<string, any>;
  if (t.errorCode) return `Result: ${t.errorCode.replace(/_/g, ' ').toLowerCase()}`;
  if (t.status === 'CONFIRMATION_REQUIRED') return String(s.confirmationText ?? tx('Waiting for the customer to confirm'));
  if (s.slots) return tx('{n} slots found', { n: s.slots.count });
  if (s.services) return tx('{n} services', { n: s.services.count });
  if (s.prices) return tx('{n} price(s)', { n: s.prices.count });
  if (s.resources) return tx('{n} staff/resources', { n: s.resources.count });
  if (s.results) return tx('{n} knowledge passages', { n: s.results.count });
  if (s.status) return String(s.status).replace(/_/g, ' ').toLowerCase();
  return tx('Done');
}
