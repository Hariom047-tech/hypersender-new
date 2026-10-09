import { createHash } from 'node:crypto';
import type { Db } from '../database/transaction-runner.js';
import { OpsRepository } from '../repositories/ops.repository.js';
import { checkServiceability, isOpenAt, nextOpening, type WeeklyHours } from './geo-hours.js';
import { rankMenu } from './menu-match.js';
import { renderBill, renderCart, renderDish, renderMenu, renderReceipt } from './whatsapp-format.js';
import { formatMoney, priceCart, type CouponRule, type PriceLineInput, type Totals } from './pricing.js';

/*
 * Restaurant ordering domain (shared by the assistant tools - worker or
 * sandbox - and the owner dashboard). Every method runs inside the caller's
 * tenant transaction (RLS) and is scoped to ONE business. The cart is the
 * authoritative draft order; every mutation bumps cart.version, which
 * invalidates older checkout quotes.
 */

export type CartOwner = { contactId: string; testSessionId?: undefined } | { testSessionId: string; contactId?: undefined };
export interface Scope { businessId: string; owner: CartOwner; conversationId?: string | null }
export type OrderingError = { ok: false; errorCode: string; message?: string; [k: string]: unknown };
const err = (errorCode: string, message?: string, extra: Record<string, unknown> = {}): OrderingError => ({ ok: false, errorCode, ...(message ? { message } : {}), ...extra });

export interface OrderingSettings {
  enabled: boolean; fulfillmentModes: string[]; paymentMethods: string[]; currency: string; taxRateBps: number; taxInclusive: boolean;
  packagingFeeMinor: number; minOrderMinor: number; deliveryFeeMinor: number; freeDeliveryAboveMinor: number | null; deliveryPincodes: string[];
  deliveryRadiusKm: number | null; prepTimeMinutes: number; schedulingEnabled: boolean; maxScheduleDays: number; quoteTtlMinutes: number;
  autoCancelBeforeAccept: boolean;
}

export const PAYMENT_FOR_MODE: Record<string, string[]> = { DELIVERY: ['COD'], PICKUP: ['PAY_AT_PICKUP'], DINE_IN: ['PAY_AT_PICKUP'] };
export const PAYMENT_LABEL: Record<string, string> = { COD: 'Cash on delivery', PAY_AT_PICKUP: 'Pay at the counter', ONLINE: 'Online payment' };

interface MenuRow { id: string; name: string; description: string | null; category: string | null; categoryId: string | null; foodType: string; basePriceMinor: number;
  currency: string; available: boolean; allergens: string[]; allergenVerified: boolean; tags: string[]; spiceLevel: number | null;
  variants: Array<{ id: string; name: string; priceMinor: number; isDefault: boolean; available: boolean }> }

export class OrderingService {
  private readonly ops = new OpsRepository();

  // ------------------------------------------------------------ settings ---
  async settings(db: Db, businessId: string): Promise<OrderingSettings | null> {
    const r = (await db.query('SELECT * FROM app.ordering_settings WHERE business_id = $1', [businessId])).rows[0];
    if (!r) return null;
    return { enabled: r.enabled, fulfillmentModes: r.fulfillment_modes, paymentMethods: r.payment_methods.filter((p: string) => p !== 'ONLINE'), currency: r.currency,
      taxRateBps: r.tax_rate_bps, taxInclusive: r.tax_inclusive, packagingFeeMinor: Number(r.packaging_fee_minor), minOrderMinor: Number(r.min_order_minor),
      deliveryFeeMinor: Number(r.delivery_fee_minor), freeDeliveryAboveMinor: r.free_delivery_above_minor === null ? null : Number(r.free_delivery_above_minor),
      deliveryPincodes: r.delivery_pincodes, deliveryRadiusKm: r.delivery_radius_km === null ? null : Number(r.delivery_radius_km), prepTimeMinutes: r.prep_time_minutes,
      schedulingEnabled: r.scheduling_enabled, maxScheduleDays: r.max_schedule_days, quoteTtlMinutes: r.quote_ttl_minutes, autoCancelBeforeAccept: r.auto_cancel_before_accept };
  }

  async business(db: Db, businessId: string): Promise<{ name: string; timezone: string; hours: WeeklyHours; origin: { lat: number; lng: number } | null }> {
    const b = (await db.query(
      `SELECT b.name, b.timezone, b.business_hours,
              (SELECT json_build_object('lat', l.latitude, 'lng', l.longitude) FROM app.business_locations l
                WHERE l.business_id = b.id AND l.deleted_at IS NULL AND l.latitude IS NOT NULL ORDER BY l.is_primary DESC LIMIT 1) AS origin
         FROM app.businesses b WHERE b.id = $1`, [businessId])).rows[0];
    return { name: b.name, timezone: b.timezone, hours: b.business_hours ?? {}, origin: b.origin ? { lat: Number(b.origin.lat), lng: Number(b.origin.lng) } : null };
  }

  /** What the customer can do right now (modes, payment, open/closed, scheduling, delivery area summary). */
  async options(db: Db, businessId: string, now = new Date()) {
    const s = await this.settings(db, businessId);
    if (!s?.enabled) return err('ORDERING_NOT_AVAILABLE', 'This business does not take orders on WhatsApp.');
    const b = await this.business(db, businessId);
    const open = isOpenAt(b.hours, b.timezone, now);
    const next = open ? null : nextOpening(b.hours, b.timezone, now);
    return { ok: true as const, openNow: open, nextOpening: next?.toISOString() ?? null,
      fulfillmentModes: s.fulfillmentModes, paymentMethods: s.fulfillmentModes.flatMap((m) => PAYMENT_FOR_MODE[m]).filter((p, i, a) => a.indexOf(p) === i && s.paymentMethods.includes(p)),
      onlinePayment: 'NOT_AVAILABLE', minimumOrder: s.minOrderMinor ? formatMoney(s.minOrderMinor, s.currency) : null,
      delivery: s.fulfillmentModes.includes('DELIVERY') ? { fee: formatMoney(s.deliveryFeeMinor, s.currency),
        freeAbove: s.freeDeliveryAboveMinor !== null ? formatMoney(s.freeDeliveryAboveMinor, s.currency) : null,
        area: s.deliveryPincodes.length ? `pincodes ${s.deliveryPincodes.slice(0, 10).join(', ')}${s.deliveryPincodes.length > 10 ? '...' : ''}`
          : s.deliveryRadiusKm !== null ? `within ${s.deliveryRadiusKm} km` : 'not configured' } : null,
      scheduling: s.schedulingEnabled ? { enabled: true, maxDaysAhead: s.maxScheduleDays } : { enabled: false }, prepTimeMinutes: s.prepTimeMinutes };
  }

  // ---------------------------------------------------------------- menu ---
  async menu(db: Db, businessId: string): Promise<MenuRow[]> {
    const r = await db.query(
      `SELECT i.id, i.name, i.description, c.name AS category, i.category_id, i.food_type, i.base_price_minor, i.currency, i.available AND coalesce(c.active, true) AS available,
              i.allergens, i.allergen_info_verified, i.tags, i.spice_level,
              coalesce((SELECT json_agg(json_build_object('id', v.id, 'name', v.name, 'priceMinor', v.price_minor, 'isDefault', v.is_default, 'available', v.available)
                                        ORDER BY v.display_order, v.price_minor)
                          FROM app.menu_item_variants v WHERE v.item_id = i.id AND v.deleted_at IS NULL), '[]') AS variants
         FROM app.menu_items i LEFT JOIN app.menu_categories c ON c.id = i.category_id AND c.deleted_at IS NULL
        WHERE i.business_id = $1 AND i.deleted_at IS NULL
        ORDER BY coalesce(c.display_order, 1000), i.display_order, i.name LIMIT 1000`, [businessId]);
    return r.rows.map((x) => ({ id: x.id, name: x.name, description: x.description, category: x.category, categoryId: x.category_id, foodType: x.food_type,
      basePriceMinor: Number(x.base_price_minor), currency: x.currency, available: x.available, allergens: x.allergens, allergenVerified: x.allergen_info_verified,
      tags: x.tags, spiceLevel: x.spice_level, variants: x.variants.map((v: any) => ({ ...v, priceMinor: Number(v.priceMinor) })) }));
  }

