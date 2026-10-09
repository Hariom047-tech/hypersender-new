import { Injectable } from '@nestjs/common';
import type { Db } from '../database/transaction-runner.js';

export interface AuthCredentialRow {
  encryptedCredentials: Buffer;
  wrappedDataKey: Buffer;
  keyReference: string;
  encryptionVersion: number;
}

@Injectable()
export class WhatsAppRepository {
  async insertInstance(db: Db, i: { id?: string; organizationId: string; businessId: string; name: string; createdByUserId?: string }): Promise<string> {
    const r = await db.query(
      `INSERT INTO app.whatsapp_instances (id, organization_id, business_id, instance_name, created_by_user_id)
       VALUES (coalesce($1::uuid, app.uuid_generate_v7()), $2, $3, $4, $5) RETURNING id`,
      [i.id ?? null, i.organizationId, i.businessId, i.name, i.createdByUserId ?? null]);
    return r.rows[0].id;
  }

  async findInstance(db: Db, id: string): Promise<{ id: string; organizationId: string; businessId: string; status: string; whatsappJid: string | null } | null> {
    const r = await db.query(
      `SELECT id, organization_id, business_id, status, whatsapp_jid FROM app.whatsapp_instances
        WHERE id = $1 AND deleted_at IS NULL`, [id]);
    const row = r.rows[0];
    return row ? { id: row.id, organizationId: row.organization_id, businessId: row.business_id, status: row.status, whatsappJid: row.whatsapp_jid } : null;
  }

  /** Atomic compare-and-set claim. Returns the fencing token, or null if another worker holds a live lease. */
  async claimLease(db: Db, instanceId: string, workerId: string, leaseSeconds: number): Promise<number | null> {
    const r = await db.query('SELECT app.claim_instance_lease($1, $2, $3) AS token', [instanceId, workerId, leaseSeconds]);
    return r.rows[0].token === null ? null : Number(r.rows[0].token);
  }

  /** Claim for an explicit user (re)link: also admits LOGGED_OUT instances (new QR). */
  async claimLeaseForLink(db: Db, instanceId: string, workerId: string, leaseSeconds: number): Promise<number | null> {
    const r = await db.query('SELECT app.claim_instance_lease_for_link($1, $2, $3) AS token', [instanceId, workerId, leaseSeconds]);
    return r.rows[0].token === null ? null : Number(r.rows[0].token);
  }

  /** Pre-assigns a provider message id to a QUEUED message (echo de-duplication). Returns the id to use. */
  async assignProviderId(db: Db, messageId: string, candidate: string): Promise<string | null> {
    const r = await db.query(
      `UPDATE app.messages SET provider_message_id = coalesce(provider_message_id, $2)
        WHERE id = $1 AND status = 'QUEUED' RETURNING provider_message_id`, [messageId, candidate]);
    return r.rows[0]?.provider_message_id ?? null;
  }

  async releaseLease(db: Db, instanceId: string, workerId: string, token: number): Promise<boolean> {
    const r = await db.query('SELECT app.release_instance_lease($1, $2, $3) AS ok', [instanceId, workerId, token]);
    return r.rows[0].ok;
  }

  /** Fencing check; raises SQLSTATE 55P03 / HINT HS_LEASE_LOST when the lease moved. */
  async assertLease(db: Db, instanceId: string, workerId: string, token: number): Promise<void> {
    await db.query('SELECT app.assert_instance_lease($1, $2, $3)', [instanceId, workerId, token]);
  }

