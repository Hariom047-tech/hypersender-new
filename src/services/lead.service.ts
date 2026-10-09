import type { DbContext } from '../database/tenant-context.js';
import type { Db, TransactionRunner } from '../database/transaction-runner.js';
import { OpsRepository } from '../repositories/ops.repository.js';

export interface LeadFields {
  intent?: 'BUY' | 'RENT' | 'SELL' | 'INVEST' | 'ENQUIRY' | 'OTHER';
  interest?: string;
  propertyType?: string;
  location?: string;
  bedrooms?: number;
  budgetMinMinor?: number;
  budgetMaxMinor?: number;
  currency?: string;
  timeline?: string;
  qualification?: 'UNQUALIFIED' | 'WARM' | 'HOT' | 'COLD';
  notes?: string;
  /** Vertical-specific fields (e.g. havan type, call-back); shallow-merged into leads.attributes. */
  attributes?: Record<string, unknown>;
}

export interface LeadView {
  id: string; status: string; intent: string | null; interest: string | null; propertyType: string | null; location: string | null;
  bedrooms: number | null; budgetMinMinor: number | null; budgetMaxMinor: number | null; currency: string | null; timeline: string | null;
  qualification: string; notes: string | null; attributes: Record<string, unknown>; createdAt: string; updatedAt: string;
}

const COLS = `id, status, intent, interest, property_type AS "propertyType", location_pref AS "location", bedrooms,
              budget_min_minor AS "budgetMinMinor", budget_max_minor AS "budgetMaxMinor", currency, timeline, qualification, notes, attributes,
              created_at AS "createdAt", updated_at AS "updatedAt"`;

const view = (r: any): LeadView => ({ ...r, budgetMinMinor: r.budgetMinMinor === null ? null : Number(r.budgetMinMinor),
  budgetMaxMinor: r.budgetMaxMinor === null ? null : Number(r.budgetMaxMinor) });

/**
 * Leads: one OPEN lead per (business, contact) - enforced by a partial unique
 * index - so repeated "create" calls converge on the same row (merge), and an
 * idempotency key makes retried AI runs a no-op.
 */
export class LeadService {
  constructor(private readonly tx: TransactionRunner, private readonly ops: OpsRepository) {}

  async getOpen(db: Db, businessId: string, contactId: string): Promise<LeadView | null> {
    const r = await db.query(`SELECT ${COLS} FROM app.leads WHERE business_id = $1 AND contact_id = $2 AND status IN ('NEW','CONTACTED','QUALIFIED')`,
      [businessId, contactId]);
    return r.rows[0] ? view(r.rows[0]) : null;
  }

  /** Create, or merge into the existing open lead. Returns created=false when merged/replayed. */
  async upsert(ctx: DbContext & { organizationId: string }, p: { businessId: string; contactId: string; conversationId?: string | null;
    aiAgentId?: string | null; source: 'AI_WHATSAPP' | 'DASHBOARD' | 'API'; idempotencyKey?: string; fields: LeadFields; createOnly?: boolean }):
    Promise<{ lead: LeadView; created: boolean } | { lead: null; created: false; reason: 'NO_OPEN_LEAD' }> {
    return this.tx.inTenant(async (db) => {
      if (p.idempotencyKey) {
        const r = await db.query(`SELECT ${COLS} FROM app.leads WHERE organization_id = $1 AND idempotency_key = $2`, [ctx.organizationId, p.idempotencyKey]);
        if (r.rows[0]) return { lead: view(r.rows[0]), created: false };
      }
      await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('lead:' || $1::text || ':' || $2::text, 0))`, [p.businessId, p.contactId]);
      const existing = await this.getOpen(db, p.businessId, p.contactId);
      const f = p.fields;
      if (existing) {
        const r = await db.query(
          `UPDATE app.leads SET intent = coalesce($2, intent), interest = coalesce($3, interest), property_type = coalesce($4, property_type),
                  location_pref = coalesce($5, location_pref), bedrooms = coalesce($6, bedrooms), budget_min_minor = coalesce($7, budget_min_minor),
                  budget_max_minor = coalesce($8, budget_max_minor), currency = coalesce($9, currency), timeline = coalesce($10, timeline),
                  qualification = coalesce($11, qualification),
                  notes = CASE WHEN $12::text IS NULL THEN notes ELSE left(coalesce(notes || E'\\n', '') || $12, 2000) END,
                  attributes = attributes || coalesce($13::jsonb, '{}'::jsonb),
                  status = CASE WHEN coalesce($11, qualification) = 'HOT' AND status = 'NEW' THEN 'QUALIFIED' ELSE status END
            WHERE id = $1 RETURNING ${COLS}`,
          [existing.id, f.intent ?? null, f.interest ?? null, f.propertyType ?? null, f.location ?? null, f.bedrooms ?? null,
           f.budgetMinMinor ?? null, f.budgetMaxMinor ?? null, f.currency ?? null, f.timeline ?? null, f.qualification ?? null, f.notes ?? null,
           f.attributes ? JSON.stringify(f.attributes) : null]);
        return { lead: view(r.rows[0]), created: false };
      }
      if (p.createOnly === false) return { lead: null, created: false, reason: 'NO_OPEN_LEAD' as const };
      const r = await db.query(
        `INSERT INTO app.leads (organization_id, business_id, contact_id, conversation_id, ai_agent_id, intent, interest, property_type, location_pref,
                                bedrooms, budget_min_minor, budget_max_minor, currency, timeline, qualification, notes, source, idempotency_key, status, attributes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,coalesce($15,'UNQUALIFIED'),$16,$17,$18,
                 CASE WHEN $15 = 'HOT' THEN 'QUALIFIED' ELSE 'NEW' END, coalesce($19::jsonb, '{}'::jsonb))
         RETURNING ${COLS}`,
        [ctx.organizationId, p.businessId, p.contactId, p.conversationId ?? null, p.aiAgentId ?? null, f.intent ?? null, f.interest ?? null,
         f.propertyType ?? null, f.location ?? null, f.bedrooms ?? null, f.budgetMinMinor ?? null, f.budgetMaxMinor ?? null, f.currency ?? null,
         f.timeline ?? null, f.qualification ?? null, f.notes ?? null, p.source, p.idempotencyKey ?? null, f.attributes ? JSON.stringify(f.attributes) : null]);
      await this.ops.enqueueOutbox(db, { organizationId: ctx.organizationId, eventType: 'LEAD_CREATED', aggregateType: 'LEAD', aggregateId: r.rows[0].id,
        payload: { lead_id: r.rows[0].id, business_id: p.businessId }, dedupeKey: `lead-created:${r.rows[0].id}` });
      return { lead: view(r.rows[0]), created: true };
    }, ctx, { retries: 2 });
  }
}
