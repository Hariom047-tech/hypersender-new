import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { connectionConfig } from '../scripts/lib/config.js';
import { uuidv7 } from '../src/common/uuid.js';
import { createPool } from '../src/database/pools.js';
import { TransactionRunner } from '../src/database/transaction-runner.js';
import { AiRepository } from '../src/repositories/ai.repository.js';
import { BookingRepository } from '../src/repositories/booking.repository.js';
import { IdentityRepository } from '../src/repositories/identity.repository.js';
import { KnowledgeRepository } from '../src/repositories/knowledge.repository.js';
import { MessagingRepository } from '../src/repositories/messaging.repository.js';
import { OpsRepository } from '../src/repositories/ops.repository.js';
import { WebhookRepository } from '../src/repositories/webhook.repository.js';
import { WhatsAppRepository } from '../src/repositories/whatsapp.repository.js';
import { LocalKeyProvider } from '../src/security/crypto/key-provider.js';
import { AiResponseService } from '../src/services/ai-response.service.js';
import { ApiKeyService } from '../src/services/api-key.service.js';
import { BookingService } from '../src/services/booking.service.js';
import { MessageIngestionService } from '../src/services/message-ingestion.service.js';
import { OnboardingService } from '../src/services/onboarding.service.js';
import { OutboundMessageService } from '../src/services/outbound-message.service.js';
import { OutboxRelayService } from '../src/services/outbox-relay.service.js';
import { WebhookService } from '../src/services/webhook.service.js';

process.env.PASSWORD_SCRYPT_LOG_N = '12'; // fast hashing in tests only

export const TEST_DB = process.env.TEST_DB_NAME ?? 'hypersender_test';

export function makeHarness() {
  const owner = new Pool({ ...connectionConfig('owner', TEST_DB), max: 5 });
  const appPool = createPool('app', { database: TEST_DB, max: 15 });
  const workerPool = createPool('worker', { database: TEST_DB, max: 15 });
  const appTx = new TransactionRunner(appPool);
  const workerTx = new TransactionRunner(workerPool);
  const keys = new LocalKeyProvider(process.env.LOCAL_MASTER_KEY_BASE64!);
  const repos = {
    identity: new IdentityRepository(), whatsapp: new WhatsAppRepository(), messaging: new MessagingRepository(),
    ops: new OpsRepository(), webhooks: new WebhookRepository(), ai: new AiRepository(), bookings: new BookingRepository(),
    knowledge: new KnowledgeRepository(),
  };
  const outboundWorker = new OutboundMessageService(workerTx, repos.messaging, repos.ops);
  const services = {
    onboarding: new OnboardingService(appTx, repos.identity, repos.ops),
    apiKeys: new ApiKeyService(appTx, repos.ops, keys),
    ingestion: new MessageIngestionService(workerTx, repos.messaging, repos.ops),
    outboundApp: new OutboundMessageService(appTx, repos.messaging, repos.ops),
    outboundWorker,
    bookingsApp: new BookingService(appTx, repos.bookings, repos.ops),
    bookingsWorker: new BookingService(workerTx, repos.bookings, repos.ops),
    ai: new AiResponseService(workerTx, repos.ai, outboundWorker, repos.ops),
    webhooksApp: new WebhookService(appTx, repos.webhooks, repos.ops, keys),
    webhooksWorker: new WebhookService(workerTx, repos.webhooks, repos.ops, keys),
    relay: new OutboxRelayService(workerTx, repos.ops),
  };
  return {
    owner, appPool, workerPool, appTx, workerTx, keys, repos, services,
    async close() { await Promise.all([owner.end(), appPool.end(), workerPool.end()]); },
  };
}
export type Harness = ReturnType<typeof makeHarness>;

export interface Tenant {
  label: string;
  orgId: string;
  userId: string;
  businessId: string;
  instanceId: string;
  instanceJid: string;
  instancePhone: string;
  contactId: string;
  contactJid: string;
  conversationId: string;
  serviceId: string;
  resourceId: string;
  agentId: string;
  inboundMessageId: string;
  knowledgeSourceId: string;
}

