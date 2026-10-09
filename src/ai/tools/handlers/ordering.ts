import type { CartOwner, Scope } from '../../../ordering/ordering.service.js';
import { fail, ok, withDb, type AssistantTool, type ToolDeps, type ToolExecutionContext, type ToolOutcome } from '../types.js';

/*
 * Restaurant ordering capabilities (thin, business-level wrappers over
 * OrderingService). The cart always belongs to ctx.contactId (live) or the
 * test session (Test Assistant) - the model can never address another cart.
 * Totals are ONLY what the pricing engine returns.
 */

function owner(ctx: ToolExecutionContext): CartOwner | null {
  if (ctx.contactId) return { contactId: ctx.contactId };
  if (ctx.testSessionId) return { testSessionId: ctx.testSessionId };
  return null;
}
const scopeOf = (ctx: ToolExecutionContext): Scope | null => {
  const o = owner(ctx);
  return o ? { businessId: ctx.businessId, owner: o, conversationId: ctx.conversationId } : null;
};
/** Map OrderingService results ({ok:false,...} | {ok:true,...}) onto tool outcomes. */
function out(r: { ok: boolean } & Record<string, unknown>, effects?: ToolOutcome['effects']): ToolOutcome {
  const { ok: success, errorCode, message, ...rest } = r as Record<string, unknown>;
  if (!success) return fail(String(errorCode ?? 'FAILED'), message as string | undefined, rest);
  // The cart's ready-to-send layout goes to the top level: "display" = the message to send verbatim.
  const cart = rest.cart as Record<string, unknown> | undefined;
  if (cart && typeof cart.display === 'string' && rest.display === undefined) {
    const { display, totals: _totals, ...cartRest } = cart;
    return ok({ display, ...rest, cart: cartRest }, effects);
  }
  return ok(rest, effects);
}
function cartTool<I>(handlerKey: string, run: (db: any, deps: ToolDeps, scope: Scope, input: I, ctx: ToolExecutionContext) => Promise<any>, write = true): AssistantTool<I> {
  return {
    handlerKey, isReadOnly: !write, sandboxSafe: write,
    async execute(ctx, input, deps) {
      const scope = scopeOf(ctx);
      if (!scope) return fail('NO_CUSTOMER');
      return out(await withDb(ctx, deps, (db) => run(db, deps, scope, input, ctx), !write), write ? { wrote: true } : undefined);
    },
  };
}

export const searchMenu: AssistantTool<{ query?: string; category?: string; veg_only?: boolean; food_type?: string; max_price?: number; limit?: number }> = {
  handlerKey: 'ordering.search_menu', isReadOnly: true,
  async execute(ctx, i, deps) {
    return out(await withDb(ctx, deps, (db) => deps.ordering.searchMenu(db, ctx.businessId, { query: i.query, category: i.category,
      foodType: i.veg_only ? 'VEG' : i.food_type, maxPriceMinor: i.max_price !== undefined ? Math.round(i.max_price * 100) : undefined, limit: i.limit })));
  },
};

export const getMenuItem: AssistantTool<{ item_id: string }> = {
  handlerKey: 'ordering.menu_item', isReadOnly: true,
  async execute(ctx, i, deps) { return out(await withDb(ctx, deps, (db) => deps.ordering.itemDetails(db, ctx.businessId, i.item_id))); },
};

export const getCart = cartTool<Record<string, never>>('ordering.get_cart', async (db, deps, scope) => ({ ok: true, cart: await deps.ordering.view(db, scope) }), false);

export const addCartItem = cartTool<{ item_id: string; variant_id?: string; quantity: number; modifier_ids?: string[]; special_instructions?: string }>(
  'ordering.add_item', (db, deps, scope, i) => deps.ordering.addItem(db, scope, { itemId: i.item_id, variantId: i.variant_id, quantity: i.quantity,
    modifierIds: i.modifier_ids, instructions: i.special_instructions }));

