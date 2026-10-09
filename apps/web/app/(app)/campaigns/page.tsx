'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { useSetupBusiness } from '@/components/setup/common';
import { Button, Card, EmptyState, ErrorState, Field, Input, LoadingSkeleton, Notice, PageHeader, Select, StatusBadge, Tabs, Textarea } from '@/components/ui';
import { api, friendlyMessage } from '@/lib/api';
import { locale, msg, t } from '@/lib/i18n';
import { can } from '@/lib/permissions';
import { guessColumns, readSpreadsheet } from '@/lib/spreadsheet';
import type { Instance } from '@/lib/types';
import { useWorkspace } from '@/lib/workspace';

type Audience = { type: 'ALL' } | { type: 'RECENT'; days: number } | { type: 'SELECTED'; contactIds: string[] };
interface ImportResult { contactIds: string[]; added: number; created: number; optedOut: number; invalidCount: number; invalid: { row: number; phone: string }[] }
interface Stats { total: number; pending: number; skipped: number; sent: number; delivered: number; read: number; failed: number; replied: number; optedOut: number }
interface Campaign {
  id: string; name: string; message: string; audience: Audience; status: string; scheduledAt: string | null; sendFrom: string; sendUntil: string;
  intervalSeconds: number; waitingReason: string | null; pauseReason: string | null; recipientCount: number; whatsappInstanceId: string;
  whatsappName: string; whatsappPhone: string | null; startedAt: string | null; completedAt: string | null; createdAt: string; stats?: Stats;
}
interface AudienceInfo { eligible: number; optedOut: number; noConsent: number; dailyLimit: number | null }
interface ConsentContact { id: string; name: string | null; phone: string | null; marketing: 'CHATTED' | 'OPTED_IN' | 'OPTED_OUT' | 'NO_CONSENT'; prefSource: string | null; prefNote: string | null }

