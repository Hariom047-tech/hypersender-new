import type { Totals } from './pricing.js';

/*
 * Ready-to-send WhatsApp layouts for menu, cart, bill and order receipt.
 *
 * Why server-side: prices and alignment must never depend on the model. Tools
 * return a `display` string and the platform rules make the assistant send it
 * verbatim (it may only add one short sentence around it).
 *
 * Bill/cart use a WhatsApp monospace block (```...```) laid out like a thermal
 * POS receipt, WIDTH characters wide so it never wraps inside a chat bubble on
 * a phone. The ₹ sign is kept OUTSIDE the monospace block: many phone fonts
 * render it with a different width, which would break column alignment.
 */

export const WIDTH = 28;
const RULE = '-'.repeat(WIDTH);
const DOUBLE = '='.repeat(WIDTH);
/** WhatsApp messages are cut at 4096 chars; replies are clipped at 4000. Leave room for the assistant's sentence. */
const MAX_DISPLAY = 3200;

const SYMBOL: Record<string, string> = { INR: '₹', USD: '$', EUR: '€', GBP: '£', AED: 'AED ' };
const sym = (currency: string) => SYMBOL[currency] ?? `${currency} `;

/** 123456 -> "1,234.56" (Indian grouping for INR); always two decimals, like a printed bill. */
export function amount(minor: number, currency = 'INR'): string {
  const v = Math.abs(minor) / 100;
  const s = new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
  return minor < 0 ? `-${s}` : s;
}
/** Shelf price for menus: "₹199" or "₹199.50". */
export function price(minor: number, currency = 'INR'): string {
  const v = minor / 100;
  return `${sym(currency)}${new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en', { maximumFractionDigits: minor % 100 === 0 ? 0 : 2, minimumFractionDigits: minor % 100 === 0 ? 0 : 2 }).format(v)}`;
}

