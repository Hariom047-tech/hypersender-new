import { loadConversationView, loadMessageView } from '../../api/views.js';
import type { TransactionRunner } from '../../database/transaction-runner.js';
import type { ClaimedOutboxEvent } from '../../repositories/ops.repository.js';
import type { NotificationService } from '../../services/notification.service.js';
import type { OutboxRelayService } from '../../services/outbox-relay.service.js';
import type { RealtimeBus } from '../realtime/realtime-bus.js';

/** Realtime payloads travel through pg NOTIFY (8 KB limit, encrypted+base64): cap message text. */
export const REALTIME_TEXT_LIMIT = 1500;

const USER_INITIATED = new Set(['USER_LOGOUT', 'INSTANCE_DELETED', 'USER_DISCONNECT']);

/**
 * Turns committed outbox facts into normalised APPLICATION events for the
 * browser (org-wide realtime stream) and operational notifications. Runs on
 * the general relay: each outbox event is handled once, under its own
 * tenant's context. Payloads are read back from our tables (never provider objects).
 */
export function registerAppEventBridge(relay: OutboxRelayService, tx: TransactionRunner, bus: RealtimeBus, notifications: NotificationService): void {
  const at = () => new Date().toISOString();

  const onMessage = async (e: ClaimedOutboxEvent) => {
    if (!e.organizationId) return;
    const organizationId = e.organizationId;
    const loaded = await tx.inTenant(async (db) => {
      const message = await loadMessageView(db, e.aggregateId, REALTIME_TEXT_LIMIT);
      if (!message) return null;
      const conversation = await loadConversationView(db, message.conversationId);
      const count = (await db.query('SELECT count(*)::int AS n FROM app.messages WHERE conversation_id = $1', [message.conversationId])).rows[0].n;
      return { message, conversation, isFirst: count === 1 };
    }, { organizationId }, { readOnly: true });
    if (!loaded) return;
    const { message, conversation, isFirst } = loaded;
    const base = { organizationId, businessId: message.businessId, instanceId: message.instanceId, at: at() };
    const isNewMessage = e.eventType === 'MESSAGE_RECEIVED' || e.eventType === 'MESSAGE_REACTION' ||
      (e.eventType === 'MESSAGE_SENT' && message.origin === 'LINKED_DEVICE');
    if (isNewMessage) {
      await bus.publish({ ...base, type: 'message.created', data: { message } });
      if (conversation) await bus.publish({ ...base, type: isFirst ? 'conversation.created' : 'conversation.updated', data: { conversation } });
    } else {
      await bus.publish({ ...base, type: 'message.status_updated',
        data: { messageId: message.id, conversationId: message.conversationId, status: message.status, errorCode: message.errorCode } });
      if (conversation && e.eventType === 'MESSAGE_SENT') await bus.publish({ ...base, type: 'conversation.updated', data: { conversation } });
    }
  };
  for (const t of ['MESSAGE_RECEIVED', 'MESSAGE_SENT', 'MESSAGE_DELIVERED', 'MESSAGE_READ', 'MESSAGE_FAILED', 'MESSAGE_REVOKED', 'MESSAGE_REACTION']) {
    relay.on(t, onMessage);
  }

  relay.on('INSTANCE_STATUS_CHANGED', async (e) => {
    if (!e.organizationId) return;
    const p = e.payload as { instance_id: string; business_id: string; previous_status: string; status: string; reason: string | null };
    await bus.publish({ type: 'instance.status_updated', organizationId: e.organizationId, businessId: p.business_id, instanceId: p.instance_id,
      at: at(), data: { instanceId: p.instance_id, status: p.status, previousStatus: p.previous_status, reason: p.reason } });
    const name = await instanceName(tx, e.organizationId, p.instance_id);
    if (p.status === 'LOGGED_OUT' && !USER_INITIATED.has(p.reason ?? '')) {
      await notifications.notifyAdmins(e.organizationId, { type: 'WHATSAPP_LOGGED_OUT', dedupeKey: `logout:${p.instance_id}`,
        title: `WhatsApp logged out: ${name}`, body: 'The linked device was removed. Scan a new QR code to reconnect.', data: { instance_id: p.instance_id } });
    } else if (p.status === 'ERROR') {
      await notifications.notifyAdmins(e.organizationId, { type: 'WHATSAPP_ERROR', dedupeKey: `error:${p.instance_id}`,
        title: `WhatsApp stopped: ${name}`, body: 'The connection could not be maintained. Open the instance to reconnect.', data: { instance_id: p.instance_id } });
    }
  });

  // Delayed check enqueued when an instance leaves CONNECTED (grace period).
  relay.on('INSTANCE_RECONNECT_CHECK', async (e) => {
    if (!e.organizationId) return;
    const p = e.payload as { instance_id: string };
    const row = await tx.inTenant(async (db) => (await db.query(
      `SELECT status, disconnect_reason, instance_name, deleted_at IS NOT NULL AS deleted FROM app.whatsapp_instances WHERE id = $1`, [p.instance_id])).rows[0],
      { organizationId: e.organizationId }, { readOnly: true });
    if (!row || row.deleted || row.status === 'CONNECTED' || USER_INITIATED.has(row.disconnect_reason ?? '')) return;
    if (!['RECONNECTING', 'DISCONNECTED', 'ERROR'].includes(row.status)) return;
    await notifications.notifyAdmins(e.organizationId, { type: 'WHATSAPP_RECONNECT_TROUBLE', dedupeKey: `reconnect:${p.instance_id}`,
      title: `WhatsApp disconnected: ${row.instance_name}`, body: 'We have been unable to reconnect for several minutes. Messages are not being received.',
      data: { instance_id: p.instance_id } });
  });
}