export const updateCartItem = cartTool<{ line_id: string; quantity?: number; variant_id?: string; add_modifier_ids?: string[]; remove_modifier_ids?: string[];
  special_instructions?: string; apply_to_quantity?: number }>(
  'ordering.update_item', (db, deps, scope, i) => deps.ordering.updateLine(db, scope, { lineId: i.line_id, quantity: i.quantity, variantId: i.variant_id,
    addModifierIds: i.add_modifier_ids, removeModifierIds: i.remove_modifier_ids, instructions: i.special_instructions, applyToQuantity: i.apply_to_quantity }));

export const removeCartItem = cartTool<{ line_id: string; quantity?: number }>(
  'ordering.remove_item', (db, deps, scope, i) => deps.ordering.removeLine(db, scope, { lineId: i.line_id, quantity: i.quantity }));

export const clearCart: AssistantTool<Record<string, never>> = {
  ...cartTool<Record<string, never>>('ordering.clear_cart', (db, deps, scope) => deps.ordering.clear(db, scope)),
  async preview(ctx, _i, deps) {
    const scope = scopeOf(ctx);
    if (!scope) return { ok: false, outcome: fail('NO_CUSTOMER') };
    const v = await withDb(ctx, deps, (db) => deps.ordering.view(db, scope));
    if (v.empty) return { ok: false, outcome: fail('CART_EMPTY', 'The cart is already empty.') };
    return { ok: true, text: `Remove all ${v.lines.length} item(s) from the cart`, details: { items: v.lines.map((l) => `${l.quantity} x ${l.name}`) } };
  },
};

export const applyCoupon = cartTool<{ code: string }>('ordering.apply_coupon', (db, deps, scope, i) => deps.ordering.applyCoupon(db, scope, i.code));
export const removeCoupon = cartTool<Record<string, never>>('ordering.remove_coupon', (db, deps, scope) => deps.ordering.removeCoupon(db, scope));

export const getOrderingOptions: AssistantTool = {
  handlerKey: 'ordering.options', isReadOnly: true,
  async execute(ctx, _i, deps) { return out(await withDb(ctx, deps, (db) => deps.ordering.options(db, ctx.businessId, ctx.now))); },
};

export const setFulfillment = cartTool<{ mode: string; scheduled_for?: string }>(
  'ordering.set_fulfillment', (db, deps, scope, i, ctx) => deps.ordering.setFulfillment(db, scope, { mode: i.mode, scheduledFor: i.scheduled_for }, ctx.now));

export const checkDeliveryArea: AssistantTool<{ pincode?: string; latitude?: number; longitude?: number }> = {
  handlerKey: 'ordering.check_area', isReadOnly: true,
  async execute(ctx, i, deps) { return out(await withDb(ctx, deps, (db) => deps.ordering.checkArea(db, ctx.businessId, i))); },
};

export const setDeliveryAddress = cartTool<Record<string, unknown>>('ordering.set_address', (db, deps, scope, i) => deps.ordering.setAddress(db, scope, i));
export const setPaymentMethod = cartTool<{ method: string }>('ordering.set_payment', (db, deps, scope, i) => deps.ordering.setPayment(db, scope, i.method));
export const createCheckoutQuote = cartTool<Record<string, never>>('ordering.create_quote', (db, deps, scope, _i, ctx) => deps.ordering.createQuote(db, scope, ctx.now));

