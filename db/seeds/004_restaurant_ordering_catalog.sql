-- =============================================================================
-- PLATFORM SEED (Phase 5): restaurant ordering capabilities + the
-- "Restaurant Food Ordering Assistant" template. Idempotent, platform data only.
-- =============================================================================

INSERT INTO app.ai_tools (key, name, description, category, handler_key, side_effect, risk_level, requires_confirmation, availability,
                          capability_name, capability_description, input_schema, output_schema, config_schema, version)
SELECT t.key, t.name, t.description, t.category, t.handler, t.side_effect, t.risk, t.confirm, 'READY', t.cap, t.capdesc,
       t.input::jsonb, '{"type":"object"}'::jsonb, t.config::jsonb, 1
FROM (VALUES
  ('SEARCH_MENU', 'Search menu', 'Find menu items by name (typos and Hinglish are fine), category, veg-only or maximum price. With no query (or with a category) it returns "display": the formatted menu to send verbatim when the customer asks for the menu. Returns ids, prices and availability; several close matches mean you must ask which one.',
   'ORDERING', 'ordering.search_menu', 'READ', 'LOW', false, 'Menu search', 'Finds dishes on your menu, even with spelling mistakes.',
   $j${"type":"object","additionalProperties":false,"properties":{"query":{"type":"string","maxLength":100},"category":{"type":"string","maxLength":60},"veg_only":{"type":"boolean"},"food_type":{"type":"string","enum":["VEG","NON_VEG","EGG","VEGAN"]},"max_price":{"type":"number","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":30}}}$j$, '{"type":"object","properties":{}}'),
  ('GET_MENU_ITEM', 'Get menu item', 'Full details of one menu item: sizes/variants with prices, available add-ons and removals (modifiers), spice level, allergen information.',
   'ORDERING', 'ordering.menu_item', 'READ', 'LOW', false, 'Dish details', 'Explains sizes, add-ons and allergens of a dish.',
   $j${"type":"object","additionalProperties":false,"required":["item_id"],"properties":{"item_id":{"type":"string","format":"uuid"}}}$j$, '{"type":"object","properties":{}}'),
  ('GET_CART', 'Get cart', 'The customer''s current cart with line ids, customisations and the backend-calculated bill. Returns "display": a ready-to-send bill - send it verbatim. Always use this before answering "total kitna hua" or changing an ambiguous line.',
   'ORDERING', 'ordering.get_cart', 'READ', 'LOW', false, 'Show cart & bill', 'Shows the cart and the exact bill.',
   $j${"type":"object","additionalProperties":false,"properties":{}}$j$, '{"type":"object","properties":{}}'),
  ('ADD_CART_ITEM', 'Add to cart', 'Add a menu item to the cart with quantity, optional variant (size), modifier ids (add-ons/removals) and a special instruction. Identical lines are merged.',
   'ORDERING', 'ordering.add_item', 'WRITE', 'LOW', false, 'Add to cart', 'Adds dishes to the customer''s cart.',
   $j${"type":"object","additionalProperties":false,"required":["item_id","quantity"],"properties":{"item_id":{"type":"string","format":"uuid"},"variant_id":{"type":"string","format":"uuid"},"quantity":{"type":"integer","minimum":1,"maximum":100},"modifier_ids":{"type":"array","maxItems":20,"items":{"type":"string","format":"uuid"}},"special_instructions":{"type":"string","maxLength":300}}}$j$, '{"type":"object","properties":{}}'),
  ('UPDATE_CART_ITEM', 'Update cart line', 'Change one cart line: quantity, size, add/remove modifiers or instructions. Use apply_to_quantity to change only some units (e.g. extra cheese on 1 of 2 burgers splits the line).',
   'ORDERING', 'ordering.update_item', 'WRITE', 'LOW', false, 'Edit cart', 'Changes quantity, size or customisation of a cart item.',
   $j${"type":"object","additionalProperties":false,"required":["line_id"],"properties":{"line_id":{"type":"string","format":"uuid"},"quantity":{"type":"integer","minimum":1,"maximum":100},"variant_id":{"type":"string","format":"uuid"},"add_modifier_ids":{"type":"array","maxItems":20,"items":{"type":"string","format":"uuid"}},"remove_modifier_ids":{"type":"array","maxItems":20,"items":{"type":"string","format":"uuid"}},"special_instructions":{"type":"string","maxLength":300},"apply_to_quantity":{"type":"integer","minimum":1,"maximum":100}}}$j$, '{"type":"object","properties":{}}'),
  ('REMOVE_CART_ITEM', 'Remove from cart', 'Remove a cart line, or only some units of it.',
   'ORDERING', 'ordering.remove_item', 'WRITE', 'LOW', false, 'Remove from cart', 'Removes items from the cart.',
   $j${"type":"object","additionalProperties":false,"required":["line_id"],"properties":{"line_id":{"type":"string","format":"uuid"},"quantity":{"type":"integer","minimum":1,"maximum":100}}}$j$, '{"type":"object","properties":{}}'),
  ('CLEAR_CART', 'Clear cart', 'Remove everything from the draft cart (asks the customer to confirm first).',
   'ORDERING', 'ordering.clear_cart', 'WRITE', 'MEDIUM', true, 'Clear cart', 'Empties the cart after the customer confirms.',
   $j${"type":"object","additionalProperties":false,"properties":{}}$j$, $j${"type":"object","properties":{"requireConfirmation":{"type":"boolean","default":true}}}$j$),
  ('APPLY_COUPON', 'Apply coupon', 'Apply a coupon code the customer gave. Only coupons configured by the restaurant exist.',
   'ORDERING', 'ordering.apply_coupon', 'WRITE', 'LOW', false, 'Coupons', 'Applies your restaurant''s coupon codes.',
   $j${"type":"object","additionalProperties":false,"required":["code"],"properties":{"code":{"type":"string","minLength":2,"maxLength":30}}}$j$, '{"type":"object","properties":{}}'),
  ('REMOVE_COUPON', 'Remove coupon', 'Remove the coupon from the cart.',
   'ORDERING', 'ordering.remove_coupon', 'WRITE', 'LOW', false, 'Remove coupon', 'Removes a coupon from the cart.',
   $j${"type":"object","additionalProperties":false,"properties":{}}$j$, '{"type":"object","properties":{}}'),
  ('GET_ORDERING_OPTIONS', 'Get ordering options', 'Whether the restaurant is open now (and next opening), enabled delivery/pickup/dine-in, payment methods, minimum order, delivery fee/area and scheduling.',
   'ORDERING', 'ordering.options', 'READ', 'LOW', false, 'Ordering options', 'Tells customers about delivery, pickup, payment and timings.',
   $j${"type":"object","additionalProperties":false,"properties":{}}$j$, '{"type":"object","properties":{}}'),
  ('SET_FULFILLMENT', 'Set delivery or pickup', 'Choose DELIVERY, PICKUP or DINE_IN for the cart, optionally scheduled for a later time (if the restaurant allows scheduling).',
   'ORDERING', 'ordering.set_fulfillment', 'WRITE', 'LOW', false, 'Delivery / pickup', 'Sets delivery, pickup or dine-in.',
   $j${"type":"object","additionalProperties":false,"required":["mode"],"properties":{"mode":{"type":"string","enum":["DELIVERY","PICKUP","DINE_IN"]},"scheduled_for":{"type":"string","format":"date-time"}}}$j$, '{"type":"object","properties":{}}'),
  ('CHECK_DELIVERY_AREA', 'Check delivery area', 'Check whether a pincode or map location is inside the delivery area.',
   'ORDERING', 'ordering.check_area', 'READ', 'LOW', false, 'Delivery area check', 'Checks if you deliver to an area.',
   $j${"type":"object","additionalProperties":false,"properties":{"pincode":{"type":"string","maxLength":10},"latitude":{"type":"number","minimum":-90,"maximum":90},"longitude":{"type":"number","minimum":-180,"maximum":180}}}$j$, '{"type":"object","properties":{}}'),
  ('SET_DELIVERY_ADDRESS', 'Set delivery address', 'Save (parts of) the delivery address; fields are merged with what was given before. Returns missing fields and whether it is serviceable. Pass WhatsApp location coordinates when shared, or a saved_address_id from the customer context.',
   'ORDERING', 'ordering.set_address', 'WRITE', 'LOW', false, 'Delivery address', 'Collects and validates the delivery address.',
   $j${"type":"object","additionalProperties":false,"properties":{"name":{"type":"string","maxLength":100},"house":{"type":"string","maxLength":200},"street":{"type":"string","maxLength":200},"locality":{"type":"string","maxLength":200},"landmark":{"type":"string","maxLength":200},"city":{"type":"string","maxLength":100},"pincode":{"type":"string","maxLength":10},"latitude":{"type":"number","minimum":-90,"maximum":90},"longitude":{"type":"number","minimum":-180,"maximum":180},"instructions":{"type":"string","maxLength":200},"saved_address_id":{"type":"string","format":"uuid"}}}$j$, '{"type":"object","properties":{}}'),
  ('SET_PAYMENT_METHOD', 'Set payment method', 'Choose the payment method: COD (cash on delivery) or PAY_AT_PICKUP. Online payment is not available.',
   'ORDERING', 'ordering.set_payment', 'WRITE', 'LOW', false, 'Payment method', 'Records Cash on Delivery / Pay at counter.',
   $j${"type":"object","additionalProperties":false,"required":["method"],"properties":{"method":{"type":"string","enum":["COD","PAY_AT_PICKUP","ONLINE"]}}}$j$, '{"type":"object","properties":{}}'),
  ('CREATE_CHECKOUT_QUOTE', 'Create checkout quote', 'Validate the cart for checkout and create the final priced order summary (quote). Returns what is still missing, or "display" (the final bill - send it verbatim) + quote id to confirm.',
   'ORDERING', 'ordering.create_quote', 'WRITE', 'LOW', false, 'Final bill', 'Prepares the final order summary with the exact total.',
   $j${"type":"object","additionalProperties":false,"properties":{}}$j$, '{"type":"object","properties":{}}'),
  ('CONFIRM_ORDER', 'Confirm order', 'Place the order for a checkout quote. The customer must explicitly confirm the latest summary first; a changed cart invalidates the quote.',
   'ORDERING', 'ordering.confirm_order', 'WRITE', 'HIGH', true, 'Place orders', 'Places the order after the customer confirms the final summary.',
   $j${"type":"object","additionalProperties":false,"required":["quote_id"],"properties":{"quote_id":{"type":"string","format":"uuid"}}}$j$, $j${"type":"object","properties":{"requireConfirmation":{"type":"boolean","default":true}}}$j$),
  ('GET_ORDER_STATUS', 'Get order status', 'Status, items, total and payment status of the customer''s recent orders (or one order by number).',
   'ORDERING', 'ordering.order_status', 'READ', 'LOW', false, 'Order tracking', 'Tells customers where their order is.',
   $j${"type":"object","additionalProperties":false,"properties":{"order_number":{"type":"integer","minimum":1}}}$j$, '{"type":"object","properties":{}}'),
  ('REQUEST_ORDER_CANCELLATION', 'Request order cancellation', 'Cancel a placed order: immediate only if the restaurant has not accepted it yet (and allows it); otherwise a request is sent to the restaurant.',
   'ORDERING', 'ordering.request_cancel', 'WRITE', 'MEDIUM', true, 'Order cancellation', 'Cancels or requests cancellation of an order.',
   $j${"type":"object","additionalProperties":false,"required":["reason"],"properties":{"order_number":{"type":"integer","minimum":1},"reason":{"type":"string","minLength":2,"maxLength":300}}}$j$, $j${"type":"object","properties":{"requireConfirmation":{"type":"boolean","default":true}}}$j$),
  ('REQUEST_ORDER_CHANGE', 'Request order change', 'Ask the restaurant to change an already placed order (items or address). The restaurant decides.',
   'ORDERING', 'ordering.request_change', 'WRITE', 'LOW', false, 'Order changes', 'Sends change requests for placed orders to your team.',
   $j${"type":"object","additionalProperties":false,"required":["change_type","details"],"properties":{"order_number":{"type":"integer","minimum":1},"change_type":{"type":"string","enum":["MODIFY","ADDRESS"]},"details":{"type":"string","minLength":2,"maxLength":1000}}}$j$, '{"type":"object","properties":{}}'),
  ('CREATE_SUPPORT_TICKET', 'Create support ticket', 'Record a complaint or issue (wrong/missing item, quality, delay, payment, refund, packaging, allergy) for the restaurant team.',
   'ORDERING', 'ordering.support_ticket', 'WRITE', 'LOW', false, 'Complaints', 'Records complaints for your team.',
   $j${"type":"object","additionalProperties":false,"required":["category","description"],"properties":{"category":{"type":"string","enum":["WRONG_ITEM","MISSING_ITEM","QUALITY","DELAY","PAYMENT","REFUND","PACKAGING","ALLERGY","OTHER"]},"description":{"type":"string","minLength":2,"maxLength":1000},"order_number":{"type":"integer","minimum":1},"priority":{"type":"string","enum":["LOW","NORMAL","HIGH","URGENT"]}}}$j$, '{"type":"object","properties":{}}'),
  ('REORDER_PREVIOUS', 'Repeat previous order', 'Rebuild the cart from the customer''s previous order, re-checked against today''s menu and prices. Reports skipped items and price changes. Never places the order.',
   'ORDERING', 'ordering.reorder', 'WRITE', 'LOW', false, 'Repeat last order', 'Rebuilds a customer''s previous order in the cart.',
   $j${"type":"object","additionalProperties":false,"properties":{"order_number":{"type":"integer","minimum":1},"replace_cart":{"type":"boolean"}}}$j$, '{"type":"object","properties":{}}'),
  ('SAVE_CUSTOMER_PREFERENCE', 'Save customer preference', 'Remember something the customer explicitly told you about themselves for next time: preferred language, veg/non-veg/Jain preference, an allergy they mentioned, or a short note.',
   'CUSTOMER', 'customer.save_preference', 'WRITE', 'LOW', false, 'Remember preferences', 'Remembers language, veg preference and notes for next time.',
   $j${"type":"object","additionalProperties":false,"properties":{"preferred_language":{"type":"string","maxLength":12},"food_preference":{"type":"string","enum":["VEG","NON_VEG","EGG","VEGAN","JAIN"]},"allergy_note":{"type":"string","maxLength":300},"notes":{"type":"string","maxLength":500}}}$j$, '{"type":"object","properties":{}}')
) AS t(key, name, description, category, handler, side_effect, risk, confirm, cap, capdesc, input, config)
ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, category = EXCLUDED.category, handler_key = EXCLUDED.handler_key,
  side_effect = EXCLUDED.side_effect, risk_level = EXCLUDED.risk_level, requires_confirmation = EXCLUDED.requires_confirmation, availability = EXCLUDED.availability,
  capability_name = EXCLUDED.capability_name, capability_description = EXCLUDED.capability_description, input_schema = EXCLUDED.input_schema, config_schema = EXCLUDED.config_schema;

