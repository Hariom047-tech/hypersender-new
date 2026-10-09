'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Drawer, fromMinor, rupees, toMinor, useSetupBusiness } from '@/components/setup/common';
import { Button, ConfirmDialog, DataTable, EmptyState, ErrorState, Field, Input, Notice, PageHeader, StatusBadge, Textarea } from '@/components/ui';
import { api, friendlyMessage } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';
import { t } from '@/lib/i18n';

interface Service { id: string; name: string; description: string | null; durationMinutes: number | null; priceMinor: number | null; currency: string; active: boolean; resourceIds: string[] }
interface Resource { id: string; name: string; resourceType: string }

/** Services & prices customers can book (appointments, treatments, table reservations). */
export default function ServicesPage() {
  const { role } = useWorkspace();
  const { bid, orgId, picker, missing, currency } = useSetupBusiness();
  const qc = useQueryClient();
  const editable = ['OWNER', 'ADMIN', 'MANAGER'].includes(role ?? '');
  const [editing, setEditing] = useState<Service | 'new' | null>(null);
  const [removing, setRemoving] = useState<Service | null>(null);
  const key = ['org', orgId, 'setup', bid, 'services'];
  const q = useQuery({ queryKey: key, enabled: Boolean(bid), queryFn: () => api<Service[]>(`/v1/businesses/${bid}/services`) });
  const res = useQuery({ queryKey: ['org', orgId, 'setup', bid, 'resources'], enabled: Boolean(bid), queryFn: () => api<Resource[]>(`/v1/businesses/${bid}/resources`) });
  const save = useMutation({
    mutationFn: (p: { id?: string; body: object }) => api(`/v1/businesses/${bid}/services${p.id ? `/${p.id}` : ''}`, { method: p.id ? 'PATCH' : 'POST', body: p.body }),
    onSuccess: () => { setEditing(null); void qc.invalidateQueries({ queryKey: ['org', orgId, 'setup', bid] }); },
  });
  const del = useMutation({ mutationFn: (id: string) => api(`/v1/businesses/${bid}/services/${id}`, { method: 'DELETE' }),
    onSuccess: () => { setRemoving(null); void qc.invalidateQueries({ queryKey: key }); } });
  if (missing) return <><PageHeader title={t("Services & prices")} />{missing}</>;
  const submit = (e: FormEvent<HTMLFormElement>) => {
    const f = new FormData(e.currentTarget);
    const price = toMinor(f.get('price'));
    if (Number.isNaN(price)) return;
    save.mutate({ id: editing !== 'new' ? editing?.id : undefined, body: { name: f.get('name'), description: f.get('description') || null,
      durationMinutes: f.get('duration') ? Number(f.get('duration')) : null, priceMinor: price, active: f.get('active') === 'on', resourceIds: f.getAll('resourceIds').map(String) } });
  };
  const current = editing && editing !== 'new' ? editing : null;
  return (
    <>
      <PageHeader title={t("Services & prices")} description={t("What customers can book, with duration and price. The assistant quotes these prices exactly.")}
        actions={<div className="flex items-center gap-3">{picker}{editable && <Button onClick={() => setEditing('new')}>{t("+ Add service")}</Button>}</div>} />
      {q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
        <DataTable caption={t("Services")} loading={q.isLoading} rows={q.data} rowKey={(r) => r.id} onRowClick={editable ? (r) => setEditing(r) : undefined}
          empty={<EmptyState title={t("No services yet")} body={t("Add what you offer, e.g. 'Consultation – 30 min – ₹500' or 'Table for 4'.")} />}
          columns={[
            { key: 'name', header: t("Service"), cell: (r) => <span className="font-medium">{r.name}</span> },
            { key: 'dur', header: t("Duration"), cell: (r) => (r.durationMinutes ? t('{n} min', { n: r.durationMinutes }) : '—') },
            { key: 'price', header: t("Price"), cell: (r) => rupees(r.priceMinor, r.currency) },
            { key: 'who', header: t("Provided by"), cell: (r) => <span className="text-xs">{r.resourceIds.map((id) => res.data?.find((x) => x.id === id)?.name).filter(Boolean).join(', ') || t("Anyone")}</span> },
            { key: 'st', header: t("Status"), cell: (r) => <StatusBadge tone={r.active ? 'green' : 'slate'}>{r.active ? t("Active") : t("Hidden")}</StatusBadge> },
            { key: 'x', header: '', cell: (r) => (editable ? <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setRemoving(r); }}>{t("Delete")}</Button> : null) },
          ]} />
      )}
      {editing && (
        <Drawer title={current ? t("Edit {name}", { name: current.name }) : t("Add service")} onClose={() => setEditing(null)} onSubmit={submit} busy={save.isPending}
          error={save.isError ? friendlyMessage(save.error) : null}>
          <Field label={t("Name")}>{(id) => <Input id={id} name="name" required maxLength={200} defaultValue={current?.name} placeholder={t("Dental cleaning")} />}</Field>
          <Field label={t("Description (optional)")}>{(id) => <Textarea id={id} name="description" rows={3} maxLength={1000} defaultValue={current?.description ?? ''} />}</Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("Duration (minutes)")} hint={t("Used to find free slots.")}>{(id, h) => <Input id={id} aria-describedby={h} name="duration" type="number" min={1} max={1440} defaultValue={current?.durationMinutes ?? ''} />}</Field>
            <Field label={t("Price ({currency})", { currency: currency })} hint={t("Leave empty if the price varies.")}>{(id, h) => <Input id={id} aria-describedby={h} name="price" inputMode="decimal" defaultValue={fromMinor(current?.priceMinor)} placeholder="500" />}</Field>
          </div>
          <fieldset>
            <legend className="text-sm font-medium text-slate-800">{t("Who provides it")}</legend>
            <p className="text-xs text-slate-500">{t("Leave all unticked if any staff/table can take it.")}</p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {(res.data ?? []).map((r) => <label key={r.id} className="flex items-center gap-2 text-sm"><input type="checkbox" name="resourceIds" value={r.id} defaultChecked={current?.resourceIds.includes(r.id)} />{r.name}</label>)}
              {res.data?.length === 0 && <p className="text-xs text-slate-500">{t("No staff or tables yet.")}</p>}
            </div>
          </fieldset>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="active" defaultChecked={current?.active ?? true} /> {t("Offer this service")}</label>
        </Drawer>
      )}
      <ConfirmDialog open={Boolean(removing)} title={t("Delete service?")} body={t("“{name}” will no longer be offered. Existing bookings stay.", { name: removing?.name })}
        confirmLabel={t("Delete")} busy={del.isPending} onClose={() => setRemoving(null)} onConfirm={() => removing && del.mutate(removing.id)} />
      {!editable && <div className="mt-4"><Notice>{t("Only owners, admins and managers can change services.")}</Notice></div>}
    </>
  );
}