export const confirmOrder: AssistantTool<{ quote_id: string }> = {
  handlerKey: 'ordering.confirm_order', isReadOnly: false, timeoutMs: 10_000,
  async preview(ctx, i, deps) {
    const scope = scopeOf(ctx);
    if (!scope) return { ok: false, outcome: fail('NO_CUSTOMER') };
    const r = await withDb(ctx, deps, (db) => deps.ordering.checkQuote(db, scope, i.quote_id, ctx.now));
    if (!r.ok) return { ok: false, outcome: out(r) };
    if (r.alreadyPlaced) return { ok: false, outcome: ok({ status: 'ALREADY_PLACED', orderNumber: r.orderNumber, orderStatus: r.status,
      note: 'This order was already placed. Do not place it again.' }) };
    const t = r.quote.totals;
    return { ok: true, text: `Place order: ${t.lines.map((l: any) => `${l.quantity} x ${l.name}`).join(', ')} - total ${(Number(r.quote.total_minor) / 100).toFixed(2)} ${r.quote.currency}`,
      details: { quoteId: i.quote_id } };
  },
  async dryRun(ctx, i, deps) {
    const scope = scopeOf(ctx);
    if (!scope) return fail('NO_CUSTOMER');
    const r = await withDb(ctx, deps, (db) => deps.ordering.checkQuote(db, scope, i.quote_id, ctx.now));
    if (!r.ok) return out(r);
    return ok({ dryRun: true, status: 'WOULD_PLACE_ORDER', total: `${(Number(r.quote.total_minor) / 100).toFixed(2)} ${r.quote.currency}` });
  },
  async execute(ctx, i, deps) {
    if (!ctx.contactId) return fail('NO_CUSTOMER');
    const scope = { businessId: ctx.businessId, owner: { contactId: ctx.contactId }, conversationId: ctx.conversationId };
    const r = await withDb(ctx, deps, (db) => deps.ordering.placeOrder(db, scope, i.quote_id, { aiAgentId: ctx.assistantId, source: 'AI_WHATSAPP' }, ctx.now), false);
    if (r.ok && !r.replayed && deps.notifications) {
      await deps.notifications.notifyAdmins(ctx.organizationId, { type: 'NEW_ORDER', dedupeKey: `order:${r.orderNumber}:${ctx.businessId}`,
        title: `New order #${r.orderNumber} · ${r.total}`, body: `${r.fulfillment} · ${r.paymentMethod}. Accept it in Orders.`,
        data: { order_id: (r as any).orderId, conversation_id: ctx.conversationId } }).catch(() => undefined);
    }
    return out({ ...r, ...(r.ok ? { status: r.replayed ? 'ALREADY_PLACED' : 'ORDER_PLACED', orderStatus: r.status } : {}) } as any, r.ok ? { wrote: true } : undefined);
  },
};

export const getOrderStatus: AssistantTool<{ order_number?: number }> = {
  handlerKey: 'ordering.order_status', isReadOnly: true,
  async execute(ctx, i, deps) {
    if (!ctx.contactId) return ok({ orders: [], note: 'Test chat: no real orders.' });
    const orders = await withDb(ctx, deps, (db) => deps.ordering.customerOrders(db, ctx.businessId, ctx.contactId!, i.order_number));
    if (i.order_number && orders.length === 0) return fail('ORDER_NOT_FOUND', 'No such order for this customer.');
    return ok({ orders, note: 'Only share the status shown. No delivery time estimate is available unless listed.' });
  },
};

function notify(deps: ToolDeps, ctx: ToolExecutionContext, title: string, body: string, key: string) {
  return deps.notifications?.notifyAdmins(ctx.organizationId, { type: 'ORDER_REQUEST', dedupeKey: key, title, body, data: { conversation_id: ctx.conversationId } }).catch(() => undefined);
}

export const requestOrderCancellation: AssistantTool<{ order_number?: number; reason: string }> = {
  handlerKey: 'ordering.request_cancel', isReadOnly: false,
  async preview(ctx, i, deps) {
    if (!ctx.contactId) return { ok: true, text: 'Cancel the order', details: {} };
    const [o] = await withDb(ctx, deps, (db) => deps.ordering.customerOrders(db, ctx.businessId, ctx.contactId!, i.order_number));
    if (!o) return { ok: false, outcome: fail('ORDER_NOT_FOUND', 'No order found for this customer.') };
    return { ok: true, text: `Cancel order #${o.orderNumber} (${o.items}, ${o.total})`, details: { orderNumber: o.orderNumber, status: o.status } };
  },
  async dryRun() { return ok({ dryRun: true, status: 'WOULD_REQUEST_CANCELLATION' }); },
  async execute(ctx, i, deps) {
    if (!ctx.contactId) return fail('NO_CUSTOMER');
    const r = await withDb(ctx, deps, (db) => deps.ordering.requestCancellation(db, ctx.businessId, ctx.contactId!, i.order_number, i.reason), false);
    if (r.ok) await notify(deps, ctx, r.cancelled ? `Order #${r.orderNumber} cancelled by customer` : `Cancellation requested for order #${r.orderNumber}`,
      i.reason.slice(0, 180), `cancel:${r.orderNumber}`);
    return out(r as any, { wrote: true });
  },
};

