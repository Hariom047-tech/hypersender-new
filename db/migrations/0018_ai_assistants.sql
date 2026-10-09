-- =============================================================================
-- 0018 AI ASSISTANTS (Phase 4) - ADDITIVE ONLY.
-- Reuses every Phase 1 AI table (ai_assistant_templates, ai_tools, ai_agents,
-- ai_agent_versions, ai_agent_channels, ai_agent_tools, ai_runs, ai_tool_calls,
-- knowledge_*). Adds only what the template marketplace, tool registry,
-- confirmation flow, debounce/locking, leads and the test sandbox need.
-- Why each change exists: docs/ai-assistant-architecture.md "Database review".
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Templates: marketplace metadata (platform-owned; never tenant data).
--    `description` (existing) is the short description.
-- -----------------------------------------------------------------------------
ALTER TABLE app.ai_assistant_templates
  ADD COLUMN long_description     text,
  ADD COLUMN industry             text,
  ADD COLUMN icon_key             text        NOT NULL DEFAULT 'assistant',
  ADD COLUMN marketplace_category text        NOT NULL DEFAULT 'GENERAL',
  ADD COLUMN welcome_behavior     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN supported_languages  text[]      NOT NULL DEFAULT ARRAY['en']::text[],
  ADD COLUMN recommended_model    text,
  ADD COLUMN model_settings       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN demo_conversations   jsonb       NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN setup_requirements   jsonb       NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN recommended_for      text[]      NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN setup_minutes        integer,
  ADD COLUMN display_order        integer     NOT NULL DEFAULT 100,
  ADD COLUMN published_at         timestamptz,
  ADD COLUMN deprecated_at        timestamptz;
ALTER TABLE app.ai_assistant_templates
  ADD CONSTRAINT ai_templates_mkt_category_chk CHECK (marketplace_category IN ('APPOINTMENTS','SALES','SUPPORT','HOSPITALITY','REAL_ESTATE','GENERAL')),
  ADD CONSTRAINT ai_templates_icon_chk         CHECK (icon_key ~ '^[a-z][a-z0-9-]{1,40}$'),
  ADD CONSTRAINT ai_templates_welcome_chk      CHECK (jsonb_typeof(welcome_behavior) = 'object'),
  ADD CONSTRAINT ai_templates_model_chk        CHECK (jsonb_typeof(model_settings) = 'object'),
  ADD CONSTRAINT ai_templates_demo_chk         CHECK (jsonb_typeof(demo_conversations) = 'array'),
  ADD CONSTRAINT ai_templates_setup_chk        CHECK (jsonb_typeof(setup_requirements) = 'array'),
  ADD CONSTRAINT ai_templates_langs_chk        CHECK (cardinality(supported_languages) BETWEEN 1 AND 20),
  ADD CONSTRAINT ai_templates_minutes_chk      CHECK (setup_minutes IS NULL OR setup_minutes BETWEEN 1 AND 600);

-- -----------------------------------------------------------------------------
-- 2. Tools: a real capability registry. `availability` = does a backend handler
--    exist? A NOT_READY tool can never be enabled or executed.
-- -----------------------------------------------------------------------------
ALTER TABLE app.ai_tools
  ADD COLUMN category                text    NOT NULL DEFAULT 'SYSTEM',
  ADD COLUMN handler_key             text,
  ADD COLUMN output_schema           jsonb   NOT NULL DEFAULT '{"type":"object"}'::jsonb,
  ADD COLUMN config_schema           jsonb   NOT NULL DEFAULT '{"type":"object","properties":{}}'::jsonb,
  ADD COLUMN risk_level              text    NOT NULL DEFAULT 'LOW',
  ADD COLUMN is_read_only            boolean NOT NULL DEFAULT true,
  ADD COLUMN has_side_effects        boolean NOT NULL DEFAULT false,
  ADD COLUMN version                 integer NOT NULL DEFAULT 1,
  ADD COLUMN availability            text    NOT NULL DEFAULT 'NOT_READY',
  ADD COLUMN capability_name         text,
  ADD COLUMN capability_description  text;
-- The flags are always derived from the Phase 1 side_effect column (single source
-- of truth, so older seed statements that do not know the new columns stay valid).
CREATE FUNCTION app.ai_tools_derive_flags() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.is_read_only := (NEW.side_effect = 'READ');
  NEW.has_side_effects := (NEW.side_effect <> 'READ');
  RETURN NEW;
