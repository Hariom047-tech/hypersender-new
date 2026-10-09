'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { WeeklyEditor, type Weekly } from '@/components/setup/common';
import { Button, Card, ErrorState, Field, Input, LoadingSkeleton, Notice, StatusBadge, Textarea } from '@/components/ui';
import { api, friendlyMessage } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';
import { t, msg } from '@/lib/i18n';

interface Settings {
  configured?: boolean; panditDisplayName?: string | null; panditWhatsapp?: string | null; templeName?: string | null; templeAddress?: string | null;
  templeMapUrl?: string | null; darshanTimings?: string | null; howToReach?: string | null; templeRules?: string | null; templeNotes?: string | null;
  onlineHavanOffered: boolean; reminderLeadMinutes: number;
}
interface Calendar { configured: boolean; connected: boolean; email: string | null; status: string | null; lastError: string | null; lastSyncedAt: string | null }
interface Dates { specialDates: Array<{ id: string; name: string; startsOn: string; endsOn: string; notes: string | null }>;
  festivals: Array<{ name: string; kind: string; startsOn: string; endsOn: string; notes: string | null }> }

const CALLBACK_MSG: Record<string, { tone: 'success' | 'error' | 'warn'; text: string }> = {
  connected: { tone: 'success', text: msg("Google Calendar connected ✅ Busy times no longer show havan slots, and every booking is added to your calendar.") },
  denied: { tone: 'warn', text: msg("You did not give permission on Google. Press \"Connect Google Calendar\" again whenever you like.") },
  expired: { tone: 'error', text: msg("The connect link had expired. Please press \"Connect Google Calendar\" again.") },
  reconsent: { tone: 'error', text: msg("Google did not give offline access. Remove the app at myaccount.google.com → Security → Third-party access and connect again.") },
  failed: { tone: 'error', text: msg("Google Calendar could not be connected. Please try again in a while.") },
};

/** Pandit Ji's contact, temple information, reminders, Google Calendar and special dates. */
export function HavanSettingsPanel({ bid, orgId }: { bid: string; orgId: string | null }) {
  const { role, businesses } = useWorkspace();
  const editable = ['OWNER', 'ADMIN', 'MANAGER'].includes(role ?? '');
  const timezone = businesses.find((b) => b.id === bid)?.timezone ?? 'Asia/Kolkata';
  const base = ['org', orgId, 'setup', bid];
  const qc = useQueryClient();
  const q = useQuery({ queryKey: [...base, 'havan-settings'], queryFn: () => api<Settings>(`/v1/businesses/${bid}/havan/settings`) });
  return (
    <>
      <p className="mb-4 text-sm text-slate-600">{t("Pandit Ji's number, temple information, reminders and Google Calendar. The assistant gives yajmans this information.")}</p>
      <div className="space-y-6">
        <HavanHours bid={bid} editable={editable} base={base} timezone={timezone} />
        <CalendarCard bid={bid} editable={editable} queryKey={[...base, 'google-calendar']} />
        {q.isLoading ? <LoadingSkeleton rows={8} /> : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : q.data &&
          <SettingsForm key={`${bid}-${q.dataUpdatedAt}`} s={q.data} bid={bid} editable={editable} onSaved={() => void qc.invalidateQueries({ queryKey: base })} />}
        <SpecialDates bid={bid} editable={editable} queryKey={[...base, 'havan-dates']} />
      </div>
    </>
  );
}