INSERT INTO app.ai_tool_dependencies (tool_id, depends_on_tool_id, relation)
SELECT a.id, b.id, d.rel FROM (VALUES
  ('ADD_CART_ITEM', 'SEARCH_MENU', 'REQUIRES'), ('UPDATE_CART_ITEM', 'GET_CART', 'REQUIRES'), ('REMOVE_CART_ITEM', 'GET_CART', 'REQUIRES'),
  ('CONFIRM_ORDER', 'CREATE_CHECKOUT_QUOTE', 'REQUIRES'), ('CREATE_CHECKOUT_QUOTE', 'SET_FULFILLMENT', 'REQUIRES'), ('CREATE_CHECKOUT_QUOTE', 'SET_PAYMENT_METHOD', 'REQUIRES'),
  ('CREATE_CHECKOUT_QUOTE', 'ADD_CART_ITEM', 'REQUIRES'), ('SET_DELIVERY_ADDRESS', 'SET_FULFILLMENT', 'RECOMMENDS'), ('REQUEST_ORDER_CANCELLATION', 'GET_ORDER_STATUS', 'RECOMMENDS')
) AS d(tool, dep, rel) JOIN app.ai_tools a ON a.key = d.tool JOIN app.ai_tools b ON b.key = d.dep
ON CONFLICT (tool_id, depends_on_tool_id) DO UPDATE SET relation = EXCLUDED.relation;

INSERT INTO app.usage_event_types (code, unit, description) VALUES ('ORDER_PLACED', 'COUNT', 'Food order placed')
ON CONFLICT (code) DO UPDATE SET unit = EXCLUDED.unit, description = EXCLUDED.description;