END $$;
CREATE TRIGGER ai_tools_derive_flags BEFORE INSERT OR UPDATE ON app.ai_tools
  FOR EACH ROW EXECUTE FUNCTION app.ai_tools_derive_flags();
UPDATE app.ai_tools SET side_effect = side_effect;  -- fire the trigger for existing rows
ALTER TABLE app.ai_tools
  ADD CONSTRAINT ai_tools_category_chk     CHECK (category IN ('BUSINESS_INFO','KNOWLEDGE','CUSTOMER','BOOKING','SALES','PAYMENT','COMMUNICATION','SYSTEM','INTEGRATION')),
  ADD CONSTRAINT ai_tools_risk_chk         CHECK (risk_level IN ('LOW','MEDIUM','HIGH')),
  ADD CONSTRAINT ai_tools_ro_chk           CHECK (is_read_only = (side_effect = 'READ') AND has_side_effects = NOT is_read_only),
  ADD CONSTRAINT ai_tools_availability_chk CHECK (availability IN ('READY','NOT_READY')),
  ADD CONSTRAINT ai_tools_ready_handler_chk CHECK (availability = 'NOT_READY' OR handler_key IS NOT NULL),
  ADD CONSTRAINT ai_tools_handler_chk      CHECK (handler_key IS NULL OR handler_key ~ '^[a-z][a-z0-9_.]{1,63}$'),
  ADD CONSTRAINT ai_tools_version_chk      CHECK (version >= 1),
  ADD CONSTRAINT ai_tools_out_schema_chk   CHECK (jsonb_typeof(output_schema) = 'object'),
  ADD CONSTRAINT ai_tools_cfg_schema_chk   CHECK (jsonb_typeof(config_schema) = 'object');

-- -----------------------------------------------------------------------------
-- 3. Template -> tool mapping (which capabilities a template ships with).
-- -----------------------------------------------------------------------------
CREATE TABLE app.ai_template_tools (
  id                     uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  template_id            uuid        NOT NULL REFERENCES app.ai_assistant_templates(id) ON DELETE CASCADE,
  tool_id                uuid        NOT NULL REFERENCES app.ai_tools(id) ON DELETE RESTRICT,
  required               boolean     NOT NULL DEFAULT false,
  default_enabled        boolean     NOT NULL DEFAULT true,
  display_order          integer     NOT NULL DEFAULT 100,
  default_configuration  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_template_tools_uq         UNIQUE (template_id, tool_id),
  CONSTRAINT ai_template_tools_req_chk    CHECK (NOT required OR default_enabled),
  CONSTRAINT ai_template_tools_config_chk CHECK (jsonb_typeof(default_configuration) = 'object')
);
CREATE INDEX ai_template_tools_tool_idx ON app.ai_template_tools (tool_id);

-- -----------------------------------------------------------------------------
-- 4. Logical tool dependencies (template validation / capability UI hints).
--    Business-level tools still validate internally (CREATE_BOOKING re-checks
--    availability); this is NOT a CRUD sequence imposed on the model.
-- -----------------------------------------------------------------------------
CREATE TABLE app.ai_tool_dependencies (
  tool_id             uuid        NOT NULL REFERENCES app.ai_tools(id) ON DELETE CASCADE,
  depends_on_tool_id  uuid        NOT NULL REFERENCES app.ai_tools(id) ON DELETE CASCADE,
  relation            text        NOT NULL DEFAULT 'RECOMMENDS',
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tool_id, depends_on_tool_id),
  CONSTRAINT ai_tool_deps_self_chk     CHECK (tool_id <> depends_on_tool_id),
  CONSTRAINT ai_tool_deps_relation_chk CHECK (relation IN ('REQUIRES','RECOMMENDS'))
);

-- Model pricing: data, not code. Empty until platform admins enter verified
-- prices; runs then carry no cost estimate (never a guessed one).
CREATE TABLE app.ai_model_pricing (
  id                           uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  model_provider               text        NOT NULL,
  model_name                   text        NOT NULL,
  input_micros_per_mtok        bigint      NOT NULL,
  cached_input_micros_per_mtok bigint,
  output_micros_per_mtok       bigint      NOT NULL,
  currency                     text        NOT NULL DEFAULT 'USD',
  effective_from               timestamptz NOT NULL DEFAULT now(),
  created_at                   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_model_pricing_uq        UNIQUE (model_provider, model_name, effective_from),
  CONSTRAINT ai_model_pricing_money_chk CHECK (input_micros_per_mtok >= 0 AND output_micros_per_mtok >= 0
                                               AND coalesce(cached_input_micros_per_mtok, 0) >= 0),
  CONSTRAINT ai_model_pricing_ccy_chk   CHECK (currency ~ '^[A-Z]{3}$')
);

