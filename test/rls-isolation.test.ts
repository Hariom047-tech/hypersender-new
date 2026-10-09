import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '../src/common/uuid.js';
import { asUser, asWorker, makeHarness, seedTenant, sqlState, tenantTables, type Harness, type Tenant } from './helpers.js';

let h: Harness;
let A: Tenant;
let B: Tenant;

beforeAll(async () => {
  h = makeHarness();
  A = await seedTenant(h, 'ayush');   // "Ayush Ventures / ABC Dental"
  B = await seedTenant(h, 'xyzsalon'); // "XYZ Salon"
});
afterAll(async () => h.close());

describe('database hardening (catalog checks)', () => {
  it('every tenant table has RLS ENABLED and FORCED, with policies for both runtime roles', async () => {
    const tables = await tenantTables(h);
    expect(tables.length).toBeGreaterThanOrEqual(38);
    const r = await h.owner.query(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
              (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'app' AND p.tablename = c.relname AND 'hs_app' = ANY(p.roles)) AS app_policies,
              (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'app' AND p.tablename = c.relname AND 'hs_worker' = ANY(p.roles)) AS worker_policies
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app' AND c.relname = ANY($1)`, [tables]);
    for (const row of r.rows) {
      expect({ t: row.relname, rls: row.relrowsecurity, force: row.relforcerowsecurity }).toEqual({ t: row.relname, rls: true, force: true });
      expect(Number(row.app_policies) + Number(row.worker_policies), row.relname).toBeGreaterThan(0);
    }
    // organizations (tenant root) and users are protected too.
    const extra = await h.owner.query(`SELECT relname FROM pg_class WHERE relnamespace = 'app'::regnamespace
                                         AND relname IN ('organizations','users') AND relrowsecurity AND relforcerowsecurity`);
    expect(extra.rowCount).toBe(2);
  });

  it('runtime roles cannot bypass RLS', async () => {
    const r = await h.owner.query(`SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles
                                    WHERE rolname IN ('hs_app','hs_worker')`);
    expect(r.rowCount).toBe(2);
    for (const row of r.rows) expect([row.rolsuper, row.rolbypassrls, row.rolcreaterole, row.rolcreatedb]).toEqual([false, false, false, false]);
    // Runtime roles own nothing (an owner could disable RLS on its tables).
    const owned = await h.owner.query(`SELECT count(*)::int AS n FROM pg_class WHERE relnamespace = 'app'::regnamespace
                                         AND pg_get_userbyid(relowner) IN ('hs_app','hs_worker')`);
    expect(owned.rows[0].n).toBe(0);
  });
});

describe('Tenant A cannot SELECT Tenant B data', () => {
  it('no tenant table leaks a single foreign row to hs_app', async () => {
    for (const table of await tenantTables(h)) {
      const state = await sqlState(h.appTx.inTenant(async (db) => {
        const r = await db.query(`SELECT count(*)::int AS n FROM app.${table} WHERE organization_id IS DISTINCT FROM $1`, [A.orgId]);
        expect(r.rows[0].n, `${table} leaked rows`).toBe(0);
      }, asUser(A)));
      // '' = query ran and saw nothing foreign; 42501 = role has no SELECT at all (e.g. outbox_events) - also fine.
      expect(['', '42501'], `${table}: ${state}`).toContain(state);
    }
  });

  it('direct lookups by Tenant B primary keys return nothing', async () => {
    await h.appTx.inTenant(async (db) => {
      const probes: Array<[string, string]> = [
        ['businesses', B.businessId], ['whatsapp_instances', B.instanceId], ['contacts', B.contactId],
        ['conversations', B.conversationId], ['messages', B.inboundMessageId], ['ai_agents', B.agentId],
        ['business_resources', B.resourceId], ['services', B.serviceId], ['knowledge_sources', B.knowledgeSourceId],
      ];
      for (const [table, id] of probes) {
        const r = await db.query(`SELECT id FROM app.${table} WHERE id = $1`, [id]);
        expect(r.rowCount, table).toBe(0);
      }
      const org = await db.query('SELECT id FROM app.organizations WHERE id = $1', [B.orgId]);
      expect(org.rowCount).toBe(0);
      const own = await db.query('SELECT text_body FROM app.messages WHERE id = $1', [A.inboundMessageId]);
      expect(own.rowCount).toBe(1); // sanity: A sees its own data
    }, asUser(A));
  });

  it('hs_app cannot see Tenant B user profiles, and nobody can read password hashes', async () => {
    await h.appTx.inTenant(async (db) => {
      expect((await db.query('SELECT id FROM app.users WHERE id = $1', [B.userId])).rowCount).toBe(0);
    }, asUser(A));
    expect(await sqlState(h.appTx.inTenant((db) => db.query('SELECT password_hash FROM app.users'), asUser(A)))).toBe('42501');
  });

  it('knowledge retrieval never returns another tenant\'s embeddings, even when asked for them', async () => {
    const own = await h.workerTx.inTenant((db) => h.repos.knowledge.search(db, {
      organizationId: A.orgId, businessId: A.businessId, aiAgentId: A.agentId, embedding: [1, 0, 0], embeddingModel: 'test-3d' }), asWorker(A));
    expect(own.map((c) => c.content)).toEqual(['ayush private knowledge']);
    const foreign = await h.workerTx.inTenant((db) => h.repos.knowledge.search(db, {
      organizationId: B.orgId, businessId: B.businessId, aiAgentId: B.agentId, embedding: [1, 0, 0], embeddingModel: 'test-3d' }), asWorker(A));
    expect(foreign).toEqual([]);
  });

  it('worker in Tenant A context cannot read Tenant B messages; with no context it reads no tenant data', async () => {
    await h.workerTx.inTenant(async (db) => {
      expect((await db.query('SELECT 1 FROM app.messages WHERE id = $1', [B.inboundMessageId])).rowCount).toBe(0);
    }, asWorker(A));
    await h.workerTx.run({}, async (db) => {
      for (const t of ['messages', 'contacts', 'conversations', 'bookings', 'whatsapp_auth_credentials', 'ai_agents']) {
        expect((await db.query(`SELECT count(*)::int AS n FROM app.${t}`)).rows[0].n, t).toBe(0);
      }
    });
  });
});

describe('Tenant A cannot INSERT using Tenant B references', () => {
  it('rejects a row whose organization_id is Tenant B (RLS WITH CHECK)', async () => {
    const state = await sqlState(h.appTx.inTenant((db) => db.query(
      `INSERT INTO app.contacts (organization_id, business_id, whatsapp_jid) VALUES ($1, $2, '1@s.whatsapp.net')`,
      [B.orgId, B.businessId]), asUser(A)));
    expect(state).toBe('42501');
  });

  it('rejects Tenant B business_id under Tenant A organization_id (composite FK)', async () => {
    const state = await sqlState(h.appTx.inTenant((db) => db.query(
      `INSERT INTO app.whatsapp_instances (organization_id, business_id, instance_name) VALUES ($1, $2, 'stolen')`,
      [A.orgId, B.businessId]), asUser(A)));
    expect(state).toBe('23503');
  });

  it('cannot attach its AI agent to Tenant B WhatsApp instance', async () => {
    const state = await sqlState(h.appTx.inTenant((db) => db.query(
      `INSERT INTO app.ai_agent_channels (organization_id, business_id, ai_agent_id, whatsapp_instance_id, is_primary)
       VALUES ($1, $2, $3, $4, false)`, [A.orgId, A.businessId, A.agentId, B.instanceId]), asUser(A)));
    expect(state).toBe('23503');
  });

  it('cannot create a booking with Tenant B contact or resource', async () => {
    // Tomorrow 12:00 IST: a fixed local time, so the slot never crosses local midnight (the test used to fail 23:30-24:00 IST).
    const tomorrowIst = new Date(Date.now() + 86_400_000 + 5.5 * 3_600_000).toISOString().slice(0, 10);
    const start = new Date(`${tomorrowIst}T12:00:00+05:30`);
    const base = { businessId: A.businessId, bookingType: 'APPOINTMENT', startAt: start, endAt: new Date(+start + 1_800_000),
      timezone: 'Asia/Kolkata', customerName: 'Rahul', customerPhone: '+919812345678', source: 'DASHBOARD' as const,
      createdByType: 'USER' as const, createdByUserId: A.userId };
    // Valid resource/slot of A, but B's contact: only the composite FK can stop it.
    const withForeignContact = await h.services.bookingsApp.createBooking(asUser(A), { ...base, resourceId: A.resourceId, contactId: B.contactId });
    expect(withForeignContact).toEqual({ ok: false, reason: 'INVALID_REFERENCE' });
    const withForeignResource = await h.services.bookingsApp.createBooking(asUser(A), { ...base, contactId: A.contactId, resourceId: B.resourceId });
    expect(withForeignResource.ok).toBe(false);
    const n = await h.owner.query('SELECT count(*)::int AS n FROM app.bookings WHERE organization_id = $1', [A.orgId]);
    expect(n.rows[0].n).toBe(0);
  });

  it('cannot post a message into Tenant B conversation', async () => {
    await expect(h.services.outboundApp.enqueueText(asUser(A), { conversationId: B.conversationId, text: 'hi', idempotencyKey: uuidv7() }))
      .rejects.toThrow(/conversation not found/);
  });
});

describe('Tenant A cannot UPDATE or DELETE Tenant B data', () => {
  it('UPDATE of Tenant B rows affects 0 rows', async () => {
    const r = await h.appTx.inTenant((db) => db.query(`UPDATE app.contacts SET display_name = 'pwned' WHERE id = $1`, [B.contactId]), asUser(A));
    expect(r.rowCount).toBe(0);
    const r2 = await h.appTx.inTenant((db) => db.query(`UPDATE app.messages SET text_body = 'pwned' WHERE organization_id = $1`, [B.orgId]), asUser(A));
    expect(r2.rowCount).toBe(0);
    const check = await h.owner.query('SELECT display_name FROM app.contacts WHERE id = $1', [B.contactId]);
    expect(check.rows[0].display_name).toBe('Customer');
  });

  it('cannot move its own row into Tenant B', async () => {
    const state = await sqlState(h.appTx.inTenant((db) => db.query(
      'UPDATE app.contacts SET organization_id = $2 WHERE id = $1', [A.contactId, B.orgId]), asUser(A)));
    expect(state).toBe('42501');
  });

  it('DELETE of Tenant B rows affects 0 rows', async () => {
    const r = await h.appTx.inTenant((db) => db.query('DELETE FROM app.conversations WHERE id = $1', [B.conversationId]), asUser(A));
    expect(r.rowCount).toBe(0);
    const r2 = await h.appTx.inTenant((db) => db.query('DELETE FROM app.messages WHERE organization_id = $1', [B.orgId]), asUser(A));
    expect(r2.rowCount).toBe(0);
    expect((await h.owner.query('SELECT 1 FROM app.conversations WHERE id = $1', [B.conversationId])).rowCount).toBe(1);
  });

  it('privacy procedures cannot reach another tenant', async () => {
    const state = await sqlState(h.appTx.inTenant((db) => db.query('SELECT app.anonymize_contact($1)', [B.contactId]), asUser(A)));
    expect(state).toBe('P0002'); // no_data_found: invisible under RLS
    const s2 = await sqlState(h.appTx.inTenant((db) => db.query('SELECT app.destroy_whatsapp_auth($1)', [B.instanceId]), asUser(A)));
    expect(s2).toBe('P0002');
  });
});

describe('forged or missing tenant context (application bug simulation)', () => {
  it('user of A presenting organization B in the context sees and writes nothing', async () => {
    const forged = { organizationId: B.orgId, userId: A.userId };
    await h.appTx.inTenant(async (db) => {
      expect((await db.query('SELECT count(*)::int AS n FROM app.messages')).rows[0].n).toBe(0);
      expect((await db.query('SELECT count(*)::int AS n FROM app.contacts')).rows[0].n).toBe(0);
      expect((await db.query('SELECT count(*)::int AS n FROM app.organizations WHERE id = $1', [B.orgId])).rows[0].n).toBe(0);
    }, forged);
    const state = await sqlState(h.appTx.inTenant((db) => db.query(
      `INSERT INTO app.contacts (organization_id, business_id, whatsapp_jid) VALUES ($1, $2, '2@s.whatsapp.net')`, [B.orgId, B.businessId]), forged));
    expect(state).toBe('42501');
  });

  it('cannot join organization B by inserting a membership (privilege escalation)', async () => {
    const state = await sqlState(h.appTx.inTenant((db) => db.query(
      `INSERT INTO app.organization_members (organization_id, user_id, role, status, joined_at) VALUES ($1, $2, 'OWNER', 'ACTIVE', now())`,
      [B.orgId, A.userId]), { organizationId: B.orgId, userId: A.userId }));
    expect(state).toBe('42501');
  });

  it('a non-admin member cannot promote itself to OWNER', async () => {
    const agentUser = uuidv7();
    await h.owner.query(`INSERT INTO app.users (id, email) VALUES ($1, $2)`, [agentUser, `agent-${agentUser}@example.test`]);
    await h.owner.query(`INSERT INTO app.organization_members (organization_id, user_id, role, status, joined_at) VALUES ($1, $2, 'AGENT', 'ACTIVE', now())`,
      [A.orgId, agentUser]);
    const r = await h.appTx.inTenant((db) => db.query(
      `UPDATE app.organization_members SET role = 'OWNER' WHERE organization_id = $1 AND user_id = $2`, [A.orgId, agentUser]),
      { organizationId: A.orgId, userId: agentUser });
    expect(r.rowCount).toBe(0);
    const role = await h.owner.query('SELECT role FROM app.organization_members WHERE user_id = $1', [agentUser]);
    expect(role.rows[0].role).toBe('AGENT');
  });

  it('with no tenant context at all, hs_app sees zero tenant rows (default deny)', async () => {
    await h.appTx.run({}, async (db) => {
      for (const t of ['businesses', 'contacts', 'messages', 'bookings', 'api_keys', 'webhook_endpoints']) {
        expect((await db.query(`SELECT count(*)::int AS n FROM app.${t}`)).rows[0].n, t).toBe(0);
      }
    });
  });

  it('a malformed tenant id fails closed', async () => {
    await expect(h.appTx.run({ organizationId: "' OR 1=1 --" }, async () => undefined)).rejects.toThrow(/UUID/);
  });
});

describe('sign-up works end-to-end under RLS', () => {
  it('creates user + org + owner + trial in one transaction, and login verifies the hash', async () => {
    const email = `owner-${uuidv7()}@Example.test`;
    const { organizationId, userId } = await h.services.onboarding.signUp({
      email, password: 'correct horse battery staple', organizationName: 'Sharma Dental Clinic',
      organizationSlug: `sharma-${Date.now()}`, timezone: 'Asia/Kolkata' });
    const orgs = await h.appTx.run({ userId }, (db) => h.repos.identity.listMyOrganizations(db));
    expect(orgs.map((o) => o.id)).toEqual([organizationId]);
    expect(await h.services.onboarding.login(email.toUpperCase(), 'correct horse battery staple')).toBe(userId);
    expect(await h.services.onboarding.login(email, 'wrong password')).toBeNull();
    const ent = await h.appTx.inTenant((db) => db.query(`SELECT * FROM app.current_entitlement('MAX_WHATSAPP_INSTANCES')`),
      { organizationId, userId });
    expect(ent.rows[0]).toMatchObject({ enabled: true, limit_value: 1 });
  });

  it('the API role cannot grant itself a paid subscription', async () => {
    const state = await sqlState(h.appTx.inTenant((db) => db.query(
      `INSERT INTO app.subscriptions (organization_id, plan_id, provider, status, current_period_start, current_period_end)
       SELECT $1, id, 'MANUAL', 'ACTIVE', now(), now() + interval '1 year' FROM app.subscription_plans WHERE code = 'GROWTH'`, [A.orgId]), asUser(A)));
    expect(state).toBe('42501');
  });
});
