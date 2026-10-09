import type { Logger } from '../../common/logger.js';
import type { TenantContext } from '../../database/tenant-context.js';
import type { TransactionRunner } from '../../database/transaction-runner.js';
import { OpsRepository } from '../../repositories/ops.repository.js';
import { WhatsAppError } from '../../whatsapp/domain/whatsapp-errors.js';
import type { ModelItem, ModelProviderRegistry } from '../model/model-provider.js';
import { loadDraftSnapshot } from '../runtime/assistant-config.js';
import { AssistantRuntime } from '../runtime/assistant-runtime.js';
import { MemoryPendingActionStore } from '../runtime/pending-store.js';
import { loadRunTools } from '../runtime/tool-loader.js';
import { ToolExecutor, type ExecutorScope } from '../tools/executor.js';
import { localLabel } from '../tools/handlers/format.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolDeps } from '../tools/types.js';

const MAX_TRANSCRIPT = 30;
const TURNS_PER_10_MIN = Number(process.env.AI_SANDBOX_TURNS_PER_10_MIN ?? 60);

interface SessionState {
  transcript: Array<{ role: 'customer' | 'assistant'; text: string }>;
  pending?: any;
  customerName?: string;
}

/**
 * "Test Assistant": the REAL runtime (same prompt layers, same model, same tool
 * gate) with every side-effect tool in DRY_RUN mode, a simulated customer, and
 * no WhatsApp at all - nothing is sent, no booking/lead/handoff is written.
 * Runs in the API process under the tester's own tenant context (hs_app + RLS).
 */
export class SandboxService {
  private readonly ops = new OpsRepository();
  private readonly runtime: AssistantRuntime;

  constructor(private readonly tx: TransactionRunner, private readonly models: ModelProviderRegistry, private readonly registry: ToolRegistry,
              private readonly toolDeps: ToolDeps, logger?: Logger) {
    this.runtime = new AssistantRuntime(new ToolExecutor(registry, { ...toolDeps, notifications: undefined },
      (tool, err) => logger?.error({ event_name: 'ai.sandbox_tool_failed', tool, err: { message: String(err.message).slice(0, 300) } })));
  }

  async create(ctx: TenantContext, assistantId: string, customerName?: string): Promise<{ id: string; actionMode: 'DRY_RUN' }> {
    const state: SessionState = { transcript: [], customerName: customerName?.trim().slice(0, 60) || 'Test customer' };
    return this.tx.inTenant(async (db) => {
      const a = (await db.query('SELECT id, business_id FROM app.ai_agents WHERE id = $1 AND deleted_at IS NULL', [assistantId])).rows[0];
      if (!a || (ctx.businessId && ctx.businessId !== a.business_id)) throw new WhatsAppError('NOT_FOUND', 'assistant not found');
      const r = await db.query(
        `INSERT INTO app.ai_test_sessions (organization_id, business_id, ai_agent_id, created_by_user_id, action_mode, state)
         VALUES (app.current_org_id(), $1, $2, $3, 'DRY_RUN', $4) RETURNING id`, [a.business_id, a.id, ctx.userId ?? null, JSON.stringify(state)]);
      return { id: r.rows[0].id as string, actionMode: 'DRY_RUN' as const };
    }, ctx);
  }

  async get(ctx: TenantContext, assistantId: string, sessionId: string) {
    return this.tx.inTenant(async (db) => {
      const s = (await db.query('SELECT id, state, action_mode FROM app.ai_test_sessions WHERE id = $1 AND ai_agent_id = $2', [sessionId, assistantId])).rows[0];
      if (!s) throw new WhatsAppError('NOT_FOUND', 'test session not found');
      const turns = (await db.query(
        `SELECT turn_index AS "index", customer_text AS "customerText", reply_text AS "replyText", trace, latency_ms AS "latencyMs", status, created_at AS "createdAt"
           FROM app.ai_test_turns WHERE session_id = $1 ORDER BY turn_index`, [sessionId])).rows;
      return { id: s.id, actionMode: s.action_mode, customerName: s.state.customerName, turns };
    }, ctx, { readOnly: true });
  }

