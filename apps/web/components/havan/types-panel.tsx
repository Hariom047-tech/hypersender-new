'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Button, Card, ErrorState, Field, Input, LoadingSkeleton, Notice, StatusBadge, Textarea } from '@/components/ui';
import { api, friendlyMessage } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';
import { t, msg } from '@/lib/i18n';

interface Pkg {
  id: string; tier: Tier; name: string; description: string | null; herbCount: number | null; herbs: string[]; samagriNotes: string | null; durationMinutes: number | null; panditCount: number | null; inPersonAvailable: boolean; onlineAvailable: boolean; onlineLiveVideo: boolean;
  onlineRecording: boolean; onlinePhotos: boolean; prasadCourier: boolean; internationalCourier: boolean; yajmanPreparation: string | null; active: boolean;
}
type Tier = 'SAMANYA' | 'VISHESH' | 'MAHA_VISHESH';

const TIERS: Array<{ tier: Tier; title: string; herbs: string; desc: string }> = [
  // desc = default text the assistant tells yajmans on WhatsApp (Hinglish data, not UI) - i18n-ignore
  { tier: 'SAMANYA', title: msg("Samanya Havan"), herbs: msg('Regular havan samagri'), desc: 'Samanya havan samagri se kiya jane wala havan.' }, // i18n-ignore
  { tier: 'VISHESH', title: msg("Vishesh Havan"), herbs: msg('21 kinds of jadi-buti'), desc: 'Samagri ke saath 21 prakar ki jadi-butiyon se kiya jane wala havan.' }, // i18n-ignore
  { tier: 'MAHA_VISHESH', title: msg("Maha Vishesh Havan"), herbs: msg('31 kinds of jadi-buti'), desc: 'Samagri ke saath 31 prakar ki jadi-butiyon se kiya jane wala havan.' }, // i18n-ignore
];
const ONLINE: Array<[keyof Pkg, string]> = [
  ['onlineLiveVideo', msg("Shows the havan live on a video call")], ['onlineRecording', msg("Sends a recording of the havan")], ['onlinePhotos', msg("Sends photos")],
  ['prasadCourier', msg("Couriers prasad (bhasma, raksha sutra)")], ['internationalCourier', msg("Couriers prasad abroad too")],
];

/** The three havan types Pandit Ji offers. There is deliberately no price: dakshina is told on a call. */
export function HavanTypesPanel({ bid, orgId, settingsHref }: { bid: string; orgId: string | null; settingsHref: string }) {
  const { role } = useWorkspace();
  const editable = ['OWNER', 'ADMIN', 'MANAGER'].includes(role ?? '');
  const key = ['org', orgId, 'setup', bid, 'havan-packages'];
  const pk = useQuery({ queryKey: key, queryFn: () => api<Pkg[]>(`/v1/businesses/${bid}/havan/packages`) });
  return (
    <>
      <p className="mb-4 text-sm text-slate-600">{t("Samanya, Vishesh and Maha Vishesh havan: the assistant tells yajmans exactly this. There is no dakshina here - Pandit Ji tells it on a call.")}</p>
      {pk.isLoading ? <LoadingSkeleton rows={8} /> : pk.isError ? <ErrorState error={pk.error} onRetry={() => pk.refetch()} /> : (
        <div className="space-y-6">
          <Notice tone="info">{t("Fill in and save each havan you perform. The havan's duration is blocked in Pandit Ji's calendar for every booking. The days and hours when a havan can be booked are set in")}{' '}<Link className="underline" href={settingsHref} scroll={false}>{t("Settings & calendar")}</Link>.</Notice>
          {TIERS.map((t) => (
            <PackageForm key={`${t.tier}-${pk.dataUpdatedAt}`} bid={bid!} meta={t} pkg={pk.data?.find((p) => p.tier === t.tier) ?? null} editable={editable} queryKey={key} />
          ))}
        </div>
      )}
    </>
  );
}

