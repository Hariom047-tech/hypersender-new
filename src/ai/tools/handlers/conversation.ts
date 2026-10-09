import type { Db } from '../../../database/transaction-runner.js';
import { fail, ok, withDb, type AssistantTool, type ToolExecutionContext } from '../types.js';
import { clip } from './format.js';

/*
 * Conversation-control capabilities. HUMAN_HANDOFF / PAUSE_AUTOMATION change
 * conversations.handling_mode (the single source of truth the runtime checks
 * before every turn and again before sending), so once they succeed the
 * assistant stops auto-replying in that chat.
 */

export async function setHandoff(db: Db, ctx: { organizationId: string; businessId: string; conversationId: string; assistantId: string | null },
                                 p: { reason: string; priority?: string; summary?: string | null }): Promise<void> {
  await db.query(`UPDATE app.conversations SET handling_mode = 'HUMAN', ai_paused_until = NULL WHERE id = $1`, [ctx.conversationId]);
  await db.query(
    `INSERT INTO app.ai_conversation_states (conversation_id, organization_id, business_id, ai_agent_id, handoff_reason, handoff_priority, handoff_at, summary)
     VALUES ($1, $2, $3, $4, $5, $6, now(), $7)
     ON CONFLICT (conversation_id) DO UPDATE SET handoff_reason = EXCLUDED.handoff_reason, handoff_priority = EXCLUDED.handoff_priority,
       handoff_at = now(), summary = coalesce(EXCLUDED.summary, app.ai_conversation_states.summary)`,
    [ctx.conversationId, ctx.organizationId, ctx.businessId, ctx.assistantId, clip(p.reason, 500), p.priority ?? 'NORMAL', clip(p.summary ?? null, 4000)]);
}

async function customerName(db: Db, ctx: ToolExecutionContext): Promise<string> {
  if (!ctx.contactId) return 'A customer';
  const r = await db.query('SELECT coalesce(display_name, profile_name, phone_e164) AS n FROM app.contacts WHERE id = $1', [ctx.contactId]);
  return r.rows[0]?.n ?? 'A customer';
}

export const humanHandoff: AssistantTool<{ reason: string; priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT'; summary?: string }> = {
  handlerKey: 'conversation.handoff', isReadOnly: false,
  async dryRun(_ctx, input) {
    return ok({ dryRun: true, status: 'WOULD_HAND_OFF', handlingMode: 'HUMAN', reason: input.reason });
  },
  async execute(ctx, input, deps) {
    if (!ctx.conversationId) return fail('NO_CONVERSATION');
    const name = await withDb(ctx, deps, async (db) => {
      await setHandoff(db, { organizationId: ctx.organizationId, businessId: ctx.businessId, conversationId: ctx.conversationId!, assistantId: ctx.assistantId },
        { reason: input.reason, priority: input.priority, summary: input.summary });
      await deps.ops.recordUsage(db, { organizationId: ctx.organizationId, businessId: ctx.businessId, eventType: 'AI_HANDOFF', quantity: 1,
        resourceType: 'CONVERSATION', resourceId: ctx.conversationId!, idempotencyKey: `handoff:${ctx.idempotencyKey}` });
      return customerName(db, ctx);
    }, false);
    if (ctx.config.notifyTeam !== false && deps.notifications) {
      await deps.notifications.notifyAdmins(ctx.organizationId, { type: 'AI_HANDOFF', dedupeKey: `handoff:${ctx.conversationId}`,
        title: `${input.priority === 'URGENT' || input.priority === 'HIGH' ? 'Urgent: ' : ''}${name} needs a team member`,
        body: clip(input.summary ?? input.reason, 180) ?? 'The assistant handed this chat over.',
        data: { conversation_id: ctx.conversationId, priority: input.priority ?? 'NORMAL' } }).catch(() => undefined);
    }
    return ok({ status: 'HANDED_OFF', handlingMode: 'HUMAN', note: 'Tell the customer a team member will reply here. Do not continue helping in this chat.' },
      { handoff: true, wrote: true });
  },
};

export const pauseAutomation: AssistantTool<{ reason: string; minutes?: number }> = {
  handlerKey: 'conversation.pause', isReadOnly: false,
  async dryRun(ctx, input) {
    return ok({ dryRun: true, status: 'WOULD_PAUSE', minutes: input.minutes ?? Number(ctx.config.defaultMinutes ?? 1440) });
  },
  async execute(ctx, input, deps) {
    if (!ctx.conversationId) return fail('NO_CONVERSATION');
    const minutes = input.minutes ?? Number(ctx.config.defaultMinutes ?? 1440);
    const until = new Date(ctx.now.getTime() + minutes * 60_000);
    await withDb(ctx, deps, async (db) => {
      await db.query(`UPDATE app.conversations SET handling_mode = 'PAUSED', ai_paused_until = $2 WHERE id = $1`, [ctx.conversationId, until]);
      await db.query(
        `INSERT INTO app.ai_conversation_states (conversation_id, organization_id, business_id, ai_agent_id, handoff_reason, handoff_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (conversation_id) DO UPDATE SET handoff_reason = EXCLUDED.handoff_reason, handoff_at = now()`,
        [ctx.conversationId, ctx.organizationId, ctx.businessId, ctx.assistantId, `Paused on request: ${clip(input.reason, 400)}`]);
    }, false);
    return ok({ status: 'PAUSED', pausedUntil: until.toISOString() }, { paused: true, wrote: true });
  },
};

export const notifyTeam: AssistantTool<{ message: string; priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT' }> = {
  handlerKey: 'team.notify', isReadOnly: false,
  async dryRun(_ctx, input) {
    return ok({ dryRun: true, status: 'WOULD_NOTIFY_TEAM', message: input.message });
  },
  async execute(ctx, input, deps) {
    if (!deps.notifications) return fail('TOOL_UNAVAILABLE');
    const name = await withDb(ctx, deps, (db) => customerName(db, ctx));
    const n = await deps.notifications.notifyAdmins(ctx.organizationId, { type: 'AI_TEAM_ALERT', dedupeKey: `team-alert:${ctx.idempotencyKey}`,
      title: `${input.priority === 'URGENT' ? 'Urgent - ' : ''}Note from the assistant about ${name}`.slice(0, 200),
      body: clip(input.message, 400)!, data: { conversation_id: ctx.conversationId, priority: input.priority ?? 'NORMAL' } });
    return ok({ status: 'TEAM_NOTIFIED', recipients: n }, { wrote: true });
  },
};
