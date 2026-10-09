-- =============================================================================
-- PLATFORM SEED: lookup types, subscription plans, entitlements.
-- Idempotent (ON CONFLICT). Contains NO tenant data and NO secrets.
-- =============================================================================

INSERT INTO app.webhook_event_types (code, description) VALUES
  ('INSTANCE_CONNECTED',      'A WhatsApp instance finished connecting'),
  ('INSTANCE_DISCONNECTED',   'A WhatsApp instance lost its connection'),
  ('INSTANCE_STATUS_CHANGED', 'Any WhatsApp instance status transition'),
  ('MESSAGE_RECEIVED',        'Inbound message stored'),
  ('MESSAGE_SENT',            'Outbound message accepted by WhatsApp'),
  ('MESSAGE_DELIVERED',       'Outbound message delivered to recipient device'),
  ('MESSAGE_READ',            'Outbound message read by recipient'),
  ('MESSAGE_FAILED',          'Outbound message failed permanently'),
  ('MESSAGE_REVOKED',         'Message deleted for everyone'),
  ('MESSAGE_REACTION',        'Reaction added or removed'),
  ('BOOKING_CREATED',         'Booking created'),
  ('BOOKING_UPDATED',         'Booking confirmed, rescheduled, cancelled or completed')
ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description;

INSERT INTO app.usage_event_types (code, unit, description) VALUES
  ('WHATSAPP_MESSAGE_IN',  'COUNT',  'Inbound WhatsApp message stored'),
  ('WHATSAPP_MESSAGE_OUT', 'COUNT',  'Outbound WhatsApp message sent'),
  ('AI_RUN',               'COUNT',  'AI assistant execution'),
  ('AI_INPUT_TOKENS',      'TOKENS', 'Model input tokens'),
  ('AI_OUTPUT_TOKENS',     'TOKENS', 'Model output tokens'),
  ('MEDIA_BYTES',          'BYTES',  'Media bytes stored'),
  ('BOOKING_CREATED',      'COUNT',  'Booking created'),
  ('KNOWLEDGE_BYTES',      'BYTES',  'Knowledge source bytes ingested')
ON CONFLICT (code) DO UPDATE SET unit = EXCLUDED.unit, description = EXCLUDED.description;

INSERT INTO app.subscription_plans (code, name, description, billing_interval, price_minor_units, currency, trial_days) VALUES
  ('TRIAL',   'Free Trial', '14-day evaluation',                         'MONTH',      0, 'INR', 14),
  ('STARTER', 'Starter',    'One WhatsApp number with an AI assistant',  'MONTH', 149900, 'INR',  0),
  ('GROWTH',  'Growth',     'Multiple numbers, team inbox, API access',  'MONTH', 499900, 'INR',  0)
ON CONFLICT (code) DO UPDATE
  SET name = EXCLUDED.name, description = EXCLUDED.description, billing_interval = EXCLUDED.billing_interval,
      price_minor_units = EXCLUDED.price_minor_units, currency = EXCLUDED.currency, trial_days = EXCLUDED.trial_days;

-- (plan, feature, limit, enabled). NULL limit = unlimited.
INSERT INTO app.plan_entitlements (plan_id, feature_key, limit_value, enabled)
SELECT p.id, e.feature_key, e.limit_value, e.enabled
  FROM (VALUES
    ('TRIAL',   'MAX_WHATSAPP_INSTANCES',   1::bigint, true),
    ('TRIAL',   'MAX_AI_AGENTS',            1,     true),
    ('TRIAL',   'MONTHLY_AI_MESSAGES',      300,   true),
    ('TRIAL',   'MONTHLY_MESSAGES',         1000,  true),
    ('TRIAL',   'TEAM_MEMBERS',             2,     true),
    ('TRIAL',   'KNOWLEDGE_STORAGE_MB',     20,    true),
    ('TRIAL',   'WEBHOOKS',                 1,     true),
    ('TRIAL',   'API_ACCESS',               NULL,  false),
    ('TRIAL',   'MARKETING_DAILY_CONTACTS', 50,    true),
    ('STARTER', 'MAX_WHATSAPP_INSTANCES',   1,     true),
    ('STARTER', 'MAX_AI_AGENTS',            2,     true),
    ('STARTER', 'MONTHLY_AI_MESSAGES',      3000,  true),
    ('STARTER', 'MONTHLY_MESSAGES',         10000, true),
    ('STARTER', 'TEAM_MEMBERS',             3,     true),
    ('STARTER', 'KNOWLEDGE_STORAGE_MB',     100,   true),
    ('STARTER', 'WEBHOOKS',                 3,     true),
    ('STARTER', 'API_ACCESS',               NULL,  false),
    ('STARTER', 'MARKETING_DAILY_CONTACTS', 1000,  true),
    ('GROWTH',  'MAX_WHATSAPP_INSTANCES',   5,     true),
    ('GROWTH',  'MAX_AI_AGENTS',            10,    true),
    ('GROWTH',  'MONTHLY_AI_MESSAGES',      25000, true),
    ('GROWTH',  'MONTHLY_MESSAGES',         100000,true),
    ('GROWTH',  'TEAM_MEMBERS',             15,    true),
    ('GROWTH',  'KNOWLEDGE_STORAGE_MB',     1024,  true),
    ('GROWTH',  'WEBHOOKS',                 20,    true),
    ('GROWTH',  'API_ACCESS',               NULL,  true),
    ('GROWTH',  'MARKETING_DAILY_CONTACTS', 5000,  true)
  ) AS e(plan_code, feature_key, limit_value, enabled)
  JOIN app.subscription_plans p ON p.code = e.plan_code
ON CONFLICT (plan_id, feature_key) DO UPDATE SET limit_value = EXCLUDED.limit_value, enabled = EXCLUDED.enabled;
