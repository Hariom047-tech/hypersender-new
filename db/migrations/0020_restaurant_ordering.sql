-- =============================================================================
-- 0020 RESTAURANT ORDERING (Phase 5) - ADDITIVE ONLY.
-- Menu (items, variants, modifiers), persistent carts, checkout quotes, orders,
-- coupons, change/cancel requests, support tickets and customer memory.
-- The assistant only ever reaches these through narrow tools; every price and
-- total is computed by the backend pricing engine (src/ordering/pricing.ts).
-- Why each table exists: docs/restaurant-ordering.md "Database review".
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. Larger owner prompts (a full "system prompt" of 20-40k characters) and a
--    CUSTOM_PROMPT mode that replaces the template's instructions (layer 2).
--    Platform rules (layer 1) still always apply first.
-- -----------------------------------------------------------------------------
ALTER TABLE app.ai_agents DROP CONSTRAINT ai_agents_custom_instr_chk;
ALTER TABLE app.ai_agents ADD CONSTRAINT ai_agents_custom_instr_chk CHECK (custom_instructions IS NULL OR length(custom_instructions) <= 40000);
ALTER TABLE app.ai_agents DROP CONSTRAINT ai_agents_template_instr_chk;
ALTER TABLE app.ai_agents ADD CONSTRAINT ai_agents_template_instr_chk CHECK (template_instructions IS NULL OR length(template_instructions) <= 60000);
ALTER TABLE app.ai_agents DROP CONSTRAINT ai_agents_instr_mode_chk;
ALTER TABLE app.ai_agents ADD CONSTRAINT ai_agents_instr_mode_chk CHECK (instructions_mode IN ('SIMPLE','ADVANCED','CUSTOM_PROMPT'));
-- Ordering capabilities get their own category.
ALTER TABLE app.ai_tools DROP CONSTRAINT ai_tools_category_chk;
ALTER TABLE app.ai_tools ADD CONSTRAINT ai_tools_category_chk CHECK (category IN ('BUSINESS_INFO','KNOWLEDGE','CUSTOMER','BOOKING','SALES','PAYMENT',
  'COMMUNICATION','SYSTEM','INTEGRATION','ORDERING'));

