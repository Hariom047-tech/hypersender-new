import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '../src/common/uuid.js';
import { asUser, makeHarness, seedTenant, sqlState, type Harness, type Tenant } from './helpers.js';

let h: Harness;
let A: Tenant;
let B: Tenant;

beforeAll(async () => {
  h = makeHarness();
  A = await seedTenant(h, 'cons-a');
  B = await seedTenant(h, 'cons-b');
});
afterAll(async () => h.close());

describe('business-rule constraints', () => {
  it('one phone number cannot have two live instances in the same organization (but can in another org)', async () => {
    const dup = await sqlState(h.appTx.inTenant((db) => db.query(
      `INSERT INTO app.whatsapp_instances (organization_id, business_id, instance_name, phone_e164, status) VALUES ($1, $2, 'second', $3, 'CONNECTED')`,
      [A.orgId, A.businessId, A.instancePhone]), asUser(A)));
    expect(dup).toBe('23505');
    // Logged-out instance frees the number.
    const ok = await sqlState(h.appTx.inTenant((db) => db.query(
      `INSERT INTO app.whatsapp_instances (organization_id, business_id, instance_name, phone_e164, status) VALUES ($1, $2, 'old', $3, 'LOGGED_OUT')`,
      [A.orgId, A.businessId, A.instancePhone]), asUser(A)));
    expect(ok).toBe('');
  });

  it('two primary auto-reply agents cannot be attached to the same WhatsApp instance', async () => {
    const agent2 = uuidv7();
    await h.appTx.inTenant(async (db) => {
      await db.query(`INSERT INTO app.ai_agents (id, organization_id, business_id, name, model_provider, model_name)
                      VALUES ($1, $2, $3, 'Second', 'OPENAI', 'some-model')`, [agent2, A.orgId, A.businessId]);
    }, asUser(A));
    const state = await sqlState(h.appTx.inTenant((db) => db.query(
      `INSERT INTO app.ai_agent_channels (organization_id, business_id, ai_agent_id, whatsapp_instance_id, is_primary, enabled)
       VALUES ($1, $2, $3, $4, true, true)`, [A.orgId, A.businessId, agent2, A.instanceId]), asUser(A)));
    expect(state).toBe('23505');
    // As a non-primary (e.g. draft/testing) channel it is allowed.
    const ok = await sqlState(h.appTx.inTenant((db) => db.query(
      `INSERT INTO app.ai_agent_channels (organization_id, business_id, ai_agent_id, whatsapp_instance_id, is_primary, enabled)
       VALUES ($1, $2, $3, $4, false, true)`, [A.orgId, A.businessId, agent2, A.instanceId]), asUser(A)));
    expect(ok).toBe('');
  });

  it('format/enum CHECKs reject bad data', async () => {
    const bad = (sql: string, params: unknown[]) => sqlState(h.appTx.inTenant((db) => db.query(sql, params), asUser(A)));
    expect(await bad(`INSERT INTO app.contacts (organization_id, business_id, whatsapp_jid, phone_e164) VALUES ($1, $2, '1@s.whatsapp.net', '98765')`, [A.orgId, A.businessId])).toBe('23514');
    expect(await bad(`INSERT INTO app.services (organization_id, business_id, name, currency, price_minor_units) VALUES ($1, $2, 'x', 'rupees', 100)`, [A.orgId, A.businessId])).toBe('23514');
    expect(await bad(`INSERT INTO app.services (organization_id, business_id, name, currency, price_minor_units) VALUES ($1, $2, 'x', 'INR', -1)`, [A.orgId, A.businessId])).toBe('23514');
    expect(await bad(`UPDATE app.conversations SET status = 'ARCHIVED' WHERE id = $1`, [A.conversationId])).toBe('23514');
    expect(await bad(`INSERT INTO app.businesses (organization_id, name, timezone) VALUES ($1, 'x', 'Mars/Olympus')`, [A.orgId])).toBe('23514');
    expect(await bad(`INSERT INTO app.webhook_endpoints (organization_id, name, url, secret_ciphertext, secret_wrapped_key, secret_key_reference)
                      VALUES ($1, 'x', 'http://insecure.example', decode(repeat('00', 40), 'hex'), decode(repeat('00', 40), 'hex'), 'k')`, [A.orgId])).toBe('23514');
  });

  it('an organization always keeps an active OWNER', async () => {
    const state = await sqlState(h.appTx.inTenant((db) => db.query(
      `UPDATE app.organization_members SET role = 'ADMIN' WHERE organization_id = $1 AND user_id = $2`, [A.orgId, A.userId]), asUser(A)));
    expect(state).toBe('23514');
  });

  it('immutable ledgers cannot be edited by runtime roles', async () => {
    expect(await sqlState(h.appTx.inTenant((db) => db.query(`UPDATE app.usage_events SET quantity = 0`), asUser(A)))).toBe('42501');
    expect(await sqlState(h.appTx.inTenant((db) => db.query(`DELETE FROM app.audit_logs`), asUser(A)))).toBe('42501');
    expect(await sqlState(h.workerTx.inTenant((db) => db.query(`DELETE FROM app.invoices`), { organizationId: A.orgId }))).toBe('42501');
  });

  it('retention policy is unique per (org, business|NULL, category) and enforces platform floors', async () => {
    const ins = (days: number) => h.appTx.inTenant((db) => db.query(
      `INSERT INTO app.data_retention_policies (organization_id, data_category, retention_days) VALUES ($1, 'MESSAGES', $2)`, [A.orgId, days]), asUser(A));
    expect(await sqlState(ins(90))).toBe('');
    expect(await sqlState(ins(30))).toBe('23505'); // NULLS NOT DISTINCT
    expect(await sqlState(h.appTx.inTenant((db) => db.query(
      `INSERT INTO app.data_retention_policies (organization_id, data_category, retention_days) VALUES ($1, 'AUDIT_LOGS', 30)`, [A.orgId]), asUser(A)))).toBe('23514');
  });
});

