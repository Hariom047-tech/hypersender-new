'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { fromMinor, rupees, toMinor, useSetupBusiness } from '@/components/setup/common';
import { Button, Card, ErrorState, Field, Input, LoadingSkeleton, Notice, PageHeader } from '@/components/ui';
import { api, friendlyMessage } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';
import { t, msg } from '@/lib/i18n';

interface Settings {
  configured: boolean; enabled: boolean; fulfillmentModes: string[]; paymentMethods: string[]; currency: string; taxRateBps: number; taxInclusive: boolean;
  packagingFeeMinor: number; minOrderMinor: number; deliveryFeeMinor: number; freeDeliveryAboveMinor: number | null; deliveryPincodes: string[]; deliveryRadiusKm: number | null;
  prepTimeMinutes: number; schedulingEnabled: boolean; maxScheduleDays: number; quoteTtlMinutes: number; autoCancelBeforeAccept: boolean;
}
const MODES: Array<[string, string, string]> = [
  ['DELIVERY', msg("Home delivery"), msg("Customer pays cash on delivery")], ['PICKUP', msg("Takeaway / pickup"), msg("Customer pays at the counter")], ['DINE_IN', msg("Dine-in"), msg("Customer pays at the counter")],
];

/** How WhatsApp ordering works for this restaurant: modes, charges, taxes, delivery area. */
export default function OrderingSettingsPage() {
  const { role } = useWorkspace();
  const { bid, orgId, picker, missing } = useSetupBusiness();
  const editable = ['OWNER', 'ADMIN', 'MANAGER'].includes(role ?? '');
  const qc = useQueryClient();
  const key = ['org', orgId, 'setup', bid, 'ordering-settings'];
  const q = useQuery({ queryKey: key, enabled: Boolean(bid), queryFn: () => api<Settings>(`/v1/businesses/${bid}/ordering-settings`) });
  if (missing) return <><PageHeader title={t("Ordering settings")} />{missing}</>;
  return (
    <>
      <PageHeader title={t("Ordering settings")} description={t("How customers order on WhatsApp: delivery or pickup, charges, GST and delivery area. The assistant calculates every bill from these.")}
        actions={picker} />
      {q.isLoading ? <LoadingSkeleton rows={8} /> : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : q.data &&
        <SettingsForm key={`${bid}-${q.dataUpdatedAt}`} s={q.data} bid={bid!} editable={editable} onSaved={() => void qc.invalidateQueries({ queryKey: ['org', orgId, 'setup', bid] })} />}
    </>
  );
}