  async send(ctx: TenantContext, assistantId: string, sessionId: string, text: string) {
    const customerText = text.trim();
    if (!customerText || customerText.length > 2000) throw new WhatsAppError('VALIDATION_FAILED', 'message must be 1-2000 characters');
    const prep = await this.tx.inTenant(async (db) => {
      const s = (await db.query('SELECT * FROM app.ai_test_sessions WHERE id = $1 AND ai_agent_id = $2 AND expires_at > now() FOR UPDATE', [sessionId, assistantId])).rows[0];
      if (!s) throw new WhatsAppError('NOT_FOUND', 'test session not found or expired');
      const recent = (await db.query(
        `SELECT count(*)::int AS n FROM app.ai_test_turns t JOIN app.ai_test_sessions x ON x.id = t.session_id
          WHERE x.ai_agent_id = $1 AND t.created_at > now() - interval '10 minutes'`, [assistantId])).rows[0].n;
      if (recent >= TURNS_PER_10_MIN) throw new WhatsAppError('WHATSAPP_RATE_LIMITED', 'Too many test messages. Please wait a few minutes.');
      const snap = await loadDraftSnapshot(db, assistantId);
      if (!snap) throw new WhatsAppError('NOT_FOUND', 'assistant not found');
      const state = s.state as SessionState;
      const pending = new MemoryPendingActionStore({ pending: state.pending ?? null });
      const tools = await loadRunTools(db, snap, this.registry, { includeConfirm: Boolean(await pending.getOpen()) });
      const biz = (await db.query('SELECT name, industry, timezone, currency FROM app.businesses WHERE id = $1', [snap.businessId])).rows[0];
      const index = (await db.query('SELECT coalesce(max(turn_index), -1) + 1 AS n FROM app.ai_test_turns WHERE session_id = $1', [sessionId])).rows[0].n as number;
      return { s, snap, state, pending, tools, biz, index };
    }, ctx);
    const provider = this.models.get(prep.snap.model.provider);
    if (!provider?.configured) throw new WhatsAppError('FEATURE_NOT_IN_PLAN', 'The AI service is not configured on this server yet (administrator: set OPENAI_API_KEY).');

    const turnId = `${sessionId}:${prep.index}`;
    const history: ModelItem[] = [...prep.state.transcript.map((m) => (m.role === 'customer' ? { kind: 'user' as const, text: m.text } : { kind: 'assistant' as const, text: m.text })),
      { kind: 'user', text: customerText }];
    const now = new Date();
    const open = await prep.pending.getOpen();
    const scope: ExecutorScope = {
      base: { organizationId: ctx.organizationId, businessId: prep.snap.businessId, assistantId, conversationId: null, contactId: null, whatsappInstanceId: null,
        requestId: turnId, dbContext: { organizationId: ctx.organizationId, userId: ctx.userId, apiKeyId: ctx.apiKeyId }, timezone: prep.biz.timezone,
        currency: prep.biz.currency, now, assistantDefaults: prep.snap.defaults, sandboxCustomer: { name: prep.state.customerName }, testSessionId: sessionId,
        signal: new AbortController().signal },
      mode: 'DRY_RUN', tools: prep.tools, pending: prep.pending, logger: null, confirmationTtlMinutes: prep.snap.confirmationTtlMinutes,
    };
    const r = await this.runtime.runTurn({
      snapshot: prep.snap, provider, tools: prep.tools, history, scope, requestId: turnId,
      context: { business: { name: prep.biz.name, industry: prep.biz.industry, timezone: prep.biz.timezone, currency: prep.biz.currency, localNow: localLabel(now, prep.biz.timezone) },
        customer: { name: prep.state.customerName ?? null, returning: false }, summary: null,
        firstReply: !prep.state.transcript.some((m) => m.role === 'assistant'),
        pending: open ? { text: open.summaryText, expiresAt: open.expiresAt } : null, mode: 'SANDBOX' },
    });
    const trace = { toolsUsed: r.trace, knowledgeUsed: r.trace.some((t) => t.tool === 'SEARCH_KNOWLEDGE' && t.status === 'SUCCEEDED'),
      outcome: r.outcome, iterations: r.iterations, errorCode: r.errorCode ?? null, model: r.model,
      tokens: { input: r.usage.inputTokens, output: r.usage.outputTokens }, waitingFor: (await prep.pending.getOpen())?.summaryText ?? null };
    const state: SessionState = { ...prep.state, pending: prep.pending.state.pending ?? null,
      transcript: [...prep.state.transcript, { role: 'customer' as const, text: customerText }, ...(r.reply ? [{ role: 'assistant' as const, text: r.reply }] : [])].slice(-MAX_TRANSCRIPT) };
    await this.tx.inTenant(async (db) => {
      await db.query('UPDATE app.ai_test_sessions SET state = $2 WHERE id = $1', [sessionId, JSON.stringify(state)]);
      await db.query(
        `INSERT INTO app.ai_test_turns (organization_id, session_id, turn_index, customer_text, reply_text, trace, input_tokens, output_tokens, latency_ms, status)
         VALUES (app.current_org_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [sessionId, prep.index, customerText, r.reply, JSON.stringify(trace), r.usage.inputTokens, r.usage.outputTokens, r.latencyMs,
         r.outcome === 'FALLBACK' ? 'FALLBACK' : r.handoff ? 'HANDOFF' : 'SUCCEEDED']);
      // Test turns cost real model tokens: metered like live turns.
      const base = { organizationId: ctx.organizationId, businessId: prep.snap.businessId, resourceType: 'AI_TEST_SESSION', resourceId: sessionId };
      await this.ops.recordUsage(db, { ...base, eventType: 'AI_ASSISTANT_RUN', quantity: 1, idempotencyKey: `ai-test:${turnId}` });
      if (r.usage.inputTokens) await this.ops.recordUsage(db, { ...base, eventType: 'AI_INPUT_TOKENS', quantity: r.usage.inputTokens, idempotencyKey: `ai-test:${turnId}:in` });
      if (r.usage.outputTokens) await this.ops.recordUsage(db, { ...base, eventType: 'AI_OUTPUT_TOKENS', quantity: r.usage.outputTokens, idempotencyKey: `ai-test:${turnId}:out` });
    }, ctx);
    return { reply: r.reply, outcome: r.outcome, dryRun: true, trace, latencyMs: r.latencyMs };
  }
}
