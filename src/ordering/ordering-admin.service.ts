import type { TenantContext } from '../database/tenant-context.js';
import type { Db, TransactionRunner } from '../database/transaction-runner.js';
import { MessagingRepository } from '../repositories/messaging.repository.js';
import { OpsRepository } from '../repositories/ops.repository.js';
import { OutboundMessageService } from '../services/outbound-message.service.js';
import { WhatsAppError } from '../whatsapp/domain/whatsapp-errors.js';
import { formatMoney } from './pricing.js';
import { PAYMENT_LABEL } from './ordering.service.js';

/*
 * Restaurant owner side (dashboard, hs_app, tenant RLS): menu, ordering
 * settings, coupons, the live order board and customer notifications.
 * Status updates message the customer on WhatsApp (origin SYSTEM, so they never
 * count as a human takeover).
 */
const bad = (m: string): never => { throw new WhatsAppError('VALIDATION_FAILED', m); };
const text = (v: unknown, f: string, max: number, required = false): string | null => {
  if (v === undefined || v === null || v === '') { if (required) bad(`${f} is required`); return null; }
  if (typeof v !== 'string' || v.trim().length === 0 || v.length > max) bad(`${f} must be 1-${max} characters`);
  return (v as string).trim();
};
const money = (v: unknown, f: string, required = false): number | null => {
  if (v === undefined || v === null || v === '') { if (required) bad(`${f} is required`); return null; }
  if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 100_000_000_00) bad(`${f} must be a non-negative amount in paise`);
  return v as number;
};
const int = (v: unknown, f: string, min: number, max: number, def?: number): number => {
  if (v === undefined || v === null || v === '') { if (def === undefined) bad(`${f} is required`); return def!; }
  if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) bad(`${f} must be ${min}-${max}`);
  return v as number;
};
const strList = (v: unknown, f: string, re: RegExp, max = 30): string[] => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > max || !v.every((x) => typeof x === 'string' && re.test(x.trim()))) bad(`${f} has an invalid value`);
  return Array.from(new Set((v as string[]).map((x) => x.trim())));
};

const TRANSITIONS: Record<string, string[]> = {
  PLACED: ['ACCEPTED', 'REJECTED', 'CANCELLED'],
  ACCEPTED: ['PREPARING', 'READY', 'CANCELLED'],
  PREPARING: ['READY', 'CANCELLED'],
  READY: ['OUT_FOR_DELIVERY', 'COMPLETED', 'DELIVERED', 'CANCELLED'],
  OUT_FOR_DELIVERY: ['DELIVERED', 'CANCELLED'],
  DELIVERED: ['COMPLETED'],
};
const ACTIVE = ['PLACED', 'ACCEPTED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY'];

function customerMessage(status: string, n: number, lang: 'hi' | 'en', mode: string, reason?: string | null): string | null {
  const hi: Record<string, string> = {
    ACCEPTED: `Aapka order #${n} restaurant ne accept kar liya hai ✅ Ab taiyaar ho raha hai.`,
    PREPARING: `Order #${n} ban raha hai 🍳`,
    READY: mode === 'DELIVERY' ? `Order #${n} ready hai, jaldi nikal raha hai.` : `Order #${n} ready hai ✅ Aap counter se le sakte hain.`,
    OUT_FOR_DELIVERY: `Order #${n} delivery ke liye nikal chuka hai 🛵`,
    DELIVERED: `Order #${n} deliver ho gaya. Enjoy your meal! 😊`,
    REJECTED: `Maaf kijiye, order #${n} abhi accept nahi ho paya.${reason ? ` Reason: ${reason}` : ''}`,
    CANCELLED: `Order #${n} cancel kar diya gaya hai.${reason ? ` Reason: ${reason}` : ''}`,
  };
  const en: Record<string, string> = {
    ACCEPTED: `Your order #${n} has been accepted ✅ It's being prepared now.`,
    PREPARING: `Order #${n} is being prepared 🍳`,
    READY: mode === 'DELIVERY' ? `Order #${n} is ready and will leave shortly.` : `Order #${n} is ready ✅ Please collect it at the counter.`,
    OUT_FOR_DELIVERY: `Order #${n} is out for delivery 🛵`,
    DELIVERED: `Order #${n} has been delivered. Enjoy your meal! 😊`,
    REJECTED: `Sorry, we couldn't accept order #${n}.${reason ? ` Reason: ${reason}` : ''}`,
    CANCELLED: `Order #${n} has been cancelled.${reason ? ` Reason: ${reason}` : ''}`,
  };
  return (lang === 'en' ? en : hi)[status] ?? null;
}

export class OrderingAdminService {
  private readonly ops = new OpsRepository();
  private readonly outbound: OutboundMessageService;

  constructor(private readonly tx: TransactionRunner) {
    this.outbound = new OutboundMessageService(tx, new MessagingRepository(), this.ops);
  }

  private async business(db: Db, ctx: TenantContext, businessId: string) {
    if (ctx.businessId && ctx.businessId !== businessId) throw new WhatsAppError('NOT_FOUND', 'business not found');
    const b = (await db.query('SELECT id, currency FROM app.businesses WHERE id = $1 AND deleted_at IS NULL', [businessId])).rows[0];
    if (!b) throw new WhatsAppError('NOT_FOUND', 'business not found');
    return b as { id: string; currency: string };
  }
  private audit(db: Db, ctx: TenantContext, action: string, type: string, id?: string, metadata: object = {}) {
    return this.ops.audit(db, { organizationId: ctx.organizationId, actorType: ctx.apiKeyId ? 'API_KEY' : 'USER', actorUserId: ctx.userId,
      actorApiKeyId: ctx.apiKeyId, action, resourceType: type, resourceId: id, requestId: ctx.requestId, metadata });
  }

