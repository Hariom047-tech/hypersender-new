import { Inject, Injectable } from '@nestjs/common';
import { decodeCursor, likePattern, paginate } from '../common/cursor.js';
import type { TenantContext } from '../database/tenant-context.js';
import { APP_TX, TransactionRunner } from '../database/transaction-runner.js';
import { WhatsAppError } from '../whatsapp/domain/whatsapp-errors.js';

/** Dashboard tabs: Active = running (incl. trial), Pending = waiting for payment, Inactive = ended. */
export type SubscriptionGroup = 'ACTIVE' | 'PENDING' | 'INACTIVE';
const GROUP_STATUSES: Record<SubscriptionGroup, string[]> = { ACTIVE: ['ACTIVE', 'TRIALING'], PENDING: ['PAST_DUE'], INACTIVE: ['CANCELLED', 'EXPIRED'] };

/**
 * Transaction status as the owner sees it (one row per invoice; drafts are never shown):
 * PAID -> COMPLETED, OPEN -> PENDING (PAST_DUE once the due date passed), VOID -> CANCELLED, UNCOLLECTIBLE -> FAILED.
 */
const TX_STATUS_SQL = `CASE i.status WHEN 'PAID' THEN 'COMPLETED' WHEN 'VOID' THEN 'CANCELLED' WHEN 'UNCOLLECTIBLE' THEN 'FAILED'
                         ELSE CASE WHEN i.due_at IS NOT NULL AND i.due_at < now() THEN 'PAST_DUE' ELSE 'PENDING' END END`;
export const TX_STATUSES = ['COMPLETED', 'PENDING', 'PAST_DUE', 'CANCELLED', 'FAILED'] as const;

/** Latest successful payment's method, else the latest attempt's (category only - never card details). */
const METHOD_SQL = `(SELECT p.method_type FROM app.payments p WHERE p.invoice_id = i.id
                      ORDER BY (p.status = 'CAPTURED') DESC, p.created_at DESC LIMIT 1)`;

const TX_SELECT = `
  SELECT i.id, i.invoice_number, i.subscription_id, i.total_minor, i.currency, i.issued_at, i.paid_at, i.created_at, i.status AS invoice_status,
         ${TX_STATUS_SQL} AS status, ${METHOD_SQL} AS method_type
    FROM app.invoices i
   WHERE i.status <> 'DRAFT'`;

function txView(x: Record<string, any>) {
  return {
    id: x.id, invoiceNumber: x.invoice_number, subscriptionId: x.subscription_id, type: x.subscription_id ? 'SUBSCRIPTION' : 'ONE_TIME',
    totalMinorUnits: Number(x.total_minor), currency: x.currency, paymentMethod: x.method_type ?? null, status: x.status,
    billedAt: x.issued_at, paidAt: x.paid_at, createdAt: x.created_at, invoiceAvailable: x.invoice_status !== 'DRAFT',
  };
}

/** Billing history for the dashboard (read-only; invoices and payments are written by the billing worker / provider webhooks). */
@Injectable()
export class BillingService {
  constructor(@Inject(APP_TX) private readonly tx: TransactionRunner) {}

  async subscriptions(ctx: TenantContext, q: { group: SubscriptionGroup; search?: string }) {
    return this.tx.inTenant(async (db) => {
      const counts = (await db.query(
        `SELECT count(*) FILTER (WHERE status = ANY($1))::int AS active, count(*) FILTER (WHERE status = ANY($2))::int AS pending,
                count(*) FILTER (WHERE status = ANY($3))::int AS inactive FROM app.subscriptions`,
        [GROUP_STATUSES.ACTIVE, GROUP_STATUSES.PENDING, GROUP_STATUSES.INACTIVE])).rows[0];
      const instancesUsed = (await db.query('SELECT count(*)::int AS n FROM app.whatsapp_instances WHERE deleted_at IS NULL')).rows[0].n as number;
      const rows = (await db.query(
        `SELECT s.id, s.status, s.provider, s.created_at, s.current_period_start, s.current_period_end, s.trial_end, s.cancel_at_period_end, s.cancelled_at,
                p.code AS plan_code, p.name AS plan_name, p.price_minor_units, p.currency, p.billing_interval,
                (SELECT e.limit_value FROM app.plan_entitlements e WHERE e.plan_id = p.id AND e.feature_key = 'MAX_WHATSAPP_INSTANCES' AND e.enabled) AS instance_limit,
                (SELECT pay.method_type FROM app.payments pay JOIN app.invoices inv ON inv.id = pay.invoice_id
                  WHERE inv.subscription_id = s.id ORDER BY (pay.status = 'CAPTURED') DESC, pay.created_at DESC LIMIT 1) AS method_type
           FROM app.subscriptions s JOIN app.subscription_plans p ON p.id = s.plan_id
          WHERE s.status = ANY($1) AND ($2::text IS NULL OR s.id::text ILIKE $2 OR p.name ILIKE $2)
          ORDER BY s.created_at DESC LIMIT 100`, [GROUP_STATUSES[q.group], q.search ? likePattern(q.search) : null])).rows;
      const live = new Set(GROUP_STATUSES.ACTIVE.concat(GROUP_STATUSES.PENDING));
      return {
        counts,
        items: rows.map((x) => ({
          id: x.id, service: 'WHATSAPP', tier: x.plan_name, planCode: x.plan_code, status: x.status,
          // usage is only meaningful for the running subscription
          instances: { used: live.has(x.status) ? instancesUsed : null, limit: x.instance_limit === null ? null : Number(x.instance_limit) },
          paymentMethod: x.method_type ?? (x.status === 'TRIALING' ? 'TRIAL' : x.provider === 'MANUAL' ? 'MANUAL' : null),
          priceMinorUnits: Number(x.price_minor_units), currency: x.currency, interval: x.billing_interval,
          subscribedAt: x.created_at, periodStart: x.current_period_start, endsAt: x.current_period_end, trialEnd: x.trial_end,
          cancelAtPeriodEnd: x.cancel_at_period_end, cancelledAt: x.cancelled_at,
        })),
      };
    }, ctx, { readOnly: true });
  }