describe('privacy & deletion procedures', () => {
  it('anonymize_contact strips PII from contact, messages and bookings', async () => {
    await h.appTx.inTenant((db) => db.query('SELECT app.anonymize_contact($1)', [A.contactId]), asUser(A));
    const c = await h.owner.query('SELECT phone_e164, display_name, status, whatsapp_jid FROM app.contacts WHERE id = $1', [A.contactId]);
    expect(c.rows[0]).toMatchObject({ phone_e164: null, display_name: null, status: 'ANONYMIZED' });
    expect(c.rows[0].whatsapp_jid).toMatch(/@anonymized\.invalid$/);
    const m = await h.owner.query('SELECT text_body FROM app.messages WHERE contact_id = $1', [A.contactId]);
    expect(m.rows.every((r) => r.text_body === null)).toBe(true);
  });

  it('purge_conversation deletes messages but keeps bookings', async () => {
    const n = await h.appTx.inTenant((db) => db.query('SELECT app.purge_conversation($1) AS n', [A.conversationId]), asUser(A));
    expect(n.rows[0].n).toBeGreaterThanOrEqual(1);
    expect((await h.owner.query('SELECT 1 FROM app.conversations WHERE id = $1', [A.conversationId])).rowCount).toBe(0);
  });

  it('organization purge destroys operational data + secrets and retains financial/audit records', async () => {
    const T = await seedTenant(h, 'purge');
    await h.services.apiKeys.create(asUser(T), { name: 'k', scopes: ['messages:read'] });
    await h.owner.query(`INSERT INTO app.whatsapp_auth_credentials (organization_id, instance_id, encrypted_credentials, wrapped_data_key, key_reference)
                         VALUES ($1, $2, decode(repeat('ab', 40), 'hex'), decode(repeat('cd', 40), 'hex'), 'local-dev:v1')`, [T.orgId, T.instanceId]);
    await h.owner.query(`INSERT INTO app.invoices (organization_id, provider, status, currency, subtotal_minor, total_minor, amount_paid_minor, paid_at)
                         VALUES ($1, 'MANUAL', 'PAID', 'INR', 100, 100, 100, now())`, [T.orgId]);

    // Purge refuses a live organization.
    expect(await sqlState(h.owner.query('SELECT app_admin.purge_organization_data($1)', [T.orgId]))).toBe('P0001');
    await h.owner.query('UPDATE app.organizations SET deleted_at = now() WHERE id = $1', [T.orgId]);
    await h.owner.query('SELECT app_admin.purge_organization_data($1)', [T.orgId]);

    const count = async (t: string) => (await h.owner.query(`SELECT count(*)::int AS n FROM app.${t} WHERE organization_id = $1`, [T.orgId])).rows[0].n;
    for (const t of ['whatsapp_auth_credentials', 'whatsapp_signal_keys', 'api_keys', 'messages', 'contacts', 'conversations', 'businesses',
                     'whatsapp_instances', 'knowledge_chunks', 'ai_agents', 'organization_members']) {
      expect(await count(t), t).toBe(0);
    }
    expect(await count('invoices')).toBe(1);
    expect(await count('subscriptions')).toBe(1);
    expect(await count('audit_logs')).toBeGreaterThanOrEqual(1);
    // Runtime roles cannot run the purge.
    expect(await sqlState(h.appTx.inTenant((db) => db.query('SELECT app_admin.purge_organization_data($1)', [B.orgId]), asUser(B)))).toBe('42501');
  });
});
