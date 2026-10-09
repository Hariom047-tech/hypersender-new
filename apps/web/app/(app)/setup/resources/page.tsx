'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Drawer, useSetupBusiness } from '@/components/setup/common';
import { Button, ConfirmDialog, DataTable, EmptyState, ErrorState, Field, Input, Notice, PageHeader, Select, StatusBadge, Textarea } from '@/components/ui';
import { api, friendlyMessage } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';
import { t, msg } from '@/lib/i18n';

interface Resource { id: string; resourceType: string; name: string; description: string | null; capacity: number; active: boolean; serviceIds: string[]; hasOwnHours: boolean }
interface Service { id: string; name: string }

const RESOURCE_TYPES: Array<[string, string, string]> = [
  ['TABLE', msg("Table"), msg("Seats")], ['DOCTOR', msg("Doctor"), msg("Patients at a time")], ['DENTIST', msg("Dentist"), msg("Patients at a time")], ['STYLIST', msg("Stylist"), msg("Clients at a time")],
  ['THERAPIST', msg("Therapist"), msg("Clients at a time")], ['ROOM', msg("Room"), msg("Guests")], ['STAFF', msg("Staff member"), msg("Customers at a time")], ['AGENT', msg("Agent"), msg("Visits at a time")],
  ['EQUIPMENT', msg("Equipment"), msg("Units")],
];
const label = (t: string) => RESOURCE_TYPES.find(([k]) => k === t)?.[1] ?? t;