function SettingsForm({ s, bid, editable, onSaved }: { s: Settings; bid: string; editable: boolean; onSaved: () => void }) {
  const [modes, setModes] = useState<string[]>(s.fulfillmentModes);
  const [local, setLocal] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const save = useMutation({ mutationFn: (body: object) => api(`/v1/businesses/${bid}/ordering-settings`, { method: 'PUT', body }), onSuccess: () => { setSaved(true); onSaved(); } });
  const delivery = modes.includes('DELIVERY');
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLocal(null); setSaved(false);
    const f = new FormData(e.currentTarget);
    if (!modes.length) return setLocal(t("Choose at least one way to order."));
    const m = (k: string) => toMinor(f.get(k));
    const money = { packagingFeeMinor: m('packaging') ?? 0, minOrderMinor: m('minOrder') ?? 0, deliveryFeeMinor: m('deliveryFee') ?? 0, freeDeliveryAboveMinor: m('freeAbove') };
    if (Object.values(money).some((v) => Number.isNaN(v))) return setLocal(t("Check the amounts - use numbers like 40 or 49.50."));
    const tax = Number(f.get('tax') || 0);
    if (!Number.isFinite(tax) || tax < 0 || tax > 50) return setLocal(t("GST must be between 0 and 50%."));
    const pins = String(f.get('pincodes') ?? '').split(/[\s,]+/).map((p) => p.trim()).filter(Boolean);
    if (pins.some((p) => !/^[0-9]{4,10}$/.test(p))) return setLocal(t("PIN codes must be digits only, separated by commas."));
    const radius = String(f.get('radius') ?? '').trim();
    if (delivery && !pins.length && !radius) return setLocal(t("For delivery, add the PIN codes you deliver to, or a delivery radius in km (or both)."));
    save.mutate({
      enabled: f.get('enabled') === 'on', fulfillmentModes: modes,
      paymentMethods: [...(delivery ? ['COD'] : []), ...(modes.some((x) => x !== 'DELIVERY') ? ['PAY_AT_PICKUP'] : [])],
      taxRateBps: Math.round(tax * 100), taxInclusive: f.get('taxInclusive') === 'on', ...money,
      deliveryPincodes: pins, deliveryRadiusKm: radius ? Number(radius) : null,
      prepTimeMinutes: Number(f.get('prep') || 30), schedulingEnabled: f.get('scheduling') === 'on', maxScheduleDays: Number(f.get('maxDays') || 2),
      quoteTtlMinutes: Number(f.get('quoteTtl') || 15), autoCancelBeforeAccept: f.get('autoCancel') === 'on',
    });
  };
  return (
    <form onSubmit={submit} className="space-y-6">
      {!s.configured && <Notice tone="warn">{t("Ordering is not set up yet. Fill this in and save - your Restaurant Ordering assistant needs it.")}</Notice>}
      <fieldset disabled={!editable} className="space-y-6">
        <Card title={t("Ordering on WhatsApp")}>
          <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" name="enabled" defaultChecked={s.configured ? s.enabled : true} /> {t("Accept food orders on WhatsApp")}</label>
          <p className="mt-1 text-xs text-slate-500">{t("When off, the assistant can still show the menu but will not take orders.")}</p>
          <fieldset className="mt-4">
            <legend className="text-sm font-medium text-slate-800">{t("How can customers get their food?")}</legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              {MODES.map(([k, label, pay]) => (
                <label key={k} className="flex items-start gap-2 rounded-lg p-3 text-sm ring-1 ring-slate-200 has-[:checked]:bg-emerald-50 has-[:checked]:ring-emerald-600">
                  <input type="checkbox" className="mt-0.5" checked={modes.includes(k)} onChange={(e) => setModes(e.target.checked ? [...modes, k] : modes.filter((x) => x !== k))} />
                  <span><span className="block font-medium">{label}</span><span className="text-xs text-slate-500">{pay}</span></span>
                </label>
              ))}
            </div>
            <p className="mt-2 text-xs text-slate-500">{t("Online payment (UPI / cards) is coming soon. The assistant never asks for card or UPI details.")}</p>
          </fieldset>
        </Card>
        <Card title={t("Bill: taxes & charges")}>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={t("GST %")} hint={t("Commonly 5% for restaurants.")}>{(id, h) => <Input id={id} aria-describedby={h} name="tax" type="number" step="0.01" min={0} max={50} defaultValue={s.taxRateBps / 100} />}</Field>
            <Field label={t("Packaging charge per order (₹)")}>{(id) => <Input id={id} name="packaging" inputMode="decimal" defaultValue={fromMinor(s.packagingFeeMinor)} placeholder="0" />}</Field>
            <Field label={t("Minimum order (₹)")}>{(id) => <Input id={id} name="minOrder" inputMode="decimal" defaultValue={fromMinor(s.minOrderMinor)} placeholder="0" />}</Field>
          </div>
          <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" name="taxInclusive" defaultChecked={s.taxInclusive} /> {t("Menu prices already include GST")}</label>
        </Card>
        {delivery && (
          <Card title={t("Delivery")}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("Delivery fee (₹)")}>{(id) => <Input id={id} name="deliveryFee" inputMode="decimal" defaultValue={fromMinor(s.deliveryFeeMinor)} placeholder="40" />}</Field>
              <Field label={t("Free delivery above (₹, optional)")}>{(id) => <Input id={id} name="freeAbove" inputMode="decimal" defaultValue={fromMinor(s.freeDeliveryAboveMinor)} placeholder="499" />}</Field>
              <div className="sm:col-span-2">
                <Field label={t("PIN codes you deliver to")} hint={t("Separate with commas. A customer's address must be in one of these (or inside the radius).")}>{(id, h) => (
                  <Input id={id} aria-describedby={h} name="pincodes" defaultValue={s.deliveryPincodes.join(', ')} placeholder="452001, 452010, 452016" />)}</Field>
              </div>
              <Field label={t("Or deliver within (km)")} hint={t("Measured from your branch map pin.")}>{(id, h) => <Input id={id} aria-describedby={h} name="radius" type="number" step="0.1" min={0.1} max={100} defaultValue={s.deliveryRadiusKm ?? ''} />}</Field>
            </div>
            <p className="mt-3 text-xs text-slate-500">{t("The radius needs a map pin on your branch -")}{' '}<Link className="underline" href="/setup/locations">{t("Branches & location")}</Link>.</p>
          </Card>
        )}
        <Card title={t("Timing & rules")}>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={t("Usual preparation time (min)")} hint={t("Shown to customers as an estimate.")}>{(id, h) => <Input id={id} aria-describedby={h} name="prep" type="number" min={1} max={600} defaultValue={s.prepTimeMinutes} />}</Field>
            <Field label={t("Bill valid for (min)")} hint={t("If the customer waits longer to confirm, the bill is recalculated.")}>{(id, h) => <Input id={id} aria-describedby={h} name="quoteTtl" type="number" min={1} max={120} defaultValue={s.quoteTtlMinutes} />}</Field>
            <Field label={t("Order ahead up to (days)")}>{(id) => <Input id={id} name="maxDays" type="number" min={0} max={30} defaultValue={s.maxScheduleDays} />}</Field>
          </div>
          <div className="mt-3 space-y-2 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" name="scheduling" defaultChecked={s.schedulingEnabled} /> {t("Allow scheduled orders (for a later time)")}</label>
            <label className="flex items-center gap-2"><input type="checkbox" name="autoCancel" defaultChecked={s.autoCancelBeforeAccept} /> {t("Customers can cancel on WhatsApp until you accept the order")}</label>
          </div>
          <p className="mt-3 text-xs text-slate-500">{t("Opening hours for orders come from")}{' '}<Link className="underline" href="/settings/business">{t("Settings → Business hours")}</Link>{t("; holidays from")}{' '}<Link className="underline" href="/setup/availability">{t("Timings & holidays")}</Link>.</p>
        </Card>
        <BillPreview />
        {(local || save.isError) && <Notice tone="error">{local ?? friendlyMessage(save.error)}</Notice>}
        {saved && <Notice tone="success">{t("Saved. New bills use these settings immediately.")}</Notice>}
        {editable && <Button type="submit" loading={save.isPending}>{t("Save ordering settings")}</Button>}
      </fieldset>
    </form>
  );
}

function BillPreview() {
  return (
    <p className="text-xs text-slate-500">
      {t("Bill order: items → coupon discount → packaging → GST on (items − discount + packaging) → delivery fee. Example for a")}{' '}{rupees(50000)} {t("order with 5% GST and")}{' '}{rupees(2000)} {t("packaging: GST")}{' '}{rupees(2600)}.
    </p>
  );
}