async function instanceName(tx: TransactionRunner, organizationId: string, instanceId: string): Promise<string> {
  const r = await tx.inTenant((db) => db.query('SELECT instance_name FROM app.whatsapp_instances WHERE id = $1', [instanceId]), { organizationId }, { readOnly: true });
  return r.rows[0]?.instance_name ?? 'instance';
}

/** WEBHOOK_TEST_REQUESTED: one synthetic event delivered ONLY to the requested endpoint (if still enabled). */
export function registerWebhookTestHandler(relay: OutboxRelayService, tx: TransactionRunner): void {
  relay.on('WEBHOOK_TEST_REQUESTED', async (e) => {
    if (!e.organizationId) return;
    const endpointId = String(e.payload.endpoint_id);
    await tx.inTenant(async (db) => {
      const ep = await db.query('SELECT id, business_id, instance_id FROM app.webhook_endpoints WHERE id = $1 AND enabled AND deleted_at IS NULL', [endpointId]);
      if (!ep.rows[0]) return;
      const ev = await db.query(
        `INSERT INTO app.webhook_events (organization_id, business_id, instance_id, event_type, resource_type, resource_id, payload, idempotency_key)
         VALUES ($1, $2, $3, 'WEBHOOK_TEST', 'WEBHOOK_ENDPOINT', $4, $5, $6)
         ON CONFLICT (organization_id, idempotency_key) DO NOTHING RETURNING id`,
        [e.organizationId, ep.rows[0].business_id, ep.rows[0].instance_id, endpointId,
         JSON.stringify({ organizationId: e.organizationId, test: true, message: 'This is a test event from HyperSender.' }), `outbox:${e.id}`]);
      if (ev.rows[0]) {
        await db.query(`INSERT INTO app.webhook_deliveries (organization_id, webhook_event_id, webhook_endpoint_id) VALUES ($1, $2, $3)
                        ON CONFLICT DO NOTHING`, [e.organizationId, ev.rows[0].id, endpointId]);
      }
    }, { organizationId: e.organizationId });
  });
}