  // ----------------------------------------------------------------- menu ---
  getMenu(ctx: TenantContext, businessId: string) {
    return this.tx.inTenant(async (db) => {
      await this.business(db, ctx, businessId);
      const categories = (await db.query(`SELECT id, name, description, display_order AS "displayOrder", active FROM app.menu_categories
                                          WHERE business_id = $1 AND deleted_at IS NULL ORDER BY display_order, name`, [businessId])).rows;
      const items = (await db.query(
        `SELECT i.id, i.category_id AS "categoryId", i.name, i.description, i.food_type AS "foodType", i.base_price_minor AS "basePriceMinor", i.currency,
                i.available, i.spice_level AS "spiceLevel", i.allergens, i.allergen_info_verified AS "allergenVerified", i.tags, i.prep_minutes AS "prepMinutes",
                i.display_order AS "displayOrder",
                coalesce((SELECT json_agg(json_build_object('id', v.id, 'name', v.name, 'priceMinor', v.price_minor, 'isDefault', v.is_default, 'available', v.available)
                                          ORDER BY v.display_order, v.price_minor) FROM app.menu_item_variants v WHERE v.item_id = i.id AND v.deleted_at IS NULL), '[]') AS variants,
                coalesce((SELECT array_agg(l.group_id) FROM app.menu_item_modifier_groups l WHERE l.item_id = i.id), '{}') AS "modifierGroupIds"
           FROM app.menu_items i WHERE i.business_id = $1 AND i.deleted_at IS NULL ORDER BY i.display_order, i.name`, [businessId])).rows
        .map((i) => ({ ...i, basePriceMinor: Number(i.basePriceMinor), variants: i.variants.map((v: any) => ({ ...v, priceMinor: Number(v.priceMinor) })) }));
      const groups = (await db.query(
        `SELECT g.id, g.name, g.min_select AS "minSelect", g.max_select AS "maxSelect",
                coalesce((SELECT json_agg(json_build_object('id', m.id, 'name', m.name, 'kind', m.kind, 'priceDeltaMinor', m.price_delta_minor, 'available', m.available)
                                          ORDER BY m.display_order, m.name) FROM app.menu_modifiers m WHERE m.group_id = g.id AND m.deleted_at IS NULL), '[]') AS modifiers
           FROM app.menu_modifier_groups g WHERE g.business_id = $1 AND g.deleted_at IS NULL ORDER BY g.name`, [businessId])).rows
        .map((g) => ({ ...g, modifiers: g.modifiers.map((m: any) => ({ ...m, priceDeltaMinor: Number(m.priceDeltaMinor) })) }));
      return { categories, items, modifierGroups: groups };
    }, ctx, { readOnly: true });
  }

  saveCategory(ctx: TenantContext, businessId: string, id: string | null, b: Record<string, unknown>) {
    const name = text(b.name, 'name', 100, true)!;
    const description = text(b.description, 'description', 500);
    const order = int(b.displayOrder, 'displayOrder', 0, 10000, 100);
    const active = b.active === undefined ? true : Boolean(b.active);
    return this.tx.inTenant(async (db) => {
      await this.business(db, ctx, businessId);
      if (id) {
        const r = await db.query(`UPDATE app.menu_categories SET name = $2, description = $3, display_order = $4, active = $5 WHERE id = $1 AND business_id = $6 AND deleted_at IS NULL`,
          [id, name, description, order, active, businessId]);
        if (!r.rowCount) throw new WhatsAppError('NOT_FOUND', 'category not found');
        return { id };
      }
      const r = await db.query(`INSERT INTO app.menu_categories (organization_id, business_id, name, description, display_order, active)
                                VALUES (app.current_org_id(), $1, $2, $3, $4, $5) RETURNING id`, [businessId, name, description, order, active]);
      await this.audit(db, ctx, 'MENU_CATEGORY_CREATED', 'MENU_CATEGORY', r.rows[0].id);
      return { id: r.rows[0].id };
    }, ctx);
  }

  deleteCategory(ctx: TenantContext, businessId: string, id: string) {
    return this.tx.inTenant(async (db) => {
      await this.business(db, ctx, businessId);
      const r = await db.query('UPDATE app.menu_categories SET deleted_at = now() WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL', [id, businessId]);
      if (!r.rowCount) throw new WhatsAppError('NOT_FOUND', 'category not found');
      await db.query('UPDATE app.menu_items SET category_id = NULL WHERE category_id = $1', [id]);
      return { deleted: true };
    }, ctx);
  }

