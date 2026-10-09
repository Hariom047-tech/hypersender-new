import { Injectable } from '@nestjs/common';
import type { Db } from '../database/transaction-runner.js';

export interface ResponderAgent {
  agentId: string;
  versionId: string | null;
  modelProvider: string;
  modelName: string;
}

@Injectable()
export class AiRepository {
  /**
   * The single agent allowed to auto-reply on an instance: the primary+enabled
   * channel (unique per instance by index) whose agent is ACTIVE with auto-reply on.
   */
  async findResponder(db: Db, instanceId: string): Promise<ResponderAgent | null> {
    const r = await db.query(
      `SELECT a.id, a.published_version_id, a.model_provider, a.model_name
         FROM app.ai_agent_channels ch
         JOIN app.ai_agents a ON a.id = ch.ai_agent_id
        WHERE ch.whatsapp_instance_id = $1 AND ch.is_primary AND ch.enabled
          AND a.status = 'ACTIVE' AND a.auto_reply_enabled AND a.deleted_at IS NULL`, [instanceId]);
    const row = r.rows[0];
    return row ? { agentId: row.id, versionId: row.published_version_id, modelProvider: row.model_provider, modelName: row.model_name } : null;
  }

  /**
   * Claim the right to answer one inbound message. UNIQUE(trigger_message_id)
   * means exactly one caller gets a row back, however many AI workers race.
   */
  async claimRun(db: Db, r: { organizationId: string; businessId: string; agent: ResponderAgent; conversationId: string; triggerMessageId: string; workerId: string }): Promise<string | null> {
    const res = await db.query(
      `INSERT INTO app.ai_runs (organization_id, business_id, ai_agent_id, ai_agent_version_id, conversation_id, trigger_message_id,
                                model_provider, model_name, status, attempt_count, locked_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'RUNNING', 1, $9)
       ON CONFLICT (trigger_message_id) DO NOTHING RETURNING id`,
      [r.organizationId, r.businessId, r.agent.agentId, r.agent.versionId, r.conversationId, r.triggerMessageId,
       r.agent.modelProvider, r.agent.modelName, r.workerId]);
    return res.rows[0]?.id ?? null;
  }

  async completeRun(db: Db, runId: string, o: { status: 'SUCCEEDED' | 'FAILED' | 'SKIPPED'; responseMessageId?: string | null; inputTokens?: number; outputTokens?: number; cachedTokens?: number; latencyMs?: number; errorCode?: string }): Promise<boolean> {
    const r = await db.query(
      `UPDATE app.ai_runs SET status = $2, response_message_id = $3, input_tokens = $4, output_tokens = $5, cached_tokens = $6,
                              latency_ms = $7, error_code = $8, completed_at = now(), locked_by = NULL
        WHERE id = $1 AND status = 'RUNNING'`,
      [runId, o.status, o.responseMessageId ?? null, o.inputTokens ?? null, o.outputTokens ?? null, o.cachedTokens ?? null,
       o.latencyMs ?? null, o.errorCode ?? null]);
    return (r.rowCount ?? 0) > 0;
  }

  /** Idempotent tool-call record (UNIQUE(ai_run_id, provider_tool_call_id)). Returns existing summary on replay. */
  async beginToolCall(db: Db, t: { organizationId: string; runId: string; toolKey: string; providerToolCallId: string; redactedArguments: object }): Promise<{ id: string; status: string; resultSummary: unknown }> {
    const r = await db.query(
      `WITH ins AS (
         INSERT INTO app.ai_tool_calls (organization_id, ai_run_id, tool_id, provider_tool_call_id, arguments)
         SELECT $1, $2, t.id, $4, $5 FROM app.ai_tools t WHERE t.key = $3 AND t.status = 'ACTIVE'
         ON CONFLICT (ai_run_id, provider_tool_call_id) DO NOTHING
         RETURNING id, status, result_summary)
       SELECT id, status, result_summary FROM ins
       UNION ALL
       SELECT id, status, result_summary FROM app.ai_tool_calls WHERE ai_run_id = $2 AND provider_tool_call_id = $4
       LIMIT 1`,
      [t.organizationId, t.runId, t.toolKey, t.providerToolCallId, JSON.stringify(t.redactedArguments)]);
    if (!r.rows[0]) throw new Error(`unknown or inactive AI tool ${t.toolKey}`);
    return { id: r.rows[0].id, status: r.rows[0].status, resultSummary: r.rows[0].result_summary };
  }

  async finishToolCall(db: Db, id: string, status: 'SUCCEEDED' | 'FAILED' | 'REJECTED', resultSummary: object, latencyMs: number, errorCode?: string): Promise<void> {
    await db.query(
      `UPDATE app.ai_tool_calls SET status = $2, result_summary = $3, latency_ms = $4, error_code = $5, completed_at = now()
        WHERE id = $1 AND status = 'PENDING'`, [id, status, JSON.stringify(resultSummary), latencyMs, errorCode ?? null]);
  }
}
