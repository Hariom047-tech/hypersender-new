'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { useSetupBusiness, WeeklyEditor, type Weekly } from '@/components/setup/common';
import { Button, Card, DataTable, EmptyState, Field, Input, Notice, PageHeader, Select } from '@/components/ui';
import { api, friendlyMessage } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';
import { t } from '@/lib/i18n';

interface Availability { resourceId: string | null; timezone: string; weekly: Weekly; configured: boolean }
interface Exception { id: string; resourceId: string | null; resourceName: string | null; startAt: string; endAt: string; type: string; reason: string | null }
interface Resource { id: string; name: string; resourceType: string }

/** Bookable hours (business-wide or per staff/table) and holidays / time off. */
export default function AvailabilityPage() {
  const { role } = useWorkspace();
  const { bid, orgId, picker, missing, business } = useSetupBusiness();
  const search = useSearchParams();
  const qc = useQueryClient();
  const editable = ['OWNER', 'ADMIN', 'MANAGER'].includes(role ?? '');
  const [scope, setScope] = useState<string>(search.get('resource') ?? '');
  const [weekly, setWeekly] = useState<Weekly>({});
  const [saved, setSaved] = useState(false);
  const res = useQuery({ queryKey: ['org', orgId, 'setup', bid, 'resources'], enabled: Boolean(bid), queryFn: () => api<Resource[]>(`/v1/businesses/${bid}/resources`) });
  const av = useQuery({ queryKey: ['org', orgId, 'setup', bid, 'availability', scope], enabled: Boolean(bid),
    queryFn: () => api<Availability>(`/v1/businesses/${bid}/availability${scope ? `?resourceId=${scope}` : ''}`) });
  const ex = useQuery({ queryKey: ['org', orgId, 'setup', bid, 'exceptions'], enabled: Boolean(bid), queryFn: () => api<Exception[]>(`/v1/businesses/${bid}/availability-exceptions`) });
  useEffect(() => { if (av.data) { setWeekly(av.data.weekly); setSaved(false); } }, [av.data]);
  const save = useMutation({ mutationFn: () => api(`/v1/businesses/${bid}/availability`, { method: 'PUT', body: { resourceId: scope || null, weekly } }),
    onSuccess: () => { setSaved(true); void qc.invalidateQueries({ queryKey: ['org', orgId, 'setup', bid] }); } });
  const addEx = useMutation({ mutationFn: (body: object) => api(`/v1/businesses/${bid}/availability-exceptions`, { method: 'POST', body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['org', orgId, 'setup', bid, 'exceptions'] }) });
  const delEx = useMutation({ mutationFn: (id: string) => api(`/v1/businesses/${bid}/availability-exceptions/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['org', orgId, 'setup', bid, 'exceptions'] }) });
  if (missing) return <><PageHeader title={t("Timings & holidays")} />{missing}</>;
  const who = scope ? res.data?.find((r) => r.id === scope)?.name ?? t('Selected') : t('Whole business');
  const submitEx = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const from = String(f.get('from'));
    const to = String(f.get('to') || from);
    const tz = business?.timezone ?? 'Asia/Kolkata';
    const offset = tz === 'Asia/Kolkata' ? '+05:30' : 'Z';
    addEx.mutate({ type: f.get('type'), resourceId: f.get('resourceId') || null, reason: f.get('reason') || null,
      startAt: new Date(`${from}T${String(f.get('fromTime') || '00:00')}:00${offset}`).toISOString(),
      endAt: new Date(`${to}T${String(f.get('toTime') || '23:59')}:00${offset}`).toISOString() });
    e.currentTarget.reset();
  };
  return (
    <>
      <PageHeader title={t("Timings & holidays")} description={t("When customers can book (times in {timezone}). Opening hours shown to customers are in Settings → Business.", { timezone: business?.timezone ?? t('your timezone') })}
        actions={picker} />
      <Card title={t("Bookable hours")} actions={
        <label className="flex items-center gap-2 text-sm">{t("For")}
          <Select className="w-56" value={scope} onChange={(e) => setScope(e.target.value)} aria-label={t("Hours for")}>
            <option value="">{t("Whole business (default)")}</option>
            {(res.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </Select>
        </label>}>
        <p className="mb-2 text-sm text-slate-600">{scope ? t("{who}'s own hours override the business hours.", { who: who }) : t("Used for every staff member or table that has no own hours.")}
          {' '}{t("Add two time ranges for lunch and dinner service.")}</p>
        {av.data && !av.data.configured && scope && <Notice>{who} {t("uses the business hours right now. Save here to give")}{' '}{who} {t("its own hours.")}</Notice>}
        <WeeklyEditor value={weekly} onChange={(w) => { setWeekly(w); setSaved(false); }} disabled={!editable} />
        {save.isError && <div className="mt-3"><Notice tone="error">{friendlyMessage(save.error)}</Notice></div>}
        {saved && <div className="mt-3"><Notice tone="success">{t("Saved. The assistant uses these hours right away.")}</Notice></div>}
        {editable && <Button className="mt-4" loading={save.isPending} onClick={() => save.mutate()}>{t("Save hours")}</Button>}
      </Card>
      <div className="mt-6">
        <Card title={t("Holidays & time off")}>
          {editable && (
            <form onSubmit={submitEx} className="mb-4 grid gap-3 sm:grid-cols-6" aria-label={t("Add holiday")}>
              <Field label={t("Type")}>{(id) => <Select id={id} name="type"><option value="HOLIDAY">{t("Holiday (closed)")}</option><option value="LEAVE">{t("Leave")}</option><option value="BLOCKED">{t("Blocked time")}</option></Select>}</Field>
              <Field label={t("Who")}>{(id) => <Select id={id} name="resourceId"><option value="">{t("Whole business")}</option>{(res.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select>}</Field>
              <Field label={t("From")}>{(id) => <Input id={id} name="from" type="date" required />}</Field>
              <Field label={t("To (optional)")}>{(id) => <Input id={id} name="to" type="date" />}</Field>
              <Field label={t("Reason")}>{(id) => <Input id={id} name="reason" maxLength={300} placeholder={t("Diwali")} />}</Field>
              <div className="flex items-end"><Button type="submit" loading={addEx.isPending}>{t("Add")}</Button></div>
              {addEx.isError && <div className="sm:col-span-6"><Notice tone="error">{friendlyMessage(addEx.error)}</Notice></div>}
            </form>
          )}
          <DataTable caption={t("Holidays and time off")} loading={ex.isLoading} rows={ex.data} rowKey={(r) => r.id}
            empty={<EmptyState title={t("No holidays planned")} />}
            columns={[
              { key: 'type', header: t("Type"), cell: (r) => r.type.toLowerCase() },
              { key: 'who', header: t("Who"), cell: (r) => r.resourceName ?? t("Whole business") },
              { key: 'from', header: t("From"), cell: (r) => dateTime(r.startAt) },
              { key: 'to', header: t("To"), cell: (r) => dateTime(r.endAt) },
              { key: 'reason', header: t("Reason"), cell: (r) => r.reason ?? '—' },
              { key: 'x', header: '', cell: (r) => (editable ? <Button size="sm" variant="ghost" onClick={() => delEx.mutate(r.id)}>{t("Remove")}</Button> : null) },
            ]} />
        </Card>
      </div>
    </>
  );
}