  async recordEvent(db: Db, e: { organizationId: string; instanceId: string; eventType: string; previousStatus?: string; newStatus?: string; reason?: string; workerId?: string; metadata?: object }): Promise<void> {
    await db.query(
      `INSERT INTO app.whatsapp_instance_events (organization_id, instance_id, event_type, previous_status, new_status, reason, worker_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [e.organizationId, e.instanceId, e.eventType, e.previousStatus ?? null, e.newStatus ?? null, e.reason ?? null,
       e.workerId ?? null, JSON.stringify(e.metadata ?? {})]);
  }

  // ---------------------------------------------------------------- auth state

  async getCredentials(db: Db, instanceId: string): Promise<AuthCredentialRow | null> {
    const r = await db.query(
      `SELECT encrypted_credentials, wrapped_data_key, key_reference, encryption_version
         FROM app.whatsapp_auth_credentials WHERE instance_id = $1`, [instanceId]);
    const row = r.rows[0];
    return row ? { encryptedCredentials: row.encrypted_credentials, wrappedDataKey: row.wrapped_data_key, keyReference: row.key_reference, encryptionVersion: row.encryption_version } : null;
  }

  async insertCredentials(db: Db, c: { organizationId: string; instanceId: string } & AuthCredentialRow): Promise<void> {
    await db.query(
      `INSERT INTO app.whatsapp_auth_credentials
         (organization_id, instance_id, encrypted_credentials, wrapped_data_key, key_reference, encryption_version)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [c.organizationId, c.instanceId, c.encryptedCredentials, c.wrappedDataKey, c.keyReference, c.encryptionVersion]);
  }

  async updateCredentials(db: Db, instanceId: string, encryptedCredentials: Buffer): Promise<void> {
    await db.query('UPDATE app.whatsapp_auth_credentials SET encrypted_credentials = $2 WHERE instance_id = $1',
      [instanceId, encryptedCredentials]);
  }

  async getSignalKeys(db: Db, instanceId: string, keyType: string, keyIds: string[]): Promise<Array<{ keyId: string; encryptedValue: Buffer }>> {
    if (keyIds.length === 0) return [];
    const r = await db.query(
      `SELECT key_id, encrypted_value FROM app.whatsapp_signal_keys
        WHERE instance_id = $1 AND key_type = $2 AND key_id = ANY($3::text[])`,
      [instanceId, keyType, keyIds]);
    return r.rows.map((row) => ({ keyId: row.key_id, encryptedValue: row.encrypted_value }));
  }

  /** Batched upsert: one statement for any number of keys. */
  async upsertSignalKeys(db: Db, organizationId: string, instanceId: string, rows: Array<{ keyType: string; keyId: string; encryptedValue: Buffer }>): Promise<void> {
    if (rows.length === 0) return;
    await db.query(
      `INSERT INTO app.whatsapp_signal_keys (organization_id, instance_id, key_type, key_id, encrypted_value)
       SELECT $1, $2, t.key_type, t.key_id, t.encrypted_value
         FROM unnest($3::text[], $4::text[], $5::bytea[]) AS t(key_type, key_id, encrypted_value)
       ON CONFLICT (instance_id, key_type, key_id)
       DO UPDATE SET encrypted_value = EXCLUDED.encrypted_value`,
      [organizationId, instanceId, rows.map((r) => r.keyType), rows.map((r) => r.keyId), rows.map((r) => r.encryptedValue)]);
  }

  async deleteSignalKeys(db: Db, instanceId: string, rows: Array<{ keyType: string; keyId: string }>): Promise<void> {
    if (rows.length === 0) return;
    await db.query(
      `DELETE FROM app.whatsapp_signal_keys k
        USING unnest($2::text[], $3::text[]) AS t(key_type, key_id)
        WHERE k.instance_id = $1 AND k.key_type = t.key_type AND k.key_id = t.key_id`,
      [instanceId, rows.map((r) => r.keyType), rows.map((r) => r.keyId)]);
  }

  /** Secure hard delete (logout / org deletion). Returns number of signal keys destroyed. */
  async destroyAuth(db: Db, instanceId: string, reason = 'LOGGED_OUT'): Promise<number> {
    const r = await db.query('SELECT app.destroy_whatsapp_auth($1, $2) AS n', [instanceId, reason]);
    return r.rows[0].n;
  }
}
