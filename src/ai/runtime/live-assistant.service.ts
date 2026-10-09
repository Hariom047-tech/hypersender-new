import type { Logger } from '../../common/logger.js';
import type { Db, TransactionRunner } from '../../database/transaction-runner.js';
import { AiRepository } from '../../repositories/ai.repository.js';
import type { OpsRepository } from '../../repositories/ops.repository.js';
import type { KeyProvider } from '../../security/crypto/key-provider.js';
import type { ClaimedOutboxEvent } from '../../repositories/ops.repository.js';
import type { NotificationService } from '../../services/notification.service.js';
import type { OutboundMessageService } from '../../services/outbound-message.service.js';
import type { ModelItem, ModelProviderRegistry } from '../model/model-provider.js';
import { ToolExecutor, type ExecutorScope } from '../tools/executor.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolDeps } from '../tools/types.js';
import { setHandoff } from '../tools/handlers/conversation.js';
import { localLabel } from '../tools/handlers/format.js';
import type { AssistantSnapshot } from './assistant-config.js';
import { AssistantRuntime, fallbackText, type TurnResult } from './assistant-runtime.js';
import { DbPendingActionStore, DbToolCallLogger } from './pending-store.js';
import { loadRunTools } from './tool-loader.js';

export const AI_TURN_DUE = 'AI_TURN_DUE';
const LEASE_SECONDS = 120;
const HISTORY_MESSAGES = 24;
const SUMMARY_EVERY = 30;

export interface LiveAssistantDeps {
  tx: TransactionRunner;               // hs_worker
  keys: KeyProvider;
  ops: OpsRepository;
  outbound: OutboundMessageService;
  notifications: NotificationService;
  registry: ToolRegistry;
  toolDeps: ToolDeps;
  models: ModelProviderRegistry;
  logger: Logger;
  workerId: string;
  /** Read receipts + "typing..." on WhatsApp while a turn runs. Best-effort; omitted => no chat signals. */
  presence?: ChatPresence;
}

export interface ChatPresence {
  markRead(instanceId: string, chatJid: string, providerMessageIds: string[]): Promise<void>;
  setTyping(instanceId: string, chatJid: string, typing: boolean): Promise<void>;
}

/** WhatsApp clears "typing..." after ~10-25s; refresh it while the model works. */
const TYPING_REFRESH_MS = 8_000;

type ProcessResult = 'NOT_DUE' | 'BUSY' | 'NOTHING_TO_DO' | 'SKIPPED' | 'DONE';

/**
 * Live WhatsApp assistant pipeline (worker process, hs_worker role).
 *
 *  MESSAGE_RECEIVED (outbox, after ingestion commit)
 *     -> schedule: state.respond_after = now + response_wait_ms; enqueue AI_TURN_DUE (delayed)
 *  AI_TURN_DUE (dedicated queue, see AssistantWorker)
 *     -> if a newer message moved respond_after: not due (its own event will fire)  = DEBOUNCE
 *     -> take the per-conversation lease (run_lock_owner/until)                      = ONE CYCLE PER CONVERSATION
 *     -> claim ai_runs(trigger = last message of the batch)                          = ONE REPLY PER BATCH
 *     -> runtime loop (model + validated tools), OUTSIDE any DB transaction
 *     -> re-check human takeover, enqueue reply via the transactional outbox        = OUR WHATSAPP GATEWAY
 *  MESSAGE_SENT with origin DASHBOARD/LINKED_DEVICE -> human takeover policy (AI pauses).
 */
export class LiveAssistantService {
  private readonly ai = new AiRepository();
  private readonly runtime: AssistantRuntime;
  private readonly executor: ToolExecutor;

  constructor(private readonly d: LiveAssistantDeps) {
    this.executor = new ToolExecutor(d.registry, d.toolDeps,
      (tool, err) => d.logger.error({ event_name: 'ai.tool_failed', tool, err: { message: String(err.message).slice(0, 300) } }));
    this.runtime = new AssistantRuntime(this.executor);
  }

