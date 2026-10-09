-- Rollback 0006.
DROP INDEX IF EXISTS app.messages_ai_agent_idx;
DROP INDEX IF EXISTS app.conversations_ai_agent_idx;
ALTER TABLE app.messages DROP CONSTRAINT IF EXISTS messages_ai_agent_fk;
ALTER TABLE app.conversations DROP CONSTRAINT IF EXISTS conversations_ai_agent_fk;
DROP TABLE IF EXISTS app.ai_tool_calls, app.ai_runs, app.ai_agent_tools, app.ai_agent_channels;
ALTER TABLE app.ai_agents DROP CONSTRAINT IF EXISTS ai_agents_published_version_fk;
DROP TABLE IF EXISTS app.ai_agent_versions, app.ai_agents, app.ai_tools, app.ai_assistant_templates;