const STATUS: Record<string, { label: string; tone: 'green' | 'amber' | 'slate' | 'red' | 'blue' }> = {
  DRAFT: { label: msg('Draft'), tone: 'slate' }, SCHEDULED: { label: msg('Scheduled'), tone: 'blue' }, SENDING: { label: msg('Sending'), tone: 'green' },
  PAUSED: { label: msg('Paused'), tone: 'amber' }, COMPLETED: { label: msg('Completed'), tone: 'slate' }, CANCELLED: { label: msg('Cancelled'), tone: 'red' },
};
const WAITING: Record<string, string> = {
  OUTSIDE_HOURS: msg('Waiting for sending hours'), DAILY_LIMIT: msg('Daily limit reached, continues tomorrow'), NUMBER_OFFLINE: msg('Waiting: WhatsApp number is offline'),
};
const SPEEDS = [
  { v: 20, label: msg('1 message every 20 seconds') }, { v: 30, label: msg('1 message every 30 seconds (recommended)') },
  { v: 60, label: msg('1 message every minute') }, { v: 120, label: msg('1 message every 2 minutes') },
];
const MARKETING: Record<ConsentContact['marketing'], { label: string; tone: 'green' | 'amber' | 'slate' | 'red' | 'blue' }> = {
  CHATTED: { label: msg('Has chatted with you'), tone: 'green' }, OPTED_IN: { label: msg('Agreed to receive offers'), tone: 'blue' },
  OPTED_OUT: { label: msg('Replied STOP'), tone: 'red' }, NO_CONSENT: { label: msg('No permission yet'), tone: 'slate' },
};
// i18n-ignore: sent to customers exactly like this (same text as the worker adds)
const FOOTER = '';
const when = (s: string | null) => (s ? new Date(s).toLocaleString(locale(), { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '');

/** What the customer will see, with a sample name (mirrors the worker's rendering). */
function preview(message: string, name = t(msg('Ramesh'))) {
  const text = message.replace(/\{name\}/g, name).trim();
  return /\bstop\b|स्टॉप/i.test(text) ? text : `${text}\n\n${FOOTER}`;
}
const wa = (text: string) => text.split(/(\*[^*]+\*|_[^_]+_)/).map((p, i) => (/^\*[^*]+\*$/.test(p) ? <b key={i}>{p.slice(1, -1)}</b>
  : /^_[^_]+_$/.test(p) ? <i key={i}>{p.slice(1, -1)}</i> : p));

export default function CampaignsPage() {
  const { bid, orgId, picker, missing } = useSetupBusiness();
  const [tab, setTab] = useState<'campaigns' | 'customers'>('campaigns');
  if (missing) return <><PageHeader title={t("Marketing campaigns")} />{missing}</>;
  return (
    <>
      <PageHeader title={t("Marketing campaigns")} actions={picker}
        description={t("Send an offer or update to customers who know your business. Sending is slow and steady to keep your WhatsApp number safe.")} />
      <Tabs label={t("View")} value={tab} onChange={setTab} tabs={[{ id: 'campaigns', label: t("📣 Campaigns") }, { id: 'customers', label: t("👥 Customers & permission") }]} />
      <div className="mt-4">{tab === 'campaigns' ? <Campaigns bid={bid!} orgId={orgId} /> : <Customers bid={bid!} orgId={orgId} />}</div>
    </>
  );
}

function SafetyNote() {
  return (
    <Notice tone="info">
      <p className="font-medium">{t("How we keep your number safe")}</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5">
        <li>{t("Only customers who messaged you, or who agreed to receive offers, get campaigns. Unknown or bought lists are not allowed.")}</li>
        <li>{t("Anyone who replies STOP is removed automatically and never gets a campaign again.")}</li>
        <li>{t("Messages go one by one, only in your sending hours, with a daily limit that grows as your number gets older.")}</li>
        <li>{t("If many people reply STOP or messages fail, the campaign pauses itself so you can check.")}</li>
      </ul>
    </Notice>
  );
}

// ------------------------------------------------------------------ campaigns tab

function Campaigns({ bid, orgId }: { bid: string; orgId: string | null }) {
  const { role } = useWorkspace();
  const manage = can(role, 'assistants:manage');
  const qc = useQueryClient();
  const key = ['org', orgId, 'campaigns', bid];
  const q = useQuery({ queryKey: key, queryFn: () => api<Campaign[]>(`/v1/businesses/${bid}/campaigns`), refetchInterval: 15_000 });
  const [editing, setEditing] = useState<Campaign | 'new' | null>(null);
  const act = useMutation({ mutationFn: ({ id, a }: { id: string; a: 'pause' | 'resume' | 'cancel' | 'start' }) => api(`/v1/businesses/${bid}/campaigns/${id}/${a}`, { method: 'POST', body: {} }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }) });
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (editing) return <CampaignForm bid={bid} orgId={orgId} initial={editing === 'new' ? null : editing} onDone={() => { setEditing(null); void qc.invalidateQueries({ queryKey: key }); }} />;
  return (
    <div className="space-y-4">
      <SafetyNote />
      {manage && <div><Button onClick={() => setEditing('new')}>{t("+ New campaign")}</Button></div>}
      {act.isError && <Notice tone="error">{friendlyMessage(act.error)}</Notice>}
      {q.isLoading ? <LoadingSkeleton rows={3} /> : !q.data?.length ? (
        <EmptyState title={t("No campaigns yet")} body={t("Create your first campaign: write the offer (or let AI write it), check who will get it, and start.")} />
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {q.data.map((c) => {
            const s = c.stats;
            const st = STATUS[c.status] ?? { label: c.status, tone: 'slate' as const };
            return (
              <li key={c.id} className="rounded-lg bg-white p-4 shadow-sm ring-1 ring-slate-200">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-base font-semibold text-slate-900">{c.name}</p>
                    <p className="text-xs text-slate-500">📱 {c.whatsappName}{c.whatsappPhone ? ` · ${c.whatsappPhone}` : ''} · 🕘 {c.sendFrom}–{c.sendUntil}</p>
                  </div>
                  <StatusBadge tone={st.tone}>{t(st.label)}</StatusBadge>
                </div>
                <p className="mt-3 line-clamp-3 whitespace-pre-line break-words rounded-md bg-slate-50 p-3 text-sm text-slate-700">{wa(c.message)}</p>
                {c.status === 'SCHEDULED' && c.scheduledAt && <p className="mt-2 text-sm text-blue-700">🗓️ {t("Starts {when}", { when: when(c.scheduledAt) })}</p>}
                {c.status === 'SENDING' && c.waitingReason && <p className="mt-2 text-sm text-amber-700">⏳ {t(WAITING[c.waitingReason] ?? c.waitingReason)}</p>}
                {c.status === 'PAUSED' && c.pauseReason && <p className="mt-2 text-sm text-amber-700">⏸️ {t(c.pauseReason)}</p>}
                {s && s.total > 0 && (
                  <>
                    <div className="mt-3 grid grid-cols-3 gap-2 text-center sm:grid-cols-6">
                      <Stat label={t("Customers")} value={s.total} />
                      <Stat label={t("Sent")} value={s.sent} />
                      <Stat label={t("Delivered")} value={s.delivered} />
                      <Stat label={t("Read")} value={s.read} />
                      <Stat label={t("Replied")} value={s.replied} />
                      <Stat label={t("STOP")} value={s.optedOut} warn={s.optedOut > 0} />
                    </div>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100" aria-hidden>
                      <div className="h-full rounded-full bg-emerald-500" style={{ width: `${Math.round(((s.sent + s.skipped) / Math.max(1, s.total)) * 100)}%` }} />
                    </div>
                  </>
                )}
                {manage && (
                  <div className="mt-3 flex flex-wrap justify-end gap-2">
                    {c.status === 'DRAFT' && <Button size="sm" variant="secondary" onClick={() => setEditing(c)}>{t("Edit")}</Button>}
                    {c.status === 'DRAFT' && <Button size="sm" loading={act.isPending} onClick={() => act.mutate({ id: c.id, a: 'start' })}>{t("▶ Start sending")}</Button>}
                    {['SENDING', 'SCHEDULED'].includes(c.status) && <Button size="sm" variant="secondary" onClick={() => act.mutate({ id: c.id, a: 'pause' })}>{t("⏸ Pause")}</Button>}
                    {c.status === 'PAUSED' && <Button size="sm" onClick={() => act.mutate({ id: c.id, a: 'resume' })}>{t("▶ Resume")}</Button>}
                    {!['COMPLETED', 'CANCELLED'].includes(c.status) && <Button size="sm" variant="ghost" onClick={() => act.mutate({ id: c.id, a: 'cancel' })}>{t("Cancel")}</Button>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className="rounded-md bg-slate-50 px-1 py-1.5">
      <p className={`text-sm font-semibold ${warn ? 'text-red-600' : 'text-slate-900'}`}>{value.toLocaleString(locale())}</p>
      <p className="text-[11px] text-slate-500">{label}</p>
    </div>
  );
}

// ------------------------------------------------------------------ create / edit

function CampaignForm({ bid, orgId, initial, onDone }: { bid: string; orgId: string | null; initial: Campaign | null; onDone: () => void }) {
  const instances = useQuery({ queryKey: ['org', orgId, 'instances'], queryFn: () => api<Instance[]>('/v1/whatsapp/instances') });
  const mine = (instances.data ?? []).filter((i) => i.businessId === bid);
  const [name, setName] = useState(initial?.name ?? '');
  const [message, setMessage] = useState(initial?.message ?? '');
  const [instanceId, setInstanceId] = useState(initial?.whatsappInstanceId ?? '');
  const [audience, setAudience] = useState<Audience>(initial?.audience ?? { type: 'ALL' });
  const [fromFile, setFromFile] = useState(initial?.audience.type === 'SELECTED');
  const [imported, setImported] = useState<ImportResult | null>(null);
  const [sendFrom, setSendFrom] = useState(initial?.sendFrom ?? '09:00');
  const [sendUntil, setSendUntil] = useState(initial?.sendUntil ?? '20:00');
  const [speed, setSpeed] = useState(initial?.intervalSeconds ?? 30);
  const [startMode, setStartMode] = useState<'now' | 'later'>('now');
  const [startAt, setStartAt] = useState('');
  useEffect(() => { if (!instanceId && mine[0]) setInstanceId(mine[0].id); }, [instanceId, mine]);

  const reach = useQuery({ queryKey: ['org', orgId, 'campaigns', bid, 'audience', audience], enabled: !fromFile || audience.type === 'SELECTED',
    queryFn: () => api<AudienceInfo>(`/v1/businesses/${bid}/campaigns/audience`, { method: 'POST', body: { audience } }) });
  const body = () => ({ name, message, whatsappInstanceId: instanceId, audience, sendFrom, sendUntil, intervalSeconds: speed });
  const save = useMutation({
    mutationFn: async (start: boolean) => {
      const c = initial ? await api<Campaign>(`/v1/businesses/${bid}/campaigns/${initial.id}`, { method: 'PUT', body: body() })
        : await api<Campaign>(`/v1/businesses/${bid}/campaigns`, { method: 'POST', body: body() });
      if (start) {
        await api(`/v1/businesses/${bid}/campaigns/${c.id}/start`, { method: 'POST',
          body: startMode === 'later' && startAt ? { scheduledAt: new Date(startAt).toISOString() } : {} });
      }
    },
    onSuccess: onDone,
  });
  const r = reach.data;
  const perDay = Math.floor(((toMin(sendUntil) - toMin(sendFrom)) * 60) / speed);

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
      <div className="space-y-4">
        <Card title={initial ? t("Edit campaign") : t("New campaign")}>
          <div className="space-y-4">
            <Field label={t("Campaign name (only you see this)")}>{(id) => <Input id={id} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder={t("e.g. Diwali offer 2026")} />}</Field>
            <Field label={t("Send from WhatsApp number")}>
              {(id) => (
                <Select id={id} value={instanceId} onChange={(e) => setInstanceId(e.target.value)}>
                  {mine.map((i) => <option key={i.id} value={i.id}>{i.name}{i.phoneNumber ? ` · ${i.phoneNumber}` : ''}{i.status !== 'CONNECTED' ? ` (${t("offline")})` : ''}</option>)}
                </Select>
              )}
            </Field>
            <AiWriter bid={bid} onPick={setMessage} />
            <Field label={t("Message")} hint={t("Write {name} where the customer's name should go. The STOP line is added automatically if it is missing.")}>
              {(id, d) => <Textarea id={id} aria-describedby={d} rows={6} value={message} maxLength={1500} onChange={(e) => setMessage(e.target.value)}
                placeholder={t("Namaste {name} ji 🙏 Is Diwali sabhi mithaiyon par *20% off*! Order ke liye reply karein.")} />}
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" type="button" onClick={() => setMessage((m) => `${m}{name}`)}>{t("+ Customer name")}</Button>
              <Button size="sm" variant="secondary" type="button" onClick={() => setMessage((m) => `${m}**`)}>{t("*Bold*")}</Button>
            </div>
          </div>
        </Card>

        <Card title={t("Who gets it")}>
          <div className="space-y-3">
            <Select aria-label={t("Who gets it")} value={fromFile ? 'FILE' : audience.type === 'RECENT' ? String(audience.days) : 'ALL'}
              onChange={(e) => {
                const v = e.target.value;
                setFromFile(v === 'FILE');
                if (v !== 'FILE') { setImported(null); setAudience(v === 'ALL' ? { type: 'ALL' } : { type: 'RECENT', days: Number(v) }); }
              }}>
              <option value="ALL">{t("Everyone who chatted with you or agreed to offers")}</option>
              <option value="30">{t("Only customers active in the last 30 days")}</option>
              <option value="90">{t("Only customers active in the last 90 days")}</option>
              <option value="180">{t("Only customers active in the last 6 months")}</option>
              <option value="FILE">{t("📄 Customers from an Excel / CSV file")}</option>
            </Select>
            {fromFile && (audience.type === 'SELECTED' && !imported ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-slate-50 p-3 text-sm text-slate-700">
                <span>{t("{n} customers from your file are selected.", { n: audience.contactIds.length.toLocaleString(locale()) })}</span>
                <Button size="sm" variant="secondary" type="button" onClick={() => setAudience({ type: 'ALL' })}>{t("Use another file")}</Button>
              </div>
            ) : audience.type === 'SELECTED' && imported ? (
              <ImportSummary res={imported} onAgain={() => { setImported(null); setAudience({ type: 'ALL' }); }} />
            ) : (
              <ImportPicker bid={bid} onImported={(res) => { setImported(res); if (res.contactIds.length) setAudience({ type: 'SELECTED', contactIds: res.contactIds }); }} />
            ))}
            {fromFile && audience.type !== 'SELECTED' ? null : reach.isLoading ? <LoadingSkeleton rows={1} /> : r && (
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-md bg-emerald-50 p-2"><p className="text-lg font-bold text-emerald-800">{r.eligible.toLocaleString(locale())}</p><p className="text-xs text-emerald-800">{t("will get it")}</p></div>
                <div className="rounded-md bg-slate-50 p-2"><p className="text-lg font-bold text-slate-700">{r.noConsent.toLocaleString(locale())}</p><p className="text-xs text-slate-500">{t("no permission")}</p></div>
                <div className="rounded-md bg-red-50 p-2"><p className="text-lg font-bold text-red-700">{r.optedOut.toLocaleString(locale())}</p><p className="text-xs text-red-700">{t("replied STOP")}</p></div>
              </div>
            )}
          </div>
        </Card>

        <Card title={t("When and how fast")}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("Send only from")}>{(id) => <Input id={id} type="time" value={sendFrom} onChange={(e) => setSendFrom(e.target.value)} />}</Field>
            <Field label={t("Until")}>{(id) => <Input id={id} type="time" value={sendUntil} onChange={(e) => setSendUntil(e.target.value)} />}</Field>
            <Field label={t("Speed")}>
              {(id) => <Select id={id} value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>{SPEEDS.map((s) => <option key={s.v} value={s.v}>{t(s.label)}</option>)}</Select>}
            </Field>
            <Field label={t("Start")}>
              {(id) => (
                <div className="space-y-2">
                  <Select id={id} value={startMode} onChange={(e) => setStartMode(e.target.value as 'now' | 'later')}>
                    <option value="now">{t("Now (within sending hours)")}</option><option value="later">{t("At a date and time")}</option>
                  </Select>
                  {startMode === 'later' && <Input type="datetime-local" aria-label={t("Start at")} value={startAt} onChange={(e) => setStartAt(e.target.value)} />}
                </div>
              )}
            </Field>
          </div>
          {perDay > 0 && (
            <p className="mt-3 text-sm text-slate-600">
              {t("At this speed about {n} messages go out per day", { n: perDay.toLocaleString(locale()) })}
              {r?.dailyLimit != null && <> · {t("your plan allows up to {n} a day per number (lower for new numbers)", { n: r.dailyLimit.toLocaleString(locale()) })}</>}
            </p>
          )}
        </Card>

        {save.isError && <Notice tone="error">{friendlyMessage(save.error)}</Notice>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" type="button" onClick={onDone}>{t("Back")}</Button>
          <Button variant="secondary" loading={save.isPending} disabled={!name.trim() || message.trim().length < 5 || !instanceId} onClick={() => save.mutate(false)}>{t("Save draft")}</Button>
          <Button loading={save.isPending} disabled={!name.trim() || message.trim().length < 5 || !instanceId || !r?.eligible || (startMode === 'later' && !startAt)}
            onClick={() => save.mutate(true)}>{startMode === 'later' ? t("Schedule campaign") : t("▶ Start sending")}</Button>
        </div>
      </div>

      <aside className="space-y-3 lg:sticky lg:top-4 lg:self-start">
        <p className="text-sm font-medium text-slate-700">{t("Preview")}</p>
        <div className="rounded-xl bg-[#0b141a] p-3">
          <p className="max-w-[90%] whitespace-pre-line break-words rounded-lg rounded-tl-none bg-[#1f2c34] px-3 py-2 text-sm text-slate-900 shadow-sm">
            {message.trim() ? wa(preview(message)) : <span className="text-slate-400">{t("Your message will appear here.")}</span>}
          </p>
        </div>
        <SafetyNote />
      </aside>
    </div>
  );
}
const toMin = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return (h || 0) * 60 + (m || 0); };

function AiWriter({ bid, onPick }: { bid: string; onPick: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [brief, setBrief] = useState('');
  const [language, setLanguage] = useState('HINGLISH');
  const draft = useMutation({ mutationFn: () => api<{ options: string[] }>(`/v1/businesses/${bid}/campaigns/ai-draft`, { method: 'POST', body: { brief, language } }) });
  if (!open) return <Button size="sm" variant="secondary" type="button" onClick={() => setOpen(true)}>{t("✨ Write with AI")}</Button>;
  return (
    <div className="space-y-3 rounded-lg bg-fuchsia-50 p-3 ring-1 ring-fuchsia-200">
      <Field label={t("Tell the AI about your offer")} hint={t("e.g. Diwali par sabhi mithaiyon par 20% off, 5 November tak, home delivery free")}>
        {(id, d) => <Textarea id={id} aria-describedby={d} rows={2} value={brief} maxLength={600} onChange={(e) => setBrief(e.target.value)} />}
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Select aria-label={t("Language")} className="w-40" value={language} onChange={(e) => setLanguage(e.target.value)}>
          <option value="HINGLISH">{t("Hinglish")}</option><option value="HINDI">{t("Hindi")}</option><option value="ENGLISH">{t("English")}</option>
        </Select>
        <Button size="sm" type="button" loading={draft.isPending} disabled={brief.trim().length < 5} onClick={() => draft.mutate()}>{t("Write 3 options")}</Button>
        <Button size="sm" variant="ghost" type="button" onClick={() => setOpen(false)}>{t("Close")}</Button>
      </div>
      {draft.isError && <Notice tone="error">{friendlyMessage(draft.error)}</Notice>}
      {draft.data && (
        <div className="grid gap-2">
          {draft.data.options.map((o, i) => (
            <button key={i} type="button" onClick={() => { onPick(o); setOpen(false); }}
              className="whitespace-pre-line rounded-md bg-white p-3 text-left text-sm text-slate-800 ring-1 ring-slate-200 hover:ring-fuchsia-400">
              {wa(o)}
              <span className="mt-2 block text-xs font-medium text-fuchsia-700">{t("Use this message")}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ import from Excel / CSV

// i18n-ignore: sample file content (column headings the importer recognises)
const SAMPLE_CSV = 'Name,Phone\nRamesh Kumar,9812345678\nSunita Sharma,+91 98765 43210\n';

/** Pick an Excel/CSV file, check the columns, say how they agreed, import. */
function ImportPicker({ bid, onImported }: { bid: string; onImported: (r: ImportResult) => void }) {
  const [file, setFile] = useState('');
  const [rows, setRows] = useState<string[][] | null>(null);
  const [readError, setReadError] = useState('');
  const [hasHeader, setHasHeader] = useState(true);
  const [nameCol, setNameCol] = useState(-1);
  const [phoneCol, setPhoneCol] = useState(0);
  const [note, setNote] = useState('');
  const body = rows ? rows.slice(hasHeader ? 1 : 0) : [];
  const width = rows ? Math.max(0, ...rows.slice(0, 50).map((r) => r.length)) : 0;
  const colName = (i: number) => (hasHeader && rows?.[0]?.[i]) || t("Column {c}", { c: String.fromCharCode(65 + (i % 26)) });
  const run = useMutation({
    mutationFn: () => api<ImportResult>(`/v1/businesses/${bid}/campaigns/import`, { method: 'POST',
      body: { note: note.trim(), rows: body.map((r) => ({ phone: r[phoneCol] ?? '', name: nameCol >= 0 ? r[nameCol] ?? '' : '' })).filter((r) => r.phone) } }),
    onSuccess: onImported,
  });

  async function pick(f: File | undefined) {
    setReadError(''); setRows(null); setFile(f?.name ?? '');
    if (!f) return;
    try {
      const data = await readSpreadsheet(f);
      if (!data.length) throw new Error(t("This file is empty."));
      const g = guessColumns(data);
      setRows(data); setHasHeader(g.hasHeader); setNameCol(g.nameCol); setPhoneCol(g.phoneCol);
    } catch (e) { setReadError(e instanceof Error ? t(e.message) : t("Could not read this file.")); }
  }
  function sample() {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([SAMPLE_CSV], { type: 'text/csv' }));
    a.download = 'customers-sample.csv'; a.click(); URL.revokeObjectURL(a.href);
  }

  return (
    <div className="space-y-3 rounded-lg bg-slate-50 p-3 ring-1 ring-slate-200">
      <p className="text-sm text-slate-700">{t("Upload an Excel (.xlsx) or CSV file with one customer per row: a name column and a mobile number column.")}</p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="cursor-pointer rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700">
          {t("📄 Choose file")}
          <input type="file" className="sr-only" accept=".xlsx,.csv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
            onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
        {file && <span className="truncate text-sm text-slate-600">{file}</span>}
        <Button size="sm" variant="ghost" type="button" onClick={sample}>{t("Download sample file")}</Button>
      </div>
      {readError && <Notice tone="error">{readError}</Notice>}
      {rows && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("Mobile number column")}>
              {(id) => <Select id={id} value={phoneCol} onChange={(e) => setPhoneCol(Number(e.target.value))}>
                {Array.from({ length: width }, (_, i) => <option key={i} value={i}>{colName(i)}</option>)}
              </Select>}
            </Field>
            <Field label={t("Name column")}>
              {(id) => <Select id={id} value={nameCol} onChange={(e) => setNameCol(Number(e.target.value))}>
                <option value={-1}>{t("No name column")}</option>
                {Array.from({ length: width }, (_, i) => <option key={i} value={i}>{colName(i)}</option>)}
              </Select>}
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} />{t("First row is a heading (not a customer)")}
          </label>
          <div className="overflow-x-auto rounded-md bg-white ring-1 ring-slate-200">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500"><tr><th className="px-3 py-1.5">{t("Name")}</th><th className="px-3 py-1.5">{t("Mobile number")}</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {body.slice(0, 5).map((r, i) => (
                  <tr key={i}><td className="px-3 py-1.5 text-slate-800">{nameCol >= 0 ? r[nameCol] : ''}</td><td className="px-3 py-1.5 text-slate-800">{r[phoneCol]}</td></tr>
                ))}
              </tbody>
            </table>
            <p className="px-3 py-1.5 text-xs text-slate-500">{t("{n} rows found in the file", { n: body.length.toLocaleString(locale()) })}</p>
          </div>
          <Field label={t("How did these customers agree to receive offers?")} hint={t("e.g. Regular shop customers who gave their number and said yes to offers")}>
            {(id, d) => <Input id={id} aria-describedby={d} value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />}
          </Field>
          {body.length > 5000 && <Notice tone="error">{t("A file can have at most 5,000 customers. Please split it into smaller files.")}</Notice>}
          {run.isError && <Notice tone="error">{friendlyMessage(run.error)}</Notice>}
          <div className="flex justify-end">
            <Button type="button" loading={run.isPending} disabled={!body.length || body.length > 5000 || note.trim().length < 3} onClick={() => run.mutate()}>
              {t("Import {n} customers", { n: body.length.toLocaleString(locale()) })}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function ImportSummary({ res, onAgain, campaign = true }: { res: ImportResult; onAgain?: () => void; campaign?: boolean }) {
  return (
    <div className="space-y-2 rounded-md bg-emerald-50 p-3 text-sm text-emerald-900 ring-1 ring-emerald-200">
      <p className="font-medium">✅ {campaign ? t("{n} customers imported and selected for this campaign.", { n: res.added.toLocaleString(locale()) }) : t("{n} customers imported. They can now get campaigns.", { n: res.added.toLocaleString(locale()) })}</p>
      {res.optedOut > 0 && <p className="text-amber-800">{t("{n} left out because they replied STOP or were removed from offers.", { n: res.optedOut.toLocaleString(locale()) })}</p>}
      {res.invalidCount > 0 && (
        <p className="text-red-700">
          {t("{n} rows skipped because the mobile number is not valid:", { n: res.invalidCount.toLocaleString(locale()) })}{' '}
          {res.invalid.slice(0, 10).map((x) => `${t("row {row}", { row: x.row })} (${x.phone || '—'})`).join(', ')}{res.invalidCount > 10 ? '…' : ''}
        </p>
      )}
      {onAgain && <Button size="sm" variant="secondary" type="button" onClick={onAgain}>{t("Use another file")}</Button>}
    </div>
  );
}

// ------------------------------------------------------------------ customers & consent tab

function Customers({ bid, orgId }: { bid: string; orgId: string | null }) {
  const { role } = useWorkspace();
  const manage = can(role, 'assistants:manage');
  const qc = useQueryClient();
  const [status, setStatus] = useState('ALL');
  const [search, setSearch] = useState('');
  const [consentFor, setConsentFor] = useState<ConsentContact | null>(null);
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<ImportResult | null>(null);
  const key =['org', orgId, 'campaigns', bid, 'contacts', status, search];
  const q = useQuery({ queryKey: key, queryFn: () => api<ConsentContact[]>(`/v1/businesses/${bid}/campaigns/contacts?status=${status}&q=${encodeURIComponent(search)}`) });
  const pref = useMutation({
    mutationFn: ({ id, s, note }: { id: string; s: 'OPTED_IN' | 'OPTED_OUT'; note?: string }) =>
      api(`/v1/businesses/${bid}/campaigns/contacts/${id}/preference`, { method: 'PUT', body: { status: s, note } }),
    onSuccess: () => { setConsentFor(null); void qc.invalidateQueries({ queryKey: ['org', orgId, 'campaigns', bid] }); },
  });
  return (
    <div className="space-y-4">
      <Notice tone="info">{t("Customers who messaged you can get campaigns. For others, record how they agreed (for example at your shop or on your website). A customer's own STOP can only be undone by them sending START.")}</Notice>
      <div className="flex flex-wrap gap-2">
        <Select aria-label={t("Show")} className="w-60" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="ALL">{t("All customers")}</option><option value="ELIGIBLE">{t("Can get campaigns")}</option>
          <option value="NO_CONSENT">{t("No permission yet")}</option><option value="OPTED_OUT">{t("Replied STOP")}</option>
        </Select>
        <Input aria-label={t("Search")} className="w-60" placeholder={t("Search name or number")} value={search} onChange={(e) => setSearch(e.target.value)} />
        {manage && <Button variant="secondary" onClick={() => { setImporting((v) => !v); setImported(null); }}>{t("📄 Import from Excel")}</Button>}
      </div>
      {importing && (imported ? (
        <div className="space-y-2">
          <p className="text-sm text-slate-600">{t("Choose \"Customers from an Excel / CSV file\" in a new campaign to send only to a file's customers.")}</p>
          <ImportSummary res={imported} campaign={false} onAgain={() => setImported(null)} />
        </div>
      ) : (
        <ImportPicker bid={bid} onImported={(res) => { setImported(res); void qc.invalidateQueries({ queryKey: ['org', orgId, 'campaigns', bid] }); }} />
      ))}
      {pref.isError && <Notice tone="error">{friendlyMessage(pref.error)}</Notice>}
      {consentFor && <ConsentForm c={consentFor} busy={pref.isPending} onCancel={() => setConsentFor(null)} onSave={(note) => pref.mutate({ id: consentFor.id, s: 'OPTED_IN', note })} />}
      {q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : q.isLoading ? <LoadingSkeleton rows={5} /> : !q.data?.length ? (
        <EmptyState title={t("No customers here")} body={t("Customers appear here after they message your WhatsApp number.")} />
      ) : (
        <ul className="divide-y divide-slate-100 rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
          {q.data.map((c) => {
            const m = MARKETING[c.marketing];
            return (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate font-medium text-slate-900">{c.name ?? t("WhatsApp customer")}</p>
                  <p className="text-xs text-slate-500">{c.phone ?? ''}{c.prefNote ? ` · ${t(c.prefNote)}` : ''}</p>
                </div>
                <span className="flex flex-wrap items-center gap-2">
                  <StatusBadge tone={m.tone}>{t(m.label)}</StatusBadge>
                  {manage && c.marketing === 'NO_CONSENT' && <Button size="sm" variant="secondary" onClick={() => setConsentFor(c)}>{t("Record permission")}</Button>}
                  {manage && (c.marketing === 'CHATTED' || c.marketing === 'OPTED_IN') && (
                    <Button size="sm" variant="ghost" loading={pref.isPending} onClick={() => pref.mutate({ id: c.id, s: 'OPTED_OUT', note: msg('Removed by business') })}>{t("Remove from offers")}</Button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function ConsentForm({ c, busy, onCancel, onSave }: { c: ConsentContact; busy: boolean; onCancel: () => void; onSave: (note: string) => void }): ReactNode {
  const [note, setNote] = useState('');
  return (
    <Card title={t("Record permission for {name}", { name: c.name ?? c.phone ?? '' })}>
      <div className="space-y-3">
        <Field label={t("How did this customer agree to receive offers?")} hint={t("e.g. Gave number at shop counter and said yes to offers")}>
          {(id, d) => <Input id={id} aria-describedby={d} value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />}
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" type="button" onClick={onCancel}>{t("Cancel")}</Button>
          <Button loading={busy} disabled={note.trim().length < 3} onClick={() => onSave(note.trim())}>{t("Save permission")}</Button>
        </div>
      </div>
    </Card>
  );
}
