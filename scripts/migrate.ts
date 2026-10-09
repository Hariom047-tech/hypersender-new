/**
 * Numbered SQL migration runner (runs as hs_owner).
 *
 *   npm run db:migrate            apply pending migrations
 *   npm run db:migrate:status     list applied / pending
 *   npm run db:migrate:down       roll back the LAST migration using db/migrations/down/<name>.down.sql
 *                                 (refused when NODE_ENV=production unless --allow-production)
 *   append `-- --test` to target the test database.
 *
 * Guarantees:
 *   - a session advisory lock serialises concurrent runners (e.g. several pods starting);
 *   - every migration runs in its own transaction (unless its first line is
 *     `-- migrate:no-transaction`, required for CREATE INDEX CONCURRENTLY);
 *   - the SHA-256 of every applied file is recorded; if an applied file is edited
 *     the runner aborts: create a NEW migration instead of modifying history.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from 'pg';
import { connectionConfig, targetDatabase } from './lib/config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const MIGRATIONS_DIR = join(ROOT, 'db', 'migrations');
const DOWN_DIR = join(MIGRATIONS_DIR, 'down');
const LOCK_KEY = 727_001_001; // arbitrary constant, unique to this runner

interface MigrationFile { version: string; name: string; file: string; sql: string; checksum: string }

function loadMigrations(): MigrationFile[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((file) => {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8').replace(/\r\n/g, '\n');
      return {
        version: file.slice(0, 4),
        name: file.replace(/\.sql$/, ''),
        file,
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
      };
    });
}

async function ensureLedger(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      version     text PRIMARY KEY,
      name        text NOT NULL,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      applied_by  text NOT NULL DEFAULT current_user,
      duration_ms integer NOT NULL
    )`);
}

async function applied(client: Client): Promise<Map<string, { name: string; checksum: string }>> {
  const r = await client.query('SELECT version, name, checksum FROM public.schema_migrations ORDER BY version');
  return new Map(r.rows.map((row) => [row.version as string, { name: row.name as string, checksum: row.checksum as string }]));
}

export async function migrateUp(database: string, log: (m: string) => void = console.log): Promise<number> {
  const client = new Client(connectionConfig('owner', database));
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await ensureLedger(client);
    const done = await applied(client);
    const files = loadMigrations();

    for (const [version, rec] of done) {
      const f = files.find((m) => m.version === version);
      if (!f) throw new Error(`Applied migration ${version} (${rec.name}) is missing from disk`);
      if (f.checksum !== rec.checksum) {
        throw new Error(`Migration ${f.file} was modified after being applied (checksum mismatch). ` +
          'Never edit applied migrations - add a new one.');
      }
    }

    let count = 0;
    for (const m of files.filter((f) => !done.has(f.version))) {
      const noTx = m.sql.startsWith('-- migrate:no-transaction');
      const started = Date.now();
      log(`applying ${m.file} ...`);
      try {
        if (!noTx) await client.query('BEGIN');
        await client.query(m.sql);
        await client.query(
          'INSERT INTO public.schema_migrations (version, name, checksum, duration_ms) VALUES ($1, $2, $3, $4)',
          [m.version, m.name, m.checksum, Date.now() - started]);
        if (!noTx) await client.query('COMMIT');
      } catch (err) {
        if (!noTx) await client.query('ROLLBACK');
        throw new Error(`Migration ${m.file} failed: ${(err as Error).message}`);
      }
      count++;
    }
    log(count === 0 ? 'database is up to date' : `applied ${count} migration(s)`);
    return count;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    await client.end();
  }
}

export async function migrateDown(database: string, log: (m: string) => void = console.log): Promise<void> {
  if (process.env.NODE_ENV === 'production' && !process.argv.includes('--allow-production')) {
    throw new Error('Refusing to roll back in production without --allow-production (prefer a forward-fix migration)');
  }
  const client = new Client(connectionConfig('owner', database));
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await ensureLedger(client);
    const r = await client.query('SELECT version, name FROM public.schema_migrations ORDER BY version DESC LIMIT 1');
    if (r.rowCount === 0) { log('nothing to roll back'); return; }
    const { version, name } = r.rows[0];
    const downFile = join(DOWN_DIR, `${name}.down.sql`);
    if (!existsSync(downFile)) throw new Error(`No rollback script for ${name} (expected ${downFile})`);
    await client.query('BEGIN');
    await client.query(readFileSync(downFile, 'utf8'));
    await client.query('DELETE FROM public.schema_migrations WHERE version = $1', [version]);
    await client.query('COMMIT');
    log(`rolled back ${name}`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    await client.end();
  }
}

async function status(database: string): Promise<void> {
  const client = new Client(connectionConfig('owner', database));
  await client.connect();
  try {
    await ensureLedger(client);
    const done = await applied(client);
    for (const m of loadMigrations()) {
      const rec = done.get(m.version);
      const state = !rec ? 'PENDING ' : rec.checksum === m.checksum ? 'applied ' : 'MODIFIED';
      console.log(`${state}  ${m.file}`);
    }
  } finally {
    await client.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cmd = process.argv[2] ?? 'up';
  const database = targetDatabase();
  const run = cmd === 'up' ? migrateUp(database) : cmd === 'down' ? migrateDown(database) : status(database);
  Promise.resolve(run).catch((err) => { console.error(err.message ?? err); process.exit(1); });
}