  private itemCard(i: MenuRow) {
    const prices = i.variants.length ? i.variants.filter((v) => v.available).map((v) => ({ variantId: v.id, variant: v.name, price: formatMoney(v.priceMinor, i.currency) }))
      : [{ variantId: null, variant: null, price: formatMoney(i.basePriceMinor, i.currency) }];
    return { itemId: i.id, name: i.name, category: i.category, foodType: i.foodType, available: i.available, prices,
      description: i.description ? i.description.slice(0, 140) : null };
  }

  /** Browsing the menu works for every restaurant; `orderingAvailable` says whether WhatsApp orders are taken. */
  async searchMenu(db: Db, businessId: string, q: { query?: string; category?: string; foodType?: string; maxPriceMinor?: number; limit?: number }) {
    const s = await this.settings(db, businessId);
    const orderingAvailable = Boolean(s?.enabled);
    let items = await this.menu(db, businessId);
    if (q.foodType) items = items.filter((i) => (q.foodType === 'VEG' ? ['VEG', 'VEGAN'].includes(i.foodType) : i.foodType === q.foodType));
    if (q.maxPriceMinor !== undefined) items = items.filter((i) => Math.min(i.basePriceMinor, ...i.variants.map((v) => v.priceMinor)) <= q.maxPriceMinor!);
    if (q.category) {
      const ranked = rankMenu(q.category, items.map((i) => ({ ...i, name: i.category ?? '' })), 0.6);
      const ids = new Set(ranked.map((r) => r.id));
      items = items.filter((i) => ids.has(i.id));
    }
    if (!q.query) {
      const available = items.filter((i) => i.available);
      const restaurant = (await this.business(db, businessId)).name;
      const title = q.category ? (available[0]?.category ?? q.category) : q.foodType === 'VEG' ? 'Veg menu' : 'Menu';
      const menu = renderMenu(available, restaurant, title);
      const display = { display: menu.display, displayNote: menu.compact
        ? 'Menu is long: this shows the categories. Send it, then ask which category to show (call SEARCH_MENU with that category).'
        : 'Send display exactly as given, then one short line inviting the order (e.g. dish name + quantity).' };
      if (!q.category && !q.foodType && q.maxPriceMinor === undefined) {
        const cats = new Map<string, number>();
        for (const i of available) cats.set(i.category ?? 'Other', (cats.get(i.category ?? 'Other') ?? 0) + 1);
        return { ok: true as const, orderingAvailable, ...display, categories: [...cats].map(([name, count]) => ({ name, items: count })),
          items: available.slice(0, q.limit ?? 30).map((i) => this.itemCard(i)), totalItems: available.length };
      }
      return { ok: true as const, orderingAvailable, ...display, items: available.slice(0, q.limit ?? 30).map((i) => this.itemCard(i)), totalItems: available.length };
    }
    const ranked = rankMenu(q.query, items);
    if (ranked.length === 0) return err('NO_MATCH', 'Nothing on the menu matches that.', { suggestions: [] });
    const top = ranked[0].score;
    const matches = ranked.slice(0, q.limit ?? 8).map((i) => ({ ...this.itemCard(i), match: i.score }));
    const clear = ranked.length === 1 || top - (ranked[1]?.score ?? 0) >= 0.15;
    return { ok: true as const, orderingAvailable, items: matches, bestMatchClear: clear, note: clear ? undefined : 'Several items match: ask the customer which one.' };
  }

  async itemDetails(db: Db, businessId: string, itemId: string) {
    const item = (await this.menu(db, businessId)).find((i) => i.id === itemId);
    if (!item) return err('ITEM_NOT_FOUND', 'No such menu item.');
    const groups = await this.modifierGroups(db, itemId);
    const display = renderDish(item, groups.map((g) => ({ name: g.name, required: g.minSelect > 0, choose: g.minSelect === g.maxSelect ? `${g.minSelect}` : `${g.minSelect}-${g.maxSelect}`,
      modifiers: g.modifiers.filter((m) => m.available) })), { list: item.allergens ?? [], verified: item.allergenVerified });
    return { ok: true as const, display, item: { ...this.itemCard(item), description: item.description, spiceLevel: item.spiceLevel,
      allergens: item.allergens, allergenInfo: item.allergenVerified ? 'verified by the restaurant' : 'not verified - cannot guarantee allergen safety',
      options: groups.map((g) => ({ group: g.name, required: g.minSelect > 0, choose: g.minSelect === g.maxSelect ? `${g.minSelect}` : `${g.minSelect}-${g.maxSelect}`,
        modifiers: g.modifiers.filter((m) => m.available).map((m) => ({ modifierId: m.id, name: m.name, kind: m.kind,
          price: m.priceDeltaMinor ? `${m.priceDeltaMinor > 0 ? '+' : ''}${formatMoney(m.priceDeltaMinor, item.currency)}` : 'free' })) })) } };
  }

  private async modifierGroups(db: Db, itemId: string) {
    const r = await db.query(
      `SELECT g.id, g.name, g.min_select, g.max_select,
              coalesce((SELECT json_agg(json_build_object('id', m.id, 'name', m.name, 'kind', m.kind, 'priceDeltaMinor', m.price_delta_minor, 'available', m.available)
                                        ORDER BY m.display_order, m.name) FROM app.menu_modifiers m WHERE m.group_id = g.id AND m.deleted_at IS NULL), '[]') AS modifiers
         FROM app.menu_item_modifier_groups l JOIN app.menu_modifier_groups g ON g.id = l.group_id AND g.deleted_at IS NULL
        WHERE l.item_id = $1 ORDER BY g.name`, [itemId]);
    return r.rows.map((g) => ({ id: g.id as string, name: g.name as string, minSelect: g.min_select as number, maxSelect: g.max_select as number,
      modifiers: (g.modifiers as any[]).map((m) => ({ ...m, priceDeltaMinor: Number(m.priceDeltaMinor) })) as Array<{ id: string; name: string; kind: string; priceDeltaMinor: number; available: boolean }> }));
  }

  /** Resolve & validate a line configuration (variant, modifiers, required choices). */
  private async resolveConfig(db: Db, businessId: string, itemId: string, variantId: string | null | undefined, modifierIds: string[]) {
    const item = (await this.menu(db, businessId)).find((i) => i.id === itemId);
    if (!item) return err('ITEM_NOT_FOUND', 'No such menu item.');
    if (!item.available) return err('ITEM_UNAVAILABLE', `${item.name} is not available right now.`);
    let variant: MenuRow['variants'][number] | null = null;
    if (item.variants.length) {
      if (variantId) {
        variant = item.variants.find((v) => v.id === variantId) ?? null;
        if (!variant) return err('VARIANT_NOT_FOUND', 'That size/option does not exist for this item.', { options: item.variants.map((v) => ({ variantId: v.id, name: v.name })) });
      } else {
        const avail = item.variants.filter((v) => v.available);
        variant = avail.length === 1 ? avail[0] : avail.find((v) => v.isDefault) ?? null;
        if (!variant) return err('VARIANT_REQUIRED', `Ask which ${item.name} option the customer wants.`, { options: avail.map((v) => ({ variantId: v.id, name: v.name, price: formatMoney(v.priceMinor, item.currency) })) });
      }
      if (!variant.available) return err('VARIANT_UNAVAILABLE', `${item.name} (${variant.name}) is not available right now.`);
    } else if (variantId) {
      return err('VARIANT_NOT_FOUND', 'This item has no size options.');
    }
    const groups = await this.modifierGroups(db, itemId);
    const byId = new Map(groups.flatMap((g) => g.modifiers.map((m) => [m.id, { ...m, groupId: g.id }] as const)));
    const chosen = Array.from(new Set(modifierIds));
    for (const id of chosen) {
      const m = byId.get(id);
      if (!m) return err('MODIFIER_NOT_ALLOWED', 'That customisation is not available for this item; record it as a special instruction instead.');
      if (!m.available) return err('MODIFIER_UNAVAILABLE', `${m.name} is not available right now.`);
    }
    for (const g of groups) {
      const n = chosen.filter((id) => byId.get(id)?.groupId === g.id).length;
      if (n > g.maxSelect) return err('TOO_MANY_OPTIONS', `Choose at most ${g.maxSelect} from ${g.name}.`);
      if (n < g.minSelect) return err('OPTION_REQUIRED', `Ask the customer to choose ${g.name}.`, { group: g.name, options: g.modifiers.filter((m) => m.available).map((m) => ({ modifierId: m.id, name: m.name })) });
    }
    return { ok: true as const, item, variant, modifiers: chosen.map((id) => byId.get(id)!).sort((a, b) => a.name.localeCompare(b.name)) };
  }

