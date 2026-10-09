import type { Db } from '../database/transaction-runner.js';
import { WhatsAppError } from '../whatsapp/domain/whatsapp-errors.js';

export type CountedFeature = 'MAX_WHATSAPP_INSTANCES' | 'TEAM_MEMBERS' | 'WEBHOOKS' | 'MAX_AI_AGENTS';
export type BooleanFeature = 'API_ACCESS';
export type Feature = CountedFeature | BooleanFeature | 'MONTHLY_MESSAGES' | 'MONTHLY_AI_MESSAGES' | 'KNOWLEDGE_STORAGE_MB';

/** What "current usage" means for each countable feature (always RLS-scoped to the current organization). */
const USAGE_SQL: Record<CountedFeature, string> = {
  MAX_WHATSAPP_INSTANCES: `SELECT count(*)::int AS n FROM app.whatsapp_instances WHERE deleted_at IS NULL`,
  TEAM_MEMBERS: `SELECT count(*)::int AS n FROM app.organization_members WHERE organization_id = app.current_org_id() AND status IN ('ACTIVE','INVITED')`,
  WEBHOOKS: `SELECT count(*)::int AS n FROM app.webhook_endpoints WHERE deleted_at IS NULL`,
  // Archived assistants are final (they can never go live again), so they free their slot.
  MAX_AI_AGENTS: `SELECT count(*)::int AS n FROM app.ai_agents WHERE deleted_at IS NULL AND status <> 'ARCHIVED'`,
};

/** Human-readable limit messages (shown as-is in the dashboard). */
const LIMIT_MESSAGE: Record<CountedFeature, (limit: number) => string> = {
  MAX_WHATSAPP_INSTANCES: (n) => `Your plan allows ${n} WhatsApp number${n === 1 ? '' : 's'}. Remove one or upgrade your plan to add another.`,
  TEAM_MEMBERS: (n) => `Your plan allows ${n} team member${n === 1 ? '' : 's'}. Remove someone or upgrade your plan to invite more.`,
  WEBHOOKS: (n) => `Your plan allows ${n} webhook${n === 1 ? '' : 's'}. Delete one or upgrade your plan to add another.`,
  MAX_AI_AGENTS: (n) => `Your plan allows ${n} AI assistant${n === 1 ? '' : 's'}. Archive an assistant you no longer use (AI Assistants → open it → Archive) or upgrade your plan, then try again.`,
};

const LIMIT_ERROR: Partial<Record<CountedFeature, 'WHATSAPP_INSTANCE_LIMIT_REACHED'>> = { MAX_WHATSAPP_INSTANCES: 'WHATSAPP_INSTANCE_LIMIT_REACHED' };

export interface Entitlement { feature: string; enabled: boolean; limit: number | null; used?: number }

/**
 * THE single place where plan entitlements are enforced. Callers run inside
 * the tenant transaction that performs the change:
 *
 *   await entitlements.assertCanAdd(db, 'MAX_WHATSAPP_INSTANCES');   // then INSERT in the same tx
 *
 * assertCanAdd takes a transaction-scoped advisory lock per (organization,
 * feature) before counting, so two concurrent requests cannot both observe
 * "below the limit" - the second waits for the first to commit and then sees
 * its row. The lock is released at COMMIT/ROLLBACK.
 */
export class EntitlementService {
  /** Organization must be operable and hold a live subscription. */
  async assertSubscriptionActive(db: Db): Promise<void> {
    const r = await db.query(
      `SELECT o.status AS org_status,
              EXISTS (SELECT 1 FROM app.subscriptions s WHERE s.organization_id = o.id AND s.status IN ('TRIALING','ACTIVE','PAST_DUE')
                        AND s.current_period_end > now()) AS live
         FROM app.organizations o WHERE o.id = app.current_org_id()`);
    const x = r.rows[0];
    if (!x || ['SUSPENDED', 'CANCELLED'].includes(x.org_status) || !x.live) throw new WhatsAppError('SUBSCRIPTION_INACTIVE');
  }

  async get(db: Db, feature: Feature): Promise<Entitlement | null> {
    const r = await db.query(`SELECT enabled, limit_value FROM app.current_entitlement($1)`, [feature]);
    const x = r.rows[0];
    return x ? { feature, enabled: x.enabled, limit: x.limit_value === null ? null : Number(x.limit_value) } : null;
  }

  async assertEnabled(db: Db, feature: BooleanFeature): Promise<void> {
    await this.assertSubscriptionActive(db);
    const e = await this.get(db, feature);
    if (!e?.enabled) throw new WhatsAppError('FEATURE_NOT_IN_PLAN', `${feature} is not included in the current plan`);
  }

  async assertCanAdd(db: Db, feature: CountedFeature, adding = 1): Promise<void> {
    await this.assertSubscriptionActive(db);
    await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('entitlement:' || $1 || ':' || app.current_org_id()::text, 0))`, [feature]);
    const e = await this.get(db, feature);
    if (!e?.enabled) throw new WhatsAppError('FEATURE_NOT_IN_PLAN', `${feature} is not included in the current plan`);
    if (e.limit === null) return;
    const used = (await db.query(USAGE_SQL[feature])).rows[0].n as number;
    if (used + adding > e.limit) throw new WhatsAppError(LIMIT_ERROR[feature] ?? 'PLAN_LIMIT_REACHED', LIMIT_MESSAGE[feature](e.limit));
  }

  /** Entitlements with current usage, for the billing/usage UI. */
  async summary(db: Db): Promise<Entitlement[]> {
    const r = await db.query(
      `SELECT pe.feature_key, pe.enabled, pe.limit_value
         FROM app.subscriptions s JOIN app.plan_entitlements pe ON pe.plan_id = s.plan_id
        WHERE s.organization_id = app.current_org_id() AND s.status IN ('TRIALING','ACTIVE','PAST_DUE')
        ORDER BY pe.feature_key`);
    const out: Entitlement[] = [];
    for (const x of r.rows) {
      const e: Entitlement = { feature: x.feature_key, enabled: x.enabled, limit: x.limit_value === null ? null : Number(x.limit_value) };
      if (x.feature_key in USAGE_SQL) e.used = (await db.query(USAGE_SQL[x.feature_key as CountedFeature])).rows[0].n;
      out.push(e);
    }
    return out;
  }
}
