import { Injectable } from '@nestjs/common';
import type { Db } from '../database/transaction-runner.js';

export interface ClaimedDelivery {
  id: string;
  organizationId: string;
  webhookEventId: string;
  webhookEndpointId: string;
  attemptNumber: number;
}

@Injectable()
export class WebhookRepository {
  async insertEndpoint(db: Db, e: {
    id: string; organizationId: string; businessId?: string | null; instanceId?: string | null; name: string; url: string;
    secretCiphertext: Buffer; secretWrappedKey: Buffer; secretKeyReference: string; secretLast4: string; createdByUserId?: string;
  }): Promise<void> {
    await db.query(
      `INSERT INTO app.webhook_endpoints (id, organization_id, business_id, instance_id, name, url,
                                          secret_ciphertext, secret_wrapped_key, secret_key_reference, secret_last4, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [e.id, e.organizationId, e.businessId ?? null, e.instanceId ?? null, e.name, e.url,
       e.secretCiphertext, e.secretWrappedKey, e.secretKeyReference, e.secretLast4, e.createdByUserId ?? null]);
  }

  async insertSubscriptions(db: Db, organizationId: string, endpointId: string, eventTypes: string[]): Promise<void> {
    await db.query(
      `INSERT INTO app.webhook_event_subscriptions (organization_id, webhook_endpoint_id, event_type)
       SELECT $1, $2, unnest($3::text[])
       ON CONFLICT (webhook_endpoint_id, event_type) DO NOTHING`, [organizationId, endpointId, eventTypes]);
  }

  /** Worker-side: endpoint URL + encrypted secret (hs_worker only; hs_app cannot read the secret columns). */
  async getEndpointForDelivery(db: Db, endpointId: string): Promise<{ url: string; enabled: boolean; secretCiphertext: Buffer; secretWrappedKey: Buffer; secretKeyReference: string; organizationId: string;
    authHeader: { ciphertext: Buffer; wrappedKey: Buffer; keyReference: string } | null } | null> {
    const r = await db.query(
      `SELECT organization_id, url, enabled AND deleted_at IS NULL AS enabled, secret_ciphertext, secret_wrapped_key, secret_key_reference,
              auth_header_ciphertext, auth_header_wrapped_key, auth_header_key_reference
         FROM app.webhook_endpoints WHERE id = $1`, [endpointId]);
    const row = r.rows[0];
    return row ? { organizationId: row.organization_id, url: row.url, enabled: row.enabled, secretCiphertext: row.secret_ciphertext,
                   secretWrappedKey: row.secret_wrapped_key, secretKeyReference: row.secret_key_reference,
                   authHeader: row.auth_header_ciphertext ? { ciphertext: row.auth_header_ciphertext, wrappedKey: row.auth_header_wrapped_key,
                                                            keyReference: row.auth_header_key_reference } : null } : null;
  }

  /** Idempotent event creation; returns null when this idempotency key was already processed. */
  async insertEvent(db: Db, e: { organizationId: string; businessId?: string | null; instanceId?: string | null; eventType: string; resourceType: string; resourceId?: string | null; payload: object; idempotencyKey: string }): Promise<string | null> {
    const r = await db.query(
      `INSERT INTO app.webhook_events (organization_id, business_id, instance_id, event_type, resource_type, resource_id, payload, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (organization_id, idempotency_key) DO NOTHING RETURNING id`,
      [e.organizationId, e.businessId ?? null, e.instanceId ?? null, e.eventType, e.resourceType, e.resourceId ?? null,
       JSON.stringify(e.payload), e.idempotencyKey]);
    return r.rows[0]?.id ?? null;
  }

  /** Fan-out using the deterministic precedence rules of app.resolve_webhook_targets. */
  async createDeliveriesForEvent(db: Db, organizationId: string, eventId: string, eventType: string, businessId: string | null, instanceId: string | null): Promise<number> {
    const r = await db.query(
      `INSERT INTO app.webhook_deliveries (organization_id, webhook_event_id, webhook_endpoint_id)
       SELECT $1, $2, t.webhook_endpoint_id FROM app.resolve_webhook_targets($3, $4, $5) t
       ON CONFLICT (webhook_event_id, webhook_endpoint_id) DO NOTHING`,
      [organizationId, eventId, eventType, businessId, instanceId]);
    return r.rowCount ?? 0;
  }

  /** Cross-tenant claim of due deliveries (hs_worker, dispatcher policy). */
  async claimDue(db: Db, workerId: string, limit: number, visibilitySeconds = 60): Promise<ClaimedDelivery[]> {
    const r = await db.query(
      `WITH due AS (
         SELECT id FROM app.webhook_deliveries
          WHERE status IN ('PENDING','RETRYING','PROCESSING') AND next_retry_at <= now()
          ORDER BY next_retry_at
          LIMIT $2
          FOR UPDATE SKIP LOCKED)
       UPDATE app.webhook_deliveries d
          SET status = 'PROCESSING', locked_by = $1, attempt_number = d.attempt_number + 1,
              last_attempt_at = now(), next_retry_at = now() + make_interval(secs => $3)
         FROM due WHERE d.id = due.id
       RETURNING d.id, d.organization_id, d.webhook_event_id, d.webhook_endpoint_id, d.attempt_number`,
      [workerId, limit, visibilitySeconds]);
    return r.rows.map((row) => ({ id: row.id, organizationId: row.organization_id, webhookEventId: row.webhook_event_id,
      webhookEndpointId: row.webhook_endpoint_id, attemptNumber: row.attempt_number }));
  }

  /** Only the worker that still holds the claim may record the outcome. */
  async recordOutcome(db: Db, d: { id: string; workerId: string; delivered: boolean; httpStatus?: number | null; responseBody?: string | null; error?: string | null; latencyMs?: number | null; maxAttempts?: number }): Promise<string | false> {
    const r = await db.query(
      `UPDATE app.webhook_deliveries
          SET status = CASE WHEN $3 THEN 'DELIVERED' WHEN attempt_number >= $7 THEN 'DEAD' ELSE 'RETRYING' END,
              delivered_at = CASE WHEN $3 THEN now() END,
              next_retry_at = CASE WHEN $3 OR attempt_number >= $7 THEN NULL
                                   ELSE now() + make_interval(secs => least(86400, 30 * (2 ^ (attempt_number - 1))::int)) END,
              http_status = $4, response_body_truncated = left($5, 4096), error_message = left($6, 2000), latency_ms = $8, locked_by = NULL
        WHERE id = $1 AND locked_by = $2 AND status = 'PROCESSING'
       RETURNING status`,
      [d.id, d.workerId, d.delivered, d.httpStatus ?? null, d.responseBody ?? null, d.error ?? null, d.maxAttempts ?? 12, d.latencyMs ?? null]);
    return r.rows[0]?.status ?? false;
  }
}