  saveItem(ctx: TenantContext, businessId: string, id: string | null, b: Record<string, unknown>) {
    const name = text(b.name, 'name', 150, true)!;
    const description = text(b.description, 'description', 1000);
    const foodType = String(b.foodType ?? 'VEG');
    if (!['VEG', 'NON_VEG', 'EGG', 'VEGAN'].includes(foodType)) bad('foodType must be VEG, NON_VEG, EGG or VEGAN');
    const variantsIn = Array.isArray(b.variants) ? b.variants as Array<Record<string, unknown>> : [];
    if (variantsIn.length > 10) bad('at most 10 sizes/variants');
    const variants = variantsIn.map((v, i) => ({ id: typeof v.id === 'string' ? v.id : null, name: text(v.name, `variants[${i}].name`, 60, true)!,
      priceMinor: money(v.priceMinor, `variants[${i}].priceMinor`, true)!, isDefault: Boolean(v.isDefault), available: v.available === undefined ? true : Boolean(v.available) }));
    if (variants.filter((v) => v.isDefault).length > 1) bad('only one default size');
    if (new Set(variants.map((v) => v.name.toLowerCase())).size !== variants.length) bad('size names must be unique');
    const basePrice = variants.length ? (money(b.basePriceMinor, 'basePriceMinor') ?? Math.min(...variants.map((v) => v.priceMinor))) : money(b.basePriceMinor, 'basePriceMinor', true)!;
    const spice = b.spiceLevel === undefined || b.spiceLevel === null || b.spiceLevel === '' ? null : int(b.spiceLevel, 'spiceLevel', 0, 5);
    const prep = b.prepMinutes === undefined || b.prepMinutes === null || b.prepMinutes === '' ? null : int(b.prepMinutes, 'prepMinutes', 1, 600);
    const allergens = strList(b.allergens, 'allergens', /^[\p{L} -]{2,40}$/u);
    const tags = strList(b.tags, 'tags', /^[\p{L}\p{N} -]{2,30}$/u);
    const groupIds = strList(b.modifierGroupIds, 'modifierGroupIds', /^[0-9a-f-]{36}$/i, 20);
    const categoryId = typeof b.categoryId === 'string' && b.categoryId ? b.categoryId : null;
    return this.tx.inTenant(async (db) => {
      const biz = await this.business(db, ctx, businessId);
      if (categoryId && !(await db.query('SELECT 1 FROM app.menu_categories WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL', [categoryId, businessId])).rowCount) {
        throw new WhatsAppError('NOT_FOUND', 'category not found');
      }
      const params = [name, description, foodType, basePrice, b.available === undefined ? true : Boolean(b.available), spice, allergens, Boolean(b.allergenVerified),
        tags, prep, int(b.displayOrder, 'displayOrder', 0, 10000, 100), categoryId];
      let itemId = id;
      if (itemId) {
        const r = await db.query(`UPDATE app.menu_items SET name = $2, description = $3, food_type = $4, base_price_minor = $5, available = $6, spice_level = $7,
                                    allergens = $8, allergen_info_verified = $9, tags = $10, prep_minutes = $11, display_order = $12, category_id = $13
                                   WHERE id = $1 AND business_id = $14 AND deleted_at IS NULL`, [itemId, ...params, businessId]);
        if (!r.rowCount) throw new WhatsAppError('NOT_FOUND', 'dish not found');
      } else {
        itemId = (await db.query(`INSERT INTO app.menu_items (organization_id, business_id, name, description, food_type, base_price_minor, available, spice_level,
                                     allergens, allergen_info_verified, tags, prep_minutes, display_order, category_id, currency)
                                   VALUES (app.current_org_id(), $13, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $14) RETURNING id`, [...params, businessId, biz.currency])).rows[0].id;
      }
      // Variants: update kept, insert new, soft-delete removed. Old carts keep working until the dish is re-saved.
      const keep = variants.filter((v) => v.id).map((v) => v.id);
      await db.query(`UPDATE app.menu_item_variants SET deleted_at = now(), is_default = false WHERE item_id = $1 AND deleted_at IS NULL AND NOT (id = ANY($2::uuid[]))`, [itemId, keep]);
      await db.query('UPDATE app.menu_item_variants SET is_default = false WHERE item_id = $1', [itemId]);
      for (const [i, v] of variants.entries()) {
        if (v.id) {
          const r = await db.query(`UPDATE app.menu_item_variants SET name = $2, price_minor = $3, is_default = $4, available = $5, display_order = $6
                                     WHERE id = $1 AND item_id = $7 AND deleted_at IS NULL`, [v.id, v.name, v.priceMinor, v.isDefault, v.available, i, itemId]);
          if (!r.rowCount) throw new WhatsAppError('NOT_FOUND', 'size not found');
        } else {
          await db.query(`INSERT INTO app.menu_item_variants (organization_id, business_id, item_id, name, price_minor, is_default, available, display_order)
                          VALUES (app.current_org_id(), $1, $2, $3, $4, $5, $6, $7)`, [businessId, itemId, v.name, v.priceMinor, v.isDefault, v.available, i]);
        }
      }
      await db.query('DELETE FROM app.menu_item_modifier_groups WHERE item_id = $1', [itemId]);
      if (groupIds.length) {
        const n = (await db.query('SELECT count(*)::int AS n FROM app.menu_modifier_groups WHERE id = ANY($1::uuid[]) AND business_id = $2 AND deleted_at IS NULL', [groupIds, businessId])).rows[0].n;
        if (n !== groupIds.length) bad('some add-on groups do not belong to this business');
        await db.query(`INSERT INTO app.menu_item_modifier_groups (organization_id, business_id, item_id, group_id)
                        SELECT app.current_org_id(), $1, $2, g FROM unnest($3::uuid[]) g`, [businessId, itemId, groupIds]);
      }
      await this.audit(db, ctx, id ? 'MENU_ITEM_UPDATED' : 'MENU_ITEM_CREATED', 'MENU_ITEM', itemId!);
      return { id: itemId };
    }, ctx);
  }

