import 'dotenv/config';
import type { ClientConfig } from 'pg';

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Missing required environment variable ${name}`);
  return v;
}

export type DbRole = 'superuser' | 'owner' | 'app' | 'worker';

/** Connection settings for each database role. Credentials come only from the environment. */
export function connectionConfig(role: DbRole, database: string): ClientConfig {
  const base = { host: env('POSTGRES_HOST', 'localhost'), port: Number(env('POSTGRES_PORT', '5432')), database };
  switch (role) {
    case 'superuser':
      return { ...base, user: env('POSTGRES_SUPERUSER', 'postgres'), password: env('POSTGRES_SUPERUSER_PASSWORD') };
    case 'owner':
      return { ...base, user: env('DB_OWNER_USER', 'hs_owner'), password: env('DB_OWNER_PASSWORD') };
    case 'app':
      return { ...base, user: env('DB_APP_USER', 'hs_app'), password: env('DB_APP_PASSWORD') };
    case 'worker':
      return { ...base, user: env('DB_WORKER_USER', 'hs_worker'), password: env('DB_WORKER_PASSWORD') };
  }
}

/** Target database: --test flag (or DB_TARGET=test) selects the isolated test database. */
export function targetDatabase(argv: string[] = process.argv): string {
  const isTest = argv.includes('--test') || process.env.DB_TARGET === 'test';
  return isTest ? env('TEST_DB_NAME', 'hypersender_test') : env('DB_NAME', 'hypersender');
}

export { env };
