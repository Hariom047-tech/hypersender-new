-- =============================================================================
-- 0009 BILLING, ENTITLEMENTS & USAGE METERING
-- Payment-provider agnostic: provider + provider_* ids; never card data.
-- =============================================================================

-- ---------------------------------------------------------------- platform ---
CREATE TABLE app.subscription_plans (
  id                 uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  code               text        NOT NULL UNIQUE,
  name               text        NOT NULL,
  description        text,
  billing_interval   text        NOT NULL,
  price_minor_units  bigint      NOT NULL,
  currency           text        NOT NULL,
  trial_days         integer     NOT NULL DEFAULT 0,
  active             boolean     NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscription_plans_code_chk     CHECK (code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  CONSTRAINT subscription_plans_interval_chk CHECK (billing_interval IN ('MONTH','YEAR')),
  CONSTRAINT subscription_plans_price_chk    CHECK (price_minor_units >= 0),
  CONSTRAINT subscription_plans_currency_chk CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT subscription_plans_trial_chk    CHECK (trial_days BETWEEN 0 AND 365)
);
SELECT app_admin.attach_updated_at_trigger('app.subscription_plans');

-- Limits are data, not code. limit_value NULL + enabled = unlimited.
CREATE TABLE app.plan_entitlements (
  id           uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  plan_id      uuid        NOT NULL REFERENCES app.subscription_plans(id) ON DELETE CASCADE,
  feature_key  text        NOT NULL,
  limit_value  bigint,
  enabled      boolean     NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plan_entitlements_uq          UNIQUE (plan_id, feature_key),
  CONSTRAINT plan_entitlements_feature_chk CHECK (feature_key ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  CONSTRAINT plan_entitlements_limit_chk   CHECK (limit_value IS NULL OR limit_value >= 0)
);
SELECT app_admin.attach_updated_at_trigger('app.plan_entitlements');

CREATE TABLE app.usage_event_types (
  code         text        PRIMARY KEY,
  unit         text        NOT NULL,
  description  text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT usage_event_types_code_chk CHECK (code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  CONSTRAINT usage_event_types_unit_chk CHECK (unit IN ('COUNT','TOKENS','BYTES','SECONDS'))
);

-- ------------------------------------------------------------------ tenant ---
CREATE TABLE app.subscriptions (
  id                        uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id           uuid        NOT NULL REFERENCES app.organizations(id) ON DELETE RESTRICT,
  plan_id                   uuid        NOT NULL REFERENCES app.subscription_plans(id) ON DELETE RESTRICT,
  provider                  text        NOT NULL,
  provider_customer_id      text,
  provider_subscription_id  text,
  status                    text        NOT NULL,
  current_period_start      timestamptz NOT NULL,
  current_period_end        timestamptz NOT NULL,
  trial_end                 timestamptz,
  cancel_at_period_end      boolean     NOT NULL DEFAULT false,
  cancelled_at              timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscriptions_id_org_uq     UNIQUE (id, organization_id),
  CONSTRAINT subscriptions_provider_chk  CHECK (provider IN ('NONE','RAZORPAY','STRIPE','MANUAL')),
  CONSTRAINT subscriptions_status_chk    CHECK (status IN ('TRIALING','ACTIVE','PAST_DUE','CANCELLED','EXPIRED')),
  CONSTRAINT subscriptions_period_chk    CHECK (current_period_end > current_period_start),
  CONSTRAINT subscriptions_trial_chk     CHECK (status <> 'TRIALING' OR trial_end IS NOT NULL)
);
-- At most one live subscription per organization.
CREATE UNIQUE INDEX subscriptions_one_live_uq ON app.subscriptions (organization_id)
  WHERE status IN ('TRIALING','ACTIVE','PAST_DUE');
CREATE UNIQUE INDEX subscriptions_provider_uq ON app.subscriptions (provider, provider_subscription_id)
  WHERE provider_subscription_id IS NOT NULL;
SELECT app_admin.attach_updated_at_trigger('app.subscriptions');

-- Financial records: retained for statutory periods. FKs RESTRICT everywhere;
-- runtime roles cannot DELETE; organization purge never touches them.
CREATE TABLE app.invoices (
  id                    uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id       uuid        NOT NULL REFERENCES app.organizations(id) ON DELETE RESTRICT,
  subscription_id       uuid,
  provider              text        NOT NULL,
  provider_invoice_id   text,
  invoice_number        text,
  status                text        NOT NULL,
  currency              text        NOT NULL,
  subtotal_minor        bigint      NOT NULL,
  discount_minor        bigint      NOT NULL DEFAULT 0,
  tax_minor             bigint      NOT NULL DEFAULT 0,
  total_minor           bigint      NOT NULL,
  amount_paid_minor     bigint      NOT NULL DEFAULT 0,
  period_start          timestamptz,
  period_end            timestamptz,
  issued_at             timestamptz,
  due_at                timestamptz,
  paid_at               timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invoices_subscription_fk FOREIGN KEY (subscription_id, organization_id)
    REFERENCES app.subscriptions (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT invoices_id_org_uq      UNIQUE (id, organization_id),
  CONSTRAINT invoices_provider_chk   CHECK (provider IN ('NONE','RAZORPAY','STRIPE','MANUAL')),
  CONSTRAINT invoices_status_chk     CHECK (status IN ('DRAFT','OPEN','PAID','VOID','UNCOLLECTIBLE')),
  CONSTRAINT invoices_currency_chk   CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT invoices_amounts_chk    CHECK (subtotal_minor >= 0 AND discount_minor >= 0 AND tax_minor >= 0
                                            AND amount_paid_minor >= 0
                                            AND total_minor = subtotal_minor - discount_minor + tax_minor
                                            AND total_minor >= 0),
  CONSTRAINT invoices_paid_chk       CHECK (status <> 'PAID' OR paid_at IS NOT NULL)
);
CREATE UNIQUE INDEX invoices_provider_uq ON app.invoices (provider, provider_invoice_id) WHERE provider_invoice_id IS NOT NULL;
CREATE UNIQUE INDEX invoices_number_uq ON app.invoices (invoice_number) WHERE invoice_number IS NOT NULL;
CREATE INDEX invoices_org_idx ON app.invoices (organization_id, created_at DESC);
SELECT app_admin.attach_updated_at_trigger('app.invoices');

CREATE TABLE app.payments (
  id                   uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id      uuid        NOT NULL REFERENCES app.organizations(id) ON DELETE RESTRICT,
  invoice_id           uuid,
  provider             text        NOT NULL,
  provider_payment_id  text        NOT NULL,
  provider_order_id    text,
  amount_minor         bigint      NOT NULL,
  currency             text        NOT NULL,
  status               text        NOT NULL,
  -- Payment METHOD CATEGORY only. Card numbers / CVV / UPI PINs are never
  -- received or stored (tokenised by the provider).
  method_type          text,
  failure_code         text,
  failure_reason       text,
  paid_at              timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payments_invoice_fk FOREIGN KEY (invoice_id, organization_id)
    REFERENCES app.invoices (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT payments_provider_uq   UNIQUE (provider, provider_payment_id),
  CONSTRAINT payments_provider_chk  CHECK (provider IN ('RAZORPAY','STRIPE','MANUAL')),
  CONSTRAINT payments_amount_chk    CHECK (amount_minor > 0),
  CONSTRAINT payments_currency_chk  CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT payments_status_chk    CHECK (status IN ('CREATED','AUTHORIZED','CAPTURED','FAILED','REFUNDED','PARTIALLY_REFUNDED')),
  CONSTRAINT payments_method_chk    CHECK (method_type IS NULL OR method_type IN ('CARD','UPI','NETBANKING','WALLET','BANK_TRANSFER','OTHER'))
);
CREATE INDEX payments_org_idx ON app.payments (organization_id, created_at DESC);
CREATE INDEX payments_invoice_idx ON app.payments (invoice_id) WHERE invoice_id IS NOT NULL;
SELECT app_admin.attach_updated_at_trigger('app.payments');

-- -----------------------------------------------------------------------------
-- usage_events: immutable metering ledger (append-only). Billing and quota
-- checks aggregate THIS table (later: rollups), never the messages table.
-- idempotency_key (e.g. 'msg-in:<message_id>') makes metering exactly-once
-- even when the producing outbox event is processed twice.
-- -----------------------------------------------------------------------------
CREATE TABLE app.usage_events (
  id               uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id  uuid        NOT NULL REFERENCES app.organizations(id) ON DELETE RESTRICT,
  business_id      uuid,
  event_type       text        NOT NULL REFERENCES app.usage_event_types(code) ON DELETE RESTRICT,
  quantity         bigint      NOT NULL,
  resource_type    text,
  resource_id      uuid,
  idempotency_key  text        NOT NULL,
  occurred_at      timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT usage_events_business_fk FOREIGN KEY (business_id, organization_id)
    REFERENCES app.businesses (id, organization_id) ON DELETE SET NULL (business_id),
  CONSTRAINT usage_events_idem_uq      UNIQUE (organization_id, idempotency_key),
  CONSTRAINT usage_events_v7_chk       CHECK (uuid_extract_version(id) = 7),
  CONSTRAINT usage_events_quantity_chk CHECK (quantity > 0)
);
-- Period aggregation per tenant (billing, quota checks).
CREATE INDEX usage_events_org_occurred_idx ON app.usage_events (organization_id, occurred_at, event_type);

-- Current organization's entitlement for a feature (NULL row => not entitled).
CREATE FUNCTION app.current_entitlement(p_feature_key text)
RETURNS TABLE (enabled boolean, limit_value bigint)
LANGUAGE sql STABLE AS $$
  SELECT pe.enabled, pe.limit_value
    FROM app.subscriptions s
    JOIN app.plan_entitlements pe ON pe.plan_id = s.plan_id AND pe.feature_key = p_feature_key
   WHERE s.organization_id = app.current_org_id()
     AND s.status IN ('TRIALING','ACTIVE','PAST_DUE')
$$;
GRANT EXECUTE ON FUNCTION app.current_entitlement(text) TO hs_app, hs_worker;

-- =============================================================================
-- RLS + GRANTS
-- =============================================================================
GRANT SELECT ON app.subscription_plans, app.plan_entitlements, app.usage_event_types TO hs_app, hs_worker;

SELECT app_admin.apply_tenant_rls('app.subscriptions');
SELECT app_admin.apply_tenant_rls('app.invoices');
SELECT app_admin.apply_tenant_rls('app.payments');
SELECT app_admin.apply_tenant_rls('app.usage_events');

-- The API may only START A TRIAL. Paid states are written by the billing worker
-- after the payment provider confirms (webhook), so an application bug can
-- never grant a paid plan.
CREATE POLICY subscriptions_app_insert_trial_only ON app.subscriptions
  AS RESTRICTIVE FOR INSERT TO hs_app
  WITH CHECK (status = 'TRIALING' AND provider = 'NONE');

GRANT SELECT, INSERT ON app.subscriptions TO hs_app;
GRANT UPDATE (cancel_at_period_end) ON app.subscriptions TO hs_app;
GRANT SELECT, INSERT, UPDATE ON app.subscriptions TO hs_worker;
GRANT SELECT ON app.invoices, app.payments TO hs_app;
GRANT SELECT, INSERT, UPDATE ON app.invoices, app.payments TO hs_worker;
GRANT SELECT, INSERT ON app.usage_events TO hs_app, hs_worker;
