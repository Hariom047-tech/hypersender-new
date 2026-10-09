import type { Db } from '../../database/transaction-runner.js';
import type { JsonSchema } from '../json-schema.js';
import type { LoadedTool } from '../tools/executor.js';
import { CONFIRM_TOOL_KEY, type ToolRegistry } from '../tools/registry.js';
import type { AssistantSnapshot } from './assistant-config.js';

/**
 * Dynamic tool loading: only the tools of THIS assistant are sent to the model.
 * A tool is loaded only if it is (a) in the assistant's configuration snapshot,
 * (b) still enabled for the assistant right now (disabling takes effect
 * immediately, even before re-publishing), (c) ACTIVE and READY in the platform
 * catalog, and (d) implemented by a registered handler.
 * CONFIRM_PENDING_ACTION is added only while a confirmation is open.
 */
export async function loadRunTools(db: Db, snapshot: AssistantSnapshot, registry: ToolRegistry, opts: { includeConfirm: boolean }): Promise<Map<string, LoadedTool>> {
  const keys = snapshot.tools.map((t) => t.key);
  const r = await db.query(
    `SELECT t.id, t.key, t.name, t.description, t.handler_key, t.input_schema, t.config_schema, t.is_read_only, t.risk_level, t.requires_confirmation
       FROM app.ai_tools t
       JOIN app.ai_agent_tools at ON at.tool_id = t.id AND at.ai_agent_id = $1 AND at.enabled
      WHERE t.key = ANY($2::text[]) AND t.status = 'ACTIVE' AND t.availability = 'READY'
     UNION ALL
     SELECT t.id, t.key, t.name, t.description, t.handler_key, t.input_schema, t.config_schema, t.is_read_only, t.risk_level, t.requires_confirmation
       FROM app.ai_tools t WHERE $3 AND t.key = $4 AND t.status = 'ACTIVE' AND t.availability = 'READY'`,
    [snapshot.assistantId, keys, opts.includeConfirm, CONFIRM_TOOL_KEY]);
  const cfg = new Map(snapshot.tools.map((t) => [t.key, t.config]));
  const out = new Map<string, LoadedTool>();
  for (const t of r.rows) {
    if (!registry.has(t.handler_key)) continue;
    out.set(t.key, {
      id: t.id, key: t.key, name: t.name, description: t.description, handlerKey: t.handler_key,
      inputSchema: t.input_schema as JsonSchema, configSchema: t.config_schema as JsonSchema, isReadOnly: t.is_read_only,
      riskLevel: t.risk_level, requiresConfirmationDefault: t.requires_confirmation, config: cfg.get(t.key) ?? {},
    });
  }
  return out;
}
