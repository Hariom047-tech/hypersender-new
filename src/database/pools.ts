import { Pool, types, type PoolConfig } from 'pg';

// int8 (bigint) -> JS string by default; our bigints (minor units, tokens,
// lease tokens) fit in Number.MAX_SAFE_INTEGER, and money is never a float.
types.setTypeParser(types.builtins.INT8, (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`int8 value ${v} exceeds safe integer range`);
  return n;
});

export const APP_POOL = Symbol('APP_POOL');
export const WORKER_POOL = Symbol('WORKER_POOL');

export type RuntimeRole = 'app' | 'worker';

/**
 * Runtime pools. The API process only ever gets an hs_app pool; worker
 * processes get an hs_worker pool. Neither role can bypass RLS. The owner
 * (migration) credentials are never loaded by runtime processes.
 */
export function createPool(role: RuntimeRole, overrides: PoolConfig = {}): Pool {
  const user = role === 'app' ? process.env.DB_APP_USER : process.env.DB_WORKER_USER;
  const password = role === 'app' ? process.env.DB_APP_PASSWORD : process.env.DB_WORKER_PASSWORD;
  if (user === process.env.DB_OWNER_USER) throw new Error('Runtime pools must not use the owner/migration role');
  return new Pool({
    host: process.env.POSTGRES_HOST,
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    database: process.env.DB_NAME,
    user,
    password,
    max: role === 'app' ? 20 : 10,
    idleTimeoutMillis: 30_000,
    application_name: `hypersender-${role}`,
    ...overrides,
  });
}