-- -----------------------------------------------------------------------------
-- 1. Menu
-- -----------------------------------------------------------------------------
CREATE TABLE app.menu_categories (
  id               uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id  uuid        NOT NULL,
  business_id      uuid        NOT NULL,
  name             text        NOT NULL,
  description      text,
  display_order    integer     NOT NULL DEFAULT 100,
  active           boolean     NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  CONSTRAINT menu_categories_business_fk FOREIGN KEY (business_id, organization_id) REFERENCES app.businesses (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT menu_categories_id_org_biz_uq UNIQUE (id, organization_id, business_id),
  CONSTRAINT menu_categories_name_chk CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  CONSTRAINT menu_categories_desc_chk CHECK (description IS NULL OR length(description) <= 500)
);
CREATE INDEX menu_categories_biz_idx ON app.menu_categories (organization_id, business_id, display_order) WHERE deleted_at IS NULL;
SELECT app_admin.attach_updated_at_trigger('app.menu_categories');

CREATE TABLE app.menu_items (
  id                  uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id     uuid        NOT NULL,
  business_id         uuid        NOT NULL,
  category_id         uuid,
  name                text        NOT NULL,
  description         text,
  food_type           text        NOT NULL DEFAULT 'VEG',
  base_price_minor    bigint      NOT NULL,
  currency            text        NOT NULL DEFAULT 'INR',
  available           boolean     NOT NULL DEFAULT true,
  spice_level         smallint,
  allergens           text[]      NOT NULL DEFAULT ARRAY[]::text[],
  allergen_info_verified boolean  NOT NULL DEFAULT false,
  tags                text[]      NOT NULL DEFAULT ARRAY[]::text[],
  prep_minutes        integer,
  display_order       integer     NOT NULL DEFAULT 100,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  CONSTRAINT menu_items_category_fk FOREIGN KEY (category_id, organization_id, business_id)
    REFERENCES app.menu_categories (id, organization_id, business_id) ON DELETE SET NULL (category_id),
  CONSTRAINT menu_items_business_fk FOREIGN KEY (business_id, organization_id) REFERENCES app.businesses (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT menu_items_id_org_biz_uq UNIQUE (id, organization_id, business_id),
  CONSTRAINT menu_items_name_chk     CHECK (length(btrim(name)) BETWEEN 1 AND 150),
  CONSTRAINT menu_items_desc_chk     CHECK (description IS NULL OR length(description) <= 1000),
  CONSTRAINT menu_items_food_chk     CHECK (food_type IN ('VEG','NON_VEG','EGG','VEGAN')),
  CONSTRAINT menu_items_price_chk    CHECK (base_price_minor >= 0),
  CONSTRAINT menu_items_currency_chk CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT menu_items_spice_chk    CHECK (spice_level IS NULL OR spice_level BETWEEN 0 AND 5),
  CONSTRAINT menu_items_prep_chk     CHECK (prep_minutes IS NULL OR prep_minutes BETWEEN 1 AND 600),
  CONSTRAINT menu_items_arrays_chk   CHECK (cardinality(allergens) <= 30 AND cardinality(tags) <= 30)
);
CREATE INDEX menu_items_biz_idx ON app.menu_items (organization_id, business_id, category_id, display_order) WHERE deleted_at IS NULL;
SELECT app_admin.attach_updated_at_trigger('app.menu_items');

CREATE TABLE app.menu_item_variants (
  id               uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id  uuid        NOT NULL,
  business_id      uuid        NOT NULL,
  item_id          uuid        NOT NULL,
  name             text        NOT NULL,
  price_minor      bigint      NOT NULL,
  is_default       boolean     NOT NULL DEFAULT false,
  available        boolean     NOT NULL DEFAULT true,
  display_order    integer     NOT NULL DEFAULT 100,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  CONSTRAINT menu_item_variants_item_fk FOREIGN KEY (item_id, organization_id, business_id)
    REFERENCES app.menu_items (id, organization_id, business_id) ON DELETE CASCADE,
  CONSTRAINT menu_item_variants_id_org_biz_uq UNIQUE (id, organization_id, business_id),
  CONSTRAINT menu_item_variants_name_chk  CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  CONSTRAINT menu_item_variants_price_chk CHECK (price_minor >= 0)
);
CREATE INDEX menu_item_variants_item_idx ON app.menu_item_variants (item_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX menu_item_variants_one_default_uq ON app.menu_item_variants (item_id) WHERE is_default AND deleted_at IS NULL;
SELECT app_admin.attach_updated_at_trigger('app.menu_item_variants');

CREATE TABLE app.menu_modifier_groups (
  id               uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id  uuid        NOT NULL,
  business_id      uuid        NOT NULL,
  name             text        NOT NULL,
  min_select       integer     NOT NULL DEFAULT 0,
  max_select       integer     NOT NULL DEFAULT 5,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  CONSTRAINT menu_modifier_groups_business_fk FOREIGN KEY (business_id, organization_id) REFERENCES app.businesses (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT menu_modifier_groups_id_org_biz_uq UNIQUE (id, organization_id, business_id),
  CONSTRAINT menu_modifier_groups_name_chk CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  CONSTRAINT menu_modifier_groups_sel_chk  CHECK (min_select >= 0 AND max_select >= 1 AND min_select <= max_select AND max_select <= 20)
);
SELECT app_admin.attach_updated_at_trigger('app.menu_modifier_groups');

CREATE TABLE app.menu_modifiers (
  id                 uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id    uuid        NOT NULL,
  business_id        uuid        NOT NULL,
  group_id           uuid        NOT NULL,
  name               text        NOT NULL,
  kind               text        NOT NULL DEFAULT 'ADD',
  price_delta_minor  bigint      NOT NULL DEFAULT 0,
  available          boolean     NOT NULL DEFAULT true,
  display_order      integer     NOT NULL DEFAULT 100,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  CONSTRAINT menu_modifiers_group_fk FOREIGN KEY (group_id, organization_id, business_id)
    REFERENCES app.menu_modifier_groups (id, organization_id, business_id) ON DELETE CASCADE,
  CONSTRAINT menu_modifiers_id_org_biz_uq UNIQUE (id, organization_id, business_id),
  CONSTRAINT menu_modifiers_name_chk  CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  CONSTRAINT menu_modifiers_kind_chk  CHECK (kind IN ('ADD','REMOVE','CHOICE')),
  CONSTRAINT menu_modifiers_price_chk CHECK (price_delta_minor BETWEEN -1000000 AND 10000000)
);
CREATE INDEX menu_modifiers_group_idx ON app.menu_modifiers (group_id) WHERE deleted_at IS NULL;
SELECT app_admin.attach_updated_at_trigger('app.menu_modifiers');

CREATE TABLE app.menu_item_modifier_groups (
  organization_id  uuid        NOT NULL,
  business_id      uuid        NOT NULL,
  item_id          uuid        NOT NULL,
  group_id         uuid        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, group_id),
  CONSTRAINT mimg_item_fk FOREIGN KEY (item_id, organization_id, business_id) REFERENCES app.menu_items (id, organization_id, business_id) ON DELETE CASCADE,
  CONSTRAINT mimg_group_fk FOREIGN KEY (group_id, organization_id, business_id) REFERENCES app.menu_modifier_groups (id, organization_id, business_id) ON DELETE CASCADE
);
CREATE INDEX menu_item_modifier_groups_group_idx ON app.menu_item_modifier_groups (group_id);

-- -----------------------------------------------------------------------------
-- 2. Ordering settings (one row per business; money in minor units)
-- -----------------------------------------------------------------------------
CREATE TABLE app.ordering_settings (
  business_id               uuid        PRIMARY KEY,
  organization_id           uuid        NOT NULL,
  enabled                   boolean     NOT NULL DEFAULT false,
  fulfillment_modes         text[]      NOT NULL DEFAULT ARRAY['PICKUP']::text[],
  payment_methods           text[]      NOT NULL DEFAULT ARRAY['PAY_AT_PICKUP']::text[],
  currency                  text        NOT NULL DEFAULT 'INR',
  tax_rate_bps              integer     NOT NULL DEFAULT 500,
  tax_inclusive             boolean     NOT NULL DEFAULT false,
  packaging_fee_minor       bigint      NOT NULL DEFAULT 0,
  min_order_minor           bigint      NOT NULL DEFAULT 0,
  delivery_fee_minor        bigint      NOT NULL DEFAULT 0,
  free_delivery_above_minor bigint,
  delivery_pincodes         text[]      NOT NULL DEFAULT ARRAY[]::text[],
  delivery_radius_km        numeric(6,2),
  prep_time_minutes         integer     NOT NULL DEFAULT 30,
  scheduling_enabled        boolean     NOT NULL DEFAULT false,
  max_schedule_days         integer     NOT NULL DEFAULT 2,
  quote_ttl_minutes         integer     NOT NULL DEFAULT 15,
  auto_cancel_before_accept boolean     NOT NULL DEFAULT true,
  next_order_number         bigint      NOT NULL DEFAULT 1001,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ordering_settings_business_fk FOREIGN KEY (business_id, organization_id) REFERENCES app.businesses (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT ordering_settings_modes_chk CHECK (fulfillment_modes <@ ARRAY['DELIVERY','PICKUP','DINE_IN']::text[] AND cardinality(fulfillment_modes) >= 1),
  CONSTRAINT ordering_settings_pay_chk   CHECK (payment_methods <@ ARRAY['COD','PAY_AT_PICKUP','ONLINE']::text[] AND cardinality(payment_methods) >= 1),
  CONSTRAINT ordering_settings_ccy_chk   CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT ordering_settings_tax_chk   CHECK (tax_rate_bps BETWEEN 0 AND 5000),
  CONSTRAINT ordering_settings_money_chk CHECK (packaging_fee_minor >= 0 AND min_order_minor >= 0 AND delivery_fee_minor >= 0
                                                 AND (free_delivery_above_minor IS NULL OR free_delivery_above_minor >= 0)),
  CONSTRAINT ordering_settings_pins_chk  CHECK (cardinality(delivery_pincodes) <= 500),
  CONSTRAINT ordering_settings_radius_chk CHECK (delivery_radius_km IS NULL OR delivery_radius_km BETWEEN 0.1 AND 100),
  CONSTRAINT ordering_settings_prep_chk  CHECK (prep_time_minutes BETWEEN 1 AND 600),
  CONSTRAINT ordering_settings_sched_chk CHECK (max_schedule_days BETWEEN 0 AND 30),
  CONSTRAINT ordering_settings_ttl_chk   CHECK (quote_ttl_minutes BETWEEN 1 AND 120),
  CONSTRAINT ordering_settings_num_chk   CHECK (next_order_number >= 1)
);
SELECT app_admin.attach_updated_at_trigger('app.ordering_settings');

-- -----------------------------------------------------------------------------
-- 3. Coupons
-- -----------------------------------------------------------------------------
CREATE TABLE app.coupons (
  id                  uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id     uuid        NOT NULL,
  business_id         uuid        NOT NULL,
  code                text        NOT NULL,
  description         text,
  discount_type       text        NOT NULL,
  discount_value      bigint      NOT NULL,
  max_discount_minor  bigint,
  min_order_minor     bigint      NOT NULL DEFAULT 0,
  valid_from          timestamptz,
  valid_until         timestamptz,
  usage_limit         integer,
  per_customer_limit  integer,
  active              boolean     NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT coupons_business_fk FOREIGN KEY (business_id, organization_id) REFERENCES app.businesses (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT coupons_code_chk   CHECK (code ~ '^[A-Z0-9_-]{2,30}$'),
  CONSTRAINT coupons_type_chk   CHECK (discount_type IN ('PERCENT','FLAT')),
  CONSTRAINT coupons_value_chk  CHECK (discount_value > 0 AND (discount_type <> 'PERCENT' OR discount_value <= 10000)),
  CONSTRAINT coupons_money_chk  CHECK (min_order_minor >= 0 AND (max_discount_minor IS NULL OR max_discount_minor > 0)),
  CONSTRAINT coupons_limits_chk CHECK ((usage_limit IS NULL OR usage_limit > 0) AND (per_customer_limit IS NULL OR per_customer_limit > 0)),
  CONSTRAINT coupons_range_chk  CHECK (valid_from IS NULL OR valid_until IS NULL OR valid_from < valid_until)
);
CREATE UNIQUE INDEX coupons_code_uq ON app.coupons (business_id, code);
SELECT app_admin.attach_updated_at_trigger('app.coupons');

-- -----------------------------------------------------------------------------
-- 4. Customer memory (long-term, per business)
-- -----------------------------------------------------------------------------
CREATE TABLE app.customer_profiles (
  contact_id          uuid        PRIMARY KEY,
  organization_id     uuid        NOT NULL,
  business_id         uuid        NOT NULL,
  preferred_language  text,
  food_preference     text,
  allergy_note        text,
  notes               text,
  updated_by          text        NOT NULL DEFAULT 'AI',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_profiles_contact_fk FOREIGN KEY (contact_id, organization_id, business_id)
    REFERENCES app.contacts (id, organization_id, business_id) ON DELETE CASCADE,
  CONSTRAINT customer_profiles_lang_chk  CHECK (preferred_language IS NULL OR preferred_language ~ '^[a-z]{2,3}(-[A-Za-z]{2,8})?$'),
  CONSTRAINT customer_profiles_food_chk  CHECK (food_preference IS NULL OR food_preference IN ('VEG','NON_VEG','EGG','VEGAN','JAIN')),
  CONSTRAINT customer_profiles_text_chk  CHECK (length(coalesce(allergy_note,'')) <= 300 AND length(coalesce(notes,'')) <= 500),
  CONSTRAINT customer_profiles_by_chk    CHECK (updated_by IN ('AI','USER','CUSTOMER'))
);
SELECT app_admin.attach_updated_at_trigger('app.customer_profiles');

CREATE TABLE app.customer_addresses (
  id               uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id  uuid        NOT NULL,
  business_id      uuid        NOT NULL,
  contact_id       uuid        NOT NULL,
  label            text,
  address          jsonb       NOT NULL,
  pincode          text,
  latitude         numeric(9,6),
  longitude        numeric(9,6),
  fingerprint      text        NOT NULL,
  last_used_at     timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_addresses_contact_fk FOREIGN KEY (contact_id, organization_id, business_id)
    REFERENCES app.contacts (id, organization_id, business_id) ON DELETE CASCADE,
  CONSTRAINT customer_addresses_id_org_biz_uq UNIQUE (id, organization_id, business_id),
  CONSTRAINT customer_addresses_addr_chk CHECK (jsonb_typeof(address) = 'object'),
  CONSTRAINT customer_addresses_pin_chk  CHECK (pincode IS NULL OR pincode ~ '^[0-9]{4,10}$'),
  CONSTRAINT customer_addresses_label_chk CHECK (label IS NULL OR length(label) <= 40)
);
CREATE UNIQUE INDEX customer_addresses_fp_uq ON app.customer_addresses (contact_id, fingerprint);
CREATE INDEX customer_addresses_contact_idx ON app.customer_addresses (contact_id, last_used_at DESC);

-- -----------------------------------------------------------------------------
-- 5. Carts (draft order state; one ACTIVE cart per customer and business).
--    Test Assistant carts belong to a test session, never to a real customer.
-- -----------------------------------------------------------------------------
CREATE TABLE app.carts (
  id                   uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id      uuid        NOT NULL,
  business_id          uuid        NOT NULL,
  contact_id           uuid,
  test_session_id      uuid,
  conversation_id      uuid,
  status               text        NOT NULL DEFAULT 'ACTIVE',
  version              integer     NOT NULL DEFAULT 1,
  fulfillment_mode     text,
  scheduled_for        timestamptz,
  address              jsonb,
  address_status       text,
  delivery_fee_minor   bigint,
  payment_method       text,
  coupon_code          text,
  customer_name        text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT carts_business_fk FOREIGN KEY (business_id, organization_id) REFERENCES app.businesses (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT carts_contact_fk FOREIGN KEY (contact_id, organization_id, business_id)
    REFERENCES app.contacts (id, organization_id, business_id) ON DELETE CASCADE,
  CONSTRAINT carts_test_session_fk FOREIGN KEY (test_session_id, organization_id)
    REFERENCES app.ai_test_sessions (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT carts_id_org_uq      UNIQUE (id, organization_id),
  CONSTRAINT carts_owner_chk      CHECK ((contact_id IS NULL) <> (test_session_id IS NULL)),
  CONSTRAINT carts_status_chk     CHECK (status IN ('ACTIVE','ORDERED','ABANDONED')),
  CONSTRAINT carts_version_chk    CHECK (version >= 1),
  CONSTRAINT carts_mode_chk       CHECK (fulfillment_mode IS NULL OR fulfillment_mode IN ('DELIVERY','PICKUP','DINE_IN')),
  CONSTRAINT carts_addr_chk       CHECK (address IS NULL OR jsonb_typeof(address) = 'object'),
  CONSTRAINT carts_addr_status_chk CHECK (address_status IS NULL OR address_status IN ('INCOMPLETE','SERVICEABLE','NOT_SERVICEABLE')),
  CONSTRAINT carts_pay_chk        CHECK (payment_method IS NULL OR payment_method IN ('COD','PAY_AT_PICKUP','ONLINE')),
  CONSTRAINT carts_fee_chk        CHECK (delivery_fee_minor IS NULL OR delivery_fee_minor >= 0),
  CONSTRAINT carts_name_chk       CHECK (customer_name IS NULL OR length(customer_name) BETWEEN 1 AND 100)
);
CREATE UNIQUE INDEX carts_one_active_contact_uq ON app.carts (business_id, contact_id) WHERE status = 'ACTIVE' AND contact_id IS NOT NULL;
CREATE UNIQUE INDEX carts_one_active_test_uq ON app.carts (business_id, test_session_id) WHERE status = 'ACTIVE' AND test_session_id IS NOT NULL;
SELECT app_admin.attach_updated_at_trigger('app.carts');

CREATE TABLE app.cart_items (
  id                    uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id       uuid        NOT NULL,
  cart_id               uuid        NOT NULL,
  business_id           uuid        NOT NULL,
  item_id               uuid        NOT NULL,
  variant_id            uuid,
  quantity              integer     NOT NULL,
  modifier_ids          uuid[]      NOT NULL DEFAULT ARRAY[]::uuid[],
  special_instructions  text,
  line_key              text        NOT NULL,
  position              integer     NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cart_items_cart_fk FOREIGN KEY (cart_id, organization_id) REFERENCES app.carts (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT cart_items_item_fk FOREIGN KEY (item_id, organization_id, business_id) REFERENCES app.menu_items (id, organization_id, business_id) ON DELETE CASCADE,
  CONSTRAINT cart_items_variant_fk FOREIGN KEY (variant_id, organization_id, business_id) REFERENCES app.menu_item_variants (id, organization_id, business_id) ON DELETE CASCADE,
  CONSTRAINT cart_items_qty_chk   CHECK (quantity BETWEEN 1 AND 100),
  CONSTRAINT cart_items_mods_chk  CHECK (cardinality(modifier_ids) <= 20),
  CONSTRAINT cart_items_instr_chk CHECK (special_instructions IS NULL OR length(special_instructions) <= 300)
);
CREATE UNIQUE INDEX cart_items_line_uq ON app.cart_items (cart_id, line_key);
CREATE INDEX cart_items_cart_idx ON app.cart_items (cart_id, position);
SELECT app_admin.attach_updated_at_trigger('app.cart_items');

-- -----------------------------------------------------------------------------
-- 6. Checkout quotes (authoritative priced snapshot of ONE cart version)
-- -----------------------------------------------------------------------------
CREATE TABLE app.checkout_quotes (
  id               uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id  uuid        NOT NULL,
  business_id      uuid        NOT NULL,
  cart_id          uuid        NOT NULL,
  cart_version     integer     NOT NULL,
  totals           jsonb       NOT NULL,
  total_minor      bigint      NOT NULL,
  currency         text        NOT NULL,
  status           text        NOT NULL DEFAULT 'VALID',
  expires_at       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT checkout_quotes_cart_fk FOREIGN KEY (cart_id, organization_id) REFERENCES app.carts (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT checkout_quotes_id_org_uq UNIQUE (id, organization_id),
  CONSTRAINT checkout_quotes_status_chk CHECK (status IN ('VALID','USED','SUPERSEDED')),
  CONSTRAINT checkout_quotes_totals_chk CHECK (jsonb_typeof(totals) = 'object' AND total_minor >= 0)
);
CREATE INDEX checkout_quotes_cart_idx ON app.checkout_quotes (cart_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- 7. Orders
-- -----------------------------------------------------------------------------
CREATE TABLE app.orders (
  id                    uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id       uuid        NOT NULL,
  business_id           uuid        NOT NULL,
  order_number          bigint      NOT NULL,
  contact_id            uuid        NOT NULL,
  conversation_id       uuid,
  cart_id               uuid,
  quote_id              uuid        NOT NULL,
  ai_agent_id           uuid,
  status                text        NOT NULL DEFAULT 'PLACED',
  fulfillment_mode      text        NOT NULL,
  scheduled_for         timestamptz,
  address               jsonb,
  customer_name         text        NOT NULL,
  customer_phone        text        NOT NULL,
  payment_method        text        NOT NULL,
  payment_status        text        NOT NULL DEFAULT 'PENDING',
  coupon_code           text,
  subtotal_minor        bigint      NOT NULL,
  discount_minor        bigint      NOT NULL DEFAULT 0,
  packaging_minor       bigint      NOT NULL DEFAULT 0,
  delivery_fee_minor    bigint      NOT NULL DEFAULT 0,
  tax_minor             bigint      NOT NULL DEFAULT 0,
  total_minor           bigint      NOT NULL,
  currency              text        NOT NULL,
  source                text        NOT NULL,
  notes                 text,
  cancel_reason         text,
  placed_at             timestamptz NOT NULL DEFAULT now(),
  accepted_at           timestamptz,
  ready_at              timestamptz,
  completed_at          timestamptz,
  cancelled_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT orders_contact_fk FOREIGN KEY (contact_id, organization_id, business_id) REFERENCES app.contacts (id, organization_id, business_id) ON DELETE RESTRICT,
  CONSTRAINT orders_conversation_fk FOREIGN KEY (conversation_id, organization_id, business_id)
    REFERENCES app.conversations (id, organization_id, business_id) ON DELETE SET NULL (conversation_id),
  CONSTRAINT orders_quote_fk FOREIGN KEY (quote_id, organization_id) REFERENCES app.checkout_quotes (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT orders_agent_fk FOREIGN KEY (ai_agent_id, organization_id, business_id) REFERENCES app.ai_agents (id, organization_id, business_id) ON DELETE SET NULL (ai_agent_id),
  CONSTRAINT orders_id_org_uq      UNIQUE (id, organization_id),
  CONSTRAINT orders_quote_uq       UNIQUE (quote_id),                -- a quote can become at most ONE order (idempotency)
  CONSTRAINT orders_number_uq      UNIQUE (business_id, order_number),
  CONSTRAINT orders_status_chk     CHECK (status IN ('PLACED','ACCEPTED','PREPARING','READY','OUT_FOR_DELIVERY','DELIVERED','COMPLETED','CANCELLED','REJECTED')),
  CONSTRAINT orders_mode_chk       CHECK (fulfillment_mode IN ('DELIVERY','PICKUP','DINE_IN')),
  CONSTRAINT orders_pay_chk        CHECK (payment_method IN ('COD','PAY_AT_PICKUP','ONLINE')),
  CONSTRAINT orders_pay_status_chk CHECK (payment_status IN ('PENDING','PAID','REFUNDED','NOT_REQUIRED')),
  CONSTRAINT orders_money_chk      CHECK (subtotal_minor >= 0 AND discount_minor >= 0 AND packaging_minor >= 0 AND delivery_fee_minor >= 0
                                          AND tax_minor >= 0 AND total_minor >= 0),
  CONSTRAINT orders_source_chk     CHECK (source IN ('AI_WHATSAPP','DASHBOARD','API')),
  CONSTRAINT orders_delivery_chk   CHECK (fulfillment_mode <> 'DELIVERY' OR address IS NOT NULL),
  CONSTRAINT orders_phone_chk      CHECK (customer_phone ~ '^\+[1-9][0-9]{6,14}$'),
  CONSTRAINT orders_cancel_chk     CHECK (status NOT IN ('CANCELLED','REJECTED') OR cancelled_at IS NOT NULL)
);
CREATE INDEX orders_biz_status_idx ON app.orders (organization_id, business_id, status, placed_at DESC);
CREATE INDEX orders_org_recent_idx ON app.orders (organization_id, placed_at DESC);
CREATE INDEX orders_contact_idx ON app.orders (contact_id, placed_at DESC);
SELECT app_admin.attach_updated_at_trigger('app.orders');

CREATE TABLE app.order_items (
  id                    uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id       uuid        NOT NULL,
  order_id              uuid        NOT NULL,
  item_id               uuid,
  name                  text        NOT NULL,
  variant_name          text,
  modifiers             jsonb       NOT NULL DEFAULT '[]'::jsonb,
  special_instructions  text,
  quantity              integer     NOT NULL,
  unit_price_minor      bigint      NOT NULL,
  line_total_minor      bigint      NOT NULL,
  position              integer     NOT NULL,
  CONSTRAINT order_items_order_fk FOREIGN KEY (order_id, organization_id) REFERENCES app.orders (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT order_items_qty_chk   CHECK (quantity BETWEEN 1 AND 100 AND unit_price_minor >= 0 AND line_total_minor >= 0),
  CONSTRAINT order_items_mods_chk  CHECK (jsonb_typeof(modifiers) = 'array')
);
CREATE INDEX order_items_order_idx ON app.order_items (order_id, position);

CREATE TABLE app.order_events (
  id                    uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id       uuid        NOT NULL,
  order_id              uuid        NOT NULL,
  from_status           text,
  to_status             text        NOT NULL,
  actor_type            text        NOT NULL,
  actor_user_id         uuid        REFERENCES app.users(id) ON DELETE SET NULL,
  note                  text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_events_order_fk FOREIGN KEY (order_id, organization_id) REFERENCES app.orders (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT order_events_actor_chk CHECK (actor_type IN ('AI','USER','CUSTOMER','SYSTEM')),
  CONSTRAINT order_events_note_chk  CHECK (note IS NULL OR length(note) <= 500)
);
CREATE INDEX order_events_order_idx ON app.order_events (order_id, created_at);

CREATE TABLE app.order_change_requests (
  id                 uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id    uuid        NOT NULL,
  business_id        uuid        NOT NULL,
  order_id           uuid        NOT NULL,
  kind               text        NOT NULL,
  details            text        NOT NULL,
  status             text        NOT NULL DEFAULT 'PENDING',
  requested_by       text        NOT NULL DEFAULT 'AI',
  resolution_note    text,
  resolved_by_user_id uuid       REFERENCES app.users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  resolved_at        timestamptz,
  CONSTRAINT ocr_order_fk FOREIGN KEY (order_id, organization_id) REFERENCES app.orders (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT ocr_kind_chk   CHECK (kind IN ('MODIFY','CANCEL','ADDRESS')),
  CONSTRAINT ocr_status_chk CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  CONSTRAINT ocr_by_chk     CHECK (requested_by IN ('AI','CUSTOMER','USER')),
  CONSTRAINT ocr_text_chk   CHECK (length(details) BETWEEN 1 AND 1000 AND length(coalesce(resolution_note,'')) <= 500)
);
CREATE INDEX ocr_order_idx ON app.order_change_requests (order_id, created_at DESC);
CREATE INDEX ocr_pending_idx ON app.order_change_requests (organization_id, business_id, created_at DESC) WHERE status = 'PENDING';

CREATE TABLE app.support_tickets (
  id                 uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id    uuid        NOT NULL,
  business_id        uuid        NOT NULL,
  contact_id         uuid,
  conversation_id    uuid,
  order_id           uuid,
  category           text        NOT NULL,
  description        text        NOT NULL,
  priority           text        NOT NULL DEFAULT 'NORMAL',
  status             text        NOT NULL DEFAULT 'OPEN',
  idempotency_key    text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  resolved_at        timestamptz,
  CONSTRAINT support_tickets_contact_fk FOREIGN KEY (contact_id, organization_id, business_id)
    REFERENCES app.contacts (id, organization_id, business_id) ON DELETE SET NULL (contact_id),
  CONSTRAINT support_tickets_order_fk FOREIGN KEY (order_id, organization_id) REFERENCES app.orders (id, organization_id) ON DELETE SET NULL (order_id),
  CONSTRAINT support_tickets_business_fk FOREIGN KEY (business_id, organization_id) REFERENCES app.businesses (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT support_tickets_cat_chk  CHECK (category IN ('WRONG_ITEM','MISSING_ITEM','QUALITY','DELAY','PAYMENT','REFUND','PACKAGING','ALLERGY','OTHER')),
  CONSTRAINT support_tickets_prio_chk CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT')),
  CONSTRAINT support_tickets_stat_chk CHECK (status IN ('OPEN','IN_PROGRESS','RESOLVED')),
  CONSTRAINT support_tickets_desc_chk CHECK (length(description) BETWEEN 1 AND 1000)
);
CREATE INDEX support_tickets_open_idx ON app.support_tickets (organization_id, business_id, created_at DESC) WHERE status <> 'RESOLVED';
CREATE UNIQUE INDEX support_tickets_idem_uq ON app.support_tickets (organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
SELECT app_admin.attach_updated_at_trigger('app.support_tickets');

-- =============================================================================
-- RLS + GRANTS
-- =============================================================================
SELECT app_admin.apply_tenant_rls(t) FROM unnest(ARRAY[
  'app.menu_categories','app.menu_items','app.menu_item_variants','app.menu_modifier_groups','app.menu_modifiers',
  'app.menu_item_modifier_groups','app.ordering_settings','app.coupons','app.customer_profiles','app.customer_addresses',
  'app.carts','app.cart_items','app.checkout_quotes','app.orders','app.order_items','app.order_events',
  'app.order_change_requests','app.support_tickets']::regclass[]) AS t;

-- Owner dashboard (hs_app): manage menu/settings/coupons, work orders; the Test Assistant uses sandbox carts.
GRANT SELECT, INSERT, UPDATE ON app.menu_categories, app.menu_items, app.menu_item_variants, app.menu_modifier_groups, app.menu_modifiers,
  app.ordering_settings, app.coupons TO hs_app;
GRANT SELECT, INSERT, DELETE ON app.menu_item_modifier_groups TO hs_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.carts, app.cart_items TO hs_app;
GRANT SELECT, INSERT, UPDATE ON app.checkout_quotes TO hs_app;
GRANT SELECT, UPDATE ON app.orders, app.order_change_requests, app.support_tickets TO hs_app;
GRANT SELECT ON app.order_items, app.customer_profiles, app.customer_addresses TO hs_app;
GRANT SELECT, INSERT ON app.order_events TO hs_app;
GRANT UPDATE (next_order_number) ON app.ordering_settings TO hs_worker;

-- Assistant runtime (hs_worker): read menu/settings/coupons, keep carts, create orders/tickets/requests, remember customers.
GRANT SELECT ON app.menu_categories, app.menu_items, app.menu_item_variants, app.menu_modifier_groups, app.menu_modifiers,
  app.menu_item_modifier_groups, app.ordering_settings, app.coupons TO hs_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.carts, app.cart_items TO hs_worker;
GRANT SELECT, INSERT, UPDATE ON app.checkout_quotes, app.orders, app.order_change_requests, app.support_tickets,
  app.customer_profiles, app.customer_addresses TO hs_worker;
GRANT SELECT, INSERT ON app.order_items, app.order_events TO hs_worker;