function CalendarCard({ bid, editable, queryKey }: { bid: string; editable: boolean; queryKey: unknown[] }) {
  const qc = useQueryClient();
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => {
    const url = new URL(window.location.href);
    const v = url.searchParams.get('calendar');
    // Drop only the one-time flag; the assistant page keeps its tab in the query string.
    if (v) { setFlash(v); url.searchParams.delete('calendar'); window.history.replaceState(null, '', url.pathname + url.search); }
  }, []);
  const c = useQuery({ queryKey, queryFn: () => api<Calendar>(`/v1/businesses/${bid}/havan/google-calendar`) });
  const connect = useMutation({ mutationFn: () => api<{ authUrl: string }>(`/v1/businesses/${bid}/havan/google-calendar/connect`, { method: 'POST' }),
    onSuccess: (r) => window.location.assign(r.authUrl) });
  const disconnect = useMutation({ mutationFn: () => api(`/v1/businesses/${bid}/havan/google-calendar`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey }) });
  const msg = flash ? CALLBACK_MSG[flash] ?? CALLBACK_MSG.failed : null;
  const d = c.data;
  return (
    <Card title={<span className="flex items-center gap-2">{t("Google Calendar")}{' '}{d && (d.connected
      ? <StatusBadge tone={d.status === 'ERROR' ? 'red' : 'green'}>{d.status === 'ERROR' ? t("Problem") : t("Connected")}</StatusBadge>
      : <StatusBadge tone="slate">{t("Not connected")}</StatusBadge>)}</span>}>
      <div className="space-y-4 text-sm">
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        {c.isLoading ? <LoadingSkeleton rows={2} /> : c.isError ? <ErrorState error={c.error} onRetry={() => c.refetch()} /> : d && (
          d.connected ? (
            <>
              <p>{t("Connected account:")}{' '}<strong>{d.email ?? t("Google account")}</strong>{d.lastSyncedAt && <span className="text-slate-500"> {t("· last sync")}{' '}{new Date(d.lastSyncedAt).toLocaleString('en-IN')}</span>}</p>
              {d.status === 'ERROR' && <Notice tone="error">{d.lastError ?? t("Google Calendar is not syncing.")} {t("Please remove the calendar and connect it again.")}</Notice>}
              <ul className="list-disc space-y-1 pl-5 text-slate-600">
                <li>{t("Whenever your calendar is busy, the assistant does not offer a havan slot.")}</li>
                <li>{t("Every new havan booking becomes an event in your calendar (with yajman, mode, gotra and sankalp). Rescheduling moves the event; cancelling removes it.")}</li>
                <li>{t("We never read the names or details of your other events - only \"busy / free\".")}</li>
              </ul>
              {editable && <Button variant="secondary" loading={disconnect.isPending} onClick={() => disconnect.mutate()}>{t("Remove calendar")}</Button>}
            </>
          ) : (
            <>
              <p className="text-slate-700">{t("Connect your Google Calendar so that no yajman can book a havan while you are busy (travel, another puja, a family event), and every booking appears in your phone's calendar automatically.")}</p>
              <ol className="list-decimal space-y-1 pl-5 text-slate-600">
                <li>{t("Press")}{' '}<strong>{t("\"Connect Google Calendar\"")}</strong> {t("below.")}</li>
                <li>{t("A Google page opens - sign in with the Google account whose calendar Pandit Ji uses (the one shown in the Google Calendar app on the phone).")}</li>
                <li>{t("On the \"See your free/busy\" and \"View and edit events\" permissions, press")}{' '}<strong>{t("Allow / Continue")}</strong> {t("below.")}</li>
                <li>{t("You come back to this page and it shows \"Connected\". That's it!")}</li>
              </ol>
              <p className="text-xs text-slate-500">{t("Keep adding your other events to the calendar as before - the assistant skips those times automatically. You can remove the connection any time here or at myaccount.google.com → Security → Third-party access.")}</p>
              {!d.configured && <Notice tone="warn">{t("Google Calendar is not set up on this server yet. The administrator needs to set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (see docs/google-calendar.md).")}</Notice>}
              {connect.isError && <Notice tone="error">{friendlyMessage(connect.error)}</Notice>}
              {editable && <Button loading={connect.isPending} disabled={!d.configured} onClick={() => connect.mutate()}>{t("Connect Google Calendar")}</Button>}
            </>
          )
        )}
      </div>
    </Card>
  );
}