function PackageForm({ bid, meta, pkg, editable, queryKey }: { bid: string; meta: (typeof TIERS)[number]; pkg: Pkg | null; editable: boolean; queryKey: unknown[] }) {
  const qc = useQueryClient();
  const [online, setOnline] = useState(pkg ? pkg.onlineAvailable : true);
  const [local, setLocal] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const done = () => { setSaved(true); void qc.invalidateQueries({ queryKey }); };
  const save = useMutation({ mutationFn: (body: object) => api(`/v1/businesses/${bid}/havan/packages/${meta.tier}`, { method: 'PUT', body }), onSuccess: done });
  const remove = useMutation({ mutationFn: () => api(`/v1/businesses/${bid}/havan/packages/${meta.tier}`, { method: 'DELETE' }), onSuccess: done });
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLocal(null); setSaved(false);
    const f = new FormData(e.currentTarget);
    const num = (k: string) => { const v = String(f.get(k) ?? '').trim(); return v ? Number(v) : null; };
    const inPerson = f.get('inPerson') === 'on';
    if (!inPerson && !online) return setLocal(t("Choose at least one: in Nalkheda or online."));
    const duration = num('duration');
    if (!duration || duration < 15 || duration > 1440) return setLocal(t("Enter the havan duration between 15 and 1440 minutes (e.g. 120)."));
    save.mutate({
      name: String(f.get('name') || meta.title), description: String(f.get('description') || '') || null, herbCount: num('herbCount'),
      herbs: String(f.get('herbs') ?? '').split(',').map((x) => x.trim()).filter(Boolean), samagriNotes: String(f.get('samagri') || '') || null,
      durationMinutes: duration, panditCount: num('pandits'), inPersonAvailable: inPerson, onlineAvailable: online,
      ...Object.fromEntries(ONLINE.map(([k]) => [k, online && f.get(k) === 'on'])), yajmanPreparation: String(f.get('prep') || '') || null, active: f.get('active') === 'on',
    });
  };
  return (
    <form onSubmit={submit}>
      <Card title={<span className="flex items-center gap-2">{meta.title} <span className="text-xs font-normal text-slate-500">· {meta.herbs}</span>
        {pkg ? <StatusBadge tone={pkg.active ? 'green' : 'amber'}>{pkg.active ? t("Offered") : t("Turned off")}</StatusBadge>
          : <StatusBadge tone="slate">{t("Not set up")}</StatusBadge>}</span>}>
        <fieldset disabled={!editable} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("Name")}>{(id) => <Input id={id} name="name" defaultValue={pkg?.name ?? meta.title} maxLength={120} />}</Field>
            <Field label={t("How long the havan takes (minutes)")} hint={t("This much time is blocked in Pandit Ji's calendar. For example 2 hours = 120.")}>{(id, h) => (
              <Input id={id} aria-describedby={h} name="duration" type="number" min={15} max={1440} required defaultValue={pkg?.durationMinutes ?? 120} />)}</Field>
          </div>
          <Field label={t("Description (this is what yajmans are told)")}>{(id) => <Textarea id={id} name="description" rows={2} maxLength={2000} defaultValue={pkg?.description ?? meta.desc} />}</Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("Number of jadi-buti")}>{(id) => <Input id={id} name="herbCount" type="number" min={1} max={108} defaultValue={pkg?.herbCount ?? (meta.tier === 'VISHESH' ? 21 : meta.tier === 'MAHA_VISHESH' ? 31 : '')} />}</Field>
            <Field label={t("Number of Pandits (optional)")}>{(id) => <Input id={id} name="pandits" type="number" min={1} max={51} defaultValue={pkg?.panditCount ?? ''} />}</Field>
          </div>
          <Field label={t("Names of the jadi-buti (optional, separated by commas)")} hint={t("If left empty, the assistant says Pandit Ji will tell the names on the call.")}>{(id, h) => (
            <Textarea id={id} aria-describedby={h} name="herbs" rows={2} defaultValue={pkg?.herbs.join(', ') ?? ''} />)}</Field>
          <Field label={t("Samagri details (optional)")}>{(id) => <Textarea id={id} name="samagri" rows={2} maxLength={2000} defaultValue={pkg?.samagriNotes ?? ''} />}</Field>
          <fieldset>
            <legend className="text-sm font-medium text-slate-800">{t("How can yajmans have it done?")}</legend>
            <div className="mt-2 flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2"><input type="checkbox" name="inPerson" defaultChecked={pkg ? pkg.inPersonAvailable : true} /> {t("In person at Nalkheda")}</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={online} onChange={(e) => setOnline(e.target.checked)} /> {t("Online (sankalp from afar)")}</label>
            </div>
          </fieldset>
          {online && (
            <fieldset className="rounded-lg bg-slate-50 p-3">
              <legend className="px-1 text-sm font-medium text-slate-800">{t("What does an online havan include? (the assistant mentions only these)")}</legend>
              <div className="mt-1 grid gap-2 text-sm sm:grid-cols-2">
                {ONLINE.map(([k, label]) => <label key={k} className="flex items-center gap-2"><input type="checkbox" name={k} defaultChecked={Boolean(pkg?.[k])} /> {label}</label>)}
              </div>
            </fieldset>
          )}
          <Field label={t("Yajman's preparation (optional)")} hint={t("For example: bath and yellow clothes, a quiet place, video call time.")}>{(id, h) => (
            <Textarea id={id} aria-describedby={h} name="prep" rows={2} maxLength={2000} defaultValue={pkg?.yajmanPreparation ?? ''} />)}</Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="active" defaultChecked={pkg ? pkg.active : true} /> {t("Offer this havan to yajmans")}</label>
          {(local || save.isError || remove.isError) && <Notice tone="error">{local ?? friendlyMessage(save.error ?? remove.error)}</Notice>}
          {saved && <Notice tone="success">{t("Saved. The assistant now uses this information.")}</Notice>}
          {editable && (
            <div className="flex gap-2">
              <Button type="submit" loading={save.isPending}>{t("Save")}{' '}{meta.title}</Button>
              {pkg && <Button type="button" variant="secondary" loading={remove.isPending} onClick={() => remove.mutate()}>{t("Stop offering this havan")}</Button>}
            </div>
          )}
        </fieldset>
      </Card>
    </form>
  );
}
