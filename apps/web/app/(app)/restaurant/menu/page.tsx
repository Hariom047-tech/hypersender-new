'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type FormEvent } from 'react';
import { Drawer, fromMinor, rupees, toMinor, useSetupBusiness } from '@/components/setup/common';
import { Button, ConfirmDialog, EmptyState, ErrorState, Field, Input, LoadingSkeleton, Notice, PageHeader, Select, StatusBadge, Tabs, Textarea, cx } from '@/components/ui';
import { api, friendlyMessage } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';
import { t, msg } from '@/lib/i18n';

interface Category { id: string; name: string; description: string | null; displayOrder: number; active: boolean }
interface Variant { id?: string; name: string; priceMinor: number; isDefault: boolean; available: boolean }
interface Item {
  id: string; categoryId: string | null; name: string; description: string | null; foodType: 'VEG' | 'NON_VEG' | 'EGG' | 'VEGAN'; basePriceMinor: number; currency: string;
  available: boolean; spiceLevel: number | null; allergens: string[]; allergenVerified: boolean; tags: string[]; prepMinutes: number | null; displayOrder: number;
  variants: Variant[]; modifierGroupIds: string[];
}
interface Modifier { id?: string; name: string; kind: 'ADD' | 'REMOVE' | 'CHOICE'; priceDeltaMinor: number; available: boolean }
interface Group { id: string; name: string; minSelect: number; maxSelect: number; modifiers: Modifier[] }
interface Menu { categories: Category[]; items: Item[]; modifierGroups: Group[] }