  private async publishedSnapshot(db: Db, assistantId: string): Promise<AssistantSnapshot | null> {
    const r = await db.query(
      `SELECT v.configuration FROM app.ai_agents a JOIN app.ai_agent_versions v ON v.id = a.published_version_id
        WHERE a.id = $1 AND a.deleted_at IS NULL`, [assistantId]);
    return (r.rows[0]?.configuration as AssistantSnapshot) ?? null;
  }

  // ------------------------------------------------------------ scheduling ---
  async onMessageReceived(e: ClaimedOutboxEvent): Promise<void> {
    const p = e.payload as { message_id: string; conversation_id: string; business_id: string; instance_id: string; otp_request_id?: string };
    if (p.otp_request_id) return; // a "login by WhatsApp" message, already answered by the OTP service
    const org = e.organizationId!;
    await this.d.tx.inTenant(async (db) => {
      const m = (await db.query(`SELECT direction, origin, message_type AS type FROM app.messages WHERE id = $1`, [p.message_id])).rows[0];
      if (!m || m.direction !== 'INBOUND' || m.type === 'REACTION') return;
      const responder = await this.ai.findResponder(db, p.instance_id);
      if (!responder) return;
      const snap = await this.publishedSnapshot(db, responder.agentId);
      if (!snap) return;
      const waitMs = snap.responseWaitMs;
      await db.query(
        `INSERT INTO app.ai_conversation_states (conversation_id, organization_id, business_id, ai_agent_id, respond_after, pending_through_message_id)
         VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5::double precision / 1000), $6)
         ON CONFLICT (conversation_id) DO UPDATE SET ai_agent_id = EXCLUDED.ai_agent_id,
           respond_after = greatest(coalesce(app.ai_conversation_states.respond_after, EXCLUDED.respond_after), EXCLUDED.respond_after),
           pending_through_message_id = CASE WHEN app.ai_conversation_states.pending_through_message_id IS NULL
                                              OR app.ai_conversation_states.pending_through_message_id < EXCLUDED.pending_through_message_id
                                             THEN EXCLUDED.pending_through_message_id ELSE app.ai_conversation_states.pending_through_message_id END`,
        [p.conversation_id, org, p.business_id, responder.agentId, waitMs, p.message_id]);
      await this.d.ops.enqueueOutbox(db, { organizationId: org, eventType: AI_TURN_DUE, aggregateType: 'CONVERSATION',
        aggregateId: p.conversation_id, payload: { conversation_id: p.conversation_id, message_id: p.message_id },
        dedupeKey: `ai-turn:${p.message_id}`, delaySeconds: waitMs / 1000 });
    }, { organizationId: org });
  }

  /** Human takeover: a genuine human reply (dashboard or the owner's phone) pauses the AI per policy. AI/API messages never do. */
  async onMessageSent(e: ClaimedOutboxEvent): Promise<void> {
    const p = e.payload as { message_id: string };
    const org = e.organizationId!;
    await this.d.tx.inTenant(async (db) => {
      const m = (await db.query(
        `SELECT m.origin, m.conversation_id, m.business_id, c.whatsapp_instance_id, c.handling_mode
           FROM app.messages m JOIN app.conversations c ON c.id = m.conversation_id WHERE m.id = $1`, [p.message_id])).rows[0];
      if (!m || !['DASHBOARD', 'LINKED_DEVICE'].includes(m.origin)) return;
      const responder = await this.ai.findResponder(db, m.whatsapp_instance_id);
      const snap = responder ? await this.publishedSnapshot(db, responder.agentId) : null;
      const policy = snap?.handoff ?? { takeover: 'PAUSE_AI', resume: 'MANUAL', resumeAfterMinutes: 120 };
      await db.query(
        `INSERT INTO app.ai_conversation_states (conversation_id, organization_id, business_id, human_last_active_at)
         VALUES ($1, $2, $3, now()) ON CONFLICT (conversation_id) DO UPDATE SET human_last_active_at = now()`,
        [m.conversation_id, org, m.business_id]);
      if (policy.takeover !== 'PAUSE_AI') return;
      // AUTO_AFTER: every human message pushes the resume time out, so the AI never resumes while a human is active.
      const until = policy.resume === 'AUTO_AFTER' ? new Date(Date.now() + policy.resumeAfterMinutes * 60_000) : null;
      await db.query(`UPDATE app.conversations SET handling_mode = 'HUMAN', ai_paused_until = $2 WHERE id = $1`, [m.conversation_id, until]);
    }, { organizationId: org });
  }