/** Monospace-safe text: strip characters that break a ``` block or column widths. */
const clean = (s: string) => s.replace(/`/g, "'").replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '').replace(/\s+/g, ' ').trim();

/** Word-wrap into lines of at most `w` characters (hard-splits very long words). */
function wrap(text: string, w: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const word of clean(text).split(' ')) {
    let wd = word;
    while (wd.length > w) { if (cur) { out.push(cur); cur = ''; } out.push(wd.slice(0, w)); wd = wd.slice(w); }
    if (!cur) cur = wd;
    else if (cur.length + 1 + wd.length <= w) cur += ` ${wd}`;
    else { out.push(cur); cur = wd; }
  }
  if (cur) out.push(cur);
  return out.length ? out : [''];
}

/** "label ........ value" on one line; wraps the label if needed, value always right-aligned on the last line. */
function row(label: string, value: string, indent = ''): string[] {
  const lines = wrap(label, WIDTH - indent.length).map((l) => indent + l);
  const last = lines[lines.length - 1];
  if (last.length + 1 + value.length <= WIDTH) lines[lines.length - 1] = last + ' '.repeat(WIDTH - last.length - value.length) + value;
  else lines.push(value.padStart(WIDTH));
  return lines;
}

function itemRows(t: Totals): string[] {
  const out: string[] = [];
  for (const l of t.lines) {
    const title = `${l.quantity} x ${l.name}${l.variantName ? ` (${l.variantName})` : ''}`;
    out.push(...row(title, amount(l.lineTotalMinor, t.currency)));
    if (l.quantity > 1) out.push(`   @ ${amount(l.unitPriceMinor, t.currency)} each`);
    for (const m of l.modifiers) {
      const name = m.kind === 'REMOVE' ? `No ${m.name.replace(/^no\s+/i, '')}` : `+ ${m.name}`;
      out.push(...wrap(name, WIDTH - 3).map((x) => `   ${x}`));
    }
    if (l.specialInstructions) out.push(...wrap(`Note: ${l.specialInstructions}`, WIDTH - 3).map((x) => `   ${x}`));
    if (!l.available) out.push('   ** NOT AVAILABLE NOW **');
  }
  return out;
}

const block = (lines: string[]) => ['```', ...lines, '```'].join('\n');
const itemCount = (t: Totals) => t.lines.reduce((n, l) => n + l.quantity, 0);

/** Cart after add/change and "bill?" before checkout: a running bill (delivery fee is added once the address is known). */
export function renderCart(t: Totals, c: { taxRateBps: number; mode: string | null; deliveryKnown: boolean }): string {
  if (t.lines.length === 0) return '🛒 *Your cart is empty*';
  const n = itemCount(t);
  const lines = billRows(t, { restaurant: '', taxRateBps: c.taxRateBps, mode: c.mode === 'DELIVERY' && c.deliveryKnown ? 'DELIVERY' : null });
  if (c.mode === 'DELIVERY' && !c.deliveryKnown) lines.splice(lines.length - 3, 0, ...row('Delivery fee', 'at checkout'));
  return [`🛒 *Your cart* · ${n} item${n === 1 ? '' : 's'}`, block(lines), `💰 *Total: ${price(t.totalMinor, t.currency)}*`].join('\n');
}

export interface BillContext {
  restaurant: string;
  taxRateBps: number;
  mode: string | null;                 // DELIVERY | PICKUP | DINE_IN
  address?: string | null;
  scheduled?: string | null;           // already localised, e.g. "28 Sep, 19:30"
  payment?: string | null;             // label, e.g. "Cash on Delivery"
  customerName?: string | null;
  orderNumber?: number | null;
  prepMinutes?: number | null;
}
const MODE_LINE: Record<string, string> = { DELIVERY: '🛵 Home delivery', PICKUP: '🥡 Pickup / takeaway', DINE_IN: '🍽️ Dine-in' };

function billRows(t: Totals, c: BillContext): string[] {
  const pct = `${c.taxRateBps / 100}%`;
  const lines = [...itemRows(t), RULE, ...row('Item total', amount(t.subtotalMinor, t.currency))];
  if (t.discountMinor) lines.push(...row(`Discount${t.coupon?.applied ? ` (${t.coupon.code})` : ''}`, amount(-t.discountMinor, t.currency)));
  if (t.packagingMinor) lines.push(...row('Packaging', amount(t.packagingMinor, t.currency)));
  if (t.taxMinor) lines.push(...row(`GST ${pct}`, amount(t.taxMinor, t.currency)));
  else if (t.taxInclusive && c.taxRateBps) lines.push(...row(`GST ${pct}`, 'incl.'));
  if (c.mode === 'DELIVERY') lines.push(...row('Delivery fee', t.deliveryFeeMinor ? amount(t.deliveryFeeMinor, t.currency) : 'FREE'));
  lines.push(DOUBLE, ...row('TO PAY', amount(t.totalMinor, t.currency)), DOUBLE);
  return lines;
}

/** Final bill before confirmation (the customer confirms exactly this). */
export function renderBill(t: Totals, c: BillContext): string {
  const n = itemCount(t);
  const head = [`🧾 *${c.restaurant}* · Bill`, `${n} item${n === 1 ? '' : 's'} · amounts in ${sym(t.currency).trim()}`];
  const foot: string[] = [`💰 *Total to pay: ${price(t.totalMinor, t.currency)}*`];
  if (c.mode) foot.push(`${MODE_LINE[c.mode] ?? c.mode}${c.scheduled ? ` · ⏰ ${c.scheduled}` : ''}`);
  if (c.mode === 'DELIVERY' && c.address) foot.push(`📍 ${c.address}`);
  if (c.payment) foot.push(`💵 ${c.payment}`);
  if (c.customerName) foot.push(`👤 ${c.customerName}`);
  return [...head, block(billRows(t, c)), ...foot].join('\n');
}

/** Receipt after the order is placed (status: waiting for the restaurant). */
export function renderReceipt(t: Totals, c: BillContext): string {
  const lines = [`✅ *Order placed · #${c.orderNumber}*`, `🧾 ${c.restaurant}`, block(billRows(t, c)), `💰 *Total: ${price(t.totalMinor, t.currency)}*`];
  if (c.mode) lines.push(`${MODE_LINE[c.mode] ?? c.mode}${c.scheduled ? ` · ⏰ ${c.scheduled}` : ''}`);
  if (c.mode === 'DELIVERY' && c.address) lines.push(`📍 ${c.address}`);
  if (c.payment) lines.push(`💵 ${c.payment}`);
  lines.push('⏳ Status: waiting for the restaurant to accept');
  return lines.join('\n');
}