const FOOD: Record<Item['foodType'], { label: string; cls: string }> = {
  VEG: { label: msg("Veg"), cls: 'border-green-700 text-green-700' }, NON_VEG: { label: msg("Non-veg"), cls: 'border-red-700 text-red-700' },
  EGG: { label: msg("Egg"), cls: 'border-amber-600 text-amber-700' }, VEGAN: { label: msg("Vegan"), cls: 'border-emerald-600 text-emerald-700' },
};
function FoodMark({ type }: { type: Item['foodType'] }) {
  const f = FOOD[type];
  return <span title={f.label} className={cx('inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border-2', f.cls)}><span className="h-1.5 w-1.5 rounded-full bg-current" /><span className="sr-only">{f.label}</span></span>;
}
const splitList = (v: FormDataEntryValue | null) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/** Menu editor: categories, dishes (sizes, add-ons, veg/non-veg, allergens), sold-out toggle. */
export default function MenuPage() {
  const { role } = useWorkspace();
  const { bid, orgId, picker, missing, currency } = useSetupBusiness();
  const qc = useQueryClient();
  const manager = ['OWNER', 'ADMIN', 'MANAGER'].includes(role ?? '');
  const staff = manager || role === 'AGENT';
  const [tab, setTab] = useState<'dishes' | 'addons' | 'categories'>('dishes');
  const [filter, setFilter] = useState('');
  const [dish, setDish] = useState<Item | 'new' | null>(null);
  const [group, setGroup] = useState<Group | 'new' | null>(null);
  const [category, setCategory] = useState<Category | 'new' | null>(null);
  const [removing, setRemoving] = useState<{ kind: 'items' | 'modifier-groups' | 'categories'; id: string; name: string } | null>(null);
  const key = ['org', orgId, 'setup', bid, 'menu'];
  const q = useQuery({ queryKey: key, enabled: Boolean(bid), queryFn: () => api<Menu>(`/v1/businesses/${bid}/menu`) });
  const refresh = () => void qc.invalidateQueries({ queryKey: key });
  const save = useMutation({
    mutationFn: (p: { path: string; id?: string; body: object }) => api(`/v1/businesses/${bid}/menu/${p.path}${p.id ? `/${p.id}` : ''}`, { method: p.id ? 'PATCH' : 'POST', body: p.body }),
    onSuccess: () => { setDish(null); setGroup(null); setCategory(null); refresh(); },
  });
  const toggle = useMutation({ mutationFn: (p: { id: string; available: boolean }) => api(`/v1/businesses/${bid}/menu/items/${p.id}/availability`, { method: 'POST', body: { available: p.available } }),
    onSuccess: refresh });
  const del = useMutation({ mutationFn: (r: { kind: string; id: string }) => api(`/v1/businesses/${bid}/menu/${r.kind}/${r.id}`, { method: 'DELETE' }),
    onSuccess: () => { setRemoving(null); refresh(); } });
  const menu = q.data;
  const grouped = useMemo(() => {
    if (!menu) return [];
    const f = filter.trim().toLowerCase();
    const items = menu.items.filter((i) => !f || i.name.toLowerCase().includes(f) || i.tags.some((t) => t.toLowerCase().includes(f)));
    const sections = menu.categories.map((c) => ({ id: c.id, name: c.name, items: items.filter((i) => i.categoryId === c.id) }));
    const loose = items.filter((i) => !i.categoryId || !menu.categories.some((c) => c.id === i.categoryId));
    if (loose.length) sections.push({ id: 'none', name: t('No category'), items: loose });
    return sections.filter((s) => s.items.length || !f);
  }, [menu, filter]);
  if (missing) return <><PageHeader title={t("Menu")} />{missing}</>;
  const soldOut = menu?.items.filter((i) => !i.available).length ?? 0;
  const openNew = () => { save.reset(); if (tab === 'dishes') setDish('new'); else if (tab === 'addons') setGroup('new'); else setCategory('new'); };
  return (
    <>
      <PageHeader title={t("Menu")} description={t("Everything the assistant can sell. Prices here are the only prices it will ever quote.")}
        actions={<div className="flex items-center gap-3">{picker}{manager && <Button onClick={openNew}>{t("+ Add")}{' '}{tab === 'dishes' ? t("dish") : tab === 'addons' ? t("add-on group") : t("category")}</Button>}</div>} />
      <Tabs label={t("Menu sections")} value={tab} onChange={setTab} tabs={[
        { id: 'dishes', label: `Dishes${menu ? ` (${menu.items.length})` : ''}` }, { id: 'addons', label: t("Add-ons & choices") }, { id: 'categories', label: t("Categories") }]} />
      <div className="mt-4">
        {q.isLoading ? <LoadingSkeleton rows={6} /> : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !menu ? null : tab === 'dishes' ? (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <Input className="max-w-xs" aria-label={t("Search dishes")} placeholder={t("Search dishes…")} value={filter} onChange={(e) => setFilter(e.target.value)} />
              {soldOut > 0 && <StatusBadge tone="amber">{soldOut} {t("sold out")}</StatusBadge>}
              {menu.categories.length === 0 && manager && <span className="text-sm text-slate-600">{t("Tip: add categories first (Starters, Main course, Drinks…).")}</span>}
            </div>
            {menu.items.length === 0 ? <EmptyState title={t("Your menu is empty")} body={t("Add dishes with prices so customers can order on WhatsApp.")} action={manager ? <Button onClick={() => setDish('new')}>{t("+ Add first dish")}</Button> : undefined} /> : (
              <div className="space-y-6">
                {grouped.map((s) => (
                  <section key={s.id} aria-labelledby={`cat-${s.id}`}>
                    <h2 id={`cat-${s.id}`} className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">{s.name} <span className="font-normal">({s.items.length})</span></h2>
                    {s.items.length === 0 ? <p className="text-sm text-slate-500">{t("No dishes.")}</p> : (
                      <ul className="divide-y divide-slate-100 rounded-lg bg-white ring-1 ring-slate-200">
                        {s.items.map((i) => (
                          <li key={i.id} className={cx('flex flex-wrap items-center gap-3 px-4 py-3', !i.available && 'bg-slate-50')}>
                            <FoodMark type={i.foodType} />
                            <button type="button" disabled={!manager} onClick={() => { save.reset(); setDish(i); }} className="min-w-0 flex-1 text-left disabled:cursor-default">
                              <span className={cx('block font-medium', !i.available && 'text-slate-500 line-through')}>{i.name}</span>
                              <span className="block truncate text-xs text-slate-500">
                                {i.variants.length ? i.variants.map((v) => `${v.name} ${rupees(v.priceMinor, i.currency)}`).join(' · ') : rupees(i.basePriceMinor, i.currency)}
                                {i.modifierGroupIds.length > 0 && (i.modifierGroupIds.length > 1 ? t(" · {n} add-on groups", { n: i.modifierGroupIds.length }) : t(" · {n} add-on group", { n: 1 }))}
                                {i.description && ` · ${i.description}`}
                              </span>
                            </button>
                            {i.spiceLevel ? <span className="text-xs" title={t("Spice {spiceLevel}/5", { spiceLevel: i.spiceLevel })}>{'🌶️'.repeat(Math.min(3, i.spiceLevel))}</span> : null}
                            {staff && (
                              <label className="flex items-center gap-2 text-xs text-slate-700">
                                <input type="checkbox" role="switch" checked={i.available} disabled={toggle.isPending} onChange={(e) => toggle.mutate({ id: i.id, available: e.target.checked })} />
                                {i.available ? t("Available") : t("Sold out")}
                              </label>
                            )}
                            {manager && <Button size="sm" variant="ghost" onClick={() => setRemoving({ kind: 'items', id: i.id, name: i.name })}>{t("Delete")}</Button>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                ))}
              </div>
            )}
          </>
        ) : tab === 'addons' ? (
          menu.modifierGroups.length === 0 ? <EmptyState title={t("No add-ons yet")} body={t("Create groups like “Extra toppings” (+₹30 cheese), “Crust” (choose 1) or “Remove” (no onion) and attach them to dishes.")} /> : (
            <ul className="grid gap-3 md:grid-cols-2">
              {menu.modifierGroups.map((g) => (
                <li key={g.id} className="rounded-lg bg-white p-4 ring-1 ring-slate-200">
                  <div className="flex items-start justify-between gap-2">
                    <div><p className="font-medium">{g.name}</p><p className="text-xs text-slate-500">{g.minSelect > 0 ? t("Pick {maxSelect} (required)", { maxSelect: g.minSelect === g.maxSelect ? g.minSelect : `${g.minSelect}-${g.maxSelect}` }) : t("Optional, up to {maxSelect}", { maxSelect: g.maxSelect })} {t("· used by")}{' '}{menu.items.filter((i) => i.modifierGroupIds.includes(g.id)).length} {t("dishes")}</p></div>
                    {manager && <div className="flex gap-1"><Button size="sm" variant="secondary" onClick={() => { save.reset(); setGroup(g); }}>{t("Edit")}</Button><Button size="sm" variant="ghost" onClick={() => setRemoving({ kind: 'modifier-groups', id: g.id, name: g.name })}>{t("Delete")}</Button></div>}
                  </div>
                  <ul className="mt-2 flex flex-wrap gap-1.5">{g.modifiers.map((m) => <li key={m.id} className="rounded-full bg-slate-100 px-2 py-0.5 text-xs">{m.kind === 'REMOVE' ? t("No {item}", { item: m.name }) : m.name}{m.priceDeltaMinor ? ` +${rupees(m.priceDeltaMinor, currency)}` : ''}</li>)}</ul>
                </li>
              ))}
            </ul>
          )
        ) : (
          menu.categories.length === 0 ? <EmptyState title={t("No categories")} body={t("Categories help customers browse: Starters, Pizza, Main course, Desserts, Drinks.")} /> : (
            <ul className="divide-y divide-slate-100 rounded-lg bg-white ring-1 ring-slate-200">
              {menu.categories.map((c) => (
                <li key={c.id} className="flex items-center gap-3 px-4 py-3">
                  <span className="w-10 text-xs text-slate-500">#{c.displayOrder}</span>
                  <span className="flex-1"><span className="font-medium">{c.name}</span> {!c.active && <StatusBadge tone="slate">{t("Hidden")}</StatusBadge>}
                    <span className="block text-xs text-slate-500">{menu.items.filter((i) => i.categoryId === c.id).length} {t("dishes")}{c.description ? ` · ${c.description}` : ''}</span></span>
                  {manager && <><Button size="sm" variant="secondary" onClick={() => { save.reset(); setCategory(c); }}>{t("Edit")}</Button><Button size="sm" variant="ghost" onClick={() => setRemoving({ kind: 'categories', id: c.id, name: c.name })}>{t("Delete")}</Button></>}
                </li>
              ))}
            </ul>
          )
        )}
      </div>
      {toggle.isError && <div className="mt-3"><Notice tone="error">{friendlyMessage(toggle.error)}</Notice></div>}

      {dish && menu && <DishDrawer dish={dish === 'new' ? null : dish} menu={menu} currency={currency} busy={save.isPending} error={save.isError ? friendlyMessage(save.error) : null}
        onClose={() => setDish(null)} onSave={(body) => save.mutate({ path: 'items', id: dish === 'new' ? undefined : dish.id, body })} />}
      {group && <GroupDrawer group={group === 'new' ? null : group} currency={currency} busy={save.isPending} error={save.isError ? friendlyMessage(save.error) : null}
        onClose={() => setGroup(null)} onSave={(body) => save.mutate({ path: 'modifier-groups', id: group === 'new' ? undefined : group.id, body })} />}
      {category && (
        <Drawer title={category === 'new' ? t("Add category") : t("Edit {name}", { name: category.name })} onClose={() => setCategory(null)} busy={save.isPending} error={save.isError ? friendlyMessage(save.error) : null}
          onSubmit={(e) => { const f = new FormData(e.currentTarget); save.mutate({ path: 'categories', id: category === 'new' ? undefined : category.id,
            body: { name: f.get('name'), description: f.get('description') || null, displayOrder: Number(f.get('displayOrder') || 100), active: f.get('active') === 'on' } }); }}>
          {(() => { const c = category === 'new' ? null : category; return (<>
            <Field label={t("Name")}>{(id) => <Input id={id} name="name" required maxLength={100} defaultValue={c?.name} placeholder={t("Pizza")} />}</Field>
            <Field label={t("Description (optional)")}>{(id) => <Input id={id} name="description" maxLength={500} defaultValue={c?.description ?? ''} />}</Field>
            <Field label={t("Position")} hint={t("Lower numbers are shown first.")}>{(id, h) => <Input id={id} aria-describedby={h} name="displayOrder" type="number" min={0} max={10000} defaultValue={c?.displayOrder ?? (menu?.categories.length ?? 0) * 10 + 10} />}</Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="active" defaultChecked={c?.active ?? true} /> {t("Show to customers")}</label>
          </>); })()}
        </Drawer>
      )}
      <ConfirmDialog open={Boolean(removing)} title={t("Delete “{name}”?", { name: removing?.name })} confirmLabel={t("Delete")} busy={del.isPending}
        body={removing?.kind === 'categories' ? t("Dishes in this category stay on the menu without a category.") : removing?.kind === 'modifier-groups' ? t("It is removed from every dish that uses it.") : t("Customers can no longer order it. Past orders keep their details.")}
        onClose={() => { setRemoving(null); del.reset(); }} onConfirm={() => removing && del.mutate(removing)} />
      {del.isError && <div className="mt-3"><Notice tone="error">{friendlyMessage(del.error)}</Notice></div>}
    </>
  );
}

function DishDrawer({ dish, menu, currency, busy, error, onClose, onSave }: {
  dish: Item | null; menu: Menu; currency: string; busy: boolean; error: string | null; onClose: () => void; onSave: (body: object) => void;
}) {
  const [sizes, setSizes] = useState<Array<{ id?: string; name: string; price: string; isDefault: boolean; available: boolean }>>(
    () => (dish?.variants ?? []).map((v) => ({ id: v.id, name: v.name, price: fromMinor(v.priceMinor), isDefault: v.isDefault, available: v.available })));
  const [local, setLocal] = useState<string | null>(null);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    setLocal(null);
    const f = new FormData(e.currentTarget);
    const base = toMinor(f.get('price'));
    const variants = sizes.filter((s) => s.name.trim()).map((s) => ({ id: s.id, name: s.name.trim(), priceMinor: toMinor(s.price), isDefault: s.isDefault, available: s.available }));
    if (variants.some((v) => v.priceMinor === null || Number.isNaN(v.priceMinor))) return setLocal(t("Every size needs a price."));
    if (!variants.length && (base === null || Number.isNaN(base))) return setLocal(t("Enter a price."));
    if (variants.length && !variants.some((v) => v.isDefault)) variants[0].isDefault = true;
    const opt = (k: string) => (f.get(k) === '' || f.get(k) === null ? null : Number(f.get(k)));
    onSave({ name: f.get('name'), categoryId: f.get('categoryId') || null, description: f.get('description') || null, foodType: f.get('foodType'),
      basePriceMinor: variants.length ? undefined : base, variants, available: f.get('available') === 'on', spiceLevel: opt('spiceLevel'), prepMinutes: opt('prepMinutes'),
      allergens: splitList(f.get('allergens')), allergenVerified: f.get('allergenVerified') === 'on', tags: splitList(f.get('tags')),
      modifierGroupIds: f.getAll('modifierGroupIds').map(String), displayOrder: Number(f.get('displayOrder') || 100) });
  };
  return (
    <Drawer wide title={dish ? t("Edit {name}", { name: dish.name }) : t("Add dish")} onClose={onClose} onSubmit={submit} busy={busy} error={local ?? error}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2"><Field label={t("Dish name")}>{(id) => <Input id={id} name="name" required maxLength={150} defaultValue={dish?.name} placeholder={t("Paneer Tikka Pizza")} />}</Field></div>
        <Field label={t("Category")}>{(id) => <Select id={id} name="categoryId" defaultValue={dish?.categoryId ?? menu.categories[0]?.id ?? ''}><option value="">{t("No category")}</option>{menu.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}</Field>
        <Field label={t("Type")}>{(id) => <Select id={id} name="foodType" defaultValue={dish?.foodType ?? 'VEG'}><option value="VEG">{t("🟢 Veg")}</option><option value="NON_VEG">{t("🔴 Non-veg")}</option><option value="EGG">{t("🟡 Contains egg")}</option><option value="VEGAN">{t("🌱 Vegan")}</option></Select>}</Field>
        <div className="sm:col-span-2"><Field label={t("Description (optional)")}>{(id) => <Textarea id={id} name="description" rows={2} maxLength={1000} defaultValue={dish?.description ?? ''} placeholder={t("Tandoori paneer, capsicum, onion, mozzarella")} />}</Field></div>
      </div>
      <fieldset className="rounded-lg p-3 ring-1 ring-slate-200">
        <legend className="px-1 text-sm font-medium">{t("Price & sizes")}</legend>
        {sizes.length === 0 ? (
          <Field label={t("Price ({currency})", { currency: currency })}>{(id) => <Input id={id} name="price" inputMode="decimal" defaultValue={fromMinor(dish?.basePriceMinor)} placeholder="249" />}</Field>
        ) : (
          <ul className="space-y-2">
            {sizes.map((s, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2">
                <Input aria-label={t("Size {i1} name", { i1: i + 1 })} className="w-36" value={s.name} maxLength={60} placeholder={t("Medium")} onChange={(e) => setSizes(sizes.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                <Input aria-label={t("Size {i1} price", { i1: i + 1 })} className="w-28" inputMode="decimal" value={s.price} placeholder="349" onChange={(e) => setSizes(sizes.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))} />
                <label className="flex items-center gap-1 text-xs"><input type="radio" name="defaultSize" checked={s.isDefault} onChange={() => setSizes(sizes.map((x, j) => ({ ...x, isDefault: j === i })))} /> {t("Default")}</label>
                <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={s.available} onChange={(e) => setSizes(sizes.map((x, j) => (j === i ? { ...x, available: e.target.checked } : x)))} /> {t("Available")}</label>
                <button type="button" className="text-xs text-red-700 underline" onClick={() => setSizes(sizes.filter((_, j) => j !== i))}>{t("Remove")}</button>
              </li>
            ))}
          </ul>
        )}
        {sizes.length < 10 && <button type="button" className="mt-2 text-xs font-medium text-emerald-800 underline"
          onClick={() => setSizes(sizes.length ? [...sizes, { name: '', price: '', isDefault: false, available: true }]
            : [{ name: t('Regular'), price: fromMinor(dish?.basePriceMinor), isDefault: true, available: true }, { name: '', price: '', isDefault: false, available: true }])}>
          {sizes.length ? t("+ Add size") : t("+ Has sizes (Small / Medium / Large, Half / Full)")}</button>}
      </fieldset>
      <fieldset>
        <legend className="text-sm font-medium">{t("Add-ons & choices")}</legend>
        {menu.modifierGroups.length === 0 ? <p className="text-xs text-slate-500">{t("Create add-on groups in the “Add-ons & choices” tab, then tick them here.")}</p> : (
          <div className="mt-1 grid grid-cols-2 gap-2">{menu.modifierGroups.map((g) => (
            <label key={g.id} className="flex items-center gap-2 text-sm"><input type="checkbox" name="modifierGroupIds" value={g.id} defaultChecked={dish?.modifierGroupIds.includes(g.id)} />{g.name}</label>))}</div>
        )}
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={t("Spice (0-5)")}>{(id) => <Input id={id} name="spiceLevel" type="number" min={0} max={5} defaultValue={dish?.spiceLevel ?? ''} />}</Field>
        <Field label={t("Prep time (min)")}>{(id) => <Input id={id} name="prepMinutes" type="number" min={1} max={600} defaultValue={dish?.prepMinutes ?? ''} />}</Field>
        <Field label={t("Position")}>{(id) => <Input id={id} name="displayOrder" type="number" min={0} max={10000} defaultValue={dish?.displayOrder ?? 100} />}</Field>
      </div>
      <Field label={t("Allergens (comma separated)")} hint={t("e.g. milk, gluten, peanuts. The assistant only makes allergy claims if you tick “verified”.")}>{(id, h) => (
        <Input id={id} aria-describedby={h} name="allergens" defaultValue={dish?.allergens.join(', ')} />)}</Field>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="allergenVerified" defaultChecked={dish?.allergenVerified} /> {t("Allergen information is verified by the kitchen")}</label>
      <Field label={t("Tags (comma separated)")} hint={t("Helps search: bestseller, jain, spicy, kids.")}>{(id, h) => <Input id={id} aria-describedby={h} name="tags" defaultValue={dish?.tags.join(', ')} />}</Field>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="available" defaultChecked={dish?.available ?? true} /> {t("Available to order")}</label>
    </Drawer>
  );
}

function GroupDrawer({ group, currency, busy, error, onClose, onSave }: {
  group: Group | null; currency: string; busy: boolean; error: string | null; onClose: () => void; onSave: (body: object) => void;
}) {
  const [opts, setOpts] = useState<Array<{ id?: string; name: string; kind: Modifier['kind']; price: string; available: boolean }>>(
    () => (group?.modifiers.length ? group.modifiers.map((m) => ({ id: m.id, name: m.name, kind: m.kind, price: fromMinor(m.priceDeltaMinor), available: m.available }))
      : [{ name: '', kind: 'ADD', price: '', available: true }]));
  const [local, setLocal] = useState<string | null>(null);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    setLocal(null);
    const f = new FormData(e.currentTarget);
    const modifiers = opts.filter((o) => o.name.trim()).map((o) => ({ id: o.id, name: o.name.trim(), kind: o.kind, priceDeltaMinor: toMinor(o.price) ?? 0, available: o.available }));
    if (!modifiers.length) return setLocal(t("Add at least one option."));
    if (modifiers.some((m) => Number.isNaN(m.priceDeltaMinor))) return setLocal(t("Check the extra prices."));
    onSave({ name: f.get('name'), minSelect: Number(f.get('minSelect') || 0), maxSelect: Number(f.get('maxSelect') || 1), modifiers });
  };
  return (
    <Drawer wide title={group ? t("Edit {name}", { name: group.name }) : t("Add add-on group")} onClose={onClose} onSubmit={submit} busy={busy} error={local ?? error}>
      <Field label={t("Group name")}>{(id) => <Input id={id} name="name" required maxLength={60} defaultValue={group?.name} placeholder={t("Extra toppings")} />}</Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("Customer must pick at least")} hint={t("0 = optional. 1 = a required choice (e.g. crust).")}>{(id, h) => <Input id={id} aria-describedby={h} name="minSelect" type="number" min={0} max={20} defaultValue={group?.minSelect ?? 0} />}</Field>
        <Field label={t("Customer can pick at most")}>{(id) => <Input id={id} name="maxSelect" type="number" min={1} max={20} defaultValue={group?.maxSelect ?? 5} />}</Field>
      </div>
      <fieldset>
        <legend className="text-sm font-medium">{t("Options")}</legend>
        <ul className="mt-2 space-y-2">
          {opts.map((o, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2">
              <Input aria-label={t("Option {i1} name", { i1: i + 1 })} className="w-40" maxLength={60} value={o.name} placeholder={t("Extra cheese")} onChange={(e) => setOpts(opts.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              <Select aria-label={t("Option {i1} kind", { i1: i + 1 })} className="w-32" value={o.kind} onChange={(e) => setOpts(opts.map((x, j) => (j === i ? { ...x, kind: e.target.value as Modifier['kind'] } : x)))}>
                <option value="ADD">{t("Add-on")}</option><option value="CHOICE">{t("Choice")}</option><option value="REMOVE">{t("Remove (no …)")}</option></Select>
              <Input aria-label={t("Option {i1} extra price", { i1: i + 1 })} className="w-24" inputMode="decimal" value={o.price} placeholder={`+${currency === 'INR' ? '₹' : ''}0`} onChange={(e) => setOpts(opts.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))} />
              <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={o.available} onChange={(e) => setOpts(opts.map((x, j) => (j === i ? { ...x, available: e.target.checked } : x)))} /> {t("Available")}</label>
              {opts.length > 1 && <button type="button" className="text-xs text-red-700 underline" onClick={() => setOpts(opts.filter((_, j) => j !== i))}>{t("Remove")}</button>}
            </li>
          ))}
        </ul>
        {opts.length < 40 && <button type="button" className="mt-2 text-xs font-medium text-emerald-800 underline" onClick={() => setOpts([...opts, { name: '', kind: opts[opts.length - 1]?.kind ?? 'ADD', price: '', available: true }])}>{t("+ Add option")}</button>}
      </fieldset>
    </Drawer>
  );
}
