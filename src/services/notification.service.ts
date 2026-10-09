import type { Db, TransactionRunner } from '../database/transaction-runner.js';
import type { RealtimeBus } from '../whatsapp/realtime/realtime-bus.js';

export type NotificationType = 'WHATSAPP_LOGGED_OUT' | 'WHATSAPP_ERROR' | 'WHATSAPP_RECONNECT_TROUBLE' | 'WEBHOOK_FAILING'
  | 'AI_HANDOFF' | 'AI_HOT_LEAD' | 'AI_TEAM_ALERT' | 'AI_ASSISTANT_FAILING' | 'NEW_ORDER' | 'ORDER_REQUEST' | 'SUPPORT_TICKET'
  | 'PANDIT_CALLBACK' | 'PANDIT_REMINDER' | 'CAMPAIGN_PAUSED' | 'CAMPAIGN_COMPLETED';

/**
 * Operational notifications for OWNER/ADMIN members (worker role, tenant tx).
 * De-duplicated: the same (type, dedupe key) is not repeated for a recipient
 * while an unread copy newer than 6 h exists - no notification spam.
 */
export class NotificationService {
  constructor(private readonly tx: TransactionRunner, private readonly bus: RealtimeBus) {}

  async notifyAdmins(organizationId: string, n: { type: NotificationType; title: string; body: string; dedupeKey: string; data?: Record<string, unknown> }): Promise<number> {
    const created = await this.tx.inTenant(async (db: Db) => {
      const r = await db.query(
        `INSERT INTO app.notifications (organization_id, user_id, type, title, body, data)
         SELECT m.organization_id, m.user_id, $1, $2, $3, $4::jsonb
           FROM app.organization_members m
          WHERE m.organization_id = app.current_org_id() AND m.status = 'ACTIVE' AND m.role IN ('OWNER','ADMIN')
            AND NOT EXISTS (SELECT 1 FROM app.notifications x
                             WHERE x.organization_id = m.organization_id AND x.user_id = m.user_id AND x.type = $1
                               AND x.data->>'dedupe' = $5 AND x.read_at IS NULL AND x.created_at > now() - interval '6 hours')
         RETURNING id, user_id, created_at`,
        [n.type, n.title, n.body, JSON.stringify({ ...(n.data ?? {}), dedupe: n.dedupeKey }), n.dedupeKey]);
      return r.rows;
    }, { organizationId });
    for (const row of created) {
      await this.bus.publish({ type: 'notification.created', organizationId, userId: row.user_id, at: new Date().toISOString(),
        data: { id: row.id, type: n.type, title: n.title, body: n.body, createdAt: row.created_at } }).catch(() => undefined);
    }
    return created.length;
  }
}