/** Bookable staff and resources: tables with seats, doctors, stylists, rooms. */
export default function ResourcesPage() {
  const { role } = useWorkspace();
  const { bid, orgId, picker, missing } = useSetupBusiness();
  const qc = useQueryClient();
  const editable = ['OWNER', 'ADMIN', 'MANAGER'].includes(role ?? '');
  const [editing, setEditing] = useState<Resource | 'new' | null>(null);
  const [type, setType] = useState('TABLE');
  const [removing, setRemoving] = useState<Resource | null>(null);
  const q = useQuery({ queryKey: ['org', orgId, 'setup', bid, 'resources'], enabled: Boolean(bid), queryFn: () => api<Resource[]>(`/v1/businesses/${bid}/resources`) });
  const svc = useQuery({ queryKey: ['org', orgId, 'setup', bid, 'services'], enabled: Boolean(bid), queryFn: () => api<Service[]>(`/v1/businesses/${bid}/services`) });
  const save = useMutation({
    mutationFn: (p: { id?: string; body: object }) => api(`/v1/businesses/${bid}/resources${p.id ? `/${p.id}` : ''}`, { method: p.id ? 'PATCH' : 'POST', body: p.body }),
    onSuccess: () => { setEditing(null); void qc.invalidateQueries({ queryKey: ['org', orgId, 'setup', bid] }); },
  });
  const del = useMutation({ mutationFn: (id: string) => api(`/v1/businesses/${bid}/resources/${id}`, { method: 'DELETE' }),
    onSuccess: () => { setRemoving(null); void qc.invalidateQueries({ queryKey: ['org', orgId, 'setup', bid] }); } });
  if (missing) return <><PageHeader title={t("Staff & tables")} />{missing}</>;
  const current = editing && editing !== 'new' ? editing : null;
  const open = (r: Resource | 'new') => { setType(r === 'new' ? 'TABLE' : r.resourceType); setEditing(r); save.reset(); };
  const submit = (e: FormEvent<HTMLFormElement>) => {
    const f = new FormData(e.currentTarget);
    save.mutate({ id: current?.id, body: { resourceType: type, name: f.get('name'), description: f.get('description') || null, capacity: Number(f.get('capacity') || 1),
      active: f.get('active') === 'on', serviceIds: f.getAll('serviceIds').map(String) } });
  };
  const capLabel = t(RESOURCE_TYPES.find(([k]) => k === type)?.[2] ?? msg('Capacity'));
  return (
    <>
      <PageHeader title={t("Staff & tables")} description={t("Who or what customers can book: tables with seats, doctors, stylists, rooms. Set their hours in Timings.")}
        actions={<div className="flex items-center gap-3">{picker}{editable && <Button onClick={() => open('new')}>{t("+ Add")}</Button>}</div>} />
      {q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
        <DataTable caption={t("Staff and tables")} loading={q.isLoading} rows={q.data} rowKey={(r) => r.id} onRowClick={editable ? (r) => open(r) : undefined}
          empty={<EmptyState title={t("Nothing bookable yet")} body={t("Add your tables (with seats) or your doctors/stylists so the assistant can find free slots.")} />}
          columns={[
            { key: 'name', header: t("Name"), cell: (r) => <span className="font-medium">{r.name}</span> },
            { key: 'type', header: t("Type"), cell: (r) => label(r.resourceType) },
            { key: 'cap', header: t("Seats / capacity"), cell: (r) => r.capacity },
            { key: 'svc', header: t("Services"), cell: (r) => <span className="text-xs">{r.serviceIds.map((id) => svc.data?.find((s) => s.id === id)?.name).filter(Boolean).join(', ') || t("All")}</span> },
            { key: 'hours', header: t("Hours"), cell: (r) => <Link className="text-xs text-emerald-800 underline" href={`/setup/availability?resource=${r.id}`} onClick={(e) => e.stopPropagation()}>{r.hasOwnHours ? t("Own hours") : t("Business hours")}</Link> },
            { key: 'st', header: t("Status"), cell: (r) => <StatusBadge tone={r.active ? 'green' : 'slate'}>{r.active ? t("Bookable") : t("Inactive")}</StatusBadge> },
            { key: 'x', header: '', cell: (r) => (editable ? <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setRemoving(r); }}>{t("Delete")}</Button> : null) },
          ]} />
      )}
      {editing && (
        <Drawer title={current ? t("Edit {name}", { name: current.name }) : t("Add staff or table")} onClose={() => setEditing(null)} onSubmit={submit} busy={save.isPending} error={save.isError ? friendlyMessage(save.error) : null}>
          <Field label={t("Type")}>{(id) => <Select id={id} value={type} onChange={(e) => setType(e.target.value)}>{RESOURCE_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}</Field>
          <Field label={t("Name")}>{(id) => <Input id={id} name="name" required maxLength={200} defaultValue={current?.name} placeholder={type === 'TABLE' ? t("Table 4 (window)") : t("Dr Sharma")} />}</Field>
          <Field label={capLabel} hint={type === 'TABLE' ? t("The assistant only offers tables with enough seats for the party.") : undefined}>{(id, h) => (
            <Input id={id} aria-describedby={h} name="capacity" type="number" min={1} max={1000} required defaultValue={current?.capacity ?? (type === 'TABLE' ? 4 : 1)} />)}</Field>
          <Field label={t("Description (optional)")}>{(id) => <Textarea id={id} name="description" rows={2} maxLength={1000} defaultValue={current?.description ?? ''} />}</Field>
          <fieldset>
            <legend className="text-sm font-medium text-slate-800">{t("Services offered")}</legend>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {(svc.data ?? []).map((s) => <label key={s.id} className="flex items-center gap-2 text-sm"><input type="checkbox" name="serviceIds" value={s.id} defaultChecked={current?.serviceIds.includes(s.id)} />{s.name}</label>)}
              {svc.data?.length === 0 && <p className="text-xs text-slate-500">{t("No services yet (optional).")}</p>}
            </div>
          </fieldset>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="active" defaultChecked={current?.active ?? true} /> {t("Can be booked")}</label>
        </Drawer>
      )}
      <ConfirmDialog open={Boolean(removing)} title={t("Delete?")} body={t("“{name}” can no longer be booked. If it has upcoming bookings, deleting is refused.", { name: removing?.name })}
        confirmLabel={t("Delete")} busy={del.isPending} onClose={() => { setRemoving(null); del.reset(); }} onConfirm={() => removing && del.mutate(removing.id)} />
      {del.isError && <div className="mt-4"><Notice tone="error">{friendlyMessage(del.error)}</Notice></div>}
    </>
  );
}
