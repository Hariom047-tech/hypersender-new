import { Inject, Injectable } from '@nestjs/common';
import { uuidv7 } from '../common/uuid.js';
import type { TenantContext } from '../database/tenant-context.js';
import { APP_TX, TransactionRunner } from '../database/transaction-runner.js';
import { OpsRepository } from '../repositories/ops.repository.js';
import { generateApiKey, hashApiKey, looksLikeApiKey } from '../security/api-key-crypto.js';
import { aad, aesGcmDecrypt, aesGcmEncrypt } from '../security/crypto/aes-gcm.js';
import { KEY_PROVIDER, type KeyProvider } from '../security/crypto/key-provider.js';
import { WhatsAppError } from '../whatsapp/domain/whatsapp-errors.js';
import { EntitlementService } from './entitlement.service.js';

export type ApiScope = 'instances:read' | 'instances:write' | 'messages:send' | 'messages:read' | 'webhooks:manage'
  | 'contacts:read' | 'contacts:write' | 'bookings:read' | 'bookings:write';

/** What an instance key may do - always limited further to its own instance by the instance API. */
export const INSTANCE_KEY_SCOPES: ApiScope[] = ['instances:read', 'messages:send', 'messages:read'];

export interface InstanceKeyInfo { id: string; prefix: string; createdAt: string; lastUsedAt: string | null; recoverable: boolean }

function instanceKeyContext(organizationId: string, apiKeyId: string) {
  return { organization_id: organizationId, purpose: 'instance_api_key', resource_id: apiKeyId };
}

@Injectable()
export class ApiKeyService {
  private readonly entitlements = new EntitlementService();

  constructor(
    @Inject(APP_TX) private readonly tx: TransactionRunner,
    @Inject(OpsRepository) private readonly ops: OpsRepository,
    @Inject(KEY_PROVIDER) private readonly keys: KeyProvider,
  ) {}

  private get pepper(): string {
    const p = process.env.API_KEY_PEPPER;
    if (!p) throw new Error('API_KEY_PEPPER is not configured');
    return p;
  }