function SettingsForm({ s, bid, editable, onSaved }: { s: Settings; bid: string; editable: boolean; onSaved: () => void }) {
  const [saved, setSaved] = useState(false);
  const save = useMutation({ mutationFn: (body: object) => api(`/v1/businesses/${bid}/havan/settings`, { method: 'PUT', body }), onSuccess: () => { setSaved(true); onSaved(); } });
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSaved(false);
    const f = new FormData(e.currentTarget);
    const val = (k: string) => String(f.get(k) ?? '').trim() || null;
    save.mutate({ panditDisplayName: val('panditName'), panditWhatsapp: val('panditWhatsapp'), templeName: val('templeName'), templeAddress: val('templeAddress'),
      templeMapUrl: val('templeMapUrl'), darshanTimings: val('darshan'), howToReach: val('reach'), templeRules: val('rules'), templeNotes: val('notes'),
      onlineHavanOffered: f.get('online') === 'on', reminderLeadMinutes: Number(f.get('lead') || 1440) });
  };
  return (
    <form onSubmit={submit} className="space-y-6">
      {s.configured === false && <Notice tone="warn">{t("This information has not been filled in yet. The assistant starts using it as soon as you save.")}</Notice>}
      <fieldset disabled={!editable} className="space-y-6">
        <Card title={t("Pandit Ji")}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("Name (shown to yajmans)")}>{(id) => <Input id={id} name="panditName" maxLength={100} defaultValue={s.panditDisplayName ?? ''} placeholder={t("Pandit Ramesh Sharma Ji")} />}</Field>
            <Field label={t("Pandit Ji's personal WhatsApp number")} hint={t("Separate from the business number. Every new booking, reschedule / cancellation, call-back request and the day-before reminder arrive on this number on WhatsApp.")}>{(id, h) => (
              <Input id={id} aria-describedby={h} name="panditWhatsapp" inputMode="tel" defaultValue={s.panditWhatsapp ?? ''} placeholder="98260 12345" />)}</Field>
          </div>
        </Card>
        <Card title={t("Temple information")}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("Temple name")}>{(id) => <Input id={id} name="templeName" maxLength={150} defaultValue={s.templeName ?? ''} placeholder={t("Maa Baglamukhi Mandir, Nalkheda")} />}</Field>
            <Field label={t("Google Maps link (optional)")}>{(id) => <Input id={id} name="templeMapUrl" type="url" defaultValue={s.templeMapUrl ?? ''} placeholder={t("https://maps.google.com/...")} />}</Field>
          </div>
          <div className="mt-4 grid gap-4">
            <Field label={t("Address")}>{(id) => <Textarea id={id} name="templeAddress" rows={2} maxLength={500} defaultValue={s.templeAddress ?? ''} placeholder={t("Nalkheda, Agar Malwa, Madhya Pradesh")} />}</Field>
            <Field label={t("Darshan and aarti timings")}>{(id) => <Textarea id={id} name="darshan" rows={2} maxLength={1000} defaultValue={s.darshanTimings ?? ''} placeholder={t("5 AM to 10 PM; aarti morning, noon and evening")} />}</Field>
            <Field label={t("How to reach")}>{(id) => <Textarea id={id} name="reach" rows={3} maxLength={2000} defaultValue={s.howToReach ?? ''} placeholder={t("~100 km from Ujjain, ~156 km from Indore; nearest station Ujjain; airport Indore")} />}</Field>
            <Field label={t("Temple rules (optional)")}>{(id) => <Textarea id={id} name="rules" rows={2} maxLength={2000} defaultValue={s.templeRules ?? ''} />}</Field>
            <Field label={t("Other information (optional)")}>{(id) => <Textarea id={id} name="notes" rows={2} maxLength={2000} defaultValue={s.templeNotes ?? ''} />}</Field>
          </div>
        </Card>
        <Card title={t("Online havan and reminders")}>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="online" defaultChecked={s.onlineHavanOffered} /> {t("Online havan (sankalp from afar) is offered")}</label>
          <div className="mt-4 max-w-xs">
            <Field label={t("Reminder how early (minutes)")} hint={t("1440 = one day before. Sent to both Pandit Ji and the yajman.")}>{(id, h) => (
              <Input id={id} aria-describedby={h} name="lead" type="number" min={30} max={4320} defaultValue={s.reminderLeadMinutes} />)}</Field>
          </div>
        </Card>
        {save.isError && <Notice tone="error">{friendlyMessage(save.error)}</Notice>}
        {saved && <Notice tone="success">{t("Saved.")}</Notice>}
        {editable && <Button type="submit" loading={save.isPending}>{t("Save settings")}</Button>}
      </fieldset>
    </form>
  );
}

