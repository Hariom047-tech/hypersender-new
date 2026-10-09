import { ModelError, type AIModelProvider, type ModelItem, type ModelToolDefinition } from '../model/model-provider.js';
import type { ExecutedCall, ExecutorScope, LoadedTool, TraceEntry, ToolExecutor } from '../tools/executor.js';
import { CONFIRM_TOOL_KEY } from '../tools/registry.js';
import type { AssistantSnapshot } from './assistant-config.js';
import { buildInstructions, type RuntimeContext } from './prompt-builder.js';

export interface TurnInput {
  snapshot: AssistantSnapshot;
  provider: AIModelProvider;
  tools: Map<string, LoadedTool>;
  /** Recent conversation (oldest first), ending with the customer's new message(s). */
  history: ModelItem[];
  context: RuntimeContext;
  scope: ExecutorScope;
  requestId: string;
}

export type TurnOutcome = 'REPLIED' | 'HANDOFF' | 'FALLBACK' | 'NO_REPLY';

export interface TurnResult {
  reply: string | null;
  outcome: TurnOutcome;
  trace: TraceEntry[];
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number };
  iterations: number;
  modelCalls: number;
  handoff: boolean;
  paused: boolean;
  wroteSomething: boolean;
  errorCode?: string;
  model: string;
  latencyMs: number;
}

const MODEL_TIMEOUT_MS = Number(process.env.AI_MODEL_TIMEOUT_MS ?? 30_000);
const MODEL_RETRY_DELAY_MS = Number(process.env.AI_MODEL_RETRY_DELAY_MS ?? 800);

/** Replies that assert a completed action. Checked against what tools actually confirmed this turn. */
const CLAIM_RE = /\b(booked|is confirmed|has been confirmed|are confirmed|cancelled|canceled|rescheduled|appointment is set|reservation is set|saved your|i have noted)\b|book ho gay[ai]|book kar d(i|iya)|confirm ho gay[ai]|confirm kar d(i|iya)|cancel ho gay[ai]|cancel kar d(i|iya)|reschedule ho gay[ai]|reschedule kar d(i|iya)|note kar (li|liya)/i;
const CONFIRMING_TOOLS = new Set(['CREATE_BOOKING', 'RESCHEDULE_BOOKING', 'CANCEL_BOOKING', CONFIRM_TOOL_KEY, 'GET_BOOKING', 'GET_CUSTOMER_CONTEXT',
  'CREATE_LEAD', 'UPDATE_LEAD', 'GET_LEAD', 'HUMAN_HANDOFF', 'NOTIFY_TEAM', 'PAUSE_AUTOMATION']);

export function fallbackText(primaryLanguage: string, custom?: string): string {
  if (custom?.trim()) return custom.trim();
  return primaryLanguage.startsWith('hi')
    ? 'Maaf kijiye, main abhi yeh verify nahi kar pa rahi hoon. Main aapko hamari team se connect kar rahi hoon - woh jaldi reply karenge.'
    : "Sorry, I can't verify that right now. I'm connecting you with our team - they'll reply here shortly.";
}

/**
 * The orchestration loop ("assistant brain"): model -> validated tool calls ->
 * backend results -> model ... -> final reply. Provider-, storage- and
 * channel-agnostic: the same loop powers live WhatsApp turns and the sandbox.
 * Only operational traces are produced (tool, status, summary, latency) - never
 * model reasoning.
 */
export class AssistantRuntime {
  constructor(private readonly executor: ToolExecutor) {}