  setItemAvailability(ctx: TenantContext, businessId: string, id: string, available: boolean) {
    return this.tx.inTenant(async (db) => {
      await this.business(db, ctx, businessId);
      const r = await db.query('UPDATE app.menu_items SET available = $2 WHERE id = $1 AND business_id = $3 AND deleted_at IS NULL', [id, available, businessId]);
      if (!r.rowCount) throw new WhatsAppError('NOT_FOUND', 'dish not found');
      await this.audit(db, ctx, available ? 'MENU_ITEM_AVAILABLE' : 'MENU_ITEM_SOLD_OUT', 'MENU_ITEM', id);
      return { id, available };
    }, ctx);
  }

  deleteItem(ctx: TenantContext, businessId: string, id: string) {
    return this.tx.inTenant(async (db) => {
      await this.business(db, ctx, businessId);
      const r = await db.query('UPDATE app.menu_items SET deleted_at = now(), available = false WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL', [id, businessId]);
      if (!r.rowCount) throw new WhatsAppError('NOT_FOUND', 'dish not found');
      await this.audit(db, ctx, 'MENU_ITEM_DELETED', 'MENU_ITEM', id);
      return { deleted: true };
    }, ctx);
  }

  saveModifierGroup(ctx: TenantContext, businessId: string, id: string | null, b: Record<string, unknown>) {
    const name = text(b.name, 'name', 60, true)!;
    const minSelect = int(b.minSelect, 'minSelect', 0, 20, 0);
    const maxSelect = int(b.maxSelect, 'maxSelect', 1, 20, 5);
    if (minSelect > maxSelect) bad('minimum cannot be more than maximum');
    const mods = (Array.isArray(b.modifiers) ? b.modifiers as Array<Record<string, unknown>> : []).map((m, i) => {
      const kind = String(m.kind ?? 'ADD');
      if (!['ADD', 'REMOVE', 'CHOICE'].includes(kind)) bad('kind must be ADD, REMOVE or CHOICE');
      const delta = m.priceDeltaMinor === undefined || m.priceDeltaMinor === '' ? 0 : m.priceDeltaMinor;
      if (!Number.isInteger(delta) || Math.abs(delta as number) > 1_000_000) bad(`modifiers[${i}].priceDeltaMinor is invalid`);
      return { id: typeof m.id === 'string' ? m.id : null, name: text(m.name, `modifiers[${i}].name`, 60, true)!, kind, priceDeltaMinor: delta as number,
        available: m.available === undefined ? true : Boolean(m.available) };
    });
    if (mods.length === 0 || mods.length > 40) bad('add 1-40 options');
    return this.tx.inTenant(async (db) => {
      await this.business(db, ctx, businessId);
      let gid = id;
      if (gid) {
        const r = await db.query(`UPDATE app.menu_modifier_groups SET name = $2, min_select = $3, max_select = $4 WHERE id = $1 AND business_id = $5 AND deleted_at IS NULL`,
          [gid, name, minSelect, maxSelect, businessId]);
        if (!r.rowCount) throw new WhatsAppError('NOT_FOUND', 'add-on group not found');
      } else {
        gid = (await db.query(`INSERT INTO app.menu_modifier_groups (organization_id, business_id, name, min_select, max_select) VALUES (app.current_org_id(), $1, $2, $3, $4) RETURNING id`,
          [businessId, name, minSelect, maxSelect])).rows[0].id;
      }
      const keep = mods.filter((m) => m.id).map((m) => m.id);
      await db.query(`UPDATE app.menu_modifiers SET deleted_at = now() WHERE group_id = $1 AND deleted_at IS NULL AND NOT (id = ANY($2::uuid[]))`, [gid, keep]);
      for (const [i, m] of mods.entries()) {
        if (m.id) {
          await db.query(`UPDATE app.menu_modifiers SET name = $2, kind = $3, price_delta_minor = $4, available = $5, display_order = $6 WHERE id = $1 AND group_id = $7`,
            [m.id, m.name, m.kind, m.priceDeltaMinor, m.available, i, gid]);
        } else {
          await db.query(`INSERT INTO app.menu_modifiers (organization_id, business_id, group_id, name, kind, price_delta_minor, available, display_order)
                          VALUES (app.current_org_id(), $1, $2, $3, $4, $5, $6, $7)`, [businessId, gid, m.name, m.kind, m.priceDeltaMinor, m.available, i]);
        }
      }
      await this.audit(db, ctx, id ? 'MODIFIER_GROUP_UPDATED' : 'MODIFIER_GROUP_CREATED', 'MODIFIER_GROUP', gid!);
      return { id: gid };
    }, ctx);
  }

  deleteModifierGroup(ctx: TenantContext, businessId: string, id: string) {
    return this.tx.inTenant(async (db) => {
      await this.business(db, ctx, businessId);
      const r = await db.query('UPDATE app.menu_modifier_groups SET deleted_at = now() WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL', [id, businessId]);
      if (!r.rowCount) throw new WhatsAppError('NOT_FOUND', 'add-on group not found');
      await db.query('DELETE FROM app.menu_item_modifier_groups WHERE group_id = $1', [id]);
      return { deleted: true };
    }, ctx);
  }

