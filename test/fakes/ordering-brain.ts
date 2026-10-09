import type { Brain, FakeTurn } from './fake-openai.js';

/**
 * TEST-ONLY deterministic "model" for the restaurant ordering journey (spec
 * example conversation). Chooses tools only from those offered and reads real
 * tool results (ids, cart lines, quote ids). A simulation, not a language model.
 */
type Call = { name: string; args: Record<string, unknown> };

export function orderingBrain(): Brain {
  return (t: FakeTurn) => {
    const text = t.userTexts.join(' ').toLowerCase();
    const has = (k: string) => t.tools.includes(k);
    const res = (k: string) => t.results.filter((r) => r.name === k).map((r) => r.output);
    const last = t.results[t.results.length - 1];
    const call = (...calls: Call[]) => ({ calls: calls.filter((c) => has(c.name)) });
    const cart = () => res('GET_CART').at(-1)?.cart;
    if (t.instructions.startsWith('Summarise')) return { text: '- Customer orders burgers and pizza for delivery to Vijay Nagar. - Prefers veg.' };

    // Customer confirming the waiting action.
    if (t.results.length === 0 && t.instructions.includes('WAITING FOR CUSTOMER CONFIRMATION') && /\b(haan|han|yes|confirm|place kar)\b/.test(text)) {
      return call({ name: 'CONFIRM_PENDING_ACTION', args: { decision: 'CONFIRM' } });
    }
    if (last?.name === 'CONFIRM_PENDING_ACTION') {
      const o = last.output;
      if (o.status === 'ORDER_PLACED') return { text: `Order placed ✅ Order #${o.orderNumber}, Total: ${o.total}, Payment: ${o.paymentMethod}. Restaurant confirmation ka update yahin milega.` };
      if (o.status === 'ALREADY_PLACED') return { text: `Aapka order #${o.orderNumber} pehle hi place ho chuka hai.` };
      if (o.cancelled) return { text: `Order #${o.orderNumber} cancel ho gaya.` };
      if (o.requestSent) return { text: `Cancellation request restaurant ko bhej di hai. Unke confirm karne par update milega.` };
      return { text: o.success ? 'Done.' : `Maaf kijiye, yeh nahi ho paya (${o.errorCode}).` };
    }

    // 1. "bhai 2 cheese burger aur ek large farmhouse pizza"
    if (/cheese burger/.test(text) && /farmhouse/.test(text)) {
      const searches = res('SEARCH_MENU');
      if (searches.length === 0) return call({ name: 'SEARCH_MENU', args: { query: 'cheese burger' } }, { name: 'SEARCH_MENU', args: { query: 'farmhouse pizza' } });
      if (res('ADD_CART_ITEM').length === 0) {
        const burger = searches[0].items[0];
        const pizza = searches[1].items[0];
        const large = pizza.prices.find((p: any) => /large/i.test(p.variant));
        return call({ name: 'ADD_CART_ITEM', args: { item_id: burger.itemId, quantity: 2 } }, { name: 'ADD_CART_ITEM', args: { item_id: pizza.itemId, variant_id: large.variantId, quantity: 1 } });
      }
      const adds = res('ADD_CART_ITEM');
      return { text: adds.every((a) => a.success) ? 'Done ✅ 2 Cheese Burgers aur 1 Large Farmhouse Pizza cart mein add ho gaye.' : `Maaf kijiye (${adds.find((a) => !a.success).errorCode}).` };
    }

    // 2. "ek burger me extra cheese aur pizza me onion mat dalna"
    if (/extra cheese/.test(text) && /onion/.test(text)) {
      if (!cart()) return call({ name: 'GET_CART', args: {} });
      const c = cart();
      const burger = c.lines.find((l: any) => /burger/i.test(l.name));
      const pizza = c.lines.find((l: any) => /pizza/i.test(l.name));
      const details = res('GET_MENU_ITEM');
      if (details.length === 0) return call({ name: 'GET_MENU_ITEM', args: { item_id: burger.itemId } }, { name: 'GET_MENU_ITEM', args: { item_id: pizza.itemId } });
      if (res('UPDATE_CART_ITEM').length === 0) {
        const mods = (d: any) => d.item.options.flatMap((g: any) => g.modifiers);
        const cheese = mods(details[0]).find((m: any) => /extra cheese/i.test(m.name));
        const noOnion = mods(details[1]).find((m: any) => /onion/i.test(m.name));
        return call({ name: 'UPDATE_CART_ITEM', args: { line_id: burger.lineId, apply_to_quantity: 1, add_modifier_ids: [cheese.modifierId] } },
          { name: 'UPDATE_CART_ITEM', args: { line_id: pizza.lineId, add_modifier_ids: [noOnion.modifierId] } });
      }
      const final = res('UPDATE_CART_ITEM').at(-1).cart;
      return { text: `Done 👍\n${final.lines.map((l: any) => `• ${l.quantity} ${l.name}${l.variant ? ` (${l.variant})` : ''} – ${l.modifiers.join(', ') || 'normal'}`).join('\n')}` };
    }

    // 3/4. "ek burger hata do" (ambiguous) then "normal wala"
    if (/burger hata/.test(text) || /^normal/.test(text.trim())) {
      if (!cart()) return call({ name: 'GET_CART', args: {} });
      const burgers = cart().lines.filter((l: any) => /burger/i.test(l.name));
      if (/burger hata/.test(text) && burgers.length > 1) return { text: 'Kaunsa remove karu—normal Cheese Burger ya Extra Cheese wala?' };
      if (res('REMOVE_CART_ITEM').length === 0) {
        const target = burgers.find((l: any) => l.modifiers.length === 0) ?? burgers[0];
        return call({ name: 'REMOVE_CART_ITEM', args: { line_id: target.lineId } });
      }
      return { text: 'Normal Cheese Burger remove kar diya.' };
    }

    // 5. "bill"
    if (/^bill|bill batao/.test(text.trim())) {
      if (!cart()) return call({ name: 'GET_CART', args: {} });
      return { text: `${res('GET_CART').at(-1)?.display}` };
    }

    // 6. coupon
    if (/coupon|save\d+/.test(text)) {
      if (res('APPLY_COUPON').length === 0) return call({ name: 'APPLY_COUPON', args: { code: (/(save\d+)/i.exec(text)?.[1] ?? '').toUpperCase() } });
      const r = res('APPLY_COUPON')[0];
      return { text: r.success ? `Coupon ${r.coupon} laga diya ✅ Total: ${r.cart.summary.total}` : `Coupon valid nahi hai (${r.errorCode}).` };
    }

    // 7. "delivery ... 452010 ... COD"
    if (/delivery/.test(text) && /cod/.test(text)) {
      if (res('SET_FULFILLMENT').length === 0) {
        return call({ name: 'SET_FULFILLMENT', args: { mode: 'DELIVERY' } },
          { name: 'SET_DELIVERY_ADDRESS', args: { house: 'Flat 12', locality: 'Vijay Nagar', city: 'Indore', pincode: /(\d{6})/.exec(text)?.[1] ?? '' } },
          { name: 'SET_PAYMENT_METHOD', args: { method: 'COD' } });
      }
      if (res('CREATE_CHECKOUT_QUOTE').length === 0) return call({ name: 'CREATE_CHECKOUT_QUOTE', args: {} });
      const q = res('CREATE_CHECKOUT_QUOTE')[0];
      if (!q.success) return { text: `Checkout ke liye chahiye: ${q.message}` };
      if (res('CONFIRM_ORDER').length === 0) return call({ name: 'CONFIRM_ORDER', args: { quote_id: q.quoteId } });
      return { text: `Final order:\n${q.display}\n\nOrder place kar du?` };
    }

    // 8. tracking
    if (/order kaha|order status|mera order/.test(text)) {
      if (res('GET_ORDER_STATUS').length === 0) return call({ name: 'GET_ORDER_STATUS', args: {} });
      const o = res('GET_ORDER_STATUS')[0].orders[0];
      return { text: o ? `Order #${o.orderNumber}: ${o.status}` : 'Koi order nahi mila.' };
    }

    // 9. cancellation
    if (/cancel/.test(text)) {
      if (res('REQUEST_ORDER_CANCELLATION').length === 0) return call({ name: 'REQUEST_ORDER_CANCELLATION', args: { reason: 'Customer changed plans' } });
      const r = res('REQUEST_ORDER_CANCELLATION')[0];
      return { text: r.status === 'CONFIRMATION_REQUIRED' ? `${r.confirmationText}? Confirm karein.` : `(${r.errorCode ?? r.status})` };
    }

    // 10. memory
    if (/pure veg|main veg/.test(text)) {
      if (res('SAVE_CUSTOMER_PREFERENCE').length === 0) return call({ name: 'SAVE_CUSTOMER_PREFERENCE', args: { food_preference: 'VEG' } });
      return { text: 'Noted ✅ aage se veg options hi dikhaunga.' };
    }
    if (/repeat|last time/.test(text)) {
      if (res('REORDER_PREVIOUS').length === 0) return call({ name: 'REORDER_PREVIOUS', args: { replace_cart: true } });
      const r = res('REORDER_PREVIOUS')[0];
      return { text: r.success ? `Pichhla order cart mein daal diya: ${r.cart.lines.map((l: any) => `${l.quantity} x ${l.name}`).join(', ')}. Total ${r.cart.summary.total}.` : `(${r.errorCode})` };
    }
    if (/menu/.test(text)) {
      if (res('SEARCH_MENU').length === 0) return call({ name: 'SEARCH_MENU', args: {} });
      return { text: res('SEARCH_MENU')[0].categories.map((c: any) => `${c.name} (${c.items})`).join(', ') };
    }
    return { text: 'Main aapki order mein kaise madad karu?' };
  };
}
