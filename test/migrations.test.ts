import 'dotenv/config';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrap } from '../scripts/bootstrap.js';
import { connectionConfig } from '../scripts/lib/config.js';
import { readdirSync } from 'node:fs';
import { migrateDown, migrateUp } from '../scripts/migrate.js';

const DB = 'hypersender_migrations_test';
const MIGRATIONS = readdirSync(new URL('../db/migrations/', import.meta.url)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).length;
let owner: Client;

beforeAll(async () => {
  await bootstrap(DB, { recreate: true });
  owner = new Client(connectionConfig('owner', DB));
  await owner.connect();
});
afterAll(async () => owner.end());

const tableCount = async () =>
  (await owner.query(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'app'`)).rows[0].n;

describe('migration pipeline', () => {
  it('applies every migration on an empty database and is idempotent', async () => {
    expect(await migrateUp(DB, () => undefined)).toBe(MIGRATIONS);
    expect(await tableCount()).toBe(88); // 49 (Phases 1-3) + 8 (0018 AI assistants) + 18 (0020 ordering) + 7 (0021 havan) + 2 (0022 calendar) + 3 (0025 marketing) + 1 (0026 OTP)
    expect(await migrateUp(DB, () => undefined)).toBe(0);
  });

  it('refuses to run when an applied migration was modified', async () => {
    await owner.query(`UPDATE public.schema_migrations SET checksum = 'tampered' WHERE version = '0003'`);
    await expect(migrateUp(DB, () => undefined)).rejects.toThrow(/modified after being applied/);
  });

  it('rolls every migration back in reverse order and re-applies cleanly', async () => {
    // Undo the tampering from the previous test by restoring the file's real checksum.
    const { createHash } = await import('node:crypto');
    const { readFileSync } = await import('node:fs');
    const sql = readFileSync(new URL('../db/migrations/0003_whatsapp.sql', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    await owner.query(`UPDATE public.schema_migrations SET checksum = $1 WHERE version = '0003'`, [createHash('sha256').update(sql).digest('hex')]);

    for (let i = 0; i < MIGRATIONS; i++) await migrateDown(DB, () => undefined);
    expect(await tableCount()).toBe(0);
    expect((await owner.query('SELECT count(*)::int AS n FROM public.schema_migrations')).rows[0].n).toBe(0);
    expect(await migrateUp(DB, () => undefined)).toBe(MIGRATIONS);
    expect(await tableCount()).toBe(88); // 49 (Phases 1-3) + 8 (0018 AI assistants) + 18 (0020 ordering) + 7 (0021 havan) + 2 (0022 calendar) + 3 (0025 marketing) + 1 (0026 OTP)
  });
});