  // ------------------------------------------------------------- settings ---
  getSettings(ctx: TenantContext, businessId: string) {
    return this.tx.inTenant(async (db) => {
      const biz = await this.business(db, ctx, businessId);
      const r = (await db.query('SELECT * FROM app.ordering_settings WHERE business_id = $1', [businessId])).rows[0];
      if (!r) return { configured: false, enabled: false, fulfillmentModes: ['PICKUP'], paymentMethods: ['PAY_AT_PICKUP'], currency: biz.currency, taxRateBps: 500,
        taxInclusive: false, packagingFeeMinor: 0, minOrderMinor: 0, deliveryFeeMinor: 0, freeDeliveryAboveMinor: null, deliveryPincodes: [], deliveryRadiusKm: null,
        prepTimeMinutes: 30, schedulingEnabled: false, maxScheduleDays: 2, quoteTtlMinutes: 15, autoCancelBeforeAccept: true };
      return { configured: true, enabled: r.enabled, fulfillmentModes: r.fulfillment_modes, paymentMethods: r.payment_methods, currency: r.currency, taxRateBps: r.tax_rate_bps,
        taxInclusive: r.tax_inclusive, packagingFeeMinor: Number(r.packaging_fee_minor), minOrderMinor: Number(r.min_order_minor), deliveryFeeMinor: Number(r.delivery_fee_minor),
        freeDeliveryAboveMinor: r.free_delivery_above_minor === null ? null : Number(r.free_delivery_above_minor), deliveryPincodes: r.delivery_pincodes,
        deliveryRadiusKm: r.delivery_radius_km === null ? null : Number(r.delivery_radius_km), prepTimeMinutes: r.prep_time_minutes, schedulingEnabled: r.scheduling_enabled,
        maxScheduleDays: r.max_schedule_days, quoteTtlMinutes: r.quote_ttl_minutes, autoCancelBeforeAccept: r.auto_cancel_before_accept };
    }, ctx, { readOnly: true });
  }

  saveSettings(ctx: TenantContext, businessId: string, b: Record<string, unknown>) {
    const modes = strList(b.fulfillmentModes, 'fulfillmentModes', /^(DELIVERY|PICKUP|DINE_IN)$/, 3);
    if (!modes.length) bad('choose at least one of delivery, pickup or dine-in');
    const pays = strList(b.paymentMethods, 'paymentMethods', /^(COD|PAY_AT_PICKUP)$/, 2);
    if (modes.includes('DELIVERY') && !pays.includes('COD')) bad('delivery needs Cash on Delivery (online payment is not available yet)');
    if ((modes.includes('PICKUP') || modes.includes('DINE_IN')) && !pays.includes('PAY_AT_PICKUP')) bad('pickup/dine-in need "Pay at counter"');
    const pins = strList(b.deliveryPincodes, 'deliveryPincodes', /^[0-9]{4,10}$/, 500);
    const radius = b.deliveryRadiusKm === undefined || b.deliveryRadiusKm === null || b.deliveryRadiusKm === '' ? null : Number(b.deliveryRadiusKm);
    if (radius !== null && (!Number.isFinite(radius) || radius < 0.1 || radius > 100)) bad('delivery radius must be 0.1-100 km');
    const free = money(b.freeDeliveryAboveMinor, 'freeDeliveryAboveMinor');
    const v = [Boolean(b.enabled), modes, pays, int(b.taxRateBps, 'taxRateBps', 0, 5000, 500), Boolean(b.taxInclusive), money(b.packagingFeeMinor, 'packagingFeeMinor') ?? 0,
      money(b.minOrderMinor, 'minOrderMinor') ?? 0, money(b.deliveryFeeMinor, 'deliveryFeeMinor') ?? 0, free, pins, radius, int(b.prepTimeMinutes, 'prepTimeMinutes', 1, 600, 30),
      Boolean(b.schedulingEnabled), int(b.maxScheduleDays, 'maxScheduleDays', 0, 30, 2), int(b.quoteTtlMinutes, 'quoteTtlMinutes', 1, 120, 15),
      b.autoCancelBeforeAccept === undefined ? true : Boolean(b.autoCancelBeforeAccept)];
    return this.tx.inTenant(async (db) => {
      const biz = await this.business(db, ctx, businessId);
      await db.query(
        `INSERT INTO app.ordering_settings (business_id, organization_id, currency, enabled, fulfillment_modes, payment_methods, tax_rate_bps, tax_inclusive, packaging_fee_minor,
                                            min_order_minor, delivery_fee_minor, free_delivery_above_minor, delivery_pincodes, delivery_radius_km, prep_time_minutes,
                                            scheduling_enabled, max_schedule_days, quote_ttl_minutes, auto_cancel_before_accept)
         VALUES ($1, app.current_org_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
         ON CONFLICT (business_id) DO UPDATE SET enabled = EXCLUDED.enabled, fulfillment_modes = EXCLUDED.fulfillment_modes, payment_methods = EXCLUDED.payment_methods,
           tax_rate_bps = EXCLUDED.tax_rate_bps, tax_inclusive = EXCLUDED.tax_inclusive, packaging_fee_minor = EXCLUDED.packaging_fee_minor,
           min_order_minor = EXCLUDED.min_order_minor, delivery_fee_minor = EXCLUDED.delivery_fee_minor, free_delivery_above_minor = EXCLUDED.free_delivery_above_minor,
           delivery_pincodes = EXCLUDED.delivery_pincodes, delivery_radius_km = EXCLUDED.delivery_radius_km, prep_time_minutes = EXCLUDED.prep_time_minutes,
           scheduling_enabled = EXCLUDED.scheduling_enabled, max_schedule_days = EXCLUDED.max_schedule_days, quote_ttl_minutes = EXCLUDED.quote_ttl_minutes,
           auto_cancel_before_accept = EXCLUDED.auto_cancel_before_accept`,
        [businessId, biz.currency, ...v]);
      await this.audit(db, ctx, 'ORDERING_SETTINGS_UPDATED', 'BUSINESS', businessId, { enabled: String(v[0]) });
      return { saved: true };
    }, ctx);
  }