  // ---------------------------------------------------------------- cart ---
  private ownerSql(o: CartOwner) { return o.contactId ? { col: 'contact_id', val: o.contactId } : { col: 'test_session_id', val: o.testSessionId! }; }

  async activeCart(db: Db, scope: Scope, create: boolean, lock = true): Promise<any | null> {
    const { col, val } = this.ownerSql(scope.owner);
    const r = await db.query(`SELECT * FROM app.carts WHERE business_id = $1 AND ${col} = $2 AND status = 'ACTIVE'${lock ? ' FOR UPDATE' : ''}`, [scope.businessId, val]);
    if (r.rows[0] || !create) return r.rows[0] ?? null;
    const ins = await db.query(
      `INSERT INTO app.carts (organization_id, business_id, ${col}, conversation_id) VALUES (app.current_org_id(), $1, $2, $3)
       ON CONFLICT DO NOTHING RETURNING *`, [scope.businessId, val, scope.conversationId ?? null]);
    return ins.rows[0] ?? (await db.query(`SELECT * FROM app.carts WHERE business_id = $1 AND ${col} = $2 AND status = 'ACTIVE' FOR UPDATE`, [scope.businessId, val])).rows[0];
  }

  private lineKey(itemId: string, variantId: string | null, modifierIds: string[], instructions: string | null) {
    const norm = (instructions ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    return createHash('sha256').update(JSON.stringify([itemId, variantId, [...modifierIds].sort(), norm])).digest('hex').slice(0, 32);
  }

  private async touch(db: Db, cartId: string) {
    await db.query(`UPDATE app.carts SET version = version + 1 WHERE id = $1`, [cartId]);
    await db.query(`UPDATE app.checkout_quotes SET status = 'SUPERSEDED' WHERE cart_id = $1 AND status = 'VALID'`, [cartId]);
  }

  /** Merge into an existing identical line (same item, variant, modifiers, instructions) or create a new line. */
  private async upsertLine(db: Db, cart: any, cfg: { itemId: string; variantId: string | null; modifierIds: string[]; instructions: string | null; quantity: number }) {
    const key = this.lineKey(cfg.itemId, cfg.variantId, cfg.modifierIds, cfg.instructions);
    const ex = (await db.query('SELECT id, quantity FROM app.cart_items WHERE cart_id = $1 AND line_key = $2', [cart.id, key])).rows[0];
    if (ex) {
      const qty = ex.quantity + cfg.quantity;
      if (qty > 100) return err('QUANTITY_TOO_LARGE', 'Maximum 100 of one item per order.');
      await db.query('UPDATE app.cart_items SET quantity = $2 WHERE id = $1', [ex.id, qty]);
      return { ok: true as const, lineId: ex.id as string, merged: true };
    }
    const pos = (await db.query('SELECT coalesce(max(position), 0) + 1 AS p FROM app.cart_items WHERE cart_id = $1', [cart.id])).rows[0].p;
    const id = (await db.query(
      `INSERT INTO app.cart_items (organization_id, cart_id, business_id, item_id, variant_id, quantity, modifier_ids, special_instructions, line_key, position)
       VALUES (app.current_org_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [cart.id, cart.business_id, cfg.itemId, cfg.variantId, cfg.quantity, cfg.modifierIds, cfg.instructions, key, pos])).rows[0].id;
    return { ok: true as const, lineId: id as string, merged: false };
  }

  async addItem(db: Db, scope: Scope, input: { itemId: string; variantId?: string | null; quantity: number; modifierIds?: string[]; instructions?: string | null }) {
    const s = await this.settings(db, scope.businessId);
    if (!s?.enabled) return err('ORDERING_NOT_AVAILABLE', 'This business does not take orders on WhatsApp.');
    const cfg = await this.resolveConfig(db, scope.businessId, input.itemId, input.variantId, input.modifierIds ?? []);
    if (!cfg.ok) return cfg;
    const cart = await this.activeCart(db, scope, true);
    const r = await this.upsertLine(db, cart, { itemId: cfg.item.id, variantId: cfg.variant?.id ?? null, modifierIds: cfg.modifiers.map((m) => m.id),
      instructions: input.instructions?.trim() || null, quantity: input.quantity });
    if (!r.ok) return r;
    await this.touch(db, cart.id);
    return { ok: true as const, added: { lineId: r.lineId, quantity: input.quantity, name: cfg.item.name, variant: cfg.variant?.name ?? null,
      modifiers: cfg.modifiers.map((m) => m.name), instructions: input.instructions ?? null }, cart: await this.view(db, scope) };
  }

  /**
   * Change a line. With `applyToQuantity` smaller than the line quantity, the change applies to only that many units:
   * the line is SPLIT ("ek burger me extra cheese" on 2 burgers -> 1 standard + 1 extra cheese).
   */
  async updateLine(db: Db, scope: Scope, input: { lineId: string; quantity?: number; variantId?: string | null; addModifierIds?: string[]; removeModifierIds?: string[];
    instructions?: string | null; applyToQuantity?: number }) {
    const cart = await this.activeCart(db, scope, false);
    if (!cart) return err('CART_EMPTY', 'The cart is empty.');
    const line = (await db.query('SELECT * FROM app.cart_items WHERE id = $1 AND cart_id = $2', [input.lineId, cart.id])).rows[0];
    if (!line) return err('LINE_NOT_FOUND', 'That item is not in the cart; fetch the cart again.');
    const configChange = input.variantId !== undefined || input.addModifierIds?.length || input.removeModifierIds?.length || input.instructions !== undefined;
    if (!configChange) {
      if (!input.quantity) return err('NOTHING_TO_CHANGE');
      await db.query('UPDATE app.cart_items SET quantity = $2 WHERE id = $1', [line.id, input.quantity]);
      await this.touch(db, cart.id);
      return { ok: true as const, changed: 'quantity', cart: await this.view(db, scope) };
    }
    const mods = new Set<string>(line.modifier_ids);
    for (const m of input.addModifierIds ?? []) mods.add(m);
    for (const m of input.removeModifierIds ?? []) mods.delete(m);
    const variantId = input.variantId === undefined ? line.variant_id : input.variantId;
    const cfg = await this.resolveConfig(db, scope.businessId, line.item_id, variantId, [...mods]);
    if (!cfg.ok) return cfg;
    const instructions = input.instructions === undefined ? line.special_instructions : (input.instructions?.trim() || null);
    const units = input.applyToQuantity ?? (input.quantity ?? line.quantity);
    if (units > line.quantity && input.applyToQuantity !== undefined) return err('QUANTITY_MISMATCH', `The cart has only ${line.quantity} of this item.`);
    if (input.applyToQuantity !== undefined && units < line.quantity) {
      await db.query('UPDATE app.cart_items SET quantity = quantity - $2 WHERE id = $1', [line.id, units]);
    } else {
      await db.query('DELETE FROM app.cart_items WHERE id = $1', [line.id]);
    }
    const r = await this.upsertLine(db, cart, { itemId: line.item_id, variantId: cfg.variant?.id ?? null, modifierIds: cfg.modifiers.map((m) => m.id), instructions, quantity: units });
    if (!r.ok) return r;
    await this.touch(db, cart.id);
    return { ok: true as const, changed: input.applyToQuantity !== undefined && units < line.quantity ? 'split' : 'line', cart: await this.view(db, scope) };
  }

  async removeLine(db: Db, scope: Scope, input: { lineId: string; quantity?: number }) {
    const cart = await this.activeCart(db, scope, false);
    if (!cart) return err('CART_EMPTY', 'The cart is empty.');
    const line = (await db.query('SELECT id, quantity FROM app.cart_items WHERE id = $1 AND cart_id = $2', [input.lineId, cart.id])).rows[0];
    if (!line) return err('LINE_NOT_FOUND', 'That item is not in the cart; fetch the cart again.');
    if (input.quantity && input.quantity < line.quantity) await db.query('UPDATE app.cart_items SET quantity = quantity - $2 WHERE id = $1', [line.id, input.quantity]);
    else await db.query('DELETE FROM app.cart_items WHERE id = $1', [line.id]);
    await this.touch(db, cart.id);
    return { ok: true as const, cart: await this.view(db, scope) };
  }

  async clear(db: Db, scope: Scope) {
    const cart = await this.activeCart(db, scope, false);
    if (!cart) return { ok: true as const, cleared: 0 };
    const n = (await db.query('DELETE FROM app.cart_items WHERE cart_id = $1', [cart.id])).rowCount ?? 0;
    await db.query('UPDATE app.carts SET coupon_code = NULL WHERE id = $1', [cart.id]);
    await this.touch(db, cart.id);
    return { ok: true as const, cleared: n };
  }

  // -------------------------------------------------------------- coupons ---
  private async couponRule(db: Db, businessId: string, code: string, contactId: string | null, now = new Date()): Promise<CouponRule | OrderingError> {
    const c = (await db.query('SELECT * FROM app.coupons WHERE business_id = $1 AND code = $2', [businessId, code.toUpperCase()])).rows[0];
    if (!c || !c.active) return err('COUPON_INVALID', 'This coupon code is not valid.');
    if (c.valid_from && now < c.valid_from) return err('COUPON_NOT_STARTED', 'This coupon is not active yet.');
    if (c.valid_until && now > c.valid_until) return err('COUPON_EXPIRED', 'This coupon has expired.');
    if (c.usage_limit !== null) {
      const used = (await db.query(`SELECT count(*)::int AS n FROM app.orders WHERE business_id = $1 AND coupon_code = $2 AND status NOT IN ('CANCELLED','REJECTED')`, [businessId, c.code])).rows[0].n;
      if (used >= c.usage_limit) return err('COUPON_USED_UP', 'This coupon has reached its usage limit.');
    }
    if (c.per_customer_limit !== null && contactId) {
      const used = (await db.query(`SELECT count(*)::int AS n FROM app.orders WHERE contact_id = $1 AND coupon_code = $2 AND status NOT IN ('CANCELLED','REJECTED')`, [contactId, c.code])).rows[0].n;
      if (used >= c.per_customer_limit) return err('COUPON_ALREADY_USED', 'This customer has already used this coupon.');
    }
    return { code: c.code, discountType: c.discount_type, discountValue: Number(c.discount_value), maxDiscountMinor: c.max_discount_minor === null ? null : Number(c.max_discount_minor),
      minOrderMinor: Number(c.min_order_minor) };
  }

  async applyCoupon(db: Db, scope: Scope, code: string) {
    const cart = await this.activeCart(db, scope, false);
    if (!cart) return err('CART_EMPTY', 'Add items before applying a coupon.');
    const rule = await this.couponRule(db, scope.businessId, code, scope.owner.contactId ?? null);
    if ('ok' in rule) return rule;
    await db.query('UPDATE app.carts SET coupon_code = $2 WHERE id = $1', [cart.id, rule.code]);
    await this.touch(db, cart.id);
    const v = await this.view(db, scope);
    return v.totals.coupon?.applied ? { ok: true as const, coupon: rule.code, cart: v }
      : { ok: true as const, coupon: rule.code, applied: false, message: `Coupon saved but needs a minimum order of ${formatMoney(rule.minOrderMinor, v.totals.currency)}.`, cart: v };
  }

  async removeCoupon(db: Db, scope: Scope) {
    const cart = await this.activeCart(db, scope, false);
    if (!cart?.coupon_code) return { ok: true as const, removed: false };
    await db.query('UPDATE app.carts SET coupon_code = NULL WHERE id = $1', [cart.id]);
    await this.touch(db, cart.id);
    return { ok: true as const, removed: true, cart: await this.view(db, scope) };
  }

  // --------------------------------------------------------- fulfillment ---
  async setFulfillment(db: Db, scope: Scope, input: { mode: string; scheduledFor?: string | null }, now = new Date()) {
    const s = await this.settings(db, scope.businessId);
    if (!s?.enabled) return err('ORDERING_NOT_AVAILABLE');
    if (!s.fulfillmentModes.includes(input.mode)) return err('MODE_NOT_AVAILABLE', `Available: ${s.fulfillmentModes.join(', ')}.`, { available: s.fulfillmentModes });
    let scheduled: Date | null = null;
    if (input.scheduledFor) {
      if (!s.schedulingEnabled) return err('SCHEDULING_NOT_AVAILABLE', 'Orders cannot be scheduled for later.');
      scheduled = new Date(input.scheduledFor);
      const b = await this.business(db, scope.businessId);
      if (scheduled.getTime() < now.getTime() + s.prepTimeMinutes * 60_000) return err('SCHEDULE_TOO_SOON', `Needs at least ${s.prepTimeMinutes} minutes.`);
      if (scheduled.getTime() > now.getTime() + s.maxScheduleDays * 86_400_000) return err('SCHEDULE_TOO_FAR', `Orders can be scheduled up to ${s.maxScheduleDays} days ahead.`);
      if (!isOpenAt(b.hours, b.timezone, scheduled)) return err('SCHEDULE_OUTSIDE_HOURS', 'The restaurant is closed at that time.');
    }
    const cart = await this.activeCart(db, scope, true);
    const methods = PAYMENT_FOR_MODE[input.mode].filter((p) => s.paymentMethods.includes(p));
    const keepPayment = cart.payment_method && methods.includes(cart.payment_method) ? cart.payment_method : methods.length === 1 ? methods[0] : null;
    await db.query(`UPDATE app.carts SET fulfillment_mode = $2, scheduled_for = $3, payment_method = $4,
                      delivery_fee_minor = CASE WHEN $2 = 'DELIVERY' THEN delivery_fee_minor ELSE NULL END WHERE id = $1`, [cart.id, input.mode, scheduled, keepPayment]);
    await this.touch(db, cart.id);
    return { ok: true as const, mode: input.mode, scheduledFor: scheduled?.toISOString() ?? null, paymentMethod: keepPayment,
      paymentOptions: methods.map((m) => ({ method: m, label: PAYMENT_LABEL[m] })), nextStep: input.mode === 'DELIVERY' ? 'Collect the delivery address.' : undefined };
  }

  async checkArea(db: Db, businessId: string, t: { pincode?: string | null; latitude?: number | null; longitude?: number | null }) {
    const s = await this.settings(db, businessId);
    if (!s?.enabled || !s.fulfillmentModes.includes('DELIVERY')) return err('DELIVERY_NOT_OFFERED', 'This restaurant does not deliver.');
    const b = await this.business(db, businessId);
    const r = checkServiceability({ pincodes: s.deliveryPincodes, radiusKm: s.deliveryRadiusKm, origin: b.origin }, { pincode: t.pincode, lat: t.latitude, lng: t.longitude });
    return { ok: true as const, ...r, ...(r.serviceable ? { deliveryFee: formatMoney(s.deliveryFeeMinor, s.currency) } : {}) };
  }

  /** Merge address fields; returns what is still missing and whether the address is serviceable. */
  async setAddress(db: Db, scope: Scope, input: Record<string, unknown>) {
    const s = await this.settings(db, scope.businessId);
    if (!s?.enabled || !s.fulfillmentModes.includes('DELIVERY')) return err('DELIVERY_NOT_OFFERED', 'This restaurant does not deliver.');
    const cart = await this.activeCart(db, scope, true);
    let base: Record<string, unknown> = cart.address ?? {};
    if (input.saved_address_id && scope.owner.contactId) {
      const saved = (await db.query('SELECT address FROM app.customer_addresses WHERE id = $1 AND contact_id = $2', [input.saved_address_id, scope.owner.contactId])).rows[0];
      if (!saved) return err('SAVED_ADDRESS_NOT_FOUND');
      base = saved.address;
    }
    const merged: Record<string, unknown> = { ...base };
    for (const k of ['house', 'street', 'locality', 'landmark', 'city', 'pincode', 'latitude', 'longitude', 'instructions']) {
      if (input[k] !== undefined && input[k] !== null && input[k] !== '') merged[k] = typeof input[k] === 'string' ? (input[k] as string).trim().slice(0, 200) : input[k];
    }
    const missing: string[] = [];
    const hasPin = typeof merged.pincode === 'string' && /^[0-9]{4,10}$/.test(merged.pincode as string);
    const hasGeo = typeof merged.latitude === 'number' && typeof merged.longitude === 'number';
    if (!merged.house) missing.push('house');
    if (!hasPin && !hasGeo) missing.push('pincode');
    if (!merged.locality && !merged.street && !hasGeo) missing.push('locality');
    const b = await this.business(db, scope.businessId);
    const svc = hasPin || hasGeo ? checkServiceability({ pincodes: s.deliveryPincodes, radiusKm: s.deliveryRadiusKm, origin: b.origin },
      { pincode: hasPin ? merged.pincode as string : null, lat: hasGeo ? merged.latitude as number : null, lng: hasGeo ? merged.longitude as number : null }) : null;
    const status = svc && !svc.serviceable && svc.reason !== 'NEED_PINCODE_OR_LOCATION' ? 'NOT_SERVICEABLE' : missing.length ? 'INCOMPLETE' : svc?.serviceable ? 'SERVICEABLE' : 'INCOMPLETE';
    if (input.name && typeof input.name === 'string') await db.query('UPDATE app.carts SET customer_name = $2 WHERE id = $1', [cart.id, input.name.trim().slice(0, 100)]);
    await db.query(`UPDATE app.carts SET address = $2, address_status = $3, delivery_fee_minor = $4,
                      fulfillment_mode = coalesce(fulfillment_mode, 'DELIVERY') WHERE id = $1`,
      [cart.id, JSON.stringify(merged), status, status === 'SERVICEABLE' ? s.deliveryFeeMinor : null]);
    await this.touch(db, cart.id);
    return { ok: true as const, addressStatus: status, missingFields: missing, serviceability: svc,
      message: status === 'NOT_SERVICEABLE' ? 'This address is outside the delivery area. Offer pickup if available.' : undefined };
  }

  async setPayment(db: Db, scope: Scope, method: string) {
    const s = await this.settings(db, scope.businessId);
    if (!s?.enabled) return err('ORDERING_NOT_AVAILABLE');
    if (method === 'ONLINE') return err('PAYMENT_METHOD_NOT_AVAILABLE', 'Online payment is not available yet.');
    const cart = await this.activeCart(db, scope, true);
    const mode = cart.fulfillment_mode;
    const allowed = (mode ? PAYMENT_FOR_MODE[mode] : ['COD', 'PAY_AT_PICKUP']).filter((p) => s.paymentMethods.includes(p));
    if (!allowed.includes(method)) return err('PAYMENT_METHOD_NOT_AVAILABLE', `Available: ${allowed.map((p) => PAYMENT_LABEL[p]).join(', ') || 'none'}.`, { available: allowed });
    await db.query('UPDATE app.carts SET payment_method = $2 WHERE id = $1', [cart.id, method]);
    await this.touch(db, cart.id);
    return { ok: true as const, paymentMethod: method, label: PAYMENT_LABEL[method] };
  }

  // -------------------------------------------------------------- pricing ---
  private async pricedCart(db: Db, cart: any, s: OrderingSettings) {
    const lines = (await db.query(
      `SELECT ci.id, ci.item_id, ci.quantity, ci.special_instructions, ci.modifier_ids, i.name, i.available AS item_available, i.base_price_minor,
              v.name AS variant_name, v.price_minor AS variant_price, v.available AS variant_available
         FROM app.cart_items ci JOIN app.menu_items i ON i.id = ci.item_id LEFT JOIN app.menu_item_variants v ON v.id = ci.variant_id
        WHERE ci.cart_id = $1 ORDER BY ci.position`, [cart.id])).rows;
    const modIds = [...new Set(lines.flatMap((l) => l.modifier_ids))];
    const mods = modIds.length ? new Map((await db.query('SELECT id, name, kind, price_delta_minor, available FROM app.menu_modifiers WHERE id = ANY($1::uuid[])', [modIds])).rows
      .map((m) => [m.id, m])) : new Map();
    const input: PriceLineInput[] = lines.map((l) => ({
      lineId: l.id, itemId: l.item_id, name: l.name, variantName: l.variant_name, basePriceMinor: Number(l.variant_price ?? l.base_price_minor), quantity: l.quantity, specialInstructions: l.special_instructions,
      modifiers: l.modifier_ids.map((id: string) => mods.get(id)).filter(Boolean).map((m: any) => ({ id: m.id, name: m.name, kind: m.kind, priceDeltaMinor: Number(m.price_delta_minor) })),
      available: l.item_available && (l.variant_available ?? true) && l.modifier_ids.every((id: string) => mods.get(id)?.available !== false),
    }));
    let coupon: CouponRule | null = null;
    let couponError: string | null = null;
    if (cart.coupon_code) {
      const r = await this.couponRule(db, cart.business_id, cart.coupon_code, cart.contact_id);
      if ('ok' in r) couponError = r.errorCode; else coupon = r;
    }
    const totals = priceCart(input, { currency: s.currency, taxRateBps: s.taxRateBps, taxInclusive: s.taxInclusive, packagingFeeMinor: s.packagingFeeMinor,
      deliveryFeeMinor: cart.delivery_fee_minor === null ? null : Number(cart.delivery_fee_minor), freeDeliveryAboveMinor: s.freeDeliveryAboveMinor },
      { coupon, delivery: cart.fulfillment_mode === 'DELIVERY' && cart.address_status === 'SERVICEABLE' });
    if (couponError) totals.coupon = { code: cart.coupon_code, applied: false, reason: couponError };
    return totals;
  }

  async view(db: Db, scope: Scope) {
    const s = await this.settings(db, scope.businessId);
    const cart = await this.activeCart(db, scope, false, false);
    if (!s || !cart) return { lines: [], empty: true, totals: priceCart([], { currency: s?.currency ?? 'INR', taxRateBps: 0, taxInclusive: false, packagingFeeMinor: 0, deliveryFeeMinor: 0, freeDeliveryAboveMinor: null }, { delivery: false }) };
    const totals = await this.pricedCart(db, cart, s);
    const m = (x: number) => formatMoney(x, totals.currency);
    return {
      empty: totals.lines.length === 0,
      lines: totals.lines.map((l) => ({ lineId: l.lineId, itemId: l.itemId, quantity: l.quantity, name: l.name, variant: l.variantName,
        modifiers: l.modifiers.map((x) => `${x.kind === 'REMOVE' ? 'no ' : '+'}${x.name.replace(/^no /i, '')}`), instructions: l.specialInstructions,
        unitPrice: m(l.unitPriceMinor), lineTotal: m(l.lineTotalMinor), available: l.available })),
      totals, summary: { subtotal: m(totals.subtotalMinor), discount: totals.discountMinor ? m(totals.discountMinor) : null,
        packaging: totals.packagingMinor ? m(totals.packagingMinor) : null, delivery: cart.fulfillment_mode === 'DELIVERY' ? (cart.address_status === 'SERVICEABLE' ? m(totals.deliveryFeeMinor) : 'after address') : null,
        tax: totals.taxMinor ? m(totals.taxMinor) : totals.taxInclusive ? 'included' : null, total: m(totals.totalMinor),
        coupon: totals.coupon }, display: renderCart(totals, { taxRateBps: s.taxRateBps, mode: cart.fulfillment_mode, deliveryKnown: cart.address_status === 'SERVICEABLE' }),
      fulfillment: { mode: cart.fulfillment_mode, scheduledFor: cart.scheduled_for, address: cart.address, addressStatus: cart.address_status,
        paymentMethod: cart.payment_method, customerName: cart.customer_name },
      version: cart.version,
    };
  }

  // ----------------------------------------------------------- checkout ---
  async createQuote(db: Db, scope: Scope, now = new Date()) {
    const s = await this.settings(db, scope.businessId);
    if (!s?.enabled) return err('ORDERING_NOT_AVAILABLE');
    const cart = await this.activeCart(db, scope, false);
    if (!cart) return err('CART_EMPTY', 'The cart is empty.');
    const b = await this.business(db, scope.businessId);
    const totals = await this.pricedCart(db, cart, s);
    const missing: string[] = [];
    if (totals.lines.length === 0) return err('CART_EMPTY', 'The cart is empty.');
    const unavailable = totals.lines.filter((l) => !l.available).map((l) => l.name);
    if (unavailable.length) return err('ITEM_UNAVAILABLE', `No longer available: ${unavailable.join(', ')}. Remove or replace them.`, { items: unavailable });
    let mode: string | null = cart.fulfillment_mode;
    if (!mode && s.fulfillmentModes.length === 1) {
      mode = s.fulfillmentModes[0];
      await db.query('UPDATE app.carts SET fulfillment_mode = $2 WHERE id = $1', [cart.id, mode]);
    }
    if (!mode) missing.push('fulfillment_mode');
    if (mode === 'DELIVERY' && cart.address_status !== 'SERVICEABLE') missing.push(cart.address_status === 'NOT_SERVICEABLE' ? 'serviceable_address' : 'delivery_address');
    let pay = cart.payment_method;
    const payOptions = mode ? PAYMENT_FOR_MODE[mode].filter((p) => s.paymentMethods.includes(p)) : [];
    if (!pay && payOptions.length === 1) {
      pay = payOptions[0];
      await db.query('UPDATE app.carts SET payment_method = $2 WHERE id = $1', [cart.id, pay]);
    }
    if (mode && !pay) missing.push('payment_method');
    let name = cart.customer_name;
    if (!name && scope.owner.contactId) name = (await db.query('SELECT coalesce(display_name, profile_name) AS n FROM app.contacts WHERE id = $1', [scope.owner.contactId])).rows[0]?.n ?? null;
    if (!name && scope.owner.testSessionId) name = 'Test customer';
    if (!name) missing.push('customer_name');
    if (totals.subtotalMinor < s.minOrderMinor) return err('MIN_ORDER_NOT_MET', `Minimum order is ${formatMoney(s.minOrderMinor, s.currency)}.`);
    if (!cart.scheduled_for && !isOpenAt(b.hours, b.timezone, now)) {
      const next = nextOpening(b.hours, b.timezone, now);
      return err('RESTAURANT_CLOSED', 'The restaurant is closed right now.', { nextOpening: next?.toISOString() ?? null, schedulingEnabled: s.schedulingEnabled });
    }
    if (missing.length) return err('CHECKOUT_INCOMPLETE', `Still needed: ${missing.join(', ')}.`, { missing, paymentOptions: payOptions });
    // Re-price after possible auto-selections.
    const final = await this.pricedCart(db, { ...cart, fulfillment_mode: mode, payment_method: pay }, s);
    const version = (await db.query('SELECT version FROM app.carts WHERE id = $1', [cart.id])).rows[0].version;
    await db.query(`UPDATE app.checkout_quotes SET status = 'SUPERSEDED' WHERE cart_id = $1 AND status = 'VALID'`, [cart.id]);
    const expires = new Date(now.getTime() + s.quoteTtlMinutes * 60_000);
    const quote = (await db.query(
      `INSERT INTO app.checkout_quotes (organization_id, business_id, cart_id, cart_version, totals, total_minor, currency, expires_at)
       VALUES (app.current_org_id(), $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [scope.businessId, cart.id, version, JSON.stringify({ ...final, fulfillment: { mode, address: cart.address, scheduledFor: cart.scheduled_for, paymentMethod: pay, customerName: name } }),
       final.totalMinor, final.currency, expires])).rows[0];
    const display = renderBill(final, { restaurant: b.name, taxRateBps: s.taxRateBps, mode, address: mode === 'DELIVERY' ? this.addressText(cart.address) : null,
      scheduled: cart.scheduled_for ? this.localWhen(new Date(cart.scheduled_for), b.timezone) : null, payment: PAYMENT_LABEL[pay], customerName: name });
    return { ok: true as const, quoteId: quote.id as string, expiresAt: expires.toISOString(), total: formatMoney(final.totalMinor, final.currency), display,
      instruction: 'Send display exactly as given (it is the final bill), then ask the customer to confirm the order. Only after a clear yes call CONFIRM_ORDER with this quote id.' };
  }

  /** "28 Sep, 19:30" in the business timezone. */
  localWhen(d: Date, timezone: string): string {
    return new Intl.DateTimeFormat('en-IN', { timeZone: timezone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  }

  addressText(a: any): string {
    if (!a) return '';
    return [a.house, a.street, a.locality, a.landmark ? `near ${a.landmark}` : null, a.city, a.pincode].filter(Boolean).join(', ') || (a.latitude ? `pin ${a.latitude},${a.longitude}` : '');
  }

  /** Validate a quote for confirmation without writing (preview / dry run). */
  async checkQuote(db: Db, scope: Scope, quoteId: string, now = new Date()) {
    const q = (await db.query(
      `SELECT q.*, c.version AS cart_version_now, c.status AS cart_status, c.${this.ownerSql(scope.owner).col} AS owner
         FROM app.checkout_quotes q JOIN app.carts c ON c.id = q.cart_id WHERE q.id = $1 AND q.business_id = $2`, [quoteId, scope.businessId])).rows[0];
    if (!q || q.owner !== this.ownerSql(scope.owner).val) return err('QUOTE_NOT_FOUND', 'Create a checkout quote first.');
    const existing = (await db.query('SELECT order_number, status FROM app.orders WHERE quote_id = $1', [quoteId])).rows[0];
    if (existing) return { ok: true as const, alreadyPlaced: true, orderNumber: Number(existing.order_number), status: existing.status, quote: q };
    if (q.status !== 'VALID' || q.cart_version !== q.cart_version_now || q.cart_status !== 'ACTIVE') return err('QUOTE_STALE', 'The order changed after this summary. Create a new checkout quote and confirm again.');
    if (new Date(q.expires_at) < now) return err('QUOTE_EXPIRED', 'The summary expired. Create a new checkout quote.');
    return { ok: true as const, alreadyPlaced: false, quote: q };
  }

  /** Place ONE order from a VALID, current quote. Idempotent per quote (UNIQUE orders.quote_id). */
  async placeOrder(db: Db, scope: Scope & { owner: { contactId: string } }, quoteId: string, meta: { aiAgentId?: string | null; source: 'AI_WHATSAPP' | 'DASHBOARD' | 'API' }, now = new Date()) {
    await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('order-quote:' || $1::text, 0))`, [quoteId]);
    const chk = await this.checkQuote(db, scope, quoteId, now);
    if (!chk.ok) return chk;
    if (chk.alreadyPlaced) return { ok: true as const, replayed: true, orderNumber: chk.orderNumber, status: chk.status };
    const s = (await this.settings(db, scope.businessId))!;
    const cart = await this.activeCart(db, scope, false);
    const current = await this.pricedCart(db, cart, s);
    if (current.totalMinor !== Number(chk.quote.total_minor) || current.lines.some((l) => !l.available)) {
      await db.query(`UPDATE app.checkout_quotes SET status = 'SUPERSEDED' WHERE id = $1`, [quoteId]);
      return err('QUOTE_STALE', 'Prices or availability changed. Create a new checkout quote and confirm again.');
    }
    const t = chk.quote.totals;
    const contact = (await db.query('SELECT phone_e164, coalesce(display_name, profile_name) AS name FROM app.contacts WHERE id = $1', [scope.owner.contactId])).rows[0];
    if (!contact?.phone_e164) return err('CUSTOMER_PHONE_UNKNOWN', 'No phone number on this chat; hand over to the team.');
    const number = Number((await db.query(
      `UPDATE app.ordering_settings SET next_order_number = next_order_number + 1 WHERE business_id = $1 RETURNING next_order_number - 1 AS n`, [scope.businessId])).rows[0].n);
    const order = (await db.query(
      `INSERT INTO app.orders (organization_id, business_id, order_number, contact_id, conversation_id, cart_id, quote_id, ai_agent_id, fulfillment_mode, scheduled_for, address,
                               customer_name, customer_phone, payment_method, coupon_code, subtotal_minor, discount_minor, packaging_minor, delivery_fee_minor, tax_minor,
                               total_minor, currency, source)
       VALUES (app.current_org_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22) RETURNING id`,
      [scope.businessId, number, scope.owner.contactId, scope.conversationId ?? null, cart.id, quoteId, meta.aiAgentId ?? null, t.fulfillment.mode, t.fulfillment.scheduledFor,
       t.fulfillment.mode === 'DELIVERY' ? JSON.stringify(t.fulfillment.address) : null, t.fulfillment.customerName ?? contact.name ?? 'Customer', contact.phone_e164,
       t.fulfillment.paymentMethod, t.coupon?.applied ? t.coupon.code : null, t.subtotalMinor, t.discountMinor, t.packagingMinor, t.deliveryFeeMinor, t.taxMinor,
       t.totalMinor, t.currency, meta.source])).rows[0];
    for (const [i, l] of (t.lines as Totals['lines']).entries()) {
      await db.query(
        `INSERT INTO app.order_items (organization_id, order_id, item_id, name, variant_name, modifiers, special_instructions, quantity, unit_price_minor, line_total_minor, position)
         SELECT app.current_org_id(), $1, ci.item_id, $2, $3, $4, $5, $6, $7, $8, $9 FROM app.cart_items ci WHERE ci.id = $10`,
        [order.id, l.name, l.variantName, JSON.stringify(l.modifiers), l.specialInstructions, l.quantity, l.unitPriceMinor, l.lineTotalMinor, i + 1, l.lineId]);
    }
    await db.query(`INSERT INTO app.order_events (organization_id, order_id, to_status, actor_type) VALUES (app.current_org_id(), $1, 'PLACED', $2)`,
      [order.id, meta.source === 'AI_WHATSAPP' ? 'AI' : 'USER']);
    await db.query(`UPDATE app.checkout_quotes SET status = 'USED' WHERE id = $1`, [quoteId]);
    await db.query(`UPDATE app.carts SET status = 'ORDERED' WHERE id = $1`, [cart.id]);
    if (t.fulfillment.mode === 'DELIVERY' && t.fulfillment.address) await this.rememberAddress(db, scope.businessId, scope.owner.contactId, t.fulfillment.address);
    await this.ops.enqueueOutbox(db, { organizationId: (await db.query('SELECT app.current_org_id() AS o')).rows[0].o, eventType: 'ORDER_PLACED', aggregateType: 'ORDER',
      aggregateId: order.id, payload: { order_id: order.id, business_id: scope.businessId, order_number: number }, dedupeKey: `order-placed:${order.id}` });
    await this.ops.recordUsage(db, { organizationId: (await db.query('SELECT app.current_org_id() AS o')).rows[0].o, businessId: scope.businessId, eventType: 'ORDER_PLACED',
      quantity: 1, resourceType: 'ORDER', resourceId: order.id, idempotencyKey: `order:${order.id}` });
    const biz = await this.business(db, scope.businessId);
    const display = renderReceipt(t, { restaurant: biz.name, taxRateBps: s.taxRateBps, mode: t.fulfillment.mode, orderNumber: number,
      address: t.fulfillment.mode === 'DELIVERY' ? this.addressText(t.fulfillment.address) : null,
      scheduled: t.fulfillment.scheduledFor ? this.localWhen(new Date(t.fulfillment.scheduledFor), biz.timezone) : null, payment: PAYMENT_LABEL[t.fulfillment.paymentMethod] });
    return { ok: true as const, replayed: false, orderId: order.id as string, orderNumber: number, status: 'PLACED', total: formatMoney(t.totalMinor, t.currency), display,
      paymentMethod: PAYMENT_LABEL[t.fulfillment.paymentMethod], paymentStatus: 'PENDING', fulfillment: t.fulfillment.mode,
      note: 'The order is placed and waiting for the restaurant to accept it. Do not say it is accepted.' };
  }

  // -------------------------------------------------------- after order ---
  async customerOrders(db: Db, businessId: string, contactId: string, orderNumber?: number) {
    const r = await db.query(
      `SELECT o.id, o.order_number, o.status, o.payment_method, o.payment_status, o.total_minor, o.currency, o.fulfillment_mode, o.placed_at, o.scheduled_for,
              coalesce((SELECT string_agg(i.quantity || ' x ' || i.name || coalesce(' (' || i.variant_name || ')', ''), ', ' ORDER BY i.position) FROM app.order_items i WHERE i.order_id = o.id), '') AS items
         FROM app.orders o WHERE o.business_id = $1 AND o.contact_id = $2 AND ($3::bigint IS NULL OR o.order_number = $3)
        ORDER BY o.placed_at DESC LIMIT 5`, [businessId, contactId, orderNumber ?? null]);
    return r.rows.map((o) => ({ orderNumber: Number(o.order_number), status: o.status, items: o.items, total: formatMoney(Number(o.total_minor), o.currency),
      payment: `${PAYMENT_LABEL[o.payment_method]} - ${o.payment_status === 'PAID' ? 'paid' : o.payment_status === 'PENDING' ? 'not paid yet' : o.payment_status.toLowerCase()}`,
      fulfillment: o.fulfillment_mode, placedAt: o.placed_at, scheduledFor: o.scheduled_for, eta: null }));
  }

  private async orderFor(db: Db, businessId: string, contactId: string, orderNumber?: number) {
    return (await db.query(`SELECT * FROM app.orders WHERE business_id = $1 AND contact_id = $2 AND ($3::bigint IS NULL OR order_number = $3)
                             ORDER BY placed_at DESC LIMIT 1 FOR UPDATE`, [businessId, contactId, orderNumber ?? null])).rows[0] ?? null;
  }

  async requestCancellation(db: Db, businessId: string, contactId: string, orderNumber: number | undefined, reason: string) {
    const o = await this.orderFor(db, businessId, contactId, orderNumber);
    if (!o) return err('ORDER_NOT_FOUND', 'No order found for this customer.');
    if (['CANCELLED', 'REJECTED'].includes(o.status)) return { ok: true as const, status: o.status, orderNumber: Number(o.order_number), alreadyCancelled: true };
    if (['DELIVERED', 'COMPLETED'].includes(o.status)) return err('CANNOT_CANCEL', 'This order is already completed.');
    const s = await this.settings(db, businessId);
    if (o.status === 'PLACED' && s?.autoCancelBeforeAccept) {
      await db.query(`UPDATE app.orders SET status = 'CANCELLED', cancelled_at = now(), cancel_reason = $2 WHERE id = $1`, [o.id, reason.slice(0, 300)]);
      await db.query(`INSERT INTO app.order_events (organization_id, order_id, from_status, to_status, actor_type, note) VALUES (app.current_org_id(), $1, 'PLACED', 'CANCELLED', 'CUSTOMER', $2)`,
        [o.id, reason.slice(0, 300)]);
      return { ok: true as const, status: 'CANCELLED', orderNumber: Number(o.order_number), cancelled: true };
    }
    const pending = (await db.query(`SELECT id FROM app.order_change_requests WHERE order_id = $1 AND kind = 'CANCEL' AND status = 'PENDING'`, [o.id])).rows[0];
    if (!pending) {
      await db.query(`INSERT INTO app.order_change_requests (organization_id, business_id, order_id, kind, details, requested_by) VALUES (app.current_org_id(), $1, $2, 'CANCEL', $3, 'AI')`,
        [businessId, o.id, reason.slice(0, 1000) || 'Customer asked to cancel']);
    }
    return { ok: true as const, status: o.status, orderNumber: Number(o.order_number), cancelled: false, requestSent: true,
      note: 'The restaurant must approve this cancellation. Do not promise it is cancelled.' };
  }

  async requestChange(db: Db, businessId: string, contactId: string, orderNumber: number | undefined, kind: 'MODIFY' | 'ADDRESS', details: string) {
    const o = await this.orderFor(db, businessId, contactId, orderNumber);
    if (!o) return err('ORDER_NOT_FOUND', 'No order found for this customer.');
    if (['CANCELLED', 'REJECTED', 'DELIVERED', 'COMPLETED'].includes(o.status)) return err('CANNOT_CHANGE', `This order is ${o.status.toLowerCase()}.`);
    await db.query(`INSERT INTO app.order_change_requests (organization_id, business_id, order_id, kind, details, requested_by) VALUES (app.current_org_id(), $1, $2, $3, $4, 'AI')`,
      [businessId, o.id, kind, details.slice(0, 1000)]);
    return { ok: true as const, orderNumber: Number(o.order_number), requestSent: true, note: 'The restaurant must approve this change. Do not promise it is done.' };
  }

  async supportTicket(db: Db, businessId: string, contactId: string | null, conversationId: string | null, t: { category: string; description: string; orderNumber?: number; priority?: string; idempotencyKey: string }) {
    let orderId: string | null = null;
    if (t.orderNumber && contactId) {
      orderId = (await db.query('SELECT id FROM app.orders WHERE business_id = $1 AND contact_id = $2 AND order_number = $3', [businessId, contactId, t.orderNumber])).rows[0]?.id ?? null;
      if (!orderId) return err('ORDER_NOT_FOUND', 'No such order for this customer.');
    }
    const r = await db.query(
      `INSERT INTO app.support_tickets (organization_id, business_id, contact_id, conversation_id, order_id, category, description, priority, idempotency_key)
       VALUES (app.current_org_id(), $1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO UPDATE SET updated_at = now() RETURNING id, (xmax = 0) AS created`,
      [businessId, contactId, conversationId, orderId, t.category, t.description.slice(0, 1000), t.priority ?? 'NORMAL', t.idempotencyKey]);
    return { ok: true as const, ticketCreated: true, reference: String(r.rows[0].id).slice(-6).toUpperCase() };
  }

  /** "Last time wala order repeat karo": rebuild a draft cart from a past order, revalidated against today's menu and prices. */
  async reorder(db: Db, scope: Scope & { owner: { contactId: string } }, orderNumber?: number, replace = false) {
    const o = (await db.query(`SELECT id, order_number FROM app.orders WHERE business_id = $1 AND contact_id = $2 AND ($3::bigint IS NULL OR order_number = $3)
                                ORDER BY placed_at DESC LIMIT 1`, [scope.businessId, scope.owner.contactId, orderNumber ?? null])).rows[0];
    if (!o) return err('ORDER_NOT_FOUND', 'No previous order found.');
    const cart = await this.activeCart(db, scope, true);
    const count = (await db.query('SELECT count(*)::int AS n FROM app.cart_items WHERE cart_id = $1', [cart.id])).rows[0].n;
    if (count > 0 && !replace) return err('CART_NOT_EMPTY', 'The cart already has items. Ask whether to replace them.');
    if (count > 0) await db.query('DELETE FROM app.cart_items WHERE cart_id = $1', [cart.id]);
    const items = (await db.query('SELECT * FROM app.order_items WHERE order_id = $1 ORDER BY position', [o.id])).rows;
    const skipped: string[] = [];
    const priceChanged: string[] = [];
    for (const it of items) {
      if (!it.item_id) { skipped.push(it.name); continue; }
      const menu = (await this.menu(db, scope.businessId)).find((m) => m.id === it.item_id);
      const variant = it.variant_name ? menu?.variants.find((v) => v.name === it.variant_name) : null;
      const groups = menu ? await this.modifierGroups(db, menu.id) : [];
      const modIds = (it.modifiers as Array<{ name: string }>).map((m) => groups.flatMap((g) => g.modifiers).find((x) => x.name === m.name)?.id).filter(Boolean) as string[];
      const cfg = menu ? await this.resolveConfig(db, scope.businessId, menu.id, variant?.id ?? null, modIds) : err('ITEM_NOT_FOUND');
      if (!cfg.ok) { skipped.push(it.name); continue; }
      await this.upsertLine(db, cart, { itemId: menu!.id, variantId: variant?.id ?? null, modifierIds: modIds, instructions: it.special_instructions, quantity: it.quantity });
      const unitNow = (variant?.priceMinor ?? menu!.basePriceMinor) + cfg.modifiers.reduce((s, m) => s + m.priceDeltaMinor, 0);
      if (unitNow !== Number(it.unit_price_minor)) priceChanged.push(`${it.name}: ${formatMoney(Number(it.unit_price_minor), menu!.currency)} -> ${formatMoney(unitNow, menu!.currency)}`);
    }
    await this.touch(db, cart.id);
    return { ok: true as const, fromOrder: Number(o.order_number), skipped, priceChanged, cart: await this.view(db, scope) };
  }

  // -------------------------------------------------------------- memory ---
  async rememberAddress(db: Db, businessId: string, contactId: string, a: Record<string, unknown>) {
    const fp = createHash('sha256').update(JSON.stringify([a.house, a.street, a.locality, a.city, a.pincode].map((x) => String(x ?? '').toLowerCase().trim()))).digest('hex').slice(0, 32);
    await db.query(
      `INSERT INTO app.customer_addresses (organization_id, business_id, contact_id, address, pincode, latitude, longitude, fingerprint)
       VALUES (app.current_org_id(), $1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (contact_id, fingerprint) DO UPDATE SET last_used_at = now(), address = EXCLUDED.address`,
      [businessId, contactId, JSON.stringify(a), typeof a.pincode === 'string' ? a.pincode : null, typeof a.latitude === 'number' ? a.latitude : null,
       typeof a.longitude === 'number' ? a.longitude : null, fp]);
  }

  async memory(db: Db, businessId: string, contactId: string) {
    const p = (await db.query('SELECT preferred_language, food_preference, allergy_note, notes FROM app.customer_profiles WHERE contact_id = $1', [contactId])).rows[0] ?? null;
    const addresses = (await db.query('SELECT id, label, address FROM app.customer_addresses WHERE contact_id = $1 ORDER BY last_used_at DESC LIMIT 3', [contactId])).rows
      .map((x) => ({ savedAddressId: x.id, label: x.label, text: this.addressText(x.address) }));
    const orders = await this.customerOrders(db, businessId, contactId);
    return { preferences: p ? { language: p.preferred_language, food: p.food_preference, allergyNote: p.allergy_note, notes: p.notes } : null,
      savedAddresses: addresses, recentOrders: orders.slice(0, 3).map((o) => ({ orderNumber: o.orderNumber, status: o.status, items: o.items, total: o.total })) };
  }

  async savePreference(db: Db, businessId: string, contactId: string, p: { language?: string; food?: string; allergyNote?: string; notes?: string }) {
    await db.query(
      `INSERT INTO app.customer_profiles (organization_id, business_id, contact_id, preferred_language, food_preference, allergy_note, notes)
       VALUES (app.current_org_id(), $1, $2, $3, $4, $5, $6)
       ON CONFLICT (contact_id) DO UPDATE SET preferred_language = coalesce(EXCLUDED.preferred_language, app.customer_profiles.preferred_language),
         food_preference = coalesce(EXCLUDED.food_preference, app.customer_profiles.food_preference),
         allergy_note = coalesce(EXCLUDED.allergy_note, app.customer_profiles.allergy_note),
         notes = coalesce(EXCLUDED.notes, app.customer_profiles.notes), updated_by = 'AI'`,
      [businessId, contactId, p.language ?? null, p.food ?? null, p.allergyNote?.slice(0, 300) ?? null, p.notes?.slice(0, 500) ?? null]);
    return { ok: true as const, saved: true };
  }
}