  // ----------------------------------------------------------------- turns ---
  async processTurn(e: ClaimedOutboxEvent): Promise<ProcessResult> {
    const org = e.organizationId!;
    const conversationId = (e.payload as { conversation_id: string }).conversation_id;
    type Claim = { kind: 'NOT_DUE' | 'BUSY' | 'NOTHING_TO_DO' | 'SKIPPED' | 'QUOTA' }
      | { kind: 'RUN'; runId: string; snap: AssistantSnapshot; conv: any; batch: string[]; trigger: string; state: any };
    const claim: Claim = await this.d.tx.inTenant(async (db): Promise<Claim> => {
      // All time comparisons use the DATABASE clock (workers' clocks may drift).
      const st = (await db.query(
        `SELECT s.*, coalesce(s.respond_after > now() + interval '50 milliseconds', false) AS not_due,
                (s.run_lock_owner IS NOT NULL AND s.run_lock_owner <> $2 AND s.run_lock_until > now()) AS busy
           FROM app.ai_conversation_states s WHERE s.conversation_id = $1 FOR UPDATE`, [conversationId, this.d.workerId])).rows[0];
      if (!st) return { kind: 'NOTHING_TO_DO' as const };
      if (st.not_due) return { kind: 'NOT_DUE' as const };
      if (st.busy) return { kind: 'BUSY' as const };

      const conv = (await db.query(
        `SELECT c.id, c.business_id, c.whatsapp_instance_id, c.contact_id, c.handling_mode, c.ai_paused_until, c.status,
                c.ai_paused_until IS NOT NULL AND c.ai_paused_until <= now() AS pause_over,
                c.ai_paused_until IS NOT NULL AND c.ai_paused_until > now() AS paused_now
           FROM app.conversations c WHERE c.id = $1`, [conversationId])).rows[0];
      if (!conv) return { kind: 'NOTHING_TO_DO' as const };
      const batch = (await db.query(
        `SELECT id FROM app.messages WHERE conversation_id = $1 AND direction = 'INBOUND' AND message_type <> 'REACTION'
            AND ($2::uuid IS NULL OR id > $2) AND id <= $3 ORDER BY id`,
        [conversationId, st.last_processed_message_id, st.pending_through_message_id])).rows.map((r) => r.id as string);
      if (batch.length === 0) return { kind: 'NOTHING_TO_DO' as const };
      const trigger = batch[batch.length - 1];
      const markProcessed = () => db.query(
        `UPDATE app.ai_conversation_states SET last_processed_message_id = $2, respond_after = NULL WHERE conversation_id = $1`, [conversationId, trigger]);

      const responder = await this.ai.findResponder(db, conv.whatsapp_instance_id);
      const snap = responder ? await this.publishedSnapshot(db, responder.agentId) : null;
      if (!responder || !snap) { await markProcessed(); return { kind: 'SKIPPED' as const }; }

      // Human / pause gates (with policy-driven automatic resume).
      let mode: string = conv.handling_mode;
      if ((mode === 'HUMAN' && snap.handoff.resume === 'AUTO_AFTER' && conv.pause_over) || (mode === 'PAUSED' && conv.pause_over)) {
        await db.query(`UPDATE app.conversations SET handling_mode = 'AI', ai_paused_until = NULL WHERE id = $1`, [conversationId]);
        mode = 'AI';
        conv.paused_now = false;
      }
      if (mode !== 'AI' && mode !== 'HYBRID') { await markProcessed(); return { kind: 'SKIPPED' as const }; }
      if (conv.paused_now) { await markProcessed(); return { kind: 'SKIPPED' as const }; }

      // Plan quota (MONTHLY_AI_MESSAGES) - data-driven, never hard-coded.
      const ent = (await db.query(`SELECT enabled, limit_value FROM app.current_entitlement('MONTHLY_AI_MESSAGES')`)).rows[0];
      if (!ent?.enabled) { await markProcessed(); return { kind: 'SKIPPED' as const }; }
      if (ent.limit_value !== null) {
        const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
        const used = await this.d.ops.usageInPeriod(db, 'AI_ASSISTANT_RUN', monthStart, new Date(Date.now() + 1000));
        if (used >= Number(ent.limit_value)) { await markProcessed(); return { kind: 'QUOTA' as const }; }
      }

      let runId = await this.ai.claimRun(db, { organizationId: org, businessId: conv.business_id, agent: responder, conversationId, triggerMessageId: trigger,
        workerId: this.d.workerId });
      if (!runId) {
        // A crashed worker's run (lease long gone) is taken over with the SAME run id -> same idempotency keys, no duplicate effects.
        const stale = await db.query(
          `UPDATE app.ai_runs SET attempt_count = attempt_count + 1, locked_by = $2, updated_at = now()
            WHERE trigger_message_id = $1 AND status = 'RUNNING' AND updated_at < now() - make_interval(secs => $3) RETURNING id`,
          [trigger, this.d.workerId, LEASE_SECONDS + 30]);
        if (!stale.rows[0]) { await markProcessed(); return { kind: 'SKIPPED' as const }; }
        runId = stale.rows[0].id as string;
      }
      await db.query(
        `UPDATE app.ai_conversation_states SET run_lock_owner = $2, run_lock_until = now() + make_interval(secs => $3), ai_agent_id = $4
          WHERE conversation_id = $1`, [conversationId, this.d.workerId, LEASE_SECONDS, responder.agentId]);
      await db.query('UPDATE app.conversations SET assigned_ai_agent_id = $2 WHERE id = $1 AND assigned_ai_agent_id IS DISTINCT FROM $2', [conversationId, responder.agentId]);
      return { kind: 'RUN' as const, runId, snap, conv, batch, trigger, state: st };
    }, { organizationId: org }, { retries: 2 });

    if (claim.kind === 'QUOTA') {
      await this.d.notifications.notifyAdmins(org, { type: 'AI_ASSISTANT_FAILING', dedupeKey: `ai-quota:${new Date().toISOString().slice(0, 7)}`,
        title: 'AI assistant message limit reached', body: 'Your plan\'s monthly AI message limit is reached. Customers are not receiving AI replies.' }).catch(() => undefined);
      return 'SKIPPED';
    }
    if (claim.kind !== 'RUN') return claim.kind;
    const stopTyping = await this.beginChatSignals(org, claim);
    try {
      await this.runAndDeliver(org, conversationId, claim);
    } finally {
      stopTyping();
      await this.d.tx.inTenant((db) => db.query(
        `UPDATE app.ai_conversation_states SET run_lock_owner = NULL, run_lock_until = NULL WHERE conversation_id = $1 AND run_lock_owner = $2`,
        [conversationId, this.d.workerId]), { organizationId: org }).catch(() => undefined);
    }
    return 'DONE';
  }

