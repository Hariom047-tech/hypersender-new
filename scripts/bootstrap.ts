/**
 * One-time (idempotent) environment bootstrap, run with SUPERUSER credentials:
 *   1. create/refresh the three roles (hs_owner / hs_app / hs_worker)
 *   2. create the database owned by hs_owner
 *   3. install extensions and lock down default privileges
 *
 *   npm run db:bootstrap            # development database
 *   npm run db:bootstrap -- --test  # test database
 *   ... -- --test --recreate        # DROP + recreate (refused unless the name ends in _test)
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from 'pg';
import { connectionConfig, env, targetDatabase } from './lib/config.js';
import { renderSql } from './lib/sql-template.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const BOOTSTRAP_DIR = join(ROOT, 'db', 'bootstrap');

export async function bootstrap(database: string, opts: { recreate?: boolean } = {}): Promise<void> {
  const admin = new Client(connectionConfig('superuser', 'postgres'));
  await admin.connect();
  try {
    const rolesSql = renderSql(readFileSync(join(BOOTSTRAP_DIR, 'bootstrap.sql'), 'utf8'), {
      owner_password: env('DB_OWNER_PASSWORD'),
      app_password: env('DB_APP_PASSWORD'),
      worker_password: env('DB_WORKER_PASSWORD'),
    }, admin);
    await admin.query(rolesSql);

    if (opts.recreate) {
      if (!database.endsWith('_test')) throw new Error(`Refusing to drop non-test database "${database}"`);
      await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(database)} WITH (FORCE)`);
    }
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    if (exists.rowCount === 0) {
      await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(database)} OWNER hs_owner ENCODING 'UTF8' TEMPLATE template0`);
    }
  } finally {
    await admin.end();
  }

  const db = new Client(connectionConfig('superuser', database));
  await db.connect();
  try {
    await db.query(renderSql(readFileSync(join(BOOTSTRAP_DIR, 'database.sql'), 'utf8'), { db_name: database }, db));
  } finally {
    await db.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const database = targetDatabase();
  bootstrap(database, { recreate: process.argv.includes('--recreate') })
    .then(() => console.log(`bootstrap complete for database "${database}"`))
    .catch((err) => { console.error(err); process.exit(1); });
}
