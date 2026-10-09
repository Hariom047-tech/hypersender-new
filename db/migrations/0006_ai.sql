-- =============================================================================
-- 0006 AI ASSISTANTS
-- Platform catalog (templates, tools) vs tenant copies (agents, versions,
-- channels, agent tools) vs operational traces (runs, tool calls).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- ai_assistant_templates: PLATFORM data authored by platform admins. Never
-- contains tenant data. Tenants never write here; installing a template COPIES
-- it into ai_agents + ai_agent_versions, so editing/deprecating a template never
-- mutates a tenant's live agent.
-- -----------------------------------------------------------------------------
CREATE TABLE app.ai_assistant_templates (
  id                  uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  key                 text        NOT NULL,
  name                text        NOT NULL,
  description         text        NOT NULL,
  category            text        NOT NULL,
  version             integer     NOT NULL DEFAULT 1,
  base_system_prompt  text        NOT NULL,
  default_config      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status              text        NOT NULL DEFAULT 'DRAFT',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_assistant_templates_key_version_uq UNIQUE (key, version),
  CONSTRAINT ai_assistant_templates_key_chk      CHECK (key ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  CONSTRAINT ai_assistant_templates_category_chk CHECK (category ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  CONSTRAINT ai_assistant_templates_version_chk  CHECK (version >= 1),
  CONSTRAINT ai_assistant_templates_status_chk   CHECK (status IN ('DRAFT','ACTIVE','DEPRECATED')),
  CONSTRAINT ai_assistant_templates_config_chk   CHECK (jsonb_typeof(default_config) = 'object')
);
-- Exactly one installable version per template key.
CREATE UNIQUE INDEX ai_assistant_templates_one_active_uq ON app.ai_assistant_templates (key) WHERE status = 'ACTIVE';
SELECT app_admin.attach_updated_at_trigger('app.ai_assistant_templates');

-- -----------------------------------------------------------------------------
-- ai_tools: PLATFORM catalog of backend-implemented tools. The model only
-- chooses a tool + arguments; the backend executes it with normal business
-- logic under the tenant context. The model never writes SQL and never
-- "declares" success - results come from the backend.
-- -----------------------------------------------------------------------------
CREATE TABLE app.ai_tools (
  id                     uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  key                    text        NOT NULL UNIQUE,
  name                   text        NOT NULL,
  description            text        NOT NULL,
  input_schema           jsonb       NOT NULL DEFAULT '{"type":"object"}'::jsonb,
  side_effect            text        NOT NULL,
  requires_confirmation  boolean     NOT NULL DEFAULT false,
  status                 text        NOT NULL DEFAULT 'ACTIVE',
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_tools_key_chk         CHECK (key ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  CONSTRAINT ai_tools_side_effect_chk CHECK (side_effect IN ('READ','WRITE','EXTERNAL')),
  CONSTRAINT ai_tools_status_chk      CHECK (status IN ('ACTIVE','DEPRECATED')),
  CONSTRAINT ai_tools_schema_chk      CHECK (jsonb_typeof(input_schema) = 'object')
);
SELECT app_admin.attach_updated_at_trigger('app.ai_tools');

-- -----------------------------------------------------------------------------
-- ai_agents: tenant-owned assistant (one table for every industry).
-- -----------------------------------------------------------------------------
CREATE TABLE app.ai_agents (
  id                      uuid         PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id         uuid         NOT NULL,
  business_id             uuid         NOT NULL,
  template_id             uuid         REFERENCES app.ai_assistant_templates(id) ON DELETE SET NULL,
  name                    text         NOT NULL,
  description             text,
  status                  text         NOT NULL DEFAULT 'DRAFT',
  system_prompt_override  text,
  primary_language        text         NOT NULL DEFAULT 'en',
  supported_languages     text[]       NOT NULL DEFAULT ARRAY['en']::text[],
  timezone                text         NOT NULL DEFAULT 'UTC',
  tone_config             jsonb        NOT NULL DEFAULT '{}'::jsonb,
  behavior_config         jsonb        NOT NULL DEFAULT '{}'::jsonb,
  human_handoff_enabled   boolean      NOT NULL DEFAULT true,
  auto_reply_enabled      boolean      NOT NULL DEFAULT false,
  -- Provider/model are data, not code: switching model = UPDATE.
  model_provider          text         NOT NULL,
  model_name              text         NOT NULL,
  temperature             numeric(3,2),
  published_version_id    uuid,        -- FK added below (circular)
  created_by_user_id      uuid         REFERENCES app.users(id) ON DELETE SET NULL,
  created_at              timestamptz  NOT NULL DEFAULT now(),
  updated_at              timestamptz  NOT NULL DEFAULT now(),
  deleted_at              timestamptz,
  CONSTRAINT ai_agents_business_fk FOREIGN KEY (business_id, organization_id)
    REFERENCES app.businesses (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT ai_agents_id_org_uq     UNIQUE (id, organization_id),
  CONSTRAINT ai_agents_id_org_biz_uq UNIQUE (id, organization_id, business_id),
  CONSTRAINT ai_agents_name_chk      CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  CONSTRAINT ai_agents_status_chk    CHECK (status IN ('DRAFT','TESTING','ACTIVE','PAUSED','ARCHIVED')),
  CONSTRAINT ai_agents_lang_chk      CHECK (primary_language ~ '^[a-z]{2,3}(-[A-Z]{2})?$'),
  CONSTRAINT ai_agents_langs_chk     CHECK (cardinality(supported_languages) BETWEEN 1 AND 20),
  CONSTRAINT ai_agents_tz_chk        CHECK (app.is_valid_timezone(timezone)),
  CONSTRAINT ai_agents_tone_chk      CHECK (jsonb_typeof(tone_config) = 'object'),
  CONSTRAINT ai_agents_behavior_chk  CHECK (jsonb_typeof(behavior_config) = 'object'),
  CONSTRAINT ai_agents_provider_chk  CHECK (model_provider ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  CONSTRAINT ai_agents_model_chk     CHECK (length(model_name) BETWEEN 1 AND 128),
  CONSTRAINT ai_agents_temp_chk      CHECK (temperature IS NULL OR temperature BETWEEN 0 AND 2)
);
CREATE INDEX ai_agents_org_biz_idx ON app.ai_agents (organization_id, business_id) WHERE deleted_at IS NULL;
SELECT app_admin.attach_updated_at_trigger('app.ai_agents');

-- -----------------------------------------------------------------------------
-- ai_agent_versions: immutable snapshots of the effective prompt + config.
-- Only published_at may change after insert (column grants).
-- -----------------------------------------------------------------------------
CREATE TABLE app.ai_agent_versions (
  id                       uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id          uuid        NOT NULL,
  ai_agent_id              uuid        NOT NULL,
  version_number           integer     NOT NULL,
  effective_system_prompt  text        NOT NULL,
  configuration            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  template_id              uuid        REFERENCES app.ai_assistant_templates(id) ON DELETE SET NULL,
  template_version         integer,
  created_by_user_id       uuid        REFERENCES app.users(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  published_at             timestamptz,
  CONSTRAINT ai_agent_versions_agent_fk FOREIGN KEY (ai_agent_id, organization_id)
    REFERENCES app.ai_agents (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT ai_agent_versions_number_uq   UNIQUE (ai_agent_id, version_number),
  CONSTRAINT ai_agent_versions_id_agent_uq UNIQUE (id, ai_agent_id),
  CONSTRAINT ai_agent_versions_number_chk  CHECK (version_number >= 1),
  CONSTRAINT ai_agent_versions_config_chk  CHECK (jsonb_typeof(configuration) = 'object')
);

-- An agent can only publish one of ITS OWN versions.
ALTER TABLE app.ai_agents
  ADD CONSTRAINT ai_agents_published_version_fk FOREIGN KEY (published_version_id, id)
    REFERENCES app.ai_agent_versions (id, ai_agent_id) ON DELETE SET NULL (published_version_id)
    DEFERRABLE INITIALLY IMMEDIATE;

-- -----------------------------------------------------------------------------
-- ai_agent_channels: agent <-> channel mapping (many-to-many ready).
-- Runtime responder resolution for an inbound WhatsApp message:
--   the channel row with (whatsapp_instance_id = I, is_primary, enabled) whose
--   agent has status ACTIVE and auto_reply_enabled. The partial unique index
--   guarantees at most ONE such candidate per instance, so two auto-reply
--   agents can never fight over the same number.
-- -----------------------------------------------------------------------------
CREATE TABLE app.ai_agent_channels (
  id                    uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id       uuid        NOT NULL,
  business_id           uuid        NOT NULL,
  ai_agent_id           uuid        NOT NULL,
  channel_type          text        NOT NULL DEFAULT 'WHATSAPP',
  whatsapp_instance_id  uuid,
  is_primary            boolean     NOT NULL DEFAULT true,
  enabled               boolean     NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  -- Agent and instance must belong to the same business of the same tenant.
  CONSTRAINT ai_agent_channels_agent_fk FOREIGN KEY (ai_agent_id, organization_id, business_id)
    REFERENCES app.ai_agents (id, organization_id, business_id) ON DELETE CASCADE,
  CONSTRAINT ai_agent_channels_instance_fk FOREIGN KEY (whatsapp_instance_id, organization_id, business_id)
    REFERENCES app.whatsapp_instances (id, organization_id, business_id) ON DELETE CASCADE,
  CONSTRAINT ai_agent_channels_type_chk     CHECK (channel_type IN ('WHATSAPP','WEB_CHAT','INSTAGRAM','MESSENGER')),
  CONSTRAINT ai_agent_channels_wa_chk       CHECK ((channel_type = 'WHATSAPP') = (whatsapp_instance_id IS NOT NULL))
);
CREATE UNIQUE INDEX ai_agent_channels_agent_instance_uq ON app.ai_agent_channels (ai_agent_id, whatsapp_instance_id)
  WHERE whatsapp_instance_id IS NOT NULL;
CREATE UNIQUE INDEX ai_agent_channels_one_primary_uq ON app.ai_agent_channels (whatsapp_instance_id)
  WHERE is_primary AND enabled AND whatsapp_instance_id IS NOT NULL;
SELECT app_admin.attach_updated_at_trigger('app.ai_agent_channels');

-- -----------------------------------------------------------------------------
-- ai_agent_tools
-- -----------------------------------------------------------------------------
CREATE TABLE app.ai_agent_tools (
  id               uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id  uuid        NOT NULL,
  ai_agent_id      uuid        NOT NULL,
  tool_id          uuid        NOT NULL REFERENCES app.ai_tools(id) ON DELETE RESTRICT,
  enabled          boolean     NOT NULL DEFAULT true,
  configuration    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_agent_tools_agent_fk FOREIGN KEY (ai_agent_id, organization_id)
    REFERENCES app.ai_agents (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT ai_agent_tools_uq         UNIQUE (ai_agent_id, tool_id),
  CONSTRAINT ai_agent_tools_config_chk CHECK (jsonb_typeof(configuration) = 'object')
);
SELECT app_admin.attach_updated_at_trigger('app.ai_agent_tools');

-- -----------------------------------------------------------------------------
-- ai_runs: one AI execution. Stores operational metadata only - never model
-- chain-of-thought, never raw prompts containing secrets.
-- UNIQUE (trigger_message_id): an inbound message triggers at most one run, so
-- two AI workers racing on the same message produce exactly one reply.
-- Retries reuse the same row (attempt_count).
-- -----------------------------------------------------------------------------
CREATE TABLE app.ai_runs (
  id                   uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id      uuid        NOT NULL,
  business_id          uuid        NOT NULL,
  ai_agent_id          uuid        NOT NULL,
  ai_agent_version_id  uuid,
  conversation_id      uuid        NOT NULL,
  trigger_message_id   uuid        NOT NULL,
  response_message_id  uuid,
  model_provider       text        NOT NULL,
  model_name           text        NOT NULL,
  input_tokens         integer,
  output_tokens        integer,
  cached_tokens        integer,
  status               text        NOT NULL DEFAULT 'PENDING',
  attempt_count        integer     NOT NULL DEFAULT 0,
  locked_by            text,
  latency_ms           integer,
  started_at           timestamptz NOT NULL DEFAULT now(),
  completed_at         timestamptz,
  error_code           text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_runs_agent_fk FOREIGN KEY (ai_agent_id, organization_id, business_id)
    REFERENCES app.ai_agents (id, organization_id, business_id) ON DELETE RESTRICT,
  CONSTRAINT ai_runs_version_fk FOREIGN KEY (ai_agent_version_id, ai_agent_id)
    REFERENCES app.ai_agent_versions (id, ai_agent_id) ON DELETE RESTRICT,
  CONSTRAINT ai_runs_conversation_fk FOREIGN KEY (conversation_id, organization_id, business_id)
    REFERENCES app.conversations (id, organization_id, business_id) ON DELETE RESTRICT,
  CONSTRAINT ai_runs_trigger_fk FOREIGN KEY (trigger_message_id, organization_id)
    REFERENCES app.messages (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT ai_runs_response_fk FOREIGN KEY (response_message_id, organization_id)
    REFERENCES app.messages (id, organization_id) ON DELETE SET NULL (response_message_id),
  CONSTRAINT ai_runs_id_org_uq      UNIQUE (id, organization_id),
  CONSTRAINT ai_runs_trigger_uq     UNIQUE (trigger_message_id),
  CONSTRAINT ai_runs_v7_chk         CHECK (uuid_extract_version(id) = 7),
  CONSTRAINT ai_runs_status_chk     CHECK (status IN ('PENDING','RUNNING','SUCCEEDED','FAILED','CANCELLED','SKIPPED')),
  CONSTRAINT ai_runs_tokens_chk     CHECK (coalesce(input_tokens,0) >= 0 AND coalesce(output_tokens,0) >= 0 AND coalesce(cached_tokens,0) >= 0),
  CONSTRAINT ai_runs_latency_chk    CHECK (latency_ms IS NULL OR latency_ms >= 0),
  CONSTRAINT ai_runs_completed_chk  CHECK (status NOT IN ('SUCCEEDED','FAILED','CANCELLED','SKIPPED') OR completed_at IS NOT NULL)
);
CREATE INDEX ai_runs_conversation_idx ON app.ai_runs (conversation_id, created_at DESC);
CREATE INDEX ai_runs_org_created_idx ON app.ai_runs (organization_id, created_at DESC);
CREATE INDEX ai_runs_agent_idx ON app.ai_runs (ai_agent_id, created_at DESC);
CREATE INDEX ai_runs_response_idx ON app.ai_runs (response_message_id) WHERE response_message_id IS NOT NULL;
SELECT app_admin.attach_updated_at_trigger('app.ai_runs');

-- -----------------------------------------------------------------------------
-- ai_tool_calls: redacted arguments + result summary of each tool execution.
-- UNIQUE (ai_run_id, provider_tool_call_id) makes tool execution idempotent
-- when a run is retried.
-- -----------------------------------------------------------------------------
CREATE TABLE app.ai_tool_calls (
  id                     uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id        uuid        NOT NULL,
  ai_run_id              uuid        NOT NULL,
  tool_id                uuid        NOT NULL REFERENCES app.ai_tools(id) ON DELETE RESTRICT,
  provider_tool_call_id  text        NOT NULL,
  arguments              jsonb       NOT NULL DEFAULT '{}'::jsonb,
  result_summary         jsonb,
  status                 text        NOT NULL DEFAULT 'PENDING',
  latency_ms             integer,
  error_code             text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  completed_at           timestamptz,
  CONSTRAINT ai_tool_calls_run_fk FOREIGN KEY (ai_run_id, organization_id)
    REFERENCES app.ai_runs (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT ai_tool_calls_uq          UNIQUE (ai_run_id, provider_tool_call_id),
  CONSTRAINT ai_tool_calls_status_chk  CHECK (status IN ('PENDING','SUCCEEDED','FAILED','REJECTED')),
  CONSTRAINT ai_tool_calls_latency_chk CHECK (latency_ms IS NULL OR latency_ms >= 0),
  CONSTRAINT ai_tool_calls_args_chk    CHECK (jsonb_typeof(arguments) = 'object')
);

-- -----------------------------------------------------------------------------
-- Deferred FKs from 0005
-- -----------------------------------------------------------------------------
ALTER TABLE app.conversations
  ADD CONSTRAINT conversations_ai_agent_fk FOREIGN KEY (assigned_ai_agent_id, organization_id, business_id)
    REFERENCES app.ai_agents (id, organization_id, business_id) ON DELETE SET NULL (assigned_ai_agent_id);
ALTER TABLE app.messages
  ADD CONSTRAINT messages_ai_agent_fk FOREIGN KEY (ai_agent_id, organization_id)
    REFERENCES app.ai_agents (id, organization_id) ON DELETE SET NULL (ai_agent_id);
CREATE INDEX messages_ai_agent_idx ON app.messages (ai_agent_id) WHERE ai_agent_id IS NOT NULL;
CREATE INDEX conversations_ai_agent_idx ON app.conversations (assigned_ai_agent_id) WHERE assigned_ai_agent_id IS NOT NULL;

-- =============================================================================
-- RLS + GRANTS
-- =============================================================================
-- Platform catalogs: readable by runtime roles, written only by hs_owner (seeds
-- / admin tooling). No tenant data => no RLS.
GRANT SELECT ON app.ai_assistant_templates, app.ai_tools TO hs_app, hs_worker;

SELECT app_admin.apply_tenant_rls('app.ai_agents');
SELECT app_admin.apply_tenant_rls('app.ai_agent_versions');
SELECT app_admin.apply_tenant_rls('app.ai_agent_channels');
SELECT app_admin.apply_tenant_rls('app.ai_agent_tools');
SELECT app_admin.apply_tenant_rls('app.ai_runs');
SELECT app_admin.apply_tenant_rls('app.ai_tool_calls');

GRANT SELECT, INSERT, UPDATE ON app.ai_agents TO hs_app;
GRANT SELECT ON app.ai_agents TO hs_worker;
GRANT SELECT, INSERT ON app.ai_agent_versions TO hs_app;
GRANT UPDATE (published_at) ON app.ai_agent_versions TO hs_app;
GRANT SELECT ON app.ai_agent_versions TO hs_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.ai_agent_channels, app.ai_agent_tools TO hs_app;
GRANT SELECT ON app.ai_agent_channels, app.ai_agent_tools TO hs_worker;
GRANT SELECT, DELETE ON app.ai_runs, app.ai_tool_calls TO hs_app;
GRANT SELECT, INSERT, UPDATE ON app.ai_runs, app.ai_tool_calls TO hs_worker;