  /**
   * Blue ticks for the batch being answered, then "typing..." until the reply is queued (the outgoing
   * message itself clears the indicator on the customer's phone). Failures never affect the turn.
   */
  private async beginChatSignals(org: string, c: { conv: any; batch: string[] }): Promise<() => void> {
    const p = this.d.presence;
    if (!p) return () => undefined;
    const safe = (f: () => Promise<void>) => Promise.race([f(), new Promise<void>((r) => setTimeout(r, 3_000).unref?.())]).catch((err) =>
      this.d.logger.warn({ event_name: 'ai.chat_signal_failed', err: { message: String((err as Error)?.message).slice(0, 200) } }));
    try {
      const rows = (await this.d.tx.inTenant((db) => db.query(
        `SELECT provider_message_id AS pid, sender_jid AS jid FROM app.messages WHERE id = ANY($1::uuid[]) AND provider_message_id IS NOT NULL ORDER BY id`,
        [c.batch]), { organizationId: org }, { readOnly: true })).rows as Array<{ pid: string; jid: string }>;
      const jid = rows.at(-1)?.jid;
      const instance = c.conv.whatsapp_instance_id as string | null;
      if (!jid || !instance) return () => undefined;
      await safe(() => p.markRead(instance, jid, rows.map((r) => r.pid)));
      await safe(() => p.setTyping(instance, jid, true));
      const timer = setInterval(() => void safe(() => p.setTyping(instance, jid, true)), TYPING_REFRESH_MS);
      timer.unref?.();
      return () => clearInterval(timer);
    } catch (err) {
      this.d.logger.warn({ event_name: 'ai.chat_signal_failed', err: { message: String((err as Error)?.message).slice(0, 200) } });
      return () => undefined;
    }
  }

