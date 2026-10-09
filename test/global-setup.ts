import 'dotenv/config';
import { bootstrap } from '../scripts/bootstrap.js';
import { migrateUp } from '../scripts/migrate.js';
import { seed } from '../scripts/seed.js';

/**
 * Creates a fresh, isolated test database (name must end in _test - the
 * bootstrap refuses to drop anything else), then runs the REAL migration
 * pipeline and seeds exactly as production would.
 */
export default async function setup(): Promise<void> {
  const db = process.env.TEST_DB_NAME ?? 'hypersender_test';
  await bootstrap(db, { recreate: true });
  await migrateUp(db, () => undefined);
  await seed(db, () => undefined);
}