function SpecialDates({ bid, editable, queryKey }: { bid: string; editable: boolean; queryKey: unknown[] }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey, queryFn: () => api<Dates>(`/v1/businesses/${bid}/havan/special-dates`) });
  const add = useMutation({ mutationFn: (body: object) => api(`/v1/businesses/${bid}/havan/special-dates`, { method: 'POST', body }), onSuccess: () => void qc.invalidateQueries({ queryKey }) });
  const del = useMutation({ mutationFn: (id: string) => api(`/v1/businesses/${bid}/havan/special-dates/${id}`, { method: 'DELETE' }), onSuccess: () => void qc.invalidateQueries({ queryKey }) });
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    add.mutate({ name: f.get('name'), startsOn: f.get('from'), endsOn: f.get('to') || f.get('from'), notes: String(f.get('notes') ?? '') || null });
    e.currentTarget.reset();
  };
  return (
    <Card title={t("Festivals and special dates")}>
      {q.isLoading ? <LoadingSkeleton rows={3} /> : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : q.data && (
        <div className="space-y-4 text-sm">
          <div>
            <p className="font-medium text-slate-800">{t("Upcoming festivals (the assistant knows these automatically)")}</p>
            <ul className="mt-1 space-y-0.5 text-slate-600">
              {q.data.festivals.map((x) => <li key={x.name + x.startsOn}>{x.name}: {x.startsOn}{x.endsOn !== x.startsOn ? ` – ${x.endsOn}` : ''}</li>)}
            </ul>
          </div>
          <div>
            <p className="font-medium text-slate-800">{t("Pandit Ji's own dates (temple closed, special anushthan...)")}</p>
            {q.data.specialDates.length === 0 ? <p className="text-slate-500">{t("None yet.")}</p> : (
              <ul className="mt-1 divide-y divide-slate-100">
                {q.data.specialDates.map((x) => (
                  <li key={x.id} className="flex items-center justify-between py-1.5">
                    <span>{x.name}: {x.startsOn}{x.endsOn !== x.startsOn ? ` – ${x.endsOn}` : ''}{x.notes && <span className="text-slate-500"> · {x.notes}</span>}</span>
                    {editable && <Button size="sm" variant="ghost" onClick={() => del.mutate(x.id)}>{t("Remove")}</Button>}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {editable && (
            <form onSubmit={submit} className="grid items-end gap-3 sm:grid-cols-5">
              <div className="sm:col-span-2"><Field label={t("Name")}>{(id) => <Input id={id} name="name" required maxLength={120} placeholder={t("Vishesh Navratri anushthan")} />}</Field></div>
              <Field label={t("From")}>{(id) => <Input id={id} name="from" type="date" required />}</Field>
              <Field label={t("To")}>{(id) => <Input id={id} name="to" type="date" />}</Field>
              <Button type="submit" loading={add.isPending}>{t("Add")}</Button>
              <div className="sm:col-span-5"><Field label={t("Note (optional)")}>{(id) => <Input id={id} name="notes" maxLength={500} />}</Field></div>
            </form>
          )}
          {(add.isError || del.isError) && <Notice tone="error">{friendlyMessage(add.error ?? del.error)}</Notice>}
        </div>
      )}
    </Card>
  );
}

interface Availability { weekly: Weekly; configured: boolean }
interface TimeOff { id: string; resourceId: string | null; startAt: string; endAt: string; type: string; reason: string | null }

/** When havan can be booked (business-wide hours) and the days Pandit Ji is not available. */
function HavanHours({ bid, editable, base, timezone }: { bid: string; editable: boolean; base: unknown[]; timezone: string }) {
  const qc = useQueryClient();
  const [weekly, setWeekly] = useState<Weekly>({});
  const [saved, setSaved] = useState(false);
  const av = useQuery({ queryKey: [...base, 'availability', ''], queryFn: () => api<Availability>(`/v1/businesses/${bid}/availability`) });
  const ex = useQuery({ queryKey: [...base, 'exceptions'], queryFn: () => api<TimeOff[]>(`/v1/businesses/${bid}/availability-exceptions`) });
  useEffect(() => { if (av.data) setWeekly(av.data.weekly); }, [av.data]);
  const save = useMutation({ mutationFn: () => api(`/v1/businesses/${bid}/availability`, { method: 'PUT', body: { resourceId: null, weekly } }),
    onSuccess: () => { setSaved(true); void qc.invalidateQueries({ queryKey: base }); } });
  const add = useMutation({ mutationFn: (body: object) => api(`/v1/businesses/${bid}/availability-exceptions`, { method: 'POST', body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [...base, 'exceptions'] }) });
  const del = useMutation({ mutationFn: (id: string) => api(`/v1/businesses/${bid}/availability-exceptions/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [...base, 'exceptions'] }) });
  const offset = timezone === 'Asia/Kolkata' ? '+05:30' : 'Z';
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const from = String(f.get('from'));
    const to = String(f.get('to') || from);
    add.mutate({ type: 'HOLIDAY', resourceId: null, reason: String(f.get('reason') || '') || null,
      startAt: new Date(`${from}T00:00:00${offset}`).toISOString(), endAt: new Date(`${to}T23:59:00${offset}`).toISOString() });
    e.currentTarget.reset();
  };
  const day = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  return (
    <Card title={t("When a havan can be booked")}>
      <div className="space-y-5 text-sm">
        <p className="text-slate-600">{t("The days and hours when a havan can be booked. The assistant only offers free slots inside these hours (and skips busy times in Google Calendar when it is connected).")}</p>
        {av.isLoading ? <LoadingSkeleton rows={4} /> : av.isError ? <ErrorState error={av.error} onRetry={() => av.refetch()} /> : (
          <>
            {av.data && !av.data.configured && <Notice tone="warn">{t("No hours set yet - without them the assistant cannot offer any slot.")}</Notice>}
            <WeeklyEditor value={weekly} onChange={(w) => { setWeekly(w); setSaved(false); }} disabled={!editable} />
            {save.isError && <Notice tone="error">{friendlyMessage(save.error)}</Notice>}
            {saved && <Notice tone="success">{t("Saved. The assistant uses these hours right away.")}</Notice>}
            {editable && <Button loading={save.isPending} onClick={() => save.mutate()}>{t("Save hours")}</Button>}
          </>
        )}
        <div className="border-t border-slate-100 pt-4">
          <p className="font-medium text-slate-800">{t("Pandit Ji not available (leave / travel)")}</p>
          <p className="text-xs text-slate-500">{t("No havan can be booked on these days.")}</p>
          {ex.data && ex.data.filter((x) => !x.resourceId).length > 0 && (
            <ul className="mt-2 divide-y divide-slate-100">
              {ex.data.filter((x) => !x.resourceId).map((x) => (
                <li key={x.id} className="flex items-center justify-between py-1.5">
                  <span>{day(x.startAt)}{day(x.endAt) !== day(x.startAt) ? ` – ${day(x.endAt)}` : ''}{x.reason && <span className="text-slate-500"> · {x.reason}</span>}</span>
                  {editable && <Button size="sm" variant="ghost" onClick={() => del.mutate(x.id)}>{t("Remove")}</Button>}
                </li>
              ))}
            </ul>
          )}
          {editable && (
            <form onSubmit={submit} className="mt-3 grid items-end gap-3 sm:grid-cols-4">
              <Field label={t("From")}>{(id) => <Input id={id} name="from" type="date" required />}</Field>
              <Field label={t("To (optional)")}>{(id) => <Input id={id} name="to" type="date" />}</Field>
              <Field label={t("Reason (optional)")}>{(id) => <Input id={id} name="reason" maxLength={300} placeholder={t("Travel")} />}</Field>
              <Button type="submit" loading={add.isPending}>{t("Add")}</Button>
            </form>
          )}
          {(add.isError || del.isError) && <div className="mt-2"><Notice tone="error">{friendlyMessage(add.error ?? del.error)}</Notice></div>}
        </div>
      </div>
    </Card>
  );
}