  private async runAndDeliver(org: string, conversationId: string, c: { runId: string; snap: AssistantSnapshot; conv: any; batch: string[]; trigger: string; state: any }): Promise<void> {
    const { runId, snap, conv } = c;
    const provider = this.d.models.get(snap.model.provider);
    const pending = new DbPendingActionStore(this.d.tx, this.d.keys, { organizationId: org, businessId: conv.business_id, assistantId: snap.assistantId, conversationId });
    const prep = await this.d.tx.inTenant(async (db) => {
      const open = await pending.getOpen();
      const tools = await loadRunTools(db, snap, this.d.registry, { includeConfirm: Boolean(open) });
      const biz = (await db.query('SELECT name, industry, timezone, currency FROM app.businesses WHERE id = $1', [conv.business_id])).rows[0];
      const contact = (await db.query(
        `SELECT coalesce(display_name, profile_name) AS name,
                (SELECT count(*)::int FROM app.conversations x WHERE x.contact_id = c.id) > 1 AS returning
           FROM app.contacts c WHERE c.id = $1`, [conv.contact_id])).rows[0];
      const msgs = (await db.query(
        `SELECT id, direction, origin, message_type AS type, text_body, raw_metadata FROM app.messages
          WHERE conversation_id = $1 AND id <= $2 AND message_type <> 'REACTION' ORDER BY id DESC LIMIT $3`, [conversationId, c.trigger, HISTORY_MESSAGES])).rows.reverse();
      const anyAiBefore = (await db.query(`SELECT 1 FROM app.messages WHERE conversation_id = $1 AND origin = 'AI' LIMIT 1`, [conversationId])).rows.length > 0;
      const mem = (await db.query(
        `SELECT p.preferred_language, p.food_preference, p.allergy_note,
                (SELECT count(*)::int FROM app.customer_addresses a WHERE a.contact_id = $1) AS addresses,
                (SELECT count(*)::int FROM app.orders o WHERE o.contact_id = $1) AS orders,
                (SELECT count(*)::int FROM app.cart_items ci JOIN app.carts c ON c.id = ci.cart_id WHERE c.contact_id = $1 AND c.status = 'ACTIVE') AS cart_lines
           FROM (SELECT 1) x LEFT JOIN app.customer_profiles p ON p.contact_id = $1`, [conv.contact_id])).rows[0];
      const memory = [mem.preferred_language && `prefers language ${mem.preferred_language}`, mem.food_preference && `food preference ${mem.food_preference}`,
        mem.allergy_note && `mentioned allergy: ${mem.allergy_note}`, mem.addresses && `${mem.addresses} saved address(es)`, mem.orders && `${mem.orders} previous order(s)`,
        mem.cart_lines && `has ${mem.cart_lines} item line(s) in an open cart`].filter(Boolean).join('; ') || null;
      return { open, tools, biz, contact, msgs, anyAiBefore, memory };
    }, { organizationId: org }, { readOnly: true });

    const history: ModelItem[] = prep.msgs.map((m) => {
      if (m.direction === 'INBOUND' && m.type === 'LOCATION' && m.raw_metadata?.latitude !== undefined) {
        const r = m.raw_metadata;
        return { kind: 'user' as const, text: `[customer shared a WhatsApp location: latitude ${r.latitude}, longitude ${r.longitude}${r.name ? `, ${r.name}` : ''}${r.address ? `, ${r.address}` : ''}]` };
      }
      const body = m.text_body?.trim() || `[${String(m.type).toLowerCase()} message]`;
      if (m.direction === 'INBOUND') return { kind: 'user' as const, text: m.type === 'TEXT' ? body : `[customer sent a ${String(m.type).toLowerCase()}] ${m.text_body ?? ''}`.trim() };
      return { kind: 'assistant' as const, text: m.origin === 'AI' ? body : `[message from a team member] ${body}` };
    });
    const now = new Date();
    let result: TurnResult;
    if (!provider || !provider.configured) {
      result = { reply: fallbackText(snap.languages.primary, snap.handoff.fallbackMessage), outcome: 'FALLBACK', trace: [], usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
        iterations: 0, modelCalls: 0, handoff: false, paused: false, wroteSomething: false, errorCode: 'MODEL_NOT_CONFIGURED', model: snap.model.name, latencyMs: 0 };
    } else {
      const scope: ExecutorScope = {
        base: { organizationId: org, businessId: conv.business_id, assistantId: snap.assistantId, conversationId, contactId: conv.contact_id,
          whatsappInstanceId: conv.whatsapp_instance_id, requestId: runId, dbContext: { organizationId: org }, timezone: prep.biz.timezone,
          currency: prep.biz.currency, now, assistantDefaults: snap.defaults, signal: new AbortController().signal },
        mode: 'LIVE', tools: prep.tools, pending, logger: new DbToolCallLogger(this.d.tx, this.ai, org, runId), confirmationTtlMinutes: snap.confirmationTtlMinutes,
      };
      result = await this.runtime.runTurn({
        snapshot: snap, provider, tools: prep.tools, history, scope, requestId: runId,
        context: { business: { name: prep.biz.name, industry: prep.biz.industry, timezone: prep.biz.timezone, currency: prep.biz.currency, localNow: localLabel(now, prep.biz.timezone) },
          customer: { name: prep.contact?.name ?? null, returning: Boolean(prep.contact?.returning), memory: prep.memory }, summary: c.state.summary,
          firstReply: !c.state.greeted_at && !prep.anyAiBefore,
          pending: prep.open ? { text: prep.open.summaryText, expiresAt: prep.open.expiresAt } : null, mode: 'LIVE' },
      });
    }
    await this.persist(org, conversationId, c, result);
    if (result.outcome === 'FALLBACK' || result.handoff) {
      await this.d.notifications.notifyAdmins(org, result.outcome === 'FALLBACK'
        ? { type: 'AI_ASSISTANT_FAILING', dedupeKey: `ai-fallback:${conversationId}`, title: 'The AI assistant handed a chat to your team',
            body: `It could not complete a reply (${result.errorCode ?? 'error'}). Please take over this conversation.`, data: { conversation_id: conversationId } }
        : { type: 'AI_HANDOFF', dedupeKey: `handoff:${conversationId}`, title: 'A customer needs a team member', body: 'The AI assistant handed this chat over.',
            data: { conversation_id: conversationId } }).catch(() => undefined);
    }
    await this.maybeSummarize(org, conversationId, snap).catch((err) => this.d.logger.warn({ event_name: 'ai.summary_failed', err: { message: String((err as Error).message).slice(0, 200) } }));
  }

