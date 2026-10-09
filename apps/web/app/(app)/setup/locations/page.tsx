'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Drawer, parseCoordinates, useSetupBusiness } from '@/components/setup/common';
import { Button, ConfirmDialog, DataTable, EmptyState, ErrorState, Field, Input, PageHeader, StatusBadge } from '@/components/ui';
import { api, friendlyMessage } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';
import { t } from '@/lib/i18n';

interface Location { id: string; name: string; address: Record<string, string>; phone: string | null; latitude: number | null; longitude: number | null; isPrimary: boolean; status: string }
const addr = (a: Record<string, string>) => [a.line1, a.line2, a.landmark, a.city, a.state, a.postalCode].filter(Boolean).join(', ');

/** Branches / addresses. The map pin powers "location" replies and delivery-radius checks. */
export default function LocationsPage() {
  const { role } = useWorkspace();
  const { bid, orgId, picker, missing } = useSetupBusiness();
  const qc = useQueryClient();
  const editable = ['OWNER', 'ADMIN', 'MANAGER'].includes(role ?? '');
  const [editing, setEditing] = useState<Location | 'new' | null>(null);
  const [removing, setRemoving] = useState<Location | null>(null);
  const [pin, setPin] = useState('');
  const key = ['org', orgId, 'setup', bid, 'locations'];
  const q = useQuery({ queryKey: key, enabled: Boolean(bid), queryFn: () => api<Location[]>(`/v1/businesses/${bid}/locations`) });
  const save = useMutation({ mutationFn: (p: { id?: string; body: object }) => api(`/v1/businesses/${bid}/locations${p.id ? `/${p.id}` : ''}`, { method: p.id ? 'PATCH' : 'POST', body: p.body }),
    onSuccess: () => { setEditing(null); void qc.invalidateQueries({ queryKey: key }); } });
  const del = useMutation({ mutationFn: (id: string) => api(`/v1/businesses/${bid}/locations/${id}`, { method: 'DELETE' }),
    onSuccess: () => { setRemoving(null); void qc.invalidateQueries({ queryKey: key }); } });
  if (missing) return <><PageHeader title={t("Branches & location")} />{missing}</>;
  const current = editing && editing !== 'new' ? editing : null;
  const coords = parseCoordinates(pin);
  const openEditor = (l: Location | 'new') => { setPin(l !== 'new' && l.latitude !== null ? `${l.latitude}, ${l.longitude}` : ''); save.reset(); setEditing(l); };
  const submit = (e: FormEvent<HTMLFormElement>) => {
    const f = new FormData(e.currentTarget);
    const s = (k: string) => String(f.get(k) ?? '').trim();
    save.mutate({ id: current?.id, body: { name: s('name'), phone: s('phone') || null, isPrimary: f.get('isPrimary') === 'on',
      address: { line1: s('line1'), line2: s('line2'), landmark: s('landmark'), city: s('city'), state: s('state'), postalCode: s('postalCode') },
      latitude: coords?.lat ?? null, longitude: coords?.lng ?? null } });
  };
  return (
    <>
      <PageHeader title={t("Branches & location")} description={t("Your address and map pin. The assistant shares them with customers and uses the pin for delivery-radius checks.")}
        actions={<div className="flex items-center gap-3">{picker}{editable && <Button onClick={() => openEditor('new')}>{t("+ Add branch")}</Button>}</div>} />
      {q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
        <DataTable caption={t("Branches")} loading={q.isLoading} rows={q.data} rowKey={(r) => r.id} onRowClick={editable ? (r) => openEditor(r) : undefined}
          empty={<EmptyState title={t("No address yet")} body={t("Add your restaurant/clinic address and drop a map pin.")} />}
          columns={[
            { key: 'name', header: t("Branch"), cell: (r) => <span className="font-medium">{r.name} {r.isPrimary && <StatusBadge tone="blue">{t("Main")}</StatusBadge>}</span> },
            { key: 'addr', header: t("Address"), cell: (r) => <span className="text-sm">{addr(r.address)}</span> },
            { key: 'phone', header: t("Phone"), cell: (r) => r.phone ?? '—' },
            { key: 'map', header: t("Map"), cell: (r) => (r.latitude !== null
              ? <a className="text-xs text-emerald-800 underline" target="_blank" rel="noopener noreferrer" href={`https://maps.google.com/?q=${r.latitude},${r.longitude}`} onClick={(e) => e.stopPropagation()}>{t("Open pin")}</a>
              : <span className="text-xs text-amber-700">{t("No pin")}</span>) },
            { key: 'x', header: '', cell: (r) => (editable ? <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setRemoving(r); }}>{t("Delete")}</Button> : null) },
          ]} />
      )}
      {editing && (
        <Drawer title={current ? t("Edit {name}", { name: current.name }) : t("Add branch")} onClose={() => setEditing(null)} onSubmit={submit} busy={save.isPending} error={save.isError ? friendlyMessage(save.error) : null}>
          <Field label={t("Branch name")}>{(id) => <Input id={id} name="name" required maxLength={200} defaultValue={current?.name ?? 'Main branch'} />}</Field>
          <Field label={t("Address line")}>{(id) => <Input id={id} name="line1" maxLength={200} defaultValue={current?.address.line1} placeholder={t("12, MG Road")} />}</Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("Area / locality")}>{(id) => <Input id={id} name="line2" maxLength={200} defaultValue={current?.address.line2} placeholder={t("Vijay Nagar")} />}</Field>
            <Field label={t("Landmark")}>{(id) => <Input id={id} name="landmark" maxLength={200} defaultValue={current?.address.landmark} placeholder={t("Near C21 Mall")} />}</Field>
            <Field label={t("City")}>{(id) => <Input id={id} name="city" maxLength={100} defaultValue={current?.address.city} />}</Field>
            <Field label={t("State")}>{(id) => <Input id={id} name="state" maxLength={100} defaultValue={current?.address.state} />}</Field>
            <Field label={t("PIN code")}>{(id) => <Input id={id} name="postalCode" maxLength={10} inputMode="numeric" defaultValue={current?.address.postalCode} />}</Field>
            <Field label={t("Phone (optional)")}>{(id) => <Input id={id} name="phone" type="tel" maxLength={20} defaultValue={current?.phone ?? ''} placeholder="+919812345678" />}</Field>
          </div>
          <Field label={t("Map pin")} hint={t("Paste a Google Maps link or \"latitude, longitude\". Needed for delivery by distance.")}>{(id, h) => (
            <Input id={id} aria-describedby={h} value={pin} onChange={(e) => setPin(e.target.value)} placeholder={t("https://maps.google.com/?q=22.7196,75.8577")} />)}</Field>
          {pin && (coords
            ? <p className="text-xs text-emerald-800">{t("Pin:")}{' '}{coords.lat}, {coords.lng} · <a className="underline" target="_blank" rel="noopener noreferrer" href={`https://maps.google.com/?q=${coords.lat},${coords.lng}`}>{t("check on map")}</a></p>
            : <p className="text-xs text-red-700">{t("Could not read coordinates from that text.")}</p>)}
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="isPrimary" defaultChecked={current?.isPrimary ?? true} /> {t("Main branch")}</label>
        </Drawer>
      )}
      <ConfirmDialog open={Boolean(removing)} title={t("Delete branch?")} body={t("“{name}” will no longer be shared with customers.", { name: removing?.name })}
        confirmLabel={t("Delete")} busy={del.isPending} onClose={() => setRemoving(null)} onConfirm={() => removing && del.mutate(removing.id)} />
    </>
  );
}