  async transactions(ctx: TenantContext, q: { status?: string; search?: string; subscription?: string; cursor?: string; limit: number }) {
    const c = decodeCursor(q.cursor);
    return this.tx.inTenant(async (db) => {
      const summary = (await db.query(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'COMPLETED')::int AS successful,
                count(*) FILTER (WHERE status IN ('FAILED','CANCELLED','PAST_DUE'))::int AS failed,
                coalesce(sum(total_minor) FILTER (WHERE status = 'COMPLETED'), 0)::bigint AS paid_minor,
                (array_agg(DISTINCT currency))[1] AS currency
           FROM (${TX_SELECT}) t`)).rows[0];
      const r = await db.query(
        `SELECT * FROM (${TX_SELECT}) t
          WHERE ($1::text IS NULL OR t.status = $1)
            AND ($2::text IS NULL OR t.id::text ILIKE $2 OR t.invoice_number ILIKE $2)
            AND ($3::text IS NULL OR t.subscription_id::text ILIKE $3)
            AND ($4::timestamptz IS NULL OR (t.created_at, t.id) < ($4, $5::uuid))
          ORDER BY t.created_at DESC, t.id DESC LIMIT $6`,
        [q.status ?? null, q.search ? likePattern(q.search) : null, q.subscription ? likePattern(q.subscription) : null, c?.t ?? null, c?.id ?? null, q.limit + 1]);
      return {
        summary: { total: summary.total, successful: summary.successful, failed: summary.failed, paidMinorUnits: Number(summary.paid_minor), currency: summary.currency ?? 'INR' },
        ...paginate(r.rows.map(txView), q.limit, (v) => ({ t: v.createdAt, id: v.id })),
      };
    }, ctx, { readOnly: true });
  }

  /** Every transaction (newest first, capped) for the CSV export. */
  async exportTransactions(ctx: TenantContext) {
    return this.tx.inTenant(async (db) => (await db.query(`${TX_SELECT} ORDER BY i.created_at DESC LIMIT 5000`)).rows.map(txView), ctx, { readOnly: true });
  }

  /** Printable invoice (the web renders it; "Save as PDF" from the print dialog). */
  async invoice(ctx: TenantContext, id: string) {
    return this.tx.inTenant(async (db) => {
      const x = (await db.query(
        `SELECT i.*, ${TX_STATUS_SQL} AS tx_status, o.name AS org_name, p.name AS plan_name, p.billing_interval
           FROM app.invoices i JOIN app.organizations o ON o.id = i.organization_id
           LEFT JOIN app.subscriptions s ON s.id = i.subscription_id LEFT JOIN app.subscription_plans p ON p.id = s.plan_id
          WHERE i.id = $1 AND i.status <> 'DRAFT'`, [id])).rows[0];
      if (!x) throw new WhatsAppError('NOT_FOUND', 'invoice not found');
      const payments = (await db.query(
        `SELECT id, provider, provider_payment_id, amount_minor, currency, status, method_type, paid_at, created_at
           FROM app.payments WHERE invoice_id = $1 ORDER BY created_at`, [id])).rows;
      return {
        id: x.id, number: x.invoice_number, status: x.tx_status, currency: x.currency, organizationName: x.org_name,
        description: x.plan_name ? `${x.plan_name} plan (${String(x.billing_interval).toLowerCase()}ly)` : 'Service',
        periodStart: x.period_start, periodEnd: x.period_end, issuedAt: x.issued_at, dueAt: x.due_at, paidAt: x.paid_at, subscriptionId: x.subscription_id,
        subtotalMinorUnits: Number(x.subtotal_minor), discountMinorUnits: Number(x.discount_minor), taxMinorUnits: Number(x.tax_minor),
        totalMinorUnits: Number(x.total_minor), amountPaidMinorUnits: Number(x.amount_paid_minor),
        payments: payments.map((p) => ({ id: p.id, provider: p.provider, reference: p.provider_payment_id, amountMinorUnits: Number(p.amount_minor),
          currency: p.currency, status: p.status, method: p.method_type, paidAt: p.paid_at, createdAt: p.created_at })),
      };
    }, ctx, { readOnly: true });
  }
}