GRANT SELECT ON app.ai_template_tools, app.ai_tool_dependencies, app.ai_model_pricing TO hs_app, hs_worker;

-- -----------------------------------------------------------------------------
-- 5. Tenant assistants (ai_agents): installed-template snapshot + layered
--    instruction/behaviour settings. The template snapshot is copied at install
--    so a platform template update never silently changes a live assistant.
-- -----------------------------------------------------------------------------
ALTER TABLE app.ai_agents
  ADD COLUMN template_key           text,
  ADD COLUMN template_version       integer,
  ADD COLUMN template_instructions  text,
  ADD COLUMN custom_instructions    text,
  ADD COLUMN instructions_mode      text    NOT NULL DEFAULT 'SIMPLE',
  ADD COLUMN welcome_config         jsonb   NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN handoff_config         jsonb   NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN response_wait_ms       integer NOT NULL DEFAULT 4000,
  ADD COLUMN max_tool_iterations    integer NOT NULL DEFAULT 6,
  ADD COLUMN config_revision        integer NOT NULL DEFAULT 1;
ALTER TABLE app.ai_agents
  ADD CONSTRAINT ai_agents_instr_mode_chk   CHECK (instructions_mode IN ('SIMPLE','ADVANCED')),
  ADD CONSTRAINT ai_agents_custom_instr_chk CHECK (custom_instructions IS NULL OR length(custom_instructions) <= 8000),
  ADD CONSTRAINT ai_agents_template_instr_chk CHECK (template_instructions IS NULL OR length(template_instructions) <= 20000),
  ADD CONSTRAINT ai_agents_welcome_chk      CHECK (jsonb_typeof(welcome_config) = 'object'),
  ADD CONSTRAINT ai_agents_handoff_chk      CHECK (jsonb_typeof(handoff_config) = 'object'),
  ADD CONSTRAINT ai_agents_wait_chk         CHECK (response_wait_ms BETWEEN 0 AND 60000),
  ADD CONSTRAINT ai_agents_iterations_chk   CHECK (max_tool_iterations BETWEEN 1 AND 12),
  ADD CONSTRAINT ai_agents_revision_chk     CHECK (config_revision >= 1),
  ADD CONSTRAINT ai_agents_template_ver_chk CHECK (template_version IS NULL OR template_version >= 1);

-- -----------------------------------------------------------------------------
-- 6. Runs: cost/loop metadata (operational only; never prompts or reasoning).
-- -----------------------------------------------------------------------------
ALTER TABLE app.ai_runs
  ADD COLUMN tool_iterations        integer,
  ADD COLUMN trigger_message_count  integer,
  ADD COLUMN estimated_cost_micros  bigint,
  ADD COLUMN cost_currency          text,
  ADD COLUMN outcome                text;