function phone(): string {
  return `+9199${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
}

/**
 * Fixture tenants run on the GROWTH plan (API access, 5 instances, 20 webhooks).
 * Tests that exercise plan limits switch plans explicitly (see setPlan).
 */
export async function setPlan(h: Harness, orgId: string, planCode: string): Promise<void> {
  await h.owner.query(`UPDATE app.subscriptions SET plan_id = (SELECT id FROM app.subscription_plans WHERE code = $2) WHERE organization_id = $1`, [orgId, planCode]);
}

/**
 * Builds a complete tenant (org -> business -> instance -> contact ->
 * conversation -> message, booking catalog, AI agent, knowledge) using the
 * OWNER role - fixtures only; every assertion runs as hs_app / hs_worker.
 */
export async function seedTenant(h: Harness, label: string): Promise<Tenant> {
  const s = randomBytes(4).toString('hex');
  const t = {
    label, orgId: uuidv7(), userId: uuidv7(), businessId: uuidv7(), instanceId: uuidv7(), contactId: uuidv7(),
    conversationId: uuidv7(), serviceId: uuidv7(), resourceId: uuidv7(), agentId: uuidv7(), inboundMessageId: uuidv7(),
    knowledgeSourceId: uuidv7(), instancePhone: phone(),
  } as Tenant;
  t.instanceJid = `${t.instancePhone.slice(1)}@s.whatsapp.net`;
  const contactPhone = phone();
  t.contactJid = `${contactPhone.slice(1)}@s.whatsapp.net`;

  const c = await h.owner.connect();
  try {
    await c.query('BEGIN');
    await c.query(`INSERT INTO app.users (id, email, password_hash, first_name) VALUES ($1, $2, '$scrypt$ln=12,r=8,p=1$x$y', $3)`,
      [t.userId, `${label}-${s}@example.test`, label]);
    await c.query(`INSERT INTO app.organizations (id, name, slug, created_by_user_id) VALUES ($1, $2, $3, $4)`,
      [t.orgId, `${label} org`, `${label}-${s}`, t.userId]);
    await c.query(`INSERT INTO app.organization_members (organization_id, user_id, role, status, joined_at) VALUES ($1, $2, 'OWNER', 'ACTIVE', now())`,
      [t.orgId, t.userId]);
    await c.query(`INSERT INTO app.businesses (id, organization_id, name, timezone) VALUES ($1, $2, $3, 'Asia/Kolkata')`,
      [t.businessId, t.orgId, `${label} business`]);
    await c.query(
      `INSERT INTO app.whatsapp_instances (id, organization_id, business_id, instance_name, phone_e164, whatsapp_jid, status, connection_state)
       VALUES ($1, $2, $3, 'main', $4, $5, 'CONNECTED', 'OPEN')`, [t.instanceId, t.orgId, t.businessId, t.instancePhone, t.instanceJid]);
    await c.query(
      `INSERT INTO app.contacts (id, organization_id, business_id, whatsapp_jid, phone_e164, display_name) VALUES ($1, $2, $3, $4, $5, 'Customer')`,
      [t.contactId, t.orgId, t.businessId, t.contactJid, contactPhone]);
    await c.query(
      `INSERT INTO app.conversations (id, organization_id, business_id, whatsapp_instance_id, contact_id) VALUES ($1, $2, $3, $4, $5)`,
      [t.conversationId, t.orgId, t.businessId, t.instanceId, t.contactId]);
    await c.query(
      `INSERT INTO app.messages (id, organization_id, business_id, whatsapp_instance_id, conversation_id, contact_id, provider_message_id,
                                 direction, sender_jid, recipient_jid, message_type, text_body, provider_timestamp, status, from_me)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'INBOUND', $8, $9, 'TEXT', 'secret tenant message ' || $10, now(), 'RECEIVED', false)`,
      [t.inboundMessageId, t.orgId, t.businessId, t.instanceId, t.conversationId, t.contactId, `SEED${s}`, t.contactJid, t.instanceJid, label]);
    await c.query(`INSERT INTO app.services (id, organization_id, business_id, name, duration_minutes, price_minor_units, currency)
                   VALUES ($1, $2, $3, 'Consultation', 30, 50000, 'INR')`, [t.serviceId, t.orgId, t.businessId]);
    await c.query(`INSERT INTO app.business_resources (id, organization_id, business_id, resource_type, name) VALUES ($1, $2, $3, 'DOCTOR', 'Dr. Test')`,
      [t.resourceId, t.orgId, t.businessId]);
    await c.query(`INSERT INTO app.resource_services (organization_id, business_id, resource_id, service_id) VALUES ($1, $2, $3, $4)`,
      [t.orgId, t.businessId, t.resourceId, t.serviceId]);
    // Open every day, all day (tests pick arbitrary slots).
    await c.query(
      `INSERT INTO app.availability_rules (organization_id, business_id, resource_id, day_of_week, start_time, end_time, timezone)
       SELECT $1, $2, $3, d, '00:00', '24:00', 'Asia/Kolkata' FROM generate_series(1, 7) d`, [t.orgId, t.businessId, t.resourceId]);
    await c.query(
      `INSERT INTO app.ai_agents (id, organization_id, business_id, name, status, auto_reply_enabled, model_provider, model_name)
       VALUES ($1, $2, $3, 'Receptionist', 'ACTIVE', true, 'ANTHROPIC', 'claude-sonnet-5')`, [t.agentId, t.orgId, t.businessId]);
    await c.query(
      `INSERT INTO app.ai_agent_channels (organization_id, business_id, ai_agent_id, whatsapp_instance_id) VALUES ($1, $2, $3, $4)`,
      [t.orgId, t.businessId, t.agentId, t.instanceId]);
    await c.query(
      `INSERT INTO app.knowledge_sources (id, organization_id, business_id, type, title, status) VALUES ($1, $2, $3, 'FAQ', 'FAQ', 'READY')`,
      [t.knowledgeSourceId, t.orgId, t.businessId]);
    await c.query(
      `INSERT INTO app.knowledge_chunks (organization_id, business_id, knowledge_source_id, chunk_index, content, embedding, embedding_model, embedding_dimensions)
       VALUES ($1, $2, $3, 0, $4, '[1,0,0]', 'test-3d', 3)`, [t.orgId, t.businessId, t.knowledgeSourceId, `${label} private knowledge`]);
    await c.query(
      `INSERT INTO app.subscriptions (organization_id, plan_id, provider, status, current_period_start, current_period_end, trial_end)
       SELECT $1, id, 'NONE', 'TRIALING', now(), now() + interval '14 days', now() + interval '14 days' FROM app.subscription_plans WHERE code = 'GROWTH'`,
      [t.orgId]);
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
  return t;
}

/** hs_app context of the tenant's OWNER user. */
export const asUser = (t: Tenant) => ({ organizationId: t.orgId, userId: t.userId });
/** hs_worker context for the tenant. */
export const asWorker = (t: Tenant) => ({ organizationId: t.orgId });

export async function registerWorker(h: Harness, hostname: string): Promise<string> {
  const r = await h.workerTx.run({}, (db) => db.query(
    `INSERT INTO app.whatsapp_workers (hostname, status) VALUES ($1, 'ACTIVE') RETURNING id`, [hostname]));
  return r.rows[0].id;
}

/** Captures the SQLSTATE of a rejected promise ('' when it resolves). */
export async function sqlState(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return '';
  } catch (err) {
    return (err as { code?: string }).code ?? `non-pg: ${(err as Error).message}`;
  }
}

/** Every table in schema app that has an organization_id column. */
export async function tenantTables(h: Harness): Promise<string[]> {
  const r = await h.owner.query(
    `SELECT c.table_name FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = 'app' AND c.column_name = 'organization_id' ORDER BY 1`);
  return r.rows.map((x) => x.table_name);
}