export const requestOrderChange: AssistantTool<{ order_number?: number; change_type: 'MODIFY' | 'ADDRESS'; details: string }> = {
  handlerKey: 'ordering.request_change', isReadOnly: false,
  async dryRun() { return ok({ dryRun: true, status: 'WOULD_REQUEST_CHANGE' }); },
  async execute(ctx, i, deps) {
    if (!ctx.contactId) return fail('NO_CUSTOMER');
    const r = await withDb(ctx, deps, (db) => deps.ordering.requestChange(db, ctx.businessId, ctx.contactId!, i.order_number, i.change_type, i.details), false);
    if (r.ok) await notify(deps, ctx, `Change requested for order #${r.orderNumber}`, i.details.slice(0, 180), `change:${r.orderNumber}:${ctx.idempotencyKey}`);
    return out(r as any, { wrote: true });
  },
};

export const createSupportTicket: AssistantTool<{ category: string; description: string; order_number?: number; priority?: string }> = {
  handlerKey: 'ordering.support_ticket', isReadOnly: false,
  async dryRun() { return ok({ dryRun: true, status: 'WOULD_CREATE_TICKET' }); },
  async execute(ctx, i, deps) {
    const r = await withDb(ctx, deps, (db) => deps.ordering.supportTicket(db, ctx.businessId, ctx.contactId, ctx.conversationId,
      { category: i.category, description: i.description, orderNumber: i.order_number, priority: i.priority, idempotencyKey: ctx.idempotencyKey }), false);
    if (r.ok) await deps.notifications?.notifyAdmins(ctx.organizationId, { type: 'SUPPORT_TICKET', dedupeKey: `ticket:${ctx.idempotencyKey}`,
      title: `Support ticket: ${i.category.replace(/_/g, ' ').toLowerCase()}`, body: i.description.slice(0, 180), data: { conversation_id: ctx.conversationId } }).catch(() => undefined);
    return out(r as any, { wrote: true });
  },
};

export const reorderPrevious: AssistantTool<{ order_number?: number; replace_cart?: boolean }> = {
  handlerKey: 'ordering.reorder', isReadOnly: false, sandboxSafe: true,
  async execute(ctx, i, deps) {
    if (!ctx.contactId) return fail('NO_PREVIOUS_ORDERS', 'Test chat: there are no previous orders.');
    const scope = { businessId: ctx.businessId, owner: { contactId: ctx.contactId }, conversationId: ctx.conversationId };
    return out(await withDb(ctx, deps, (db) => deps.ordering.reorder(db, scope, i.order_number, Boolean(i.replace_cart)), false) as any, { wrote: true });
  },
};

export const saveCustomerPreference: AssistantTool<{ preferred_language?: string; food_preference?: string; allergy_note?: string; notes?: string }> = {
  handlerKey: 'customer.save_preference', isReadOnly: false,
  async dryRun(_ctx, i) { return ok({ dryRun: true, wouldSave: i }); },
  async execute(ctx, i, deps) {
    if (!ctx.contactId) return fail('NO_CUSTOMER');
    return out(await withDb(ctx, deps, (db) => deps.ordering.savePreference(db, ctx.businessId, ctx.contactId!, { language: i.preferred_language, food: i.food_preference,
      allergyNote: i.allergy_note, notes: i.notes }), false) as any, { wrote: true });
  },
};

export const ORDERING_TOOLS: AssistantTool<any>[] = [searchMenu, getMenuItem, getCart, addCartItem, updateCartItem, removeCartItem, clearCart, applyCoupon, removeCoupon,
  getOrderingOptions, setFulfillment, checkDeliveryArea, setDeliveryAddress, setPaymentMethod, createCheckoutQuote, confirmOrder, getOrderStatus,
  requestOrderCancellation, requestOrderChange, createSupportTicket, reorderPrevious, saveCustomerPreference];
