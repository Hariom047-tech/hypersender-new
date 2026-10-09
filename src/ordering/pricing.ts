/**
 * THE pricing engine. Pure and deterministic: all money is integer minor units
 * (paise). The assistant never computes totals; it only relays these values.
 *
 *   line unit   = variant price (or item base price) + sum(modifier deltas)
 *   line total  = unit x quantity
 *   subtotal    = sum(line totals)
 *   discount    = coupon (PERCENT capped by max_discount, or FLAT), never > subtotal,
 *                 only when subtotal >= coupon.min_order
 *   packaging   = per-order packaging fee (0 when cart is empty)
 *   delivery    = delivery fee for DELIVERY, 0 when subtotal >= free_delivery_above
 *   tax         = round_half_up((subtotal - discount + packaging) x rate), 0 when prices are tax-inclusive
 *   total       = subtotal - discount + packaging + delivery + tax
 */
export interface PriceLineInput {
  lineId: string;
  itemId?: string;
  name: string;
  variantName: string | null;
  basePriceMinor: number;
  modifiers: Array<{ id: string; name: string; kind: string; priceDeltaMinor: number }>;
  quantity: number;
  specialInstructions: string | null;
  available: boolean;
}

export interface PricingSettings {
  currency: string;
  taxRateBps: number;
  taxInclusive: boolean;
  packagingFeeMinor: number;
  deliveryFeeMinor: number | null;
  freeDeliveryAboveMinor: number | null;
}

export interface CouponRule { code: string; discountType: 'PERCENT' | 'FLAT'; discountValue: number; maxDiscountMinor: number | null; minOrderMinor: number }

export interface PricedLine { lineId: string; itemId?: string; name: string; variantName: string | null; modifiers: Array<{ name: string; kind: string; priceDeltaMinor: number }>;
  quantity: number; unitPriceMinor: number; lineTotalMinor: number; specialInstructions: string | null; available: boolean }

export interface Totals {
  currency: string;
  lines: PricedLine[];
  subtotalMinor: number;
  discountMinor: number;
  coupon: { code: string; applied: boolean; reason?: string } | null;
  packagingMinor: number;
  deliveryFeeMinor: number;
  taxMinor: number;
  taxInclusive: boolean;
  totalMinor: number;
}

const roundHalfUp = (x: number) => Math.floor(x + 0.5);

export function priceCart(lines: PriceLineInput[], s: PricingSettings, opts: { coupon?: CouponRule | null; delivery: boolean }): Totals {
  const priced: PricedLine[] = lines.map((l) => {
    const unit = l.basePriceMinor + l.modifiers.reduce((sum, m) => sum + m.priceDeltaMinor, 0);
    const unitPriceMinor = Math.max(0, unit);
    return { lineId: l.lineId, itemId: l.itemId, name: l.name, variantName: l.variantName, modifiers: l.modifiers.map(({ name, kind, priceDeltaMinor }) => ({ name, kind, priceDeltaMinor })),
      quantity: l.quantity, unitPriceMinor, lineTotalMinor: unitPriceMinor * l.quantity, specialInstructions: l.specialInstructions, available: l.available };
  });
  const subtotal = priced.reduce((sum, l) => sum + l.lineTotalMinor, 0);
  let discount = 0;
  let coupon: Totals['coupon'] = null;
  if (opts.coupon) {
    const c = opts.coupon;
    if (subtotal < c.minOrderMinor) {
      coupon = { code: c.code, applied: false, reason: `MIN_ORDER_${c.minOrderMinor}` };
    } else {
      discount = c.discountType === 'PERCENT' ? roundHalfUp((subtotal * c.discountValue) / 10_000) : c.discountValue;
      if (c.maxDiscountMinor !== null) discount = Math.min(discount, c.maxDiscountMinor);
      discount = Math.min(discount, subtotal);
      coupon = { code: c.code, applied: true };
    }
  }
  const packaging = priced.length ? s.packagingFeeMinor : 0;
  const delivery = opts.delivery && priced.length
    ? (s.freeDeliveryAboveMinor !== null && subtotal >= s.freeDeliveryAboveMinor ? 0 : (s.deliveryFeeMinor ?? 0))
    : 0;
  const taxable = subtotal - discount + packaging;
  const tax = s.taxInclusive ? 0 : roundHalfUp((taxable * s.taxRateBps) / 10_000);
  return { currency: s.currency, lines: priced, subtotalMinor: subtotal, discountMinor: discount, coupon, packagingMinor: packaging,
    deliveryFeeMinor: delivery, taxMinor: tax, taxInclusive: s.taxInclusive, totalMinor: subtotal - discount + packaging + delivery + tax };
}

export function formatMoney(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en', { style: 'currency', currency, maximumFractionDigits: minor % 100 === 0 ? 0 : 2 }).format(minor / 100);
  } catch {
    return `${currency} ${(minor / 100).toFixed(2)}`;
  }
}

/** Customer-facing bill text built only from backend totals. */
export function billText(t: Totals): string {
  const m = (x: number) => formatMoney(x, t.currency);
  const lines = t.lines.map((l) => {
    const mods = l.modifiers.map((x) => `${x.kind === 'REMOVE' ? '-' : '+'} ${x.name}`);
    const extra = [...mods, ...(l.specialInstructions ? [`note: ${l.specialInstructions}`] : [])];
    return `${l.quantity} x ${l.name}${l.variantName ? ` (${l.variantName})` : ''} - ${m(l.lineTotalMinor)}${extra.length ? `\n   ${extra.join(', ')}` : ''}`;
  });
  const rows = [`Subtotal: ${m(t.subtotalMinor)}`];
  if (t.discountMinor) rows.push(`Discount${t.coupon ? ` (${t.coupon.code})` : ''}: -${m(t.discountMinor)}`);
  if (t.packagingMinor) rows.push(`Packaging: ${m(t.packagingMinor)}`);
  if (t.deliveryFeeMinor) rows.push(`Delivery: ${m(t.deliveryFeeMinor)}`);
  if (t.taxMinor) rows.push(`Taxes: ${m(t.taxMinor)}`);
  rows.push(`Total: ${m(t.totalMinor)}`);
  return [...lines, '', ...rows].join('\n');
}
