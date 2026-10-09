import { createHash } from 'node:crypto';
import { redact } from '../../security/redact.js';
import { applyDefaults, validateSchema, type JsonSchema } from '../json-schema.js';
import { CONFIRM_HANDLER, CONFIRM_TOOL_KEY, type ToolRegistry } from './registry.js';
import { FORBIDDEN_ARGUMENT_KEYS, type ToolDeps, type ToolEffects, type ToolExecutionContext, type ToolMode, type ToolOutcome, type ToolResult } from './types.js';

/** A tool as loaded for ONE assistant run: only ACTIVE, READY, enabled tools are ever loaded. */
export interface LoadedTool {
  id: string;
  key: string;
  name: string;
  description: string;
  handlerKey: string;
  inputSchema: JsonSchema;
  configSchema: JsonSchema;
  isReadOnly: boolean;
  riskLevel: string;
  requiresConfirmationDefault: boolean;
  /** Per-assistant configuration (already validated at save time; re-validated here). */
  config: Record<string, unknown>;
}

export interface PendingActionView { id: string; toolKey: string; state: string; summaryText: string; details: Record<string, unknown>; expiresAt: Date; createdByRequestId: string | null }

/** Durable confirmation state: DB table (live) or the sandbox session (test). */
export interface PendingActionStore {
  getOpen(): Promise<PendingActionView | null>;
  create(p: { toolId: string; toolKey: string; args: Record<string, unknown>; summaryText: string; details: Record<string, unknown>; requestId: string; expiresAt: Date }): Promise<string>;
  loadArgs(id: string): Promise<Record<string, unknown>>;
  resolve(id: string, state: 'CONFIRMED' | 'CANCELLED' | 'EXPIRED' | 'EXECUTED' | 'FAILED', p?: { requestId?: string; result?: Record<string, unknown> }): Promise<void>;
}

/** Operational log sink (ai_tool_calls in live runs). */
export interface ToolCallLogger {
  begin(p: { toolKey: string; callId: string; args: Record<string, unknown>; idempotencyKey: string | null }): Promise<{ id: string; replay?: { status: string; summary: unknown } }>;
  finish(id: string, status: 'SUCCEEDED' | 'FAILED' | 'REJECTED', summary: Record<string, unknown>, latencyMs: number, errorCode?: string): Promise<void>;
}

export interface TraceEntry {
  tool: string;
  status: 'SUCCEEDED' | 'FAILED' | 'REJECTED' | 'CONFIRMATION_REQUIRED' | 'DRY_RUN';
  errorCode?: string;
  summary: Record<string, unknown>;
  latencyMs: number;
}

export interface ExecutedCall { callId: string; toolKey: string; output: ToolResult; effects: ToolEffects; trace: TraceEntry; wasWrite: boolean }

export interface ExecutorScope {
  base: Omit<ToolExecutionContext, 'toolCallId' | 'idempotencyKey' | 'config' | 'mode'>;
  mode: ToolMode;
  tools: Map<string, LoadedTool>;
  pending: PendingActionStore;
  logger: ToolCallLogger | null;
  confirmationTtlMinutes: number;
}

const DEFAULT_TIMEOUT_MS = 8_000;

export const canonicalArgs = (a: unknown): string => JSON.stringify(a, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => x.localeCompare(y))) : v));
const argsHash = (a: unknown) => createHash('sha256').update(canonicalArgs(a)).digest('hex').slice(0, 24);

function findForbidden(v: unknown, path = ''): string | null {
  if (!v || typeof v !== 'object') return null;
  for (const [k, sub] of Object.entries(v as Record<string, unknown>)) {
    if (FORBIDDEN_ARGUMENT_KEYS.has(k.toLowerCase())) return `${path}${k}`;
    const deeper = findForbidden(sub, `${path}${k}.`);
    if (deeper) return deeper;
  }
  return null;
}

/** Compact, redacted, size-bounded summary for logs/traces (never full knowledge text or customer data dumps). */
export function summarize(result: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(result)) {
    if (Array.isArray(v)) out[k] = { count: v.length };
    else if (typeof v === 'string') out[k] = v.length > 160 ? `${v.slice(0, 157)}...` : v;
    else if (v && typeof v === 'object') out[k] = Object.fromEntries(Object.entries(v as Record<string, unknown>).slice(0, 12)
      .map(([a, b]) => [a, typeof b === 'string' && b.length > 120 ? `${b.slice(0, 117)}...` : Array.isArray(b) ? { count: b.length } : b]));
    else out[k] = v;
  }
  return redact(out) as Record<string, unknown>;
}

function timeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([p, new Promise<T>((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error('TOOL_TIMEOUT'), { code: 'TOOL_TIMEOUT' })), ms); })])
    .finally(() => clearTimeout(t));
}

/**
 * THE gate between model output and backend code. For every tool call:
 *   1 tool exists  2 ACTIVE  3 enabled for this assistant (only such tools are loaded)
 *   4 handler exists  5 arguments parse + no tenant/ownership keys + schema-valid
 *   6 tenant context is fixed by the scope (never from arguments)
 *   7 resource ownership: handlers resolve ids under business + RLS
 *   8 business rules: inside handlers/services
 *   9 confirmation policy: side-effect tools wait for the customer's explicit yes
 *  10 execute (timeout; DRY_RUN for sandboxes)  11 log a redacted operational record
 */
export class ToolExecutor {
  constructor(private readonly registry: ToolRegistry, private readonly deps: ToolDeps,
              private readonly onError: (toolKey: string, err: Error) => void = () => undefined) {}

  async execute(scope: ExecutorScope, call: { callId: string; name: string; arguments: string }): Promise<ExecutedCall> {
    const started = Date.now();
    const tool = scope.tools.get(call.name);
    const reject = (errorCode: string, message: string, extra: Record<string, unknown> = {}): ExecutedCall => {
      const output: ToolResult = { success: false, errorCode, message, ...extra };
      return { callId: call.callId, toolKey: call.name, output, effects: {}, wasWrite: false,
        trace: { tool: call.name, status: 'REJECTED', errorCode, summary: summarize(output), latencyMs: Date.now() - started } };
    };
    if (!tool) return reject('TOOL_NOT_ENABLED', 'This capability is not available to you. Do not claim it was done.');
    const handler = tool.handlerKey === CONFIRM_HANDLER ? null : this.registry.get(tool.handlerKey);
    if (tool.handlerKey !== CONFIRM_HANDLER && !handler) return reject('TOOL_UNAVAILABLE', 'This capability is temporarily unavailable.');

    let args: Record<string, unknown>;
    try {
      const parsed = JSON.parse(call.arguments || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      args = parsed;
    } catch {
      return this.logged(scope, tool, call, {}, reject('INVALID_ARGUMENTS', 'Arguments must be a JSON object.'));
    }
    const forbidden = findForbidden(args);
    if (forbidden) return this.logged(scope, tool, call, args, reject('FORBIDDEN_ARGUMENT', `"${forbidden}" cannot be supplied; the business and customer are fixed by the system.`));
    const issues = validateSchema(tool.inputSchema, args);
    if (issues.length) return this.logged(scope, tool, call, args, reject('INVALID_ARGUMENTS', 'Arguments do not match the capability.', { issues: issues.slice(0, 5) }));

    const config = applyDefaults(tool.configSchema, tool.config);
    const idempotencyKey = `${scope.base.requestId}:${tool.key}:${argsHash(args)}`;
    const ctx: ToolExecutionContext = { ...scope.base, toolCallId: call.callId, idempotencyKey, config, mode: scope.mode };

    if (tool.handlerKey === CONFIRM_HANDLER) return this.confirm(scope, tool, call, args as { decision: 'CONFIRM' | 'DECLINE' }, started);

    const needsConfirmation = !tool.isReadOnly && (config.requireConfirmation !== undefined ? Boolean(config.requireConfirmation) : tool.requiresConfirmationDefault);
    if (needsConfirmation) {
      if (!handler!.preview) return reject('TOOL_UNAVAILABLE', 'Confirmation is not supported for this capability.');
      const pv = await this.guard(tool.key, () => handler!.preview!(ctx, args, this.deps), handler!.timeoutMs);
      if ('result' in pv) return this.finish(scope, tool, call, args, pv, started, false);
      if (!pv.ok) return this.finish(scope, tool, call, args, pv.outcome, started, false);
      const open = await scope.pending.getOpen();
      if (open) await scope.pending.resolve(open.id, 'CANCELLED');
      const expiresAt = new Date(Date.now() + scope.confirmationTtlMinutes * 60_000);
      const id = await scope.pending.create({ toolId: tool.id, toolKey: tool.key, args, summaryText: pv.text, details: pv.details,
        requestId: scope.base.requestId, expiresAt });
      const output: ToolResult = { success: false, status: 'CONFIRMATION_REQUIRED', pendingActionId: id, confirmationText: pv.text, details: pv.details,
        instruction: 'Nothing has been done yet. Ask the customer to confirm these exact details. When they reply, call CONFIRM_PENDING_ACTION.' };
      const trace: TraceEntry = { tool: tool.key, status: 'CONFIRMATION_REQUIRED', summary: summarize({ confirmationText: pv.text }), latencyMs: Date.now() - started };
      await this.log(scope, tool, call, args, null, 'SUCCEEDED', trace.summary, trace.latencyMs);
      return { callId: call.callId, toolKey: tool.key, output, effects: {}, trace, wasWrite: false };
    }
    return this.run(scope, tool, call, args, ctx, started);
  }

  /** Executes (or dry-runs) a validated call. */
  private async run(scope: ExecutorScope, tool: LoadedTool, call: { callId: string; name: string }, args: Record<string, unknown>,
                    ctx: ToolExecutionContext, started: number): Promise<ExecutedCall> {
    const handler = this.registry.get(tool.handlerKey)!;
    const dry = scope.mode === 'DRY_RUN' && !tool.isReadOnly && !(handler.sandboxSafe && ctx.testSessionId);
    let replay: { status: string; summary: unknown } | undefined;
    let logId: string | null = null;
    if (scope.logger) {
      const b = await scope.logger.begin({ toolKey: tool.key, callId: call.callId, args: redact(args) as Record<string, unknown>, idempotencyKey: tool.isReadOnly ? null : ctx.idempotencyKey });
      logId = b.id;
      replay = b.replay;
    }
    if (replay && replay.status !== 'PENDING') {
      // Same provider call replayed in a retried run: report the recorded outcome, never execute twice.
      const output = { success: replay.status === 'SUCCEEDED', replayed: true, ...(replay.summary as object) } as ToolResult;
      return { callId: call.callId, toolKey: tool.key, output, effects: {}, wasWrite: !tool.isReadOnly,
        trace: { tool: tool.key, status: replay.status === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED', summary: summarize(output), latencyMs: Date.now() - started } };
    }
    const outcome = await this.guard(tool.key, () => (dry ? handler.dryRun!(ctx, args, this.deps) : handler.execute(ctx, args, this.deps)), handler.timeoutMs);
    return this.finish(scope, tool, call, args, outcome, started, !tool.isReadOnly && !dry, logId, dry);
  }

  private async confirm(scope: ExecutorScope, tool: LoadedTool, call: { callId: string; name: string }, args: { decision: 'CONFIRM' | 'DECLINE' },
                        started: number): Promise<ExecutedCall> {
    const open = await scope.pending.getOpen();
    const done = (output: ToolResult, status: TraceEntry['status'] = output.success ? 'SUCCEEDED' : 'FAILED'): ExecutedCall =>
      ({ callId: call.callId, toolKey: tool.key, output, effects: {}, wasWrite: false,
         trace: { tool: tool.key, status, errorCode: output.errorCode as string | undefined, summary: summarize(output), latencyMs: Date.now() - started } });
    if (!open) return done({ success: false, errorCode: 'NO_PENDING_ACTION', message: 'Nothing is waiting for confirmation.' });
    if (open.expiresAt.getTime() <= Date.now()) {
      await scope.pending.resolve(open.id, 'EXPIRED');
      return done({ success: false, errorCode: 'CONFIRMATION_EXPIRED', message: 'The confirmation window expired. Re-check details before trying again.' });
    }
    // The customer's "yes" must come in a LATER turn than the one that asked - the model cannot confirm its own request.
    if (open.createdByRequestId === scope.base.requestId) {
      return done({ success: false, errorCode: 'CONFIRMATION_NOT_FROM_CUSTOMER', message: 'Wait for the customer to reply before confirming.' }, 'REJECTED');
    }
    if (args.decision === 'DECLINE') {
      await scope.pending.resolve(open.id, 'CANCELLED', { requestId: scope.base.requestId });
      return done({ success: true, status: 'ACTION_CANCELLED', action: open.toolKey });
    }
    const target = [...scope.tools.values()].find((t) => t.key === open.toolKey);
    if (!target) {
      await scope.pending.resolve(open.id, 'CANCELLED');
      return done({ success: false, errorCode: 'TOOL_NOT_ENABLED', message: 'That capability is no longer enabled.' });
    }
    await scope.pending.resolve(open.id, 'CONFIRMED', { requestId: scope.base.requestId });
    const storedArgs = await scope.pending.loadArgs(open.id);   // exact arguments the customer saw - not model memory
    const ctx: ToolExecutionContext = { ...scope.base, toolCallId: call.callId, idempotencyKey: `pending:${open.id}`,
      config: applyDefaults(target.configSchema, target.config), mode: scope.mode };
    const executed = await this.run(scope, target, { callId: `${call.callId}:exec`, name: target.key }, storedArgs, ctx, started);
    await scope.pending.resolve(open.id, executed.output.success ? 'EXECUTED' : 'FAILED', { requestId: scope.base.requestId, result: summarize(executed.output) });
    return { ...executed, callId: call.callId, toolKey: tool.key, output: { ...executed.output, confirmedAction: target.key },
      trace: { ...executed.trace, tool: tool.key, summary: { ...executed.trace.summary, action: target.key } } };
  }

  private async guard(toolKey: string, fn: () => Promise<any>, ms = DEFAULT_TIMEOUT_MS): Promise<any> {
    try {
      return await timeout(fn(), ms);
    } catch (err) {
      this.onError(toolKey, err as Error);
      if ((err as { code?: string }).code === 'TOOL_TIMEOUT') return { result: { success: false, errorCode: 'TOOL_TIMEOUT', message: 'The system did not answer in time. Do not assume the action happened.' } };
      return { result: { success: false, errorCode: 'TOOL_FAILED', message: 'The capability failed. Do not assume the action happened.' } };
    }
  }

  private async finish(scope: ExecutorScope, tool: LoadedTool, call: { callId: string; name: string }, args: Record<string, unknown>,
                       outcome: ToolOutcome, started: number, isWrite: boolean, logId?: string | null, dry = false): Promise<ExecutedCall> {
    const latencyMs = Date.now() - started;
    const status: TraceEntry['status'] = outcome.result.success ? (dry ? 'DRY_RUN' : 'SUCCEEDED') : 'FAILED';
    const summary = summarize(outcome.result);
    if (logId && scope.logger) await scope.logger.finish(logId, outcome.result.success ? 'SUCCEEDED' : 'FAILED', summary, latencyMs, outcome.result.errorCode);
    else if (!logId) await this.log(scope, tool, call, args, null, outcome.result.success ? 'SUCCEEDED' : 'FAILED', summary, latencyMs, outcome.result.errorCode);
    return { callId: call.callId, toolKey: tool.key, output: outcome.result, effects: outcome.effects ?? {}, wasWrite: isWrite && outcome.result.success,
      trace: { tool: tool.key, status, errorCode: outcome.result.errorCode, summary, latencyMs } };
  }

  private async logged(scope: ExecutorScope, tool: LoadedTool, call: { callId: string; name: string }, args: Record<string, unknown>, r: ExecutedCall): Promise<ExecutedCall> {
    await this.log(scope, tool, call, args, null, 'REJECTED', r.trace.summary, r.trace.latencyMs, r.output.errorCode as string);
    return r;
  }

  private async log(scope: ExecutorScope, tool: LoadedTool, call: { callId: string }, args: Record<string, unknown>, idem: string | null,
                    status: 'SUCCEEDED' | 'FAILED' | 'REJECTED', summary: Record<string, unknown>, latencyMs: number, errorCode?: string): Promise<void> {
    if (!scope.logger) return;
    const b = await scope.logger.begin({ toolKey: tool.key, callId: call.callId, args: redact(args) as Record<string, unknown>, idempotencyKey: idem });
    if (!b.replay || b.replay.status === 'PENDING') await scope.logger.finish(b.id, status, summary, latencyMs, errorCode);
  }
}

export { CONFIRM_TOOL_KEY };
