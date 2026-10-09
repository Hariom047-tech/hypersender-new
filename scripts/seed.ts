/**
 * Applies idempotent PLATFORM seed data (plans, entitlements, lookup types,
 * AI tool catalog, AI assistant templates) as hs_owner.
 * Never seeds tenant/customer data or secrets.
 *   npm run db:seed [-- --test]
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from 'pg';
import { connectionConfig, targetDatabase } from './lib/config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const SEEDS_DIR = join(ROOT, 'db', 'seeds');

export async function seed(database: string, log: (m: string) => void = console.log): Promise<void> {
  const client = new Client(connectionConfig('owner', database));
  await client.connect();
  try {
    await client.query('BEGIN');
    for (const file of readdirSync(SEEDS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
      log(`seeding ${file}`);
      await client.query(readFileSync(join(SEEDS_DIR, file), 'utf8'));
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  seed(targetDatabase()).catch((err) => { console.error(err); process.exit(1); });
}
