/**
 * Copies the latest HAVAN_BOOKING template instructions into every installed
 * Havan Booking assistant and republishes the ones that were already live.
 * (Installing a template snapshots its prompt; this is the explicit upgrade.)
 *   npx tsx scripts/refresh-havan-assistants.ts
 */
import 'dotenv/config';
import { Client } from 'pg';
import { AssistantAdminService } from '../src/ai/admin/assistant-admin.service.js';
import { aiProvidersFromEnv } from '../src/ai/model/providers-from-env.js';
import { createPool } from '../src/database/pools.js';
import { TransactionRunner } from '../src/database/transaction-runner.js';
import { connectionConfig, targetDatabase } from './lib/config.js';

async function main(): Promise<void> {
  const owner = new Client(connectionConfig('owner', targetDatabase()));
  await owner.connect();
  const rows = (await owner.query(
    `UPDATE app.ai_agents a SET template_instructions = t.base_system_prompt
       FROM app.ai_assistant_templates t
      WHERE a.template_key = 'HAVAN_BOOKING' AND t.key = 'HAVAN_BOOKING' AND t.status = 'ACTIVE' AND a.deleted_at IS NULL
      RETURNING a.id, a.name, a.organization_id, a.published_version_id IS NOT NULL AS live,
                (SELECT m.user_id FROM app.organization_members m WHERE m.organization_id = a.organization_id AND m.status = 'ACTIVE' AND m.role = 'OWNER' LIMIT 1) AS owner_user`)).rows;
  await owner.end();
  const pool = createPool('app');
  const admin = new AssistantAdminService(new TransactionRunner(pool), aiProvidersFromEnv().models);
  for (const r of rows) {
    if (!r.live) { console.log(`updated (draft): ${r.name}`); continue; }
    const res = await admin.publish({ organizationId: r.organization_id, userId: r.owner_user, role: 'OWNER' }, r.id);
    console.log(`updated + ${res.published ? `published v${res.version}` : 'NOT published (see readiness in the dashboard)'}: ${r.name}`);
  }
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
