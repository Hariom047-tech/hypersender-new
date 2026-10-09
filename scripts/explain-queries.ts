/**
 * Query-plan evidence for the dashboard's hot queries, against the TEST database
 * only (refuses anything else). Loads a synthetic tenant (20k contacts /
 * conversations, 200k messages) plus a second "noise" tenant, then runs
 * EXPLAIN (ANALYZE, BUFFERS) as hs_app with RLS active.
 *   npx tsx scripts/explain-queries.ts --test
 */
import 'dotenv/config';
import { Client, Pool } from 'pg';
import { connectionConfig, targetDatabase } from './lib/config.js';
import { TransactionRunner } from '../src/database/transaction-runner.js';
import { CONVERSATION_VIEW_SQL, MESSAGE_VIEW_SQL } from '../src/api/views.js';

const db = targetDatabase();
if (!db.endsWith('_test')) throw new Error('explain-queries only runs against a *_test database');

async function seedVolume(owner: Client, label: string, contacts: number, msgsPerConv: number): Promise<{ org: string; user: string; biz: string; conv: string }> {
  const r = await owner.query(`
    WITH u AS (INSERT INTO app.users (email, password_hash) VALUES ($1 || '-' || gen_random_uuid() || '@example.test', '$scrypt$ln=12,r=8,p=1$x$y') RETURNING id),
         o AS (INSERT INTO app.organizations (name, slug, created_by_user_id) SELECT $1, $1 || '-' || substr(md5(random()::text), 1, 8), id FROM u RETURNING id),
         m AS (INSERT INTO app.organization_members (organization_id, user_id, role, status, joined_at) SELECT o.id, u.id, 'OWNER', 'ACTIVE', now() FROM o, u RETURNING 1),
         b AS (INSERT INTO app.businesses (organization_id, name) SELECT id, 'Biz' FROM o RETURNING id, organization_id),
         i AS (INSERT INTO app.whatsapp_instances (organization_id, business_id, instance_name, status) SELECT organization_id, id, 'main', 'CONNECTED' FROM b RETURNING id, organization_id, business_id)
    SELECT i.id AS inst, i.organization_id AS org, i.business_id AS biz, (SELECT id FROM u) AS usr FROM i`, [label]);
  const { inst, org, biz, usr } = r.rows[0];
  await owner.query(`
    INSERT INTO app.contacts (organization_id, business_id, whatsapp_jid, phone_e164, display_name, first_seen_at, last_seen_at)
    SELECT $1, $2, (919000000000 + g)::text || '@s.whatsapp.net', '+' || (919000000000 + g)::text, 'Customer ' || g, now() - interval '400 days', now() - (g || ' minutes')::interval
      FROM generate_series(1, $3) g`, [org, biz, contacts]);
  await owner.query(`
    INSERT INTO app.conversations (organization_id, business_id, whatsapp_instance_id, contact_id, last_message_at, unread_count, status)
    SELECT organization_id, business_id, $3, id, last_seen_at, (random() * 3)::int, CASE WHEN random() < 0.8 THEN 'OPEN' ELSE 'RESOLVED' END
      FROM app.contacts WHERE organization_id = $1 AND business_id = $2`, [org, biz, inst]);
  await owner.query(`
    INSERT INTO app.messages (id, organization_id, business_id, whatsapp_instance_id, conversation_id, contact_id, provider_message_id, direction,
                              sender_jid, recipient_jid, message_type, text_body, provider_timestamp, status, from_me)
    SELECT app.uuid_generate_v7(), c.organization_id, c.business_id, c.whatsapp_instance_id, c.id, c.contact_id, md5(c.id::text || g), 'INBOUND',
           'x@s.whatsapp.net', 'y@s.whatsapp.net', 'TEXT', 'message ' || g, c.last_message_at - (g || ' seconds')::interval, 'RECEIVED', false
      FROM app.conversations c, generate_series(1, $2) g WHERE c.organization_id = $1`, [org, msgsPerConv]);
  const conv = (await owner.query(`SELECT id FROM app.conversations WHERE organization_id = $1 ORDER BY last_message_at DESC LIMIT 1`, [org])).rows[0].id;
  return { org, user: usr, biz, conv };
}

async function main(): Promise<void> {
  const owner = new Client(connectionConfig('owner', db));
  await owner.connect();
  console.log('seeding volume (target tenant 20k contacts x 10 msgs, noise tenant 20k x 2)...');
  const t = await seedVolume(owner, 'perf', 20_000, 10);
  await seedVolume(owner, 'noise', 20_000, 2);
  await owner.query('ANALYZE');
  await owner.end();

  const pool = new Pool({ ...connectionConfig('app', db), max: 2 });
  const tx = new TransactionRunner(pool);
  const ctx = { organizationId: t.org, userId: t.user };
  const plans: Record<string, [string, unknown[]]> = {
    'inbox (open, newest first, 30)': [`WITH page AS (SELECT c.id FROM app.conversations c WHERE c.organization_id = app.current_org_id()
       AND c.status IN ('OPEN','WAITING') ORDER BY c.last_message_at DESC, c.id DESC LIMIT 31)
       ${CONVERSATION_VIEW_SQL} JOIN page ON page.id = c.id ORDER BY c.last_message_at DESC, c.id DESC`, []],
    'inbox unread filter': [`WITH page AS (SELECT c.id FROM app.conversations c WHERE c.organization_id = app.current_org_id()
       AND c.status IN ('OPEN','WAITING') AND c.unread_count > 0 ORDER BY c.last_message_at DESC, c.id DESC LIMIT 31)
       ${CONVERSATION_VIEW_SQL} JOIN page ON page.id = c.id ORDER BY c.last_message_at DESC, c.id DESC`, []],
    'inbox all': [`WITH page AS (SELECT c.id FROM app.conversations c WHERE c.organization_id = app.current_org_id()
       ORDER BY c.last_message_at DESC, c.id DESC LIMIT 31)
       ${CONVERSATION_VIEW_SQL} JOIN page ON page.id = c.id ORDER BY c.last_message_at DESC, c.id DESC`, []],
    'message history page (40)': [`${MESSAGE_VIEW_SQL} WHERE m.conversation_id = $1 ORDER BY m.message_timestamp DESC, m.id DESC LIMIT 41`, [t.conv]],
    'contact search (name/phone)': [`SELECT id FROM app.contacts ct WHERE ct.deleted_at IS NULL AND (ct.display_name ILIKE $1 OR ct.profile_name ILIKE $1 OR ct.phone_e164 LIKE $1)
       ORDER BY ct.last_seen_at DESC, ct.id DESC LIMIT 31`, ['%1234%']],
    'contacts list (newest seen)': [`SELECT id FROM app.contacts ct WHERE ct.deleted_at IS NULL ORDER BY ct.last_seen_at DESC, ct.id DESC LIMIT 31`, []],
    'instance list': [`SELECT id FROM app.whatsapp_instances WHERE deleted_at IS NULL ORDER BY created_at`, []],
  };
  for (const [name, [sql, params]] of Object.entries(plans)) {
    const out = await tx.inTenant(async (d) => (await d.query(`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) ${sql}`, params)).rows.map((r) => r['QUERY PLAN']), ctx);
    const exec = out.find((l: string) => l.startsWith('Execution Time'));
    const scans = out.filter((l: string) => /Scan/.test(l)).map((l: string) => l.trim().replace(/\s+\(actual.*$/, '')).slice(0, 6);
    console.log(`\n## ${name}: ${exec}\n  ${scans.join('\n  ')}`);
  }
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