  private async persist(org: string, conversationId: string, c: { runId: string; snap: AssistantSnapshot; conv: any; batch: string[]; trigger: string }, r: TurnResult): Promise<void> {
    await this.d.tx.inTenant(async (db) => {
      // A human may have taken over while the model was thinking: never talk over them.
      const now = (await db.query(
        `SELECT c.handling_mode,
                EXISTS (SELECT 1 FROM app.messages m WHERE m.conversation_id = c.id AND m.direction = 'OUTBOUND'
                          AND m.origin IN ('DASHBOARD','LINKED_DEVICE') AND m.id > $2) AS human_replied
           FROM app.conversations c WHERE c.id = $1`, [conversationId, c.batch[0]])).rows[0];
      const humanTookOver = !r.handoff && r.outcome !== 'FALLBACK' && (now.human_replied || (now.handling_mode !== 'AI' && now.handling_mode !== 'HYBRID'));
      let responseMessageId: string | null = null;
      if (r.reply && !humanTookOver) {
        const sent = await this.d.outbound.enqueueTextInTx(db, { conversationId, text: r.reply.slice(0, 4000), idempotencyKey: `ai-run:${c.runId}`,
          aiAgentId: c.snap.assistantId, origin: 'AI', replyToMessageId: c.batch.length === 1 ? c.trigger : undefined });
        responseMessageId = sent.messageId;
      }
      if (r.outcome === 'FALLBACK') {
        await setHandoff(db, { organizationId: org, businessId: c.conv.business_id, conversationId, assistantId: c.snap.assistantId },
          { reason: `Assistant fallback: ${r.errorCode ?? 'error'}`, priority: 'HIGH' });
      }
      const cost = await this.estimateCost(db, c.snap, r);
      const outcome = humanTookOver ? 'SKIPPED_HUMAN' : r.outcome === 'NO_REPLY' ? 'NO_REPLY' : r.outcome;
      await db.query(
        `UPDATE app.ai_runs SET status = $2, response_message_id = $3, input_tokens = $4, output_tokens = $5, cached_tokens = $6, latency_ms = $7,
                error_code = $8, completed_at = now(), locked_by = NULL, tool_iterations = $9, trigger_message_count = $10,
                estimated_cost_micros = $11, cost_currency = $12, outcome = $13, model_name = $14
          WHERE id = $1 AND status = 'RUNNING'`,
        [c.runId, humanTookOver ? 'CANCELLED' : r.outcome === 'FALLBACK' ? 'FAILED' : 'SUCCEEDED', responseMessageId, r.usage.inputTokens, r.usage.outputTokens,
         r.usage.cachedTokens, r.latencyMs, r.errorCode ?? null, r.iterations, c.batch.length, cost?.micros ?? null, cost?.currency ?? null, outcome, r.model]);
      await db.query(
        `UPDATE app.ai_conversation_states SET last_processed_message_id = $2, respond_after = CASE WHEN pending_through_message_id > $2 THEN respond_after ELSE NULL END,
                greeted_at = coalesce(greeted_at, CASE WHEN $3 THEN now() END), messages_since_summary = messages_since_summary + $4
          WHERE conversation_id = $1`, [conversationId, c.trigger, Boolean(responseMessageId), c.batch.length + (responseMessageId ? 1 : 0)]);
      const base = { organizationId: org, businessId: c.conv.business_id, resourceType: 'AI_RUN', resourceId: c.runId };
      await this.d.ops.recordUsage(db, { ...base, eventType: 'AI_ASSISTANT_RUN', quantity: 1, idempotencyKey: `ai-assistant-run:${c.runId}` });
      if (r.usage.inputTokens > 0) await this.d.ops.recordUsage(db, { ...base, eventType: 'AI_INPUT_TOKENS', quantity: r.usage.inputTokens, idempotencyKey: `ai-run:${c.runId}:in` });
      if (r.usage.outputTokens > 0) await this.d.ops.recordUsage(db, { ...base, eventType: 'AI_OUTPUT_TOKENS', quantity: r.usage.outputTokens, idempotencyKey: `ai-run:${c.runId}:out` });
      const toolCalls = r.trace.filter((t) => t.tool !== 'REPLY_GUARD' && t.status !== 'REJECTED').length;
      if (toolCalls > 0) await this.d.ops.recordUsage(db, { ...base, eventType: 'AI_TOOL_CALL', quantity: toolCalls, idempotencyKey: `ai-run:${c.runId}:tools` });
    }, { organizationId: org }, { retries: 2 });
  }