// ------------------------------------------------------------------- menu ---
export interface MenuDisplayItem {
  name: string; category: string | null; foodType: string; description?: string | null; basePriceMinor: number; currency: string;
  variants: Array<{ name: string; priceMinor: number; available: boolean }>; spiceLevel?: number | null; tags?: string[];
}
const FOOD_MARK: Record<string, string> = { VEG: '🟢', VEGAN: '🟢', NON_VEG: '🔴', EGG: '🟡' };
const CATEGORY_ICON: Array<[RegExp, string]> = [
  [/pizza/i, '🍕'], [/burger/i, '🍔'], [/biryani|rice|pulao/i, '🍛'], [/starter|appeti|snack|tikka|kebab/i, '🥙'], [/main|curry|sabzi|gravy/i, '🍲'],
  [/bread|roti|naan|paratha/i, '🫓'], [/chinese|noodle|momo/i, '🥡'], [/south|dosa|idli/i, '🥞'], [/dessert|sweet|ice/i, '🍨'], [/drink|beverage|juice|shake|coffee|tea|lassi/i, '🥤'],
  [/combo|thali|meal/i, '🍱'], [/salad/i, '🥗'], [/soup/i, '🍜'], [/sandwich|wrap|roll/i, '🌯'], [/pasta/i, '🍝'],
];
const catIcon = (name: string) => CATEGORY_ICON.find(([re]) => re.test(name))?.[1] ?? '🍽️';

function menuLine(i: MenuDisplayItem): string[] {
  const avail = i.variants.filter((v) => v.available);
  const from = avail.length ? Math.min(...avail.map((v) => v.priceMinor)) : i.basePriceMinor;
  const spice = i.spiceLevel && i.spiceLevel >= 3 ? ' 🌶️' : '';
  const out = [`${FOOD_MARK[i.foodType] ?? '•'} ${i.name}${spice} — ${avail.length > 1 ? 'from ' : ''}${price(from, i.currency)}`];
  if (avail.length > 1) out.push(`      _${avail.map((v) => `${v.name} ${price(v.priceMinor, i.currency)}`).join(' | ')}_`);
  return out;
}

function legend(items: MenuDisplayItem[]): string {
  const types = new Set(items.map((i) => (i.foodType === 'VEGAN' ? 'VEG' : i.foodType)));
  return [types.has('VEG') && '🟢 Veg', types.has('NON_VEG') && '🔴 Non-veg', types.has('EGG') && '🟡 Egg'].filter(Boolean).join('  ');
}

/**
 * Full menu grouped by category. If it would be too long for one WhatsApp
 * message, returns the category index instead (`compact: true`).
 */
export function renderMenu(items: MenuDisplayItem[], restaurant: string, title = 'Menu'): { display: string; compact: boolean } {
  if (items.length === 0) return { display: `🍽️ *${restaurant}*\nNo dishes are available right now.`, compact: false };
  const groups = new Map<string, MenuDisplayItem[]>();
  for (const i of items) { const k = i.category ?? 'Other'; groups.set(k, [...(groups.get(k) ?? []), i]); }
  const parts = [`🍽️ *${restaurant} — ${title}*`];
  for (const [cat, list] of groups) parts.push('', `*${catIcon(cat)} ${cat.toUpperCase()}*`, ...list.flatMap(menuLine));
  const lg = legend(items);
  if (lg) parts.push('', lg);
  const full = parts.join('\n');
  if (full.length <= MAX_DISPLAY) return { display: full, compact: false };
  const idx = [`🍽️ *${restaurant} — Menu*`, '', ...[...groups].map(([cat, list], n) => `${n + 1}. ${catIcon(cat)} *${cat}* (${list.length})`)];
  return { display: idx.join('\n'), compact: true };
}

/** A dish with its sizes and add-ons, for "what options are there?". */
export function renderDish(i: MenuDisplayItem, groups: Array<{ name: string; required: boolean; choose: string; modifiers: Array<{ name: string; kind: string; priceDeltaMinor: number }> }>,
  allergens: { list: string[]; verified: boolean }): string {
  const out = [`${FOOD_MARK[i.foodType] ?? '•'} *${i.name}*`];
  if (i.description) out.push(`_${i.description.slice(0, 200)}_`);
  const avail = i.variants.filter((v) => v.available);
  if (avail.length) out.push('', '*Sizes*', ...avail.map((v) => `• ${v.name} — ${price(v.priceMinor, i.currency)}`));
  else out.push(`Price: ${price(i.basePriceMinor, i.currency)}`);
  for (const g of groups) {
    if (!g.modifiers.length) continue;
    out.push('', `*${g.name}*${g.required ? ` (choose ${g.choose})` : ' (optional)'}`,
      ...g.modifiers.map((m) => `• ${m.kind === 'REMOVE' ? `No ${m.name.replace(/^no\s+/i, '')}` : m.name}${m.priceDeltaMinor ? ` +${price(m.priceDeltaMinor, i.currency)}` : ''}`));
  }
  if (allergens.list.length) out.push('', `⚠️ Allergens: ${allergens.list.join(', ')}${allergens.verified ? '' : ' (not verified by the kitchen)'}`);
  return out.join('\n');
}