  // -------------------------------------------------------------- coupons ---
  listCoupons(ctx: TenantContext, businessId: string) {
    return this.tx.inTenant(async (db) => {
      await this.business(db, ctx, businessId);
      return (await db.query(
        `SELECT c.id, c.code, c.description, c.discount_type AS "discountType", c.discount_value AS "discountValue", c.max_discount_minor AS "maxDiscountMinor",
                c.min_order_minor AS "minOrderMinor", c.valid_from AS "validFrom", c.valid_until AS "validUntil", c.usage_limit AS "usageLimit",
                c.per_customer_limit AS "perCustomerLimit", c.active,
                (SELECT count(*)::int FROM app.orders o WHERE o.business_id = c.business_id AND o.coupon_code = c.code AND o.status NOT IN ('CANCELLED','REJECTED')) AS used
           FROM app.coupons c WHERE c.business_id = $1 ORDER BY c.created_at DESC`, [businessId])).rows
        .map((c) => ({ ...c, discountValue: Number(c.discountValue), maxDiscountMinor: c.maxDiscountMinor === null ? null : Number(c.maxDiscountMinor), minOrderMinor: Number(c.minOrderMinor) }));
    }, ctx, { readOnly: true });
  }

  saveCoupon(ctx: TenantContext, businessId: string, id: string | null, b: Record<string, unknown>) {
    const code = String(b.code ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9_-]{2,30}$/.test(code)) bad('code: 2-30 letters, digits, - or _');
    const type = String(b.discountType ?? '');
    if (!['PERCENT', 'FLAT'].includes(type)) bad('discountType must be PERCENT or FLAT');
    const value = int(b.discountValue, 'discountValue', 1, type === 'PERCENT' ? 10000 : 100_000_000_00);
    const from = b.validFrom ? new Date(String(b.validFrom)) : null;
    const until = b.validUntil ? new Date(String(b.validUntil)) : null;
    if ((from && Number.isNaN(+from)) || (until && Number.isNaN(+until)) || (from && until && from >= until)) bad('invalid validity dates');
    const params = [code, text(b.description, 'description', 300), type, value, money(b.maxDiscountMinor, 'maxDiscountMinor'), money(b.minOrderMinor, 'minOrderMinor') ?? 0,
      from, until, b.usageLimit ? int(b.usageLimit, 'usageLimit', 1, 1_000_000) : null, b.perCustomerLimit ? int(b.perCustomerLimit, 'perCustomerLimit', 1, 1000) : null,
      b.active === undefined ? true : Boolean(b.active)];
    return this.tx.inTenant(async (db) => {
      await this.business(db, ctx, businessId);
      try {
        if (id) {
          const r = await db.query(`UPDATE app.coupons SET code = $2, description = $3, discount_type = $4, discount_value = $5, max_discount_minor = $6, min_order_minor = $7,
                                      valid_from = $8, valid_until = $9, usage_limit = $10, per_customer_limit = $11, active = $12 WHERE id = $1 AND business_id = $13`, [id, ...params, businessId]);
          if (!r.rowCount) throw new WhatsAppError('NOT_FOUND', 'coupon not found');
          return { id };
        }
        const r = await db.query(`INSERT INTO app.coupons (organization_id, business_id, code, description, discount_type, discount_value, max_discount_minor, min_order_minor,
                                    valid_from, valid_until, usage_limit, per_customer_limit, active) VALUES (app.current_org_id(), $12, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
          [...params, businessId]);
        await this.audit(db, ctx, 'COUPON_CREATED', 'COUPON', r.rows[0].id, { code });
        return { id: r.rows[0].id };
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new WhatsAppError('CONFLICT', 'A coupon with this code already exists.');
        throw e;
      }
    }, ctx);
  }

  // --------------------------------------------------------------- orders ---
  listOrders(ctx: TenantContext, q: { businessId?: string; view: 'ACTIVE' | 'DONE' | 'CANCELLED' | 'ALL' }) {
    const statuses = q.view === 'ACTIVE' ? ACTIVE : q.view === 'DONE' ? ['DELIVERED', 'COMPLETED'] : q.view === 'CANCELLED' ? ['CANCELLED', 'REJECTED'] : null;
    return this.tx.inTenant(async (db) => (await db.query(
      `SELECT o.id, o.order_number AS "orderNumber", o.status, o.fulfillment_mode AS "fulfillmentMode", o.payment_method AS "paymentMethod", o.payment_status AS "paymentStatus",
              o.total_minor AS "totalMinor", o.currency, o.customer_name AS "customerName", o.customer_phone AS "customerPhone", o.placed_at AS "placedAt",
              o.scheduled_for AS "scheduledFor", b.name AS "businessName", o.business_id AS "businessId", o.conversation_id AS "conversationId",
              coalesce((SELECT string_agg(i.quantity || ' x ' || i.name || coalesce(' (' || i.variant_name || ')', ''), ', ' ORDER BY i.position) FROM app.order_items i WHERE i.order_id = o.id), '') AS items,
              (SELECT count(*)::int FROM app.order_change_requests r WHERE r.order_id = o.id AND r.status = 'PENDING') AS "pendingRequests"
         FROM app.orders o JOIN app.businesses b ON b.id = o.business_id
        WHERE ($1::uuid IS NULL OR o.business_id = $1) AND ($2::text[] IS NULL OR o.status = ANY($2))
        ORDER BY CASE WHEN o.status = 'PLACED' THEN 0 ELSE 1 END, o.placed_at DESC LIMIT 200`,
      [ctx.businessId ?? q.businessId ?? null, statuses])).rows.map((o) => ({ ...o, orderNumber: Number(o.orderNumber), totalMinor: Number(o.totalMinor),
        total: formatMoney(Number(o.totalMinor), o.currency) })), ctx, { readOnly: true });
  }

  getOrder(ctx: TenantContext, id: string) {
    return this.tx.inTenant(async (db) => {
      const o = (await db.query('SELECT o.*, b.name AS business_name FROM app.orders o JOIN app.businesses b ON b.id = o.business_id WHERE o.id = $1', [id])).rows[0];
      if (!o || (ctx.businessId && o.business_id !== ctx.businessId)) throw new WhatsAppError('NOT_FOUND', 'order not found');
      const items = (await db.query(`SELECT name, variant_name AS "variantName", modifiers, special_instructions AS "instructions", quantity, unit_price_minor AS "unitPriceMinor",
                                            line_total_minor AS "lineTotalMinor" FROM app.order_items WHERE order_id = $1 ORDER BY position`, [id])).rows
        .map((i) => ({ ...i, unitPriceMinor: Number(i.unitPriceMinor), lineTotalMinor: Number(i.lineTotalMinor) }));
      const events = (await db.query(`SELECT from_status AS "from", to_status AS "to", actor_type AS actor, note, created_at AS at FROM app.order_events WHERE order_id = $1 ORDER BY created_at`, [id])).rows;
      const requests = (await db.query(`SELECT id, kind, details, status, requested_by AS "requestedBy", resolution_note AS "resolutionNote", created_at AS "createdAt", resolved_at AS "resolvedAt"
                                         FROM app.order_change_requests WHERE order_id = $1 ORDER BY created_at DESC`, [id])).rows;
      const n = (x: unknown) => Number(x);
      return { id: o.id, orderNumber: n(o.order_number), status: o.status, businessName: o.business_name, fulfillmentMode: o.fulfillment_mode, scheduledFor: o.scheduled_for,
        address: o.address, customerName: o.customer_name, customerPhone: o.customer_phone, paymentMethod: o.payment_method, paymentMethodLabel: PAYMENT_LABEL[o.payment_method],
        paymentStatus: o.payment_status, couponCode: o.coupon_code, currency: o.currency, subtotalMinor: n(o.subtotal_minor), discountMinor: n(o.discount_minor),
        packagingMinor: n(o.packaging_minor), deliveryFeeMinor: n(o.delivery_fee_minor), taxMinor: n(o.tax_minor), totalMinor: n(o.total_minor), source: o.source,
        cancelReason: o.cancel_reason, placedAt: o.placed_at, conversationId: o.conversation_id, items, events, requests,
        nextStatuses: (TRANSITIONS[o.status] ?? []).filter((s) => !(s === 'OUT_FOR_DELIVERY' && o.fulfillment_mode !== 'DELIVERY') && !(s === 'DELIVERED' && o.fulfillment_mode !== 'DELIVERY')
          && !(s === 'COMPLETED' && o.status === 'READY' && o.fulfillment_mode === 'DELIVERY')) };
    }, ctx, { readOnly: true });
  }

  /** Staff moves an order along; the customer gets a WhatsApp update in the same transaction (via the outbox). */
  async updateStatus(ctx: TenantContext, id: string, to: string, note?: string | null) {
    await this.tx.inTenant(async (db) => {
      const o = (await db.query('SELECT * FROM app.orders WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!o || (ctx.businessId && o.business_id !== ctx.businessId)) throw new WhatsAppError('NOT_FOUND', 'order not found');
      if (!(TRANSITIONS[o.status] ?? []).includes(to)) throw new WhatsAppError('CONFLICT', `A ${o.status.toLowerCase().replace(/_/g, ' ')} order cannot become ${to.toLowerCase().replace(/_/g, ' ')}.`);
      const reason = note ? note.slice(0, 300) : null;
      await db.query(
        `UPDATE app.orders SET status = $2,
                accepted_at = CASE WHEN $2 = 'ACCEPTED' THEN now() ELSE accepted_at END, ready_at = CASE WHEN $2 = 'READY' THEN now() ELSE ready_at END,
                completed_at = CASE WHEN $2 IN ('DELIVERED','COMPLETED') THEN now() ELSE completed_at END,
                cancelled_at = CASE WHEN $2 IN ('CANCELLED','REJECTED') THEN now() ELSE cancelled_at END,
                cancel_reason = CASE WHEN $2 IN ('CANCELLED','REJECTED') THEN $3 ELSE cancel_reason END WHERE id = $1`, [id, to, reason]);
      await db.query(`INSERT INTO app.order_events (organization_id, order_id, from_status, to_status, actor_type, actor_user_id, note) VALUES (app.current_org_id(), $1, $2, $3, 'USER', $4, $5)`,
        [id, o.status, to, ctx.userId ?? null, reason]);
      await this.notifyCustomer(db, o, to, reason);
      await this.audit(db, ctx, `ORDER_${to}`, 'ORDER', id);
    }, ctx);
    return this.getOrder(ctx, id);
  }

  private async notifyCustomer(db: Db, o: any, status: string, reason: string | null) {
    if (!o.conversation_id) return;
    const lang = (await db.query('SELECT preferred_language FROM app.customer_profiles WHERE contact_id = $1', [o.contact_id])).rows[0]?.preferred_language === 'en' ? 'en' : 'hi';
    const msg = customerMessage(status, Number(o.order_number), lang, o.fulfillment_mode, reason);
    if (!msg) return;
    try {
      await this.outbound.enqueueTextInTx(db, { conversationId: o.conversation_id, text: msg, idempotencyKey: `order-status:${o.id}:${status}`, origin: 'SYSTEM' });
    } catch { /* WhatsApp not paired any more: the status change itself still stands */ }
  }

  async markPaid(ctx: TenantContext, id: string) {
    await this.tx.inTenant(async (db) => {
      const r = await db.query(`UPDATE app.orders SET payment_status = 'PAID' WHERE id = $1 AND payment_status = 'PENDING' AND ($2::uuid IS NULL OR business_id = $2) RETURNING id`,
        [id, ctx.businessId ?? null]);
      if (!r.rowCount) throw new WhatsAppError('CONFLICT', 'Order not found or already marked paid.');
      await db.query(`INSERT INTO app.order_events (organization_id, order_id, from_status, to_status, actor_type, actor_user_id, note)
                      SELECT app.current_org_id(), id, status, status, 'USER', $2, 'Payment received' FROM app.orders WHERE id = $1`, [id, ctx.userId ?? null]);
      await this.audit(db, ctx, 'ORDER_MARKED_PAID', 'ORDER', id);
    }, ctx);
    return this.getOrder(ctx, id);
  }

  async resolveRequest(ctx: TenantContext, requestId: string, approve: boolean, note?: string | null) {
    const orderId = await this.tx.inTenant(async (db) => {
      const r = (await db.query(`SELECT r.*, o.status AS order_status, o.business_id FROM app.order_change_requests r JOIN app.orders o ON o.id = r.order_id WHERE r.id = $1 FOR UPDATE OF r`, [requestId])).rows[0];
      if (!r || (ctx.businessId && r.business_id !== ctx.businessId)) throw new WhatsAppError('NOT_FOUND', 'request not found');
      if (r.status !== 'PENDING') throw new WhatsAppError('CONFLICT', 'This request was already handled.');
      await db.query(`UPDATE app.order_change_requests SET status = $2, resolution_note = $3, resolved_by_user_id = $4, resolved_at = now() WHERE id = $1`,
        [requestId, approve ? 'APPROVED' : 'REJECTED', note?.slice(0, 500) ?? null, ctx.userId ?? null]);
      const o = (await db.query('SELECT * FROM app.orders WHERE id = $1', [r.order_id])).rows[0];
      if (approve && r.kind === 'CANCEL' && !['CANCELLED', 'REJECTED', 'DELIVERED', 'COMPLETED'].includes(o.status)) {
        await db.query(`UPDATE app.orders SET status = 'CANCELLED', cancelled_at = now(), cancel_reason = $2 WHERE id = $1`, [o.id, r.details.slice(0, 300)]);
        await db.query(`INSERT INTO app.order_events (organization_id, order_id, from_status, to_status, actor_type, actor_user_id, note) VALUES (app.current_org_id(), $1, $2, 'CANCELLED', 'USER', $3, 'Customer request approved')`,
          [o.id, o.status, ctx.userId ?? null]);
        await this.notifyCustomer(db, o, 'CANCELLED', null);
      } else if (o.conversation_id) {
        const n = Number(o.order_number);
        const msg = approve ? `Order #${n}: aapki request approve ho gayi hai ✅${note ? ` ${note}` : ''}` : `Order #${n}: maaf kijiye, aapki request approve nahi ho payi.${note ? ` ${note}` : ''}`;
        try { await this.outbound.enqueueTextInTx(db, { conversationId: o.conversation_id, text: msg, idempotencyKey: `order-request:${requestId}`, origin: 'SYSTEM' }); } catch { /* ignore */ }
      }
      await this.audit(db, ctx, approve ? 'ORDER_REQUEST_APPROVED' : 'ORDER_REQUEST_REJECTED', 'ORDER', o.id);
      return o.id as string;
    }, ctx);
    return this.getOrder(ctx, orderId);
  }

