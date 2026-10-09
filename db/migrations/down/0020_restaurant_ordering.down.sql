-- Rollback 0020 (dev/staging only; drops Phase 5 ordering data).
DROP TABLE IF EXISTS app.support_tickets, app.order_change_requests, app.order_events, app.order_items, app.orders,
  app.checkout_quotes, app.cart_items, app.carts, app.customer_addresses, app.customer_profiles, app.coupons,
  app.ordering_settings, app.menu_item_modifier_groups, app.menu_modifiers, app.menu_modifier_groups,
  app.menu_item_variants, app.menu_items, app.menu_categories;
ALTER TABLE app.ai_agents DROP CONSTRAINT ai_agents_instr_mode_chk;
UPDATE app.ai_agents SET instructions_mode = 'ADVANCED' WHERE instructions_mode = 'CUSTOM_PROMPT';
ALTER TABLE app.ai_agents ADD CONSTRAINT ai_agents_instr_mode_chk CHECK (instructions_mode IN ('SIMPLE','ADVANCED'));
ALTER TABLE app.ai_agents DROP CONSTRAINT ai_agents_custom_instr_chk;
UPDATE app.ai_agents SET custom_instructions = left(custom_instructions, 8000) WHERE length(custom_instructions) > 8000;
ALTER TABLE app.ai_agents ADD CONSTRAINT ai_agents_custom_instr_chk CHECK (custom_instructions IS NULL OR length(custom_instructions) <= 8000);
ALTER TABLE app.ai_agents DROP CONSTRAINT ai_agents_template_instr_chk;
UPDATE app.ai_agents SET template_instructions = left(template_instructions, 20000) WHERE length(template_instructions) > 20000;
ALTER TABLE app.ai_agents ADD CONSTRAINT ai_agents_template_instr_chk CHECK (template_instructions IS NULL OR length(template_instructions) <= 20000);
ALTER TABLE app.ai_tools DROP CONSTRAINT ai_tools_category_chk;
UPDATE app.ai_tools SET status = 'DEPRECATED', category = 'SYSTEM', availability = 'NOT_READY' WHERE category = 'ORDERING';
ALTER TABLE app.ai_tools ADD CONSTRAINT ai_tools_category_chk CHECK (category IN ('BUSINESS_INFO','KNOWLEDGE','CUSTOMER','BOOKING','SALES','PAYMENT',
  'COMMUNICATION','SYSTEM','INTEGRATION'));
