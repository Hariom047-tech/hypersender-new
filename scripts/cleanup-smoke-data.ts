/**
 * DEVELOPMENT-ONLY removal of disposable smoke-test tenants.
 *
 *   npx tsx scripts/cleanup-smoke-data.ts          # dry run: shows what WOULD be deleted
 *   npx tsx scripts/cleanup-smoke-data.ts --yes    # actually purge
 *
 * Safety rails:
 *  - refuses NODE_ENV=production;
 *  - targets ONLY organizations whose slug matches the smoke-test conventions
 *    used by our manual runs: ^(smoke|live)-[0-9]{9,}$  (e.g. smoke-1790558290);
 *  - no parameters to widen the match - this is deliberately NOT a generic
 *    tenant-deletion tool;
 *  - uses the audited app_admin.purge_organization_data() procedure (keeps the
 *    tombstone + financial/audit rows) and deletes only the smoke users that no
 *    longer belong to any organization.
 */
import 'dotenv/config';
import { Client } from 'pg';
import { connectionConfig, targetDatabase } from './lib/config.js';

const SLUG_RE = '^(smoke|live)-[0-9]{9,}$';
const EMAIL_RE = '^(smoke|live)[0-9]{9,}@example\\.test$';

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') throw new Error('refusing to run with NODE_ENV=production');
  const db = targetDatabase();
  const yes = process.argv.includes('--yes');
  const c = new Client(connectionConfig('owner', db));
  await c.connect();
  try {
    const orgs = (await c.query(
      `SELECT o.id, o.slug, o.name, o.created_at,
              (SELECT count(*) FROM app.whatsapp_instances i WHERE i.organization_id = o.id) AS instances,
              (SELECT count(*) FROM app.messages m WHERE m.organization_id = o.id) AS messages,
              (SELECT count(*) FROM app.organization_members m WHERE m.organization_id = o.id) AS members
         FROM app.organizations o WHERE o.slug ~ $1 ORDER BY o.created_at`, [SLUG_RE])).rows;
    const users = (await c.query(`SELECT id, email FROM app.users WHERE email_normalized ~ $1 ORDER BY created_at`, [EMAIL_RE])).rows;

    console.log(`database: ${db}`);
    console.log(`organizations matching /${SLUG_RE}/: ${orgs.length}`);
    for (const o of orgs) console.log(`  - ${o.slug}  "${o.name}"  created ${o.created_at.toISOString()}  instances=${o.instances} messages=${o.messages} members=${o.members}`);
    console.log(`users matching /${EMAIL_RE}/: ${users.length}`);
    for (const u of users) console.log(`  - ${u.email}`);

    if (!yes) {
      console.log('\nDry run only. Re-run with --yes to purge the organizations above.');
      return;
    }
    for (const o of orgs) {
      await c.query('BEGIN');
      try {
        // Stop any live session first: destroy auth material, then purge.
        await c.query(`UPDATE app.organizations SET deleted_at = coalesce(deleted_at, now()), status = 'CANCELLED' WHERE id = $1`, [o.id]);
        await c.query('SELECT app_admin.purge_organization_data($1)', [o.id]);
        await c.query('COMMIT');
        console.log(`purged ${o.slug}`);
      } catch (err) {
        await c.query('ROLLBACK');
        console.error(`failed to purge ${o.slug}: ${(err as Error).message}`);
      }
    }
    const del = await c.query(
      `DELETE FROM app.users u WHERE u.email_normalized ~ $1
          AND NOT EXISTS (SELECT 1 FROM app.organization_members m WHERE m.user_id = u.id) RETURNING email`, [EMAIL_RE]);
    console.log(`deleted ${del.rowCount} smoke user(s)`);
  } finally {
    await c.end();
  }
}

main().catch((err) => { console.error(err.message ?? err); process.exit(1); });