ALTER TABLE app.ai_runs
  ADD CONSTRAINT ai_runs_iterations_chk CHECK (tool_iterations IS NULL OR tool_iterations >= 0),
  ADD CONSTRAINT ai_runs_trigger_cnt_chk CHECK (trigger_message_count IS NULL OR trigger_message_count >= 1),
  ADD CONSTRAINT ai_runs_cost_chk       CHECK (estimated_cost_micros IS NULL OR estimated_cost_micros >= 0),
  ADD CONSTRAINT ai_runs_ccy_chk        CHECK (cost_currency IS NULL OR cost_currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT ai_runs_outcome_chk    CHECK (outcome IS NULL OR outcome IN ('REPLIED','HANDOFF','FALLBACK','SKIPPED_HUMAN','SKIPPED_INACTIVE','NO_REPLY'));
CREATE INDEX ai_runs_agent_outcome_idx ON app.ai_runs (ai_agent_id, created_at DESC, outcome);

ALTER TABLE app.ai_tool_calls ADD COLUMN idempotency_key text;
ALTER TABLE app.ai_tool_calls ADD CONSTRAINT ai_tool_calls_idem_chk CHECK (idempotency_key IS NULL OR length(idempotency_key) <= 200);

-- -----------------------------------------------------------------------------
-- 7. Pending actions: durable confirmation state (not model memory). Arguments
--    are AES-256-GCM encrypted with a per-row data key (envelope encryption);
--    only a redacted, customer-safe summary is stored in clear.
-- -----------------------------------------------------------------------------
CREATE TABLE app.ai_pending_actions (
  id                    uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id       uuid        NOT NULL,
  business_id           uuid        NOT NULL,
  ai_agent_id           uuid        NOT NULL,
  conversation_id       uuid        NOT NULL,
  tool_id               uuid        NOT NULL REFERENCES app.ai_tools(id) ON DELETE RESTRICT,
  args_ciphertext       bytea       NOT NULL,
  args_wrapped_key      bytea       NOT NULL,
  args_key_reference    text        NOT NULL,
  args_hash             text        NOT NULL,
  summary               jsonb       NOT NULL DEFAULT '{}'::jsonb,
  state                 text        NOT NULL DEFAULT 'WAITING',
  created_by_run_id     uuid,
  executed_by_run_id    uuid,
  result_summary        jsonb,
  expires_at            timestamptz NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  confirmed_at          timestamptz,
  resolved_at           timestamptz,
  CONSTRAINT ai_pending_agent_fk FOREIGN KEY (ai_agent_id, organization_id, business_id)
    REFERENCES app.ai_agents (id, organization_id, business_id) ON DELETE CASCADE,
  CONSTRAINT ai_pending_conversation_fk FOREIGN KEY (conversation_id, organization_id, business_id)
    REFERENCES app.conversations (id, organization_id, business_id) ON DELETE CASCADE,
  CONSTRAINT ai_pending_state_chk   CHECK (state IN ('WAITING','CONFIRMED','CANCELLED','EXPIRED','EXECUTED','FAILED')),
  CONSTRAINT ai_pending_summary_chk CHECK (jsonb_typeof(summary) = 'object'),
  CONSTRAINT ai_pending_expiry_chk  CHECK (expires_at > created_at),
  CONSTRAINT ai_pending_confirm_chk CHECK (state NOT IN ('CONFIRMED','EXECUTED') OR confirmed_at IS NOT NULL)
);
-- At most one open confirmation per conversation (the one the customer is answering).
CREATE UNIQUE INDEX ai_pending_one_open_uq ON app.ai_pending_actions (conversation_id) WHERE state IN ('WAITING','CONFIRMED');
CREATE INDEX ai_pending_org_idx ON app.ai_pending_actions (organization_id, created_at DESC);
SELECT app_admin.attach_updated_at_trigger('app.ai_pending_actions');

-- -----------------------------------------------------------------------------
-- 8. Per-conversation assistant state: debounce window, single-owner run lease,
--    memory summary, greeting marker, handoff reason. Conversation handling_mode
--    (existing) stays the single source of truth for AI vs HUMAN.
-- -----------------------------------------------------------------------------
CREATE TABLE app.ai_conversation_states (
  conversation_id            uuid        PRIMARY KEY,
  organization_id            uuid        NOT NULL,
  business_id                uuid        NOT NULL,
  ai_agent_id                uuid,
  respond_after              timestamptz,
  pending_through_message_id uuid,
  last_processed_message_id  uuid,
  run_lock_owner             text,
  run_lock_until             timestamptz,
  summary                    text,
  summary_through_at         timestamptz,
  messages_since_summary     integer     NOT NULL DEFAULT 0,
  greeted_at                 timestamptz,
  handoff_reason             text,
  handoff_priority           text,
  handoff_at                 timestamptz,
  human_last_active_at       timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_conv_state_conversation_fk FOREIGN KEY (conversation_id, organization_id, business_id)
    REFERENCES app.conversations (id, organization_id, business_id) ON DELETE CASCADE,
  CONSTRAINT ai_conv_state_agent_fk FOREIGN KEY (ai_agent_id, organization_id, business_id)
    REFERENCES app.ai_agents (id, organization_id, business_id) ON DELETE SET NULL (ai_agent_id),
  CONSTRAINT ai_conv_state_summary_chk  CHECK (summary IS NULL OR length(summary) <= 4000),
  CONSTRAINT ai_conv_state_reason_chk   CHECK (handoff_reason IS NULL OR length(handoff_reason) <= 500),
  CONSTRAINT ai_conv_state_priority_chk CHECK (handoff_priority IS NULL OR handoff_priority IN ('LOW','NORMAL','HIGH','URGENT')),
  CONSTRAINT ai_conv_state_lock_chk     CHECK ((run_lock_owner IS NULL) = (run_lock_until IS NULL)),
  CONSTRAINT ai_conv_state_count_chk    CHECK (messages_since_summary >= 0)
);
SELECT app_admin.attach_updated_at_trigger('app.ai_conversation_states');

-- -----------------------------------------------------------------------------
-- 9. Leads (CREATE_LEAD / UPDATE_LEAD / GET_LEAD had no backend before).
-- -----------------------------------------------------------------------------
CREATE TABLE app.leads (
  id                 uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id    uuid        NOT NULL,
  business_id        uuid        NOT NULL,
  contact_id         uuid        NOT NULL,
  conversation_id    uuid,
  ai_agent_id        uuid,
  status             text        NOT NULL DEFAULT 'NEW',
  intent             text,
  interest           text,
  property_type      text,
  location_pref      text,
  bedrooms           integer,
  budget_min_minor   bigint,
  budget_max_minor   bigint,
  currency           text,
  timeline           text,
  qualification      text        NOT NULL DEFAULT 'UNQUALIFIED',
  notes              text,
  attributes         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  source             text        NOT NULL,
  idempotency_key    text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  closed_at          timestamptz,
  CONSTRAINT leads_contact_fk FOREIGN KEY (contact_id, organization_id, business_id)
    REFERENCES app.contacts (id, organization_id, business_id) ON DELETE CASCADE,
  CONSTRAINT leads_conversation_fk FOREIGN KEY (conversation_id, organization_id, business_id)
    REFERENCES app.conversations (id, organization_id, business_id) ON DELETE SET NULL (conversation_id),
  CONSTRAINT leads_agent_fk FOREIGN KEY (ai_agent_id, organization_id, business_id)
    REFERENCES app.ai_agents (id, organization_id, business_id) ON DELETE SET NULL (ai_agent_id),
  CONSTRAINT leads_id_org_uq       UNIQUE (id, organization_id),
  CONSTRAINT leads_status_chk      CHECK (status IN ('NEW','CONTACTED','QUALIFIED','WON','LOST')),
  CONSTRAINT leads_intent_chk      CHECK (intent IS NULL OR intent IN ('BUY','RENT','SELL','INVEST','ENQUIRY','OTHER')),
  CONSTRAINT leads_qual_chk        CHECK (qualification IN ('UNQUALIFIED','WARM','HOT','COLD')),
  CONSTRAINT leads_source_chk      CHECK (source IN ('AI_WHATSAPP','DASHBOARD','API')),
  CONSTRAINT leads_bedrooms_chk    CHECK (bedrooms IS NULL OR bedrooms BETWEEN 0 AND 50),
  CONSTRAINT leads_budget_chk      CHECK (coalesce(budget_min_minor,0) >= 0 AND coalesce(budget_max_minor,0) >= 0
                                          AND (budget_min_minor IS NULL OR budget_max_minor IS NULL OR budget_min_minor <= budget_max_minor)),
  CONSTRAINT leads_currency_chk    CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  CONSTRAINT leads_text_chk        CHECK (length(coalesce(interest,'')) <= 1000 AND length(coalesce(notes,'')) <= 2000
                                          AND length(coalesce(location_pref,'')) <= 200 AND length(coalesce(property_type,'')) <= 100
                                          AND length(coalesce(timeline,'')) <= 200),
  CONSTRAINT leads_attr_chk        CHECK (jsonb_typeof(attributes) = 'object'),
  CONSTRAINT leads_closed_chk      CHECK (status NOT IN ('WON','LOST') OR closed_at IS NOT NULL)
);
CREATE INDEX leads_org_biz_idx ON app.leads (organization_id, business_id, created_at DESC);
CREATE INDEX leads_contact_idx ON app.leads (contact_id, created_at DESC);
CREATE UNIQUE INDEX leads_idempotency_uq ON app.leads (organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
-- One open lead per contact and business: UPDATE_LEAD always targets it.
CREATE UNIQUE INDEX leads_one_open_uq ON app.leads (business_id, contact_id) WHERE status IN ('NEW','CONTACTED','QUALIFIED');
SELECT app_admin.attach_updated_at_trigger('app.leads');

-- -----------------------------------------------------------------------------
-- 10. Test sandbox (never touches conversations/messages/WhatsApp).
-- -----------------------------------------------------------------------------
CREATE TABLE app.ai_test_sessions (
  id                  uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id     uuid        NOT NULL,
  business_id         uuid        NOT NULL,
  ai_agent_id         uuid        NOT NULL,
  created_by_user_id  uuid        REFERENCES app.users(id) ON DELETE SET NULL,
  action_mode         text        NOT NULL DEFAULT 'DRY_RUN',
  state               jsonb       NOT NULL DEFAULT '{}'::jsonb,
  expires_at          timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_test_sessions_agent_fk FOREIGN KEY (ai_agent_id, organization_id, business_id)
    REFERENCES app.ai_agents (id, organization_id, business_id) ON DELETE CASCADE,
  CONSTRAINT ai_test_sessions_id_org_uq UNIQUE (id, organization_id),
  CONSTRAINT ai_test_sessions_mode_chk  CHECK (action_mode IN ('DRY_RUN')),
  CONSTRAINT ai_test_sessions_state_chk CHECK (jsonb_typeof(state) = 'object')
);
CREATE INDEX ai_test_sessions_agent_idx ON app.ai_test_sessions (ai_agent_id, created_at DESC);
SELECT app_admin.attach_updated_at_trigger('app.ai_test_sessions');

CREATE TABLE app.ai_test_turns (
  id               uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id  uuid        NOT NULL,
  session_id       uuid        NOT NULL,
  turn_index       integer     NOT NULL,
  customer_text    text        NOT NULL,
  reply_text       text,
  trace            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  input_tokens     integer,
  output_tokens    integer,
  latency_ms       integer,
  status           text        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_test_turns_session_fk FOREIGN KEY (session_id, organization_id)
    REFERENCES app.ai_test_sessions (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT ai_test_turns_uq         UNIQUE (session_id, turn_index),
  CONSTRAINT ai_test_turns_status_chk CHECK (status IN ('SUCCEEDED','FAILED','HANDOFF','FALLBACK')),
  CONSTRAINT ai_test_turns_text_chk   CHECK (length(customer_text) BETWEEN 1 AND 4000),
  CONSTRAINT ai_test_turns_trace_chk  CHECK (jsonb_typeof(trace) = 'object')
);

-- -----------------------------------------------------------------------------
-- 11. Knowledge: raw text for TEXT/FAQ/CSV sources (ingested by the worker into
--     knowledge_chunks). Files/websites keep using storage_key/source_url.
-- -----------------------------------------------------------------------------
ALTER TABLE app.knowledge_sources
  ADD COLUMN raw_content    text,
  ADD COLUMN content_bytes  integer,
  ADD COLUMN chunk_count    integer;
ALTER TABLE app.knowledge_sources
  ADD CONSTRAINT knowledge_sources_raw_chk   CHECK (raw_content IS NULL OR length(raw_content) <= 500000),
  ADD CONSTRAINT knowledge_sources_bytes_chk CHECK (content_bytes IS NULL OR content_bytes >= 0),
  ADD CONSTRAINT knowledge_sources_chunks_chk CHECK (chunk_count IS NULL OR chunk_count >= 0);

-- =============================================================================
-- RLS + GRANTS
-- =============================================================================
SELECT app_admin.apply_tenant_rls('app.ai_pending_actions');
SELECT app_admin.apply_tenant_rls('app.ai_conversation_states');
SELECT app_admin.apply_tenant_rls('app.leads');
SELECT app_admin.apply_tenant_rls('app.ai_test_sessions');
SELECT app_admin.apply_tenant_rls('app.ai_test_turns');

-- Worker: runs live assistant turns (hs_worker).
GRANT SELECT, INSERT, UPDATE ON app.ai_pending_actions, app.ai_conversation_states, app.leads TO hs_worker;
-- API: dashboard reads, human takeover/resume (state), sandbox sessions, lead management, tool-reads in DRY_RUN.
GRANT SELECT ON app.ai_pending_actions TO hs_app;
GRANT SELECT, INSERT, UPDATE ON app.ai_conversation_states, app.leads TO hs_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.ai_test_sessions TO hs_app;
GRANT SELECT, INSERT ON app.ai_test_turns TO hs_app;
-- API may run sandbox tool reads and record tool-call usage; worker records AI runs (existing grants).
