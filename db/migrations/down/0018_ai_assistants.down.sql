-- Rollback 0018 (dev/staging only; drops Phase 4 data).
DROP TABLE IF EXISTS app.ai_test_turns;
DROP TABLE IF EXISTS app.ai_test_sessions;
DROP TABLE IF EXISTS app.leads;
DROP TABLE IF EXISTS app.ai_conversation_states;
DROP TABLE IF EXISTS app.ai_pending_actions;
DROP TABLE IF EXISTS app.ai_model_pricing;
DROP TABLE IF EXISTS app.ai_tool_dependencies;
DROP TABLE IF EXISTS app.ai_template_tools;
DROP TRIGGER IF EXISTS ai_tools_derive_flags ON app.ai_tools;
DROP FUNCTION IF EXISTS app.ai_tools_derive_flags();
ALTER TABLE app.knowledge_sources DROP COLUMN IF EXISTS raw_content, DROP COLUMN IF EXISTS content_bytes, DROP COLUMN IF EXISTS chunk_count;
ALTER TABLE app.ai_tool_calls DROP COLUMN IF EXISTS idempotency_key;
DROP INDEX IF EXISTS app.ai_runs_agent_outcome_idx;
ALTER TABLE app.ai_runs DROP COLUMN IF EXISTS tool_iterations, DROP COLUMN IF EXISTS trigger_message_count,
  DROP COLUMN IF EXISTS estimated_cost_micros, DROP COLUMN IF EXISTS cost_currency, DROP COLUMN IF EXISTS outcome;
ALTER TABLE app.ai_agents DROP COLUMN IF EXISTS template_key, DROP COLUMN IF EXISTS template_version,
  DROP COLUMN IF EXISTS template_instructions, DROP COLUMN IF EXISTS custom_instructions, DROP COLUMN IF EXISTS instructions_mode,
  DROP COLUMN IF EXISTS welcome_config, DROP COLUMN IF EXISTS handoff_config, DROP COLUMN IF EXISTS response_wait_ms,
  DROP COLUMN IF EXISTS max_tool_iterations, DROP COLUMN IF EXISTS config_revision;
ALTER TABLE app.ai_tools DROP COLUMN IF EXISTS category, DROP COLUMN IF EXISTS handler_key, DROP COLUMN IF EXISTS output_schema,
  DROP COLUMN IF EXISTS config_schema, DROP COLUMN IF EXISTS risk_level, DROP COLUMN IF EXISTS is_read_only,
  DROP COLUMN IF EXISTS has_side_effects, DROP COLUMN IF EXISTS version, DROP COLUMN IF EXISTS availability,
  DROP COLUMN IF EXISTS capability_name, DROP COLUMN IF EXISTS capability_description;
ALTER TABLE app.ai_assistant_templates DROP COLUMN IF EXISTS long_description, DROP COLUMN IF EXISTS industry,
  DROP COLUMN IF EXISTS icon_key, DROP COLUMN IF EXISTS marketplace_category, DROP COLUMN IF EXISTS welcome_behavior,
  DROP COLUMN IF EXISTS supported_languages, DROP COLUMN IF EXISTS recommended_model, DROP COLUMN IF EXISTS model_settings,
  DROP COLUMN IF EXISTS demo_conversations, DROP COLUMN IF EXISTS setup_requirements, DROP COLUMN IF EXISTS recommended_for,
  DROP COLUMN IF EXISTS setup_minutes, DROP COLUMN IF EXISTS display_order, DROP COLUMN IF EXISTS published_at,
  DROP COLUMN IF EXISTS deprecated_at;