  /** Cost only from the admin-maintained pricing table; no price table row => no estimate (never a guess). */
  private async estimateCost(db: Db, s: AssistantSnapshot, r: TurnResult): Promise<{ micros: number; currency: string } | null> {
    const p = (await db.query(
      `SELECT input_micros_per_mtok, cached_input_micros_per_mtok, output_micros_per_mtok, currency FROM app.ai_model_pricing
        WHERE model_provider = $1 AND model_name = $2 AND effective_from <= now() ORDER BY effective_from DESC LIMIT 1`, [s.model.provider, r.model])).rows[0];
    if (!p) return null;
    const fresh = r.usage.inputTokens - r.usage.cachedTokens;
    const micros = (fresh * Number(p.input_micros_per_mtok) + r.usage.cachedTokens * Number(p.cached_input_micros_per_mtok ?? p.input_micros_per_mtok)
      + r.usage.outputTokens * Number(p.output_micros_per_mtok)) / 1_000_000;
    return { micros: Math.round(micros), currency: p.currency };
  }

  /** Rolling conversation memory: a short factual summary (no reasoning) refreshed every ~30 messages. */
  private async maybeSummarize(org: string, conversationId: string, snap: AssistantSnapshot): Promise<void> {
    const st = await this.d.tx.inTenant(async (db) => (await db.query(
      'SELECT summary, messages_since_summary FROM app.ai_conversation_states WHERE conversation_id = $1', [conversationId])).rows[0], { organizationId: org });
    if (!st || st.messages_since_summary < SUMMARY_EVERY) return;
    const provider = this.d.models.get(snap.model.provider);
    if (!provider?.configured) return;
    const msgs = await this.d.tx.inTenant(async (db) => (await db.query(
      `SELECT direction, text_body FROM app.messages WHERE conversation_id = $1 AND text_body IS NOT NULL ORDER BY id DESC LIMIT 60`, [conversationId])).rows.reverse(),
      { organizationId: org }, { readOnly: true });
    const transcript = msgs.map((m) => `${m.direction === 'INBOUND' ? 'Customer' : 'Business'}: ${String(m.text_body).slice(0, 400)}`).join('\n');
    const res = await provider.generate({ model: snap.model.name, maxOutputTokens: 300, timeoutMs: 20_000, requestId: `summary:${conversationId}`, tools: [],
      reasoningEffort: 'minimal',
      instructions: 'Summarise this WhatsApp conversation for a customer-service assistant in at most 6 short factual bullet points: what the customer wants, preferences, decisions made, open questions. No speculation, no reasoning, no sensitive data such as payment details.',
      items: [{ kind: 'user', text: `${st.summary ? `Previous summary:\n${st.summary}\n\n` : ''}Recent messages:\n${transcript}` }] });
    if (!res.text) return;
    await this.d.tx.inTenant((db) => db.query(
      `UPDATE app.ai_conversation_states SET summary = left($2, 4000), summary_through_at = now(), messages_since_summary = 0 WHERE conversation_id = $1`,
      [conversationId, res.text]), { organizationId: org });
  }
}
