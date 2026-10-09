import { Injectable } from '@nestjs/common';
import type { TransactionRunner } from '../database/transaction-runner.js';
import { AiRepository } from '../repositories/ai.repository.js';
import { OpsRepository } from '../repositories/ops.repository.js';
import { redact } from '../security/redact.js';
import { OutboundMessageService } from './outbound-message.service.js';

export type ClaimResult =
  | { claimed: true; runId: string; agentId: string; conversationId: string; businessId: string }
  | { claimed: false; reason: 'NO_RESPONDER' | 'HUMAN_HANDLING' | 'AI_PAUSED' | 'ALREADY_CLAIMED' | 'NOT_INBOUND' };

export interface ToolOutcome { ok: boolean; summary: Record<string, unknown>; errorCode?: string }

/**
 * AI RESPONSE STRATEGY
 *   T1 claim     : decide the responder + INSERT ai_runs ON CONFLICT(trigger_message_id) DO NOTHING.
 *                  Exactly one worker wins; losers stop. (no model call inside)
 *   --- model call, OUTSIDE any transaction ---
 *   tools        : each tool call is recorded idempotently (run id + provider tool-call id) and
 *                  executed by backend services in their own transactions; the model only ever
 *                  sees the backend's result. It cannot run SQL or fabricate success.
 *   T2 complete  : enqueue the reply (idempotency key "ai-run:<run id>") + mark run SUCCEEDED
 *                  + usage rows, atomically. Replays cannot send a second reply.
 */
@Injectable()
export class AiResponseService {
  constructor(
    private readonly tx: TransactionRunner,
    private readonly ai: AiRepository,
    private readonly outbound: OutboundMessageService,
    private readonly ops: OpsRepository,
  ) {}

  async claim(organizationId: string, triggerMessageId: string, workerId: string): Promise<ClaimResult> {
    return this.tx.inTenant(async (db) => {
      const r = await db.query(
        `SELECT m.direction, m.whatsapp_instance_id, m.business_id, c.id AS conversation_id, c.handling_mode, c.ai_paused_until
           FROM app.messages m JOIN app.conversations c ON c.id = m.conversation_id
          WHERE m.id = $1`, [triggerMessageId]);
      const msg = r.rows[0];
      if (!msg || msg.direction !== 'INBOUND') return { claimed: false, reason: 'NOT_INBOUND' } as const;
      if (msg.handling_mode === 'HUMAN' || msg.handling_mode === 'PAUSED') return { claimed: false, reason: 'HUMAN_HANDLING' } as const;
      if (msg.ai_paused_until && new Date(msg.ai_paused_until) > new Date()) return { claimed: false, reason: 'AI_PAUSED' } as const;

      const agent = await this.ai.findResponder(db, msg.whatsapp_instance_id);
      if (!agent) return { claimed: false, reason: 'NO_RESPONDER' } as const;

      const runId = await this.ai.claimRun(db, { organizationId, businessId: msg.business_id, agent, conversationId: msg.conversation_id,
                                                 triggerMessageId, workerId });
      if (!runId) return { claimed: false, reason: 'ALREADY_CLAIMED' } as const;
      return { claimed: true, runId, agentId: agent.agentId, conversationId: msg.conversation_id, businessId: msg.business_id } as const;
    }, { organizationId });
  }

  /**
   * Execute a model-requested tool exactly once per (run, tool call). `execute`
   * is backend business logic (e.g. BookingService.createBooking) and its result
   * is the ONLY thing reported back to the model.
   */
  async runTool(organizationId: string, runId: string, providerToolCallId: string, toolKey: string, args: Record<string, unknown>,
                execute: () => Promise<ToolOutcome>): Promise<ToolOutcome> {
    const call = await this.tx.inTenant((db) => this.ai.beginToolCall(db, {
      organizationId, runId, toolKey, providerToolCallId, redactedArguments: redact(args),
    }), { organizationId });
    if (call.status !== 'PENDING') {
      return { ok: call.status === 'SUCCEEDED', summary: (call.resultSummary as Record<string, unknown>) ?? {} };
    }
    const started = Date.now();
    let outcome: ToolOutcome;
    try {
      outcome = await execute();
    } catch (err) {
      outcome = { ok: false, summary: { error: 'TOOL_EXECUTION_FAILED' }, errorCode: (err as Error).name };
    }
    await this.tx.inTenant((db) => this.ai.finishToolCall(db, call.id, outcome.ok ? 'SUCCEEDED' : 'FAILED', redact(outcome.summary),
      Date.now() - started, outcome.errorCode), { organizationId });
    return outcome;
  }

  async complete(organizationId: string, runId: string, reply: { text: string; inputTokens: number; outputTokens: number; cachedTokens?: number; latencyMs: number }): Promise<{ messageId: string }> {
    return this.tx.inTenant(async (db) => {
      const r = await db.query('SELECT conversation_id, ai_agent_id, business_id, trigger_message_id FROM app.ai_runs WHERE id = $1', [runId]);
      const run = r.rows[0];
      if (!run) throw new Error('ai run not found');
      const { messageId } = await this.outbound.enqueueTextInTx(db, {
        conversationId: run.conversation_id, text: reply.text, idempotencyKey: `ai-run:${runId}`, aiAgentId: run.ai_agent_id,
        replyToMessageId: run.trigger_message_id,
      });
      await this.ai.completeRun(db, runId, { status: 'SUCCEEDED', responseMessageId: messageId, inputTokens: reply.inputTokens,
        outputTokens: reply.outputTokens, cachedTokens: reply.cachedTokens, latencyMs: reply.latencyMs });
      const base = { organizationId, businessId: run.business_id, resourceType: 'AI_RUN', resourceId: runId };
      await this.ops.recordUsage(db, { ...base, eventType: 'AI_RUN', quantity: 1, idempotencyKey: `ai-run:${runId}` });
      await this.ops.recordUsage(db, { ...base, eventType: 'AI_INPUT_TOKENS', quantity: reply.inputTokens, idempotencyKey: `ai-run:${runId}:in` });
      await this.ops.recordUsage(db, { ...base, eventType: 'AI_OUTPUT_TOKENS', quantity: reply.outputTokens, idempotencyKey: `ai-run:${runId}:out` });
      return { messageId };
    }, { organizationId }, { retries: 2 });
  }

  async fail(organizationId: string, runId: string, errorCode: string): Promise<void> {
    await this.tx.inTenant((db) => this.ai.completeRun(db, runId, { status: 'FAILED', errorCode }), { organizationId });
  }
}
