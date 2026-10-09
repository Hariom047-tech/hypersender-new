import { createHash } from 'node:crypto';
import type { Db, TransactionRunner } from '../../database/transaction-runner.js';
import { AiRepository } from '../../repositories/ai.repository.js';
import { aad, aesGcmDecrypt, aesGcmEncrypt } from '../../security/crypto/aes-gcm.js';
import type { KeyProvider } from '../../security/crypto/key-provider.js';
import { canonicalArgs, type PendingActionStore, type PendingActionView, type ToolCallLogger } from '../tools/executor.js';

/**
 * Live confirmation state in app.ai_pending_actions. Arguments are encrypted
 * (per-row data key from the KeyProvider, AES-256-GCM, AAD bound to tenant +
 * row) because they can contain customer details; only a customer-facing
 * summary is stored in clear. One open action per conversation (unique index).
 */
export class DbPendingActionStore implements PendingActionStore {
  constructor(private readonly tx: TransactionRunner, private readonly keys: KeyProvider,
              private readonly scope: { organizationId: string; businessId: string; assistantId: string; conversationId: string }) {}

  private run<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    return this.tx.inTenant(fn, { organizationId: this.scope.organizationId });
  }

  /** The open (WAITING) action, even if expired - the executor answers expired confirmations explicitly. */
  async getOpen(): Promise<PendingActionView | null> {
    return this.run(async (db) => {
      const r = await db.query(
        `SELECT p.id, t.key, p.state, p.summary, p.expires_at, p.created_by_run_id FROM app.ai_pending_actions p JOIN app.ai_tools t ON t.id = p.tool_id
          WHERE p.conversation_id = $1 AND p.state = 'WAITING'`, [this.scope.conversationId]);
      const x = r.rows[0];
      return x ? { id: x.id, toolKey: x.key, state: x.state, summaryText: x.summary.text ?? '', details: x.summary.details ?? {},
                   expiresAt: new Date(x.expires_at), createdByRequestId: x.created_by_run_id } : null;
    });
  }

  async create(p: { toolId: string; toolKey: string; args: Record<string, unknown>; summaryText: string; details: Record<string, unknown>; requestId: string; expiresAt: Date }): Promise<string> {
    const id = (await this.run((db) => db.query('SELECT app.uuid_generate_v7() AS id'))).rows[0].id as string;
    const dek = await this.keys.generateDataKey({ organization_id: this.scope.organizationId, purpose: 'ai-pending-action' });
    const plaintext = Buffer.from(canonicalArgs(p.args), 'utf8');
    const ciphertext = aesGcmEncrypt(dek.plaintext, plaintext, aad('ai-pending-action', 'v1', this.scope.organizationId, id));
    dek.plaintext.fill(0);
    await this.run((db) => db.query(
      `INSERT INTO app.ai_pending_actions (id, organization_id, business_id, ai_agent_id, conversation_id, tool_id, args_ciphertext, args_wrapped_key,
                                           args_key_reference, args_hash, summary, expires_at, created_by_run_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, this.scope.organizationId, this.scope.businessId, this.scope.assistantId, this.scope.conversationId, p.toolId, ciphertext, dek.wrapped,
       dek.keyReference, createHash('sha256').update(plaintext).digest('hex'), JSON.stringify({ text: p.summaryText, details: p.details }),
       p.expiresAt, p.requestId]));
    return id;
  }

  async loadArgs(id: string): Promise<Record<string, unknown>> {
    const x = (await this.run((db) => db.query(
      'SELECT args_ciphertext, args_wrapped_key, args_key_reference FROM app.ai_pending_actions WHERE id = $1', [id]))).rows[0];
    if (!x) throw new Error('pending action not found');
    const key = await this.keys.decryptDataKey(x.args_wrapped_key, x.args_key_reference, { organization_id: this.scope.organizationId, purpose: 'ai-pending-action' });
    try {
      return JSON.parse(aesGcmDecrypt(key, x.args_ciphertext, aad('ai-pending-action', 'v1', this.scope.organizationId, id)).toString('utf8'));
    } finally {
      key.fill(0);
    }
  }

  async resolve(id: string, state: 'CONFIRMED' | 'CANCELLED' | 'EXPIRED' | 'EXECUTED' | 'FAILED', p: { requestId?: string; result?: Record<string, unknown> } = {}): Promise<void> {
    await this.run((db) => db.query(
      `UPDATE app.ai_pending_actions
          SET state = $2,
              confirmed_at = CASE WHEN $2 IN ('CONFIRMED','EXECUTED','FAILED') THEN coalesce(confirmed_at, now()) ELSE confirmed_at END,
              resolved_at = CASE WHEN $2 IN ('CANCELLED','EXPIRED','EXECUTED','FAILED') THEN now() ELSE resolved_at END,
              executed_by_run_id = coalesce($3, executed_by_run_id),
              result_summary = coalesce($4::jsonb, result_summary)
        WHERE id = $1 AND state IN ('WAITING','CONFIRMED')`,
      [id, state, p.requestId ?? null, p.result ? JSON.stringify(p.result) : null]));
  }
}

/** Sandbox confirmation state kept inside the test session (never touches live tables). */
export class MemoryPendingActionStore implements PendingActionStore {
  constructor(public state: { pending?: (PendingActionView & { args: Record<string, unknown> }) | null } = {}) {}
  async getOpen(): Promise<PendingActionView | null> {
    const p = this.state.pending;
    if (!p || p.state !== 'WAITING') return null;
    return { ...p, expiresAt: new Date(p.expiresAt) };
  }
  async create(p: { toolKey: string; args: Record<string, unknown>; summaryText: string; details: Record<string, unknown>; requestId: string; expiresAt: Date }): Promise<string> {
    const id = `sandbox-${Date.now().toString(36)}`;
    this.state.pending = { id, toolKey: p.toolKey, state: 'WAITING', summaryText: p.summaryText, details: p.details, expiresAt: p.expiresAt,
      createdByRequestId: p.requestId, args: p.args };
    return id;
  }
  async loadArgs(): Promise<Record<string, unknown>> { return this.state.pending?.args ?? {}; }
  async resolve(_id: string, state: 'CONFIRMED' | 'CANCELLED' | 'EXPIRED' | 'EXECUTED' | 'FAILED'): Promise<void> {
    if (!this.state.pending) return;
    if (state === 'CONFIRMED') this.state.pending.state = 'CONFIRMED';
    else this.state.pending = null;
  }
}

/** ai_tool_calls writer (redacted args, summary only) - idempotent per (run, provider call id). */
export class DbToolCallLogger implements ToolCallLogger {
  constructor(private readonly tx: TransactionRunner, private readonly ai: AiRepository, private readonly organizationId: string, private readonly runId: string) {}
  async begin(p: { toolKey: string; callId: string; args: Record<string, unknown>; idempotencyKey: string | null }) {
    const call = await this.tx.inTenant((db) => this.ai.beginToolCall(db, { organizationId: this.organizationId, runId: this.runId, toolKey: p.toolKey,
      providerToolCallId: p.callId, redactedArguments: p.args }), { organizationId: this.organizationId });
    if (p.idempotencyKey) {
      await this.tx.inTenant((db) => db.query('UPDATE app.ai_tool_calls SET idempotency_key = $2 WHERE id = $1 AND idempotency_key IS NULL',
        [call.id, p.idempotencyKey]), { organizationId: this.organizationId });
    }
    return { id: call.id, replay: call.status === 'PENDING' ? undefined : { status: call.status, summary: call.resultSummary } };
  }
  async finish(id: string, status: 'SUCCEEDED' | 'FAILED' | 'REJECTED', summary: Record<string, unknown>, latencyMs: number, errorCode?: string) {
    await this.tx.inTenant((db) => this.ai.finishToolCall(db, id, status, summary, latencyMs, errorCode), { organizationId: this.organizationId });
  }
}