  listTickets(ctx: TenantContext, q: { businessId?: string; open: boolean }) {
    return this.tx.inTenant(async (db) => (await db.query(
      `SELECT t.id, t.category, t.description, t.priority, t.status, t.created_at AS "createdAt", t.conversation_id AS "conversationId",
              o.order_number AS "orderNumber", coalesce(c.display_name, c.profile_name, c.phone_e164) AS customer
         FROM app.support_tickets t LEFT JOIN app.orders o ON o.id = t.order_id LEFT JOIN app.contacts c ON c.id = t.contact_id
        WHERE ($1::uuid IS NULL OR t.business_id = $1) AND ($2 = false OR t.status <> 'RESOLVED')
        ORDER BY t.created_at DESC LIMIT 200`, [ctx.businessId ?? q.businessId ?? null, q.open])).rows
      .map((t) => ({ ...t, orderNumber: t.orderNumber === null ? null : Number(t.orderNumber) })), ctx, { readOnly: true });
  }

  setTicketStatus(ctx: TenantContext, id: string, status: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED') {
    return this.tx.inTenant(async (db) => {
      const r = await db.query(`UPDATE app.support_tickets SET status = $2, resolved_at = CASE WHEN $2 = 'RESOLVED' THEN now() END
                                 WHERE id = $1 AND ($3::uuid IS NULL OR business_id = $3)`, [id, status, ctx.businessId ?? null]);
      if (!r.rowCount) throw new WhatsAppError('NOT_FOUND', 'ticket not found');
      return { id, status };
    }, ctx);
  }
}