  /** Returns the plaintext key ONCE. Only prefix + HMAC are stored. */
  async create(ctx: TenantContext, input: { name: string; scopes: ApiScope[]; businessId?: string; expiresAt?: Date; environment?: 'live' | 'test' }): Promise<{ id: string; prefix: string; plaintext: string }> {
    const key = generateApiKey(input.environment ?? 'live');
    const id = uuidv7();
    await this.tx.inTenant(async (db) => {
      await this.entitlements.assertEnabled(db, 'API_ACCESS');
      await db.query(
        `INSERT INTO app.api_keys (id, organization_id, business_id, name, key_prefix, key_hash, scopes, expires_at, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, ctx.organizationId, input.businessId ?? null, input.name, key.prefix, hashApiKey(key.plaintext, this.pepper),
         input.scopes, input.expiresAt ?? null, ctx.userId ?? null]);
      await this.ops.audit(db, { organizationId: ctx.organizationId, actorType: 'USER', actorUserId: ctx.userId, action: 'API_KEY_CREATED',
        resourceType: 'API_KEY', resourceId: id, metadata: { name: input.name, prefix: key.prefix, scopes: input.scopes } });
    }, ctx);
    return { id, prefix: key.prefix, plaintext: key.plaintext };
  }

  /** Pre-tenant authentication. Returns the tenant context for a live key, else null. */
  async authenticate(plaintext: string): Promise<TenantContext | null> {
    if (!looksLikeApiKey(plaintext)) return null;
    const hash = hashApiKey(plaintext, this.pepper);
    const r = await this.tx.run({}, (db) => db.query(
      'SELECT api_key_id, organization_id, business_id, scopes, instance_id FROM app_auth.authenticate_api_key($1)', [hash]));
    const row = r.rows[0];
    if (!row) return null;
    const ctx: TenantContext = { organizationId: row.organization_id, apiKeyId: row.api_key_id, businessId: row.business_id ?? undefined, apiScopes: row.scopes,
      instanceId: row.instance_id ?? undefined };
    // Instance keys are the WhatsApp gateway itself (every plan, like the number they belong to). Organization keys need
    // API_ACCESS: a plan downgrade that removes it cuts off existing organization keys too.
    if (ctx.instanceId) return ctx;
    const allowed = await this.tx.inTenant(async (db) => (await this.entitlements.get(db, 'API_ACCESS'))?.enabled === true, ctx, { readOnly: true });
    return allowed ? ctx : null;
  }

  async list(ctx: TenantContext): Promise<Array<Record<string, unknown>>> {
    return this.tx.inTenant(async (db) => (await db.query(
      `SELECT id, name, key_prefix AS "prefix", scopes, business_id AS "businessId", created_at AS "createdAt", last_used_at AS "lastUsedAt",
              expires_at AS "expiresAt", revoked_at AS "revokedAt", instance_id AS "instanceId",
              CASE WHEN revoked_at IS NOT NULL THEN 'REVOKED' WHEN expires_at IS NOT NULL AND expires_at <= now() THEN 'EXPIRED' ELSE 'ACTIVE' END AS status
         FROM app.api_keys ORDER BY created_at DESC LIMIT 200`)).rows, ctx, { readOnly: true });
  }

  /**
   * Instance API key ("Api Key (Bearer Token)" on the instance page). Bound to one instance and usable only on
   * the instance + OTP API. Created automatically with the instance; "Generate new key" rotates it (the old key
   * stops working in the same transaction). Authentication uses the HMAC only; the plaintext is also kept
   * encrypted so owners/admins can copy it again (revealInstanceKey).
   */
  async createInstanceKey(ctx: TenantContext, instanceId: string, o: { rotate?: boolean } = { rotate: true }): Promise<InstanceKeyInfo & { plaintext: string } | null> {
    const key = generateApiKey('live');
    const id = uuidv7();
    const dek = await this.keys.generateDataKey(instanceKeyContext(ctx.organizationId, id));
    let ciphertext: Buffer;
    try {
      ciphertext = aesGcmEncrypt(dek.plaintext, Buffer.from(key.plaintext, 'utf8'), aad('instance-api-key', 'v1', ctx.organizationId, id));
    } finally {
      dek.plaintext.fill(0);
    }
    const row = await this.tx.inTenant(async (db) => {
      const inst = (await db.query('SELECT id, business_id, instance_name FROM app.whatsapp_instances WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [instanceId])).rows[0];
      if (!inst) throw new WhatsAppError('WHATSAPP_INSTANCE_NOT_FOUND');
      // The instance row lock serialises concurrent "ensure" calls: only one creates the key.
      if (!o.rotate && (await db.query('SELECT 1 FROM app.api_keys WHERE instance_id = $1 AND revoked_at IS NULL', [instanceId])).rows.length) return null;
      const old = await db.query(
        'UPDATE app.api_keys SET revoked_at = now(), revoked_by_user_id = $2 WHERE instance_id = $1 AND revoked_at IS NULL RETURNING id', [instanceId, ctx.userId ?? null]);
      const r = await db.query(
        `INSERT INTO app.api_keys (id, organization_id, business_id, instance_id, name, key_prefix, key_hash, scopes, created_by_user_id,
                                   secret_ciphertext, secret_wrapped_key, secret_key_reference)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING created_at`,
        [id, ctx.organizationId, inst.business_id, instanceId, `Instance: ${String(inst.instance_name).slice(0, 80)}`, key.prefix,
         hashApiKey(key.plaintext, this.pepper), INSTANCE_KEY_SCOPES, ctx.userId ?? null, ciphertext, dek.wrapped, dek.keyReference]);
      await this.ops.audit(db, { organizationId: ctx.organizationId, actorType: ctx.apiKeyId ? 'API_KEY' : 'USER', actorUserId: ctx.userId,
        actorApiKeyId: ctx.apiKeyId, action: 'API_KEY_CREATED', resourceType: 'API_KEY', resourceId: id,
        metadata: { prefix: key.prefix, instance_id: instanceId, rotated: old.rows.map((x) => x.id) } });
      return r.rows[0] as { created_at: Date };
    }, ctx);
    return row ? { id, prefix: key.prefix, plaintext: key.plaintext, createdAt: row.created_at.toISOString(), lastUsedAt: null, recoverable: true } : null;
  }

  /** Makes sure the instance has a live key (instances created before automatic keys get one on first use). */
  async ensureInstanceKey(ctx: TenantContext, instanceId: string): Promise<InstanceKeyInfo | null> {
    const existing = await this.instanceKey(ctx, instanceId);
    if (existing) return existing;
    await this.createInstanceKey(ctx, instanceId, { rotate: false });
    return this.instanceKey(ctx, instanceId);
  }

  /** The instance's live key (metadata only). */
  async instanceKey(ctx: TenantContext, instanceId: string): Promise<InstanceKeyInfo | null> {
    return this.tx.inTenant(async (db) => (await db.query(
      `SELECT id, key_prefix AS "prefix", created_at AS "createdAt", last_used_at AS "lastUsedAt", secret_ciphertext IS NOT NULL AS "recoverable"
         FROM app.api_keys WHERE instance_id = $1 AND revoked_at IS NULL`, [instanceId])).rows[0] ?? null, ctx, { readOnly: true });
  }

  /** Decrypts the live instance key for the copy / show button (OWNER/ADMIN only, audited). Null for keys stored hash-only. */
  async revealInstanceKey(ctx: TenantContext, instanceId: string): Promise<string | null> {
    const row = await this.tx.inTenant(async (db) => {
      const r = (await db.query(
        `SELECT id, secret_ciphertext, secret_wrapped_key, secret_key_reference FROM app.api_keys WHERE instance_id = $1 AND revoked_at IS NULL`, [instanceId])).rows[0];
      if (r?.secret_ciphertext) {
        await this.ops.audit(db, { organizationId: ctx.organizationId, actorType: 'USER', actorUserId: ctx.userId, action: 'API_KEY_REVEALED',
          resourceType: 'API_KEY', resourceId: r.id, requestId: ctx.requestId, metadata: { instance_id: instanceId } });
      }
      return r;
    }, ctx);
    if (!row?.secret_ciphertext) return null;
    const dek = await this.keys.decryptDataKey(row.secret_wrapped_key, row.secret_key_reference, instanceKeyContext(ctx.organizationId, row.id));
    try {
      const plain = aesGcmDecrypt(dek, row.secret_ciphertext, aad('instance-api-key', 'v1', ctx.organizationId, row.id));
      const s = plain.toString('utf8');
      plain.fill(0);
      return s;
    } finally {
      dek.fill(0);
    }
  }

  async revoke(ctx: TenantContext, apiKeyId: string): Promise<boolean> {
    return this.tx.inTenant(async (db) => {
      const r = await db.query(
        'UPDATE app.api_keys SET revoked_at = now(), revoked_by_user_id = $2 WHERE id = $1 AND revoked_at IS NULL',
        [apiKeyId, ctx.userId ?? null]);
      if ((r.rowCount ?? 0) === 0) return false;
      await this.ops.audit(db, { organizationId: ctx.organizationId, actorType: 'USER', actorUserId: ctx.userId, action: 'API_KEY_REVOKED',
        resourceType: 'API_KEY', resourceId: apiKeyId });
      return true;
    }, ctx);
  }
}
