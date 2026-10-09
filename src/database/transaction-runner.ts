import type { Pool, PoolClient } from 'pg';
import { assertUuid } from '../common/uuid.js';
import { isRetryable } from './errors.js';
import { currentTenant, type DbContext } from './tenant-context.js';

export type Db = Pick<PoolClient, 'query'>;

export interface TxOptions {
  isolation?: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';
  readOnly?: boolean;
  /** Retries on serialization failure / deadlock. The callback must be idempotent. */
  retries?: number;
}

/**
 * The ONLY way application code touches the database.
 *
 * Every unit of work is a transaction whose first statement sets the tenant
 * context with set_config(..., is_local => true). The settings vanish at
 * COMMIT/ROLLBACK, so a pooled connection can never carry one tenant's context
 * into another request. RLS policies read these settings.
 *
 * Rule: never perform network I/O (WhatsApp, HTTP webhooks, LLM calls) inside
 * the callback - keep transactions short; use the outbox for side effects.
 */
export class TransactionRunner {
  constructor(private readonly pool: Pool) {}

  /** Tenant-scoped unit of work (the normal path). Defaults to the ALS context. */
  inTenant<T>(fn: (db: Db) => Promise<T>, ctx: DbContext = currentTenant(), opts: TxOptions = {}): Promise<T> {
    assertUuid(ctx.organizationId, 'organizationId');
    return this.run(ctx, fn, opts);
  }

  /**
   * Explicit context (may lack an organization): sign-up, "list my
   * organizations", worker claim queries. RLS stays fully active: without an
   * organization id, tenant tables return nothing except where a policy grants
   * the role a narrowly-scoped cross-tenant path (queue tables for hs_worker).
   */
  async run<T>(ctx: DbContext, fn: (db: Db) => Promise<T>, opts: TxOptions = {}): Promise<T> {
    if (ctx.organizationId !== undefined) assertUuid(ctx.organizationId, 'organizationId');
    if (ctx.userId !== undefined) assertUuid(ctx.userId, 'userId');
    if (ctx.apiKeyId !== undefined) assertUuid(ctx.apiKeyId, 'apiKeyId');

    const maxAttempts = 1 + (opts.retries ?? 0);
    for (let attempt = 1; ; attempt++) {
      const client = await this.pool.connect();
      let broken = false;
      try {
        await client.query(
          `BEGIN ISOLATION LEVEL ${opts.isolation ?? 'READ COMMITTED'}${opts.readOnly ? ' READ ONLY' : ''}`);
        await client.query(
          `SELECT set_config('app.current_organization_id', $1, true),
                  set_config('app.current_user_id', $2, true),
                  set_config('app.current_api_key_id', $3, true)`,
          [ctx.organizationId ?? '', ctx.userId ?? '', ctx.apiKeyId ?? '']);
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          broken = true; // connection is unusable: destroy it instead of returning it to the pool
        }
        if (attempt < maxAttempts && isRetryable(err)) continue;
        throw err;
      } finally {
        client.release(broken);
      }
    }
  }
}

export const APP_TX = Symbol('APP_TX');
export const WORKER_TX = Symbol('WORKER_TX');