  async runTurn(input: TurnInput): Promise<TurnResult> {
    const started = Date.now();
    const s = input.snapshot;
    const trace: TraceEntry[] = [];
    const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
    const items: ModelItem[] = [...input.history];
    const toolDefs: ModelToolDefinition[] = [...input.tools.values()].map((t) => ({ name: t.key, description: t.description, parameters: t.inputSchema }));
    const baseInstructions = buildInstructions(s, input.context, [...input.tools.keys()]);
    let handoff = false;
    let paused = false;
    let wroteSomething = false;
    let modelCalls = 0;
    let iterations = 0;
    let guardNote: string | null = null;
    let guardUsed = false;
    let toolsOff = false;
    let modelName = s.model.name;
    const confirmedThisTurn = new Set<string>();

    const result = (reply: string | null, outcome: TurnOutcome, errorCode?: string): TurnResult => ({
      reply, outcome, trace, usage, iterations, modelCalls, handoff, paused, wroteSomething, errorCode, model: modelName, latencyMs: Date.now() - started });
    const fallback = (code: string) => result(fallbackText(s.languages.primary, s.handoff.fallbackMessage), 'FALLBACK', code);

    while (iterations <= s.maxToolIterations) {
      let resp;
      try {
        resp = await this.callModel(input.provider, {
          model: s.model.name, instructions: guardNote ? `${baseInstructions}\n\n# CORRECTION\n${guardNote}` : baseInstructions,
          items, tools: toolsOff ? [] : toolDefs, temperature: s.model.temperature, reasoningEffort: s.model.reasoningEffort,
          maxOutputTokens: s.model.maxOutputTokens, timeoutMs: MODEL_TIMEOUT_MS, requestId: `${input.requestId}:${modelCalls}`,
        });
      } catch (err) {
        return fallback(err instanceof ModelError ? err.code : 'MODEL_FAILED');
      } finally {
        modelCalls++;
      }
      modelName = resp.model;
      usage.inputTokens += resp.usage.inputTokens;
      usage.outputTokens += resp.usage.outputTokens;
      usage.cachedTokens += resp.usage.cachedTokens;

      if (resp.toolCalls.length === 0 || toolsOff) {
        const text = resp.text?.trim() || null;
        if (!text) return handoff || paused ? result(null, handoff ? 'HANDOFF' : 'NO_REPLY') : fallback('EMPTY_REPLY');
        // Anti-fabrication guard: a completion claim needs a confirming tool result in THIS turn.
        if (!handoff && CLAIM_RE.test(text) && ![...confirmedThisTurn].some((k) => CONFIRMING_TOOLS.has(k))) {
          if (!guardUsed) {
            guardUsed = true;
            guardNote = 'Your previous draft said an action was completed, but no capability confirmed it in this turn. Either use the right capability now, or tell the customer honestly what is still needed. Do not claim completion.';
            trace.push({ tool: 'REPLY_GUARD', status: 'REJECTED', errorCode: 'UNCONFIRMED_ACTION_CLAIM', summary: {}, latencyMs: 0 });
            continue;
          }
          return fallback('UNCONFIRMED_ACTION_CLAIM');
        }
        return result(text, handoff ? 'HANDOFF' : 'REPLIED');
      }

      iterations++;
      if (iterations > s.maxToolIterations) return fallback('MAX_TOOL_ITERATIONS');
      items.push(...resp.outputItems.filter((i) => i.kind !== 'assistant'));
      const executed = await this.executeBatch(input, resp.toolCalls);
      for (const e of executed) {
        trace.push(e.trace);
        items.push({ kind: 'tool_result', callId: e.callId, output: JSON.stringify(e.output) });
        if (e.output.success) confirmedThisTurn.add(e.toolKey);
        if (e.effects.handoff) handoff = true;
        if (e.effects.paused) paused = true;
        if (e.wasWrite) wroteSomething = true;
      }
      // After a handoff/pause the assistant may send ONE closing message and must not act further.
      if (handoff || paused) toolsOff = true;
    }
    return fallback('MAX_TOOL_ITERATIONS');
  }

  /**
   * Independent read-only calls run concurrently; any batch containing a
   * side-effect (or confirmation) call runs strictly in the model's order, so
   * CHECK_AVAILABILITY -> CREATE_BOOKING stays sequential.
   */
  private async executeBatch(input: TurnInput, calls: Array<{ callId: string; name: string; arguments: string }>): Promise<ExecutedCall[]> {
    const allRead = calls.every((c) => input.tools.get(c.name)?.isReadOnly === true);
    if (allRead && calls.length > 1) return Promise.all(calls.map((c) => this.executor.execute(input.scope, c)));
    const out: ExecutedCall[] = [];
    for (const c of calls) out.push(await this.executor.execute(input.scope, c));
    return out;
  }

  /** Conservative retry: one retry for transient provider failures, then give up (caller falls back). */
  private async callModel(provider: AIModelProvider, req: Parameters<AIModelProvider['generate']>[0]) {
    try {
      return await provider.generate(req);
    } catch (err) {
      if (!(err instanceof ModelError) || !err.retryable) throw err;
      await new Promise((r) => setTimeout(r, MODEL_RETRY_DELAY_MS));
      return provider.generate(req);
    }
  }
}
