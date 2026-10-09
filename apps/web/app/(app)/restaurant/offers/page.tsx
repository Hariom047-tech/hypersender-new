'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Drawer, fromMinor, rupees, toMinor, useSetupBusiness } from '@/components/setup/common';
import { Button, DataTable, EmptyState, ErrorState, Field, Input, PageHeader, Select, StatusBadge } from '@/components/ui';
import { api, friendlyMessage } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';
import { t } from '@/lib/i18n';

interface Coupon {
  id: string; code: string; description: string | null; discountType: 'PERCENT' | 'FLAT'; discountValue: number; maxDiscountMinor: number | null; minOrderMinor: number;
  validFrom: string | null; validUntil: string | null; usageLimit: number | null; perCustomerLimit: number | null; active: boolean; used: number;
}
const toLocalInput = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');

/** Coupon codes. The assistant only applies codes that exist here and meet their conditions. */
export default function OffersPage() {
  const { role } = useWorkspace();
  const { bid, orgId, picker, missing, currency } = useSetupBusiness();
  const qc = useQueryClient();
  const editable = ['OWNER', 'ADMIN', 'MANAGER'].includes(role ?? '');
  const [editing, setEditing] = useState<Coupon | 'new' | null>(null);
  const [type, setType] = useState<'PERCENT' | 'FLAT'>('PERCENT');
  const [local, setLocal] = useState<string | null>(null);
  const key = ['org', orgId, 'setup', bid, 'coupons'];
  const q = useQuery({ queryKey: key, enabled: Boolean(bid), queryFn: () => api<Coupon[]>(`/v1/businesses/${bid}/coupons`) });
  const save = useMutation({ mutationFn: (p: { id?: string; body: object }) => api(`/v1/businesses/${bid}/coupons${p.id ? `/${p.id}` : ''}`, { method: p.id ? 'PATCH' : 'POST', body: p.body }),
    onSuccess: () => { setEditing(null); void qc.invalidateQueries({ queryKey: key }); } });
  if (missing) return <><PageHeader title={t("Offers & coupons")} />{missing}</>;
  const current = editing && editing !== 'new' ? editing : null;
  const open = (c: Coupon | 'new') => { setType(c === 'new' ? 'PERCENT' : c.discountType); setLocal(null); save.reset(); setEditing(c); };
  const describe = (c: Coupon) => `${c.discountType === 'PERCENT' ? t('{p}% off', { p: c.discountValue / 100 }) : t('{amount} off', { amount: rupees(c.discountValue, currency) })}${c.maxDiscountMinor ? t(' (max {amount})', { amount: rupees(c.maxDiscountMinor, currency) }) : ''}${c.minOrderMinor ? t(' on orders above {amount}', { amount: rupees(c.minOrderMinor, currency) }) : ''}`;
  const submit = (e: FormEvent<HTMLFormElement>) => {
    setLocal(null);
    const f = new FormData(e.currentTarget);
    const value = type === 'PERCENT' ? Math.round(Number(f.get('value')) * 100) : toMinor(f.get('value'));
    if (!value || Number.isNaN(value) || value <= 0 || (type === 'PERCENT' && value > 10000)) return setLocal(type === 'PERCENT' ? t("Enter a percentage between 0 and 100.") : t("Enter the discount amount."));
    const maxD = toMinor(f.get('maxDiscount'));
    const minO = toMinor(f.get('minOrder'));
    if (Number.isNaN(maxD) || Number.isNaN(minO)) return setLocal(t("Check the amounts."));
    const date = (k: string) => (f.get(k) ? new Date(String(f.get(k))).toISOString() : null);
    const n = (k: string) => (f.get(k) ? Number(f.get(k)) : null);
    save.mutate({ id: current?.id, body: { code: String(f.get('code')).toUpperCase(), description: f.get('description') || null, discountType: type, discountValue: value,
      maxDiscountMinor: type === 'PERCENT' ? maxD : null, minOrderMinor: minO ?? 0, validFrom: date('from'), validUntil: date('until'),
      usageLimit: n('usageLimit'), perCustomerLimit: n('perCustomer'), active: f.get('active') === 'on' } });
  };
  return (
    <>
      <PageHeader title={t("Offers & coupons")} description={t("Codes customers can use on WhatsApp. The assistant never invents discounts - only these codes work.")}
        actions={<div className="flex items-center gap-3">{picker}{editable && <Button onClick={() => open('new')}>{t("+ New coupon")}</Button>}</div>} />
      {q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
        <DataTable caption={t("Coupons")} loading={q.isLoading} rows={q.data} rowKey={(c) => c.id} onRowClick={editable ? open : undefined}
          empty={<EmptyState title={t("No coupons yet")} body={t("Example: SAVE10 - 10% off above ₹299, max ₹100.")} />}
          columns={[
            { key: 'code', header: t("Code"), cell: (c) => <span className="font-mono font-semibold">{c.code}</span> },
            { key: 'offer', header: t("Offer"), cell: (c) => <span className="text-sm">{describe(c)}</span> },
            { key: 'valid', header: t("Valid"), cell: (c) => <span className="text-xs">{c.validFrom || c.validUntil ? `${c.validFrom ? dateTime(c.validFrom) : t('now')} → ${c.validUntil ? dateTime(c.validUntil) : t('no end')}` : t("Always")}</span> },
            { key: 'used', header: t("Used"), cell: (c) => `${c.used}${c.usageLimit ? ` / ${c.usageLimit}` : ''}` },
            { key: 'st', header: t("Status"), cell: (c) => {
              const expired = c.validUntil && new Date(c.validUntil) < new Date();
              return <StatusBadge tone={!c.active || expired ? 'slate' : 'green'}>{!c.active ? t("Off") : expired ? t("Expired") : t("Active")}</StatusBadge>;
            } },
          ]} />
      )}
      {editing && (
        <Drawer title={current ? t("Edit {code}", { code: current.code }) : t("New coupon")} onClose={() => setEditing(null)} onSubmit={submit} busy={save.isPending} error={local ?? (save.isError ? friendlyMessage(save.error) : null)}>
          <Field label={t("Code")} hint={t("Letters and numbers, e.g. SAVE10.")}>{(id, h) => <Input id={id} aria-describedby={h} name="code" required pattern="[A-Za-z0-9_-]{2,30}" maxLength={30} className="font-mono uppercase" defaultValue={current?.code} />}</Field>
          <Field label={t("Description (optional)")}>{(id) => <Input id={id} name="description" maxLength={300} defaultValue={current?.description ?? ''} placeholder={t("Weekend offer")} />}</Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("Discount type")}>{(id) => <Select id={id} value={type} onChange={(e) => setType(e.target.value as 'PERCENT')}><option value="PERCENT">{t("Percentage (%)")}</option><option value="FLAT">{t("Flat amount (₹)")}</option></Select>}</Field>
            <Field label={type === 'PERCENT' ? t("Percent off") : t("Amount off (₹)")}>{(id) => <Input id={id} name="value" required inputMode="decimal"
              defaultValue={current ? (current.discountType === 'PERCENT' ? current.discountValue / 100 : fromMinor(current.discountValue)) : ''} placeholder={type === 'PERCENT' ? '10' : '50'} />}</Field>
            {type === 'PERCENT' && <Field label={t("Maximum discount (₹, optional)")}>{(id) => <Input id={id} name="maxDiscount" inputMode="decimal" defaultValue={fromMinor(current?.maxDiscountMinor)} placeholder="100" />}</Field>}
            <Field label={t("Minimum order (₹)")}>{(id) => <Input id={id} name="minOrder" inputMode="decimal" defaultValue={fromMinor(current?.minOrderMinor || null)} placeholder="299" />}</Field>
            <Field label={t("Starts (optional)")}>{(id) => <Input id={id} name="from" type="datetime-local" defaultValue={toLocalInput(current?.validFrom ?? null)} />}</Field>
            <Field label={t("Ends (optional)")}>{(id) => <Input id={id} name="until" type="datetime-local" defaultValue={toLocalInput(current?.validUntil ?? null)} />}</Field>
            <Field label={t("Total uses (optional)")}>{(id) => <Input id={id} name="usageLimit" type="number" min={1} defaultValue={current?.usageLimit ?? ''} />}</Field>
            <Field label={t("Uses per customer (optional)")}>{(id) => <Input id={id} name="perCustomer" type="number" min={1} max={1000} defaultValue={current?.perCustomerLimit ?? ''} />}</Field>
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="active" defaultChecked={current?.active ?? true} /> {t("Active")}</label>
        </Drawer>
      )}
    </>
  );
}
