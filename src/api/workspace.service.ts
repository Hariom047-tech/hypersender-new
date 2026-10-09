import { decodeCursor, likePattern, paginate } from '../common/cursor.js';
import { isPgError, PgCode } from '../database/errors.js';
import type { MemberRole, TenantContext } from '../database/tenant-context.js';
import type { Db, TransactionRunner } from '../database/transaction-runner.js';
import { OpsRepository } from '../repositories/ops.repository.js';
import { EntitlementService } from '../services/entitlement.service.js';
import { toE164 } from '../whatsapp/domain/phone.js';
import { WhatsAppError } from '../whatsapp/domain/whatsapp-errors.js';
import type { RealtimeBus } from '../whatsapp/realtime/realtime-bus.js';
import { assertBusinessScope } from './auth/permissions.js';
import { CONVERSATION_VIEW_SQL, loadConversationView, MESSAGE_VIEW_SQL, toConversationView, toMessageView } from './views.js';

const ROLES: MemberRole[] = ['OWNER', 'ADMIN', 'MANAGER', 'AGENT', 'VIEWER'];

/** Business filter: an API key restricted to a business can never widen it. */
function businessFilter(ctx: TenantContext, requested?: string): string | null {
  if (ctx.businessId) {
    if (requested && requested !== ctx.businessId) throw new WhatsAppError('NOT_FOUND');
    return ctx.businessId;
  }
  return requested ?? null;
}

/**
 * Read models + small writes backing the dashboard. Every query runs through
 * TransactionRunner.inTenant, so RLS scopes it to the caller's organization;
 * explicit business filters narrow further. All lists are keyset-paginated.
 */
export class WorkspaceService {
  private readonly ops = new OpsRepository();
  private readonly entitlements = new EntitlementService();

  constructor(private readonly tx: TransactionRunner, private readonly bus: RealtimeBus) {}

  // ---------------------------------------------------------------- dashboard
  async dashboard(ctx: TenantContext, businessId?: string) {
    const b = businessFilter(ctx, businessId);
    return this.tx.inTenant(async (db) => {
      const tz = (await db.query('SELECT timezone FROM app.organizations WHERE id = app.current_org_id()')).rows[0]?.timezone ?? 'UTC';
      const r = await db.query(
        `WITH day AS (SELECT (date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2) AS start)
         SELECT
           (SELECT count(*)::int FROM app.whatsapp_instances WHERE deleted_at IS NULL AND ($1::uuid IS NULL OR business_id = $1)) AS instances,
           (SELECT count(*)::int FROM app.whatsapp_instances WHERE deleted_at IS NULL AND status = 'CONNECTED' AND ($1::uuid IS NULL OR business_id = $1)) AS connected,
           (SELECT count(*)::int FROM app.whatsapp_instances WHERE deleted_at IS NULL AND status IN ('DISCONNECTED','LOGGED_OUT','ERROR','RECONNECTING') AND ($1::uuid IS NULL OR business_id = $1)) AS needs_attention,
           (SELECT count(*)::int FROM app.conversations WHERE status IN ('OPEN','WAITING') AND ($1::uuid IS NULL OR business_id = $1)) AS open_conversations,
           (SELECT coalesce(sum(unread_count), 0)::int FROM app.conversations WHERE status <> 'CLOSED' AND ($1::uuid IS NULL OR business_id = $1)) AS unread,
           (SELECT coalesce(sum(quantity) FILTER (WHERE event_type = 'WHATSAPP_MESSAGE_IN'), 0)::int FROM app.usage_events, day
             WHERE organization_id = app.current_org_id() AND occurred_at >= day.start AND event_type IN ('WHATSAPP_MESSAGE_IN','WHATSAPP_MESSAGE_OUT')
               AND ($1::uuid IS NULL OR business_id = $1)) AS received_today,
           (SELECT coalesce(sum(quantity) FILTER (WHERE event_type = 'WHATSAPP_MESSAGE_OUT'), 0)::int FROM app.usage_events, day
             WHERE organization_id = app.current_org_id() AND occurred_at >= day.start AND event_type IN ('WHATSAPP_MESSAGE_IN','WHATSAPP_MESSAGE_OUT')
               AND ($1::uuid IS NULL OR business_id = $1)) AS sent_today,
           (SELECT count(*)::int FROM app.contacts WHERE deleted_at IS NULL AND ($1::uuid IS NULL OR business_id = $1)) AS contacts,
           (SELECT count(*)::int FROM app.webhook_endpoints e
              JOIN LATERAL (SELECT 1 FROM app.webhook_deliveries d WHERE d.webhook_endpoint_id = e.id AND d.created_at > now() - interval '24 hours'
                              AND d.status IN ('DEAD','RETRYING') LIMIT 1) f ON true
             WHERE e.deleted_at IS NULL) AS failing_webhooks,
           (SELECT count(*)::int FROM app.bookings, day WHERE organization_id = app.current_org_id() AND start_at >= day.start
               AND start_at < day.start + interval '1 day' AND status IN ('PENDING','CONFIRMED') AND ($1::uuid IS NULL OR business_id = $1)) AS bookings_today`,
        [b, tz]);
      const x = r.rows[0];
      return {
        timezone: tz,
        instances: { total: x.instances, connected: x.connected, needsAttention: x.needs_attention },
        conversations: { open: x.open_conversations, unreadMessages: x.unread },
        messagesToday: { received: x.received_today, sent: x.sent_today, total: x.received_today + x.sent_today },
        contacts: x.contacts, failingWebhooks24h: x.failing_webhooks, bookingsToday: x.bookings_today,
      };
    }, ctx, { readOnly: true });
  }

  // ------------------------------------------------------------ conversations
  async listConversations(ctx: TenantContext, q: { businessId?: string; instanceId?: string; filter?: string; search?: string; cursor?: string; limit: number }) {
    const b = businessFilter(ctx, q.businessId);
    const c = decodeCursor(q.cursor);
    // Status predicate is a CONSTANT picked from an allow-list (never user text), so the
    // planner can use the partial ordered index conversations_org_open_recent_idx (0016).
    const statusSql = q.filter === 'resolved' ? `status IN ('RESOLVED','CLOSED')` : q.filter === 'open' || q.filter === 'unread' ? `status IN ('OPEN','WAITING')` : 'true';
    return this.tx.inTenant(async (db) => {
      // Two steps: 1) keyset page of ids via the ordered index, 2) details for that page only.
      const r = await db.query(
        `WITH page AS (
           SELECT c.id, c.last_message_at FROM app.conversations c
            WHERE c.organization_id = app.current_org_id() AND ${statusSql.replace(/status/g, 'c.status')}
              AND ($1::uuid IS NULL OR c.business_id = $1) AND ($2::uuid IS NULL OR c.whatsapp_instance_id = $2)
              AND ($3 = false OR c.unread_count > 0)
              AND ($4::text IS NULL OR EXISTS (SELECT 1 FROM app.contacts s WHERE s.id = c.contact_id
                     AND (s.display_name ILIKE $4 OR s.profile_name ILIKE $4 OR s.phone_e164 LIKE $4)))
              AND ($5::timestamptz IS NULL OR (c.last_message_at, c.id) < ($5, $6::uuid))
            ORDER BY c.last_message_at DESC, c.id DESC LIMIT $7)
         ${CONVERSATION_VIEW_SQL} JOIN page ON page.id = c.id
          ORDER BY c.last_message_at DESC, c.id DESC`,
        [b, q.instanceId ?? null, q.filter === 'unread', q.search ? likePattern(q.search) : null, c?.t ?? null, c?.id ?? null, q.limit + 1]);
      return paginate(r.rows.map(toConversationView), q.limit, (v) => ({ t: v.lastMessageAt, id: v.id }));
    }, ctx, { readOnly: true });
  }

  async getConversation(ctx: TenantContext, id: string) {
    const v = await this.tx.inTenant((db) => loadConversationView(db, id), ctx, { readOnly: true });
    if (!v) throw new WhatsAppError('NOT_FOUND');
    assertBusinessScope(ctx, v.businessId);
    return v;
  }

  /** Newest first; the client renders oldest->newest. Keyset on (message_timestamp, id). */
  async listMessages(ctx: TenantContext, conversationId: string, q: { cursor?: string; limit: number }) {
    await this.getConversation(ctx, conversationId);
    const c = decodeCursor(q.cursor);
    return this.tx.inTenant(async (db) => {
      const r = await db.query(
        `${MESSAGE_VIEW_SQL}
          WHERE m.conversation_id = $1 AND ($2::timestamptz IS NULL OR (m.message_timestamp, m.id) < ($2, $3::uuid))
          ORDER BY m.message_timestamp DESC, m.id DESC LIMIT $4`, [conversationId, c?.t ?? null, c?.id ?? null, q.limit + 1]);
      return paginate(r.rows.map((x) => toMessageView(x)), q.limit, (v) => ({ t: v.timestamp, id: v.id }));
    }, ctx, { readOnly: true });
  }

  async markRead(ctx: TenantContext, id: string) {
    const v = await this.getConversation(ctx, id);
    const updated = await this.tx.inTenant(async (db) => {
      await db.query('UPDATE app.conversations SET unread_count = 0 WHERE id = $1 AND unread_count > 0', [id]);
      return loadConversationView(db, id);
    }, ctx);
    await this.publishConversation(ctx, v.businessId, updated!);
    return updated;
  }

  async setConversationStatus(ctx: TenantContext, id: string, status: 'OPEN' | 'RESOLVED') {
    const v = await this.getConversation(ctx, id);
    const updated = await this.tx.inTenant(async (db) => {
      await db.query(`UPDATE app.conversations SET status = $2 WHERE id = $1 AND status <> 'CLOSED'`, [id, status]);
      if (status === 'RESOLVED') {
        // Handoff policy UNTIL_RESOLVED: the assistant takes over again once the team resolves the chat.
        await db.query(
          `UPDATE app.conversations c SET handling_mode = 'AI', ai_paused_until = NULL
            WHERE c.id = $1 AND c.handling_mode = 'HUMAN' AND EXISTS (
              SELECT 1 FROM app.ai_agent_channels ch JOIN app.ai_agents a ON a.id = ch.ai_agent_id
               WHERE ch.whatsapp_instance_id = c.whatsapp_instance_id AND ch.enabled AND a.status = 'ACTIVE'
                 AND a.handoff_config->>'resume' = 'UNTIL_RESOLVED')`, [id]);
      }
      return loadConversationView(db, id);
    }, ctx);
    await this.publishConversation(ctx, v.businessId, updated!);
    return updated;
  }

  /**
   * Human takeover / resume from the inbox. HUMAN stops the assistant for this chat; AI resumes it
   * (and clears any pause). The worker re-checks this mode before every turn AND before sending.
   */
  async setHandlingMode(ctx: TenantContext, id: string, mode: 'AI' | 'HUMAN') {
    const v = await this.getConversation(ctx, id);
    const updated = await this.tx.inTenant(async (db) => {
      await db.query(`UPDATE app.conversations SET handling_mode = $2, ai_paused_until = NULL WHERE id = $1`, [id, mode]);
      if (mode === 'AI') {
        await db.query(`UPDATE app.ai_conversation_states SET handoff_reason = NULL, handoff_at = NULL WHERE conversation_id = $1`, [id]);
      }
      await db.query(
        `INSERT INTO app.audit_logs (organization_id, actor_type, actor_user_id, action, resource_type, resource_id, metadata)
         VALUES (app.current_org_id(), 'USER', $2, $3, 'CONVERSATION', $1, '{}'::jsonb)`,
        [id, ctx.userId ?? null, mode === 'HUMAN' ? 'CONVERSATION_TAKEN_OVER' : 'CONVERSATION_AI_RESUMED']);
      return loadConversationView(db, id);
    }, ctx);
    await this.publishConversation(ctx, v.businessId, updated!);
    return updated;
  }

  private async publishConversation(ctx: TenantContext, businessId: string, conversation: unknown): Promise<void> {
    await this.bus.publish({ type: 'conversation.updated', organizationId: ctx.organizationId, businessId, at: new Date().toISOString(),
                             data: { conversation } as Record<string, unknown> }).catch(() => undefined);
  }

  // -------------------------------------------------------------------- contacts
  async listContacts(ctx: TenantContext, q: { businessId?: string; search?: string; cursor?: string; limit: number }) {
    const b = businessFilter(ctx, q.businessId);
    const c = decodeCursor(q.cursor);
    return this.tx.inTenant(async (db) => {
      const r = await db.query(
        `SELECT ct.id, coalesce(ct.display_name, ct.profile_name) AS name, ct.phone_e164, ct.whatsapp_jid, ct.whatsapp_lid, ct.business_id,
                b.name AS business_name, ct.first_seen_at, ct.last_seen_at, ct.status,
                lc.id AS conversation_id, lc.last_message_at
           FROM app.contacts ct JOIN app.businesses b ON b.id = ct.business_id
           LEFT JOIN LATERAL (SELECT id, last_message_at FROM app.conversations cv WHERE cv.contact_id = ct.id
                              ORDER BY last_message_at DESC LIMIT 1) lc ON true
          WHERE ct.deleted_at IS NULL AND ($1::uuid IS NULL OR ct.business_id = $1)
            AND ($2::text IS NULL OR ct.display_name ILIKE $2 OR ct.profile_name ILIKE $2 OR ct.phone_e164 LIKE $2)
            AND ($3::timestamptz IS NULL OR (ct.last_seen_at, ct.id) < ($3, $4::uuid))
          ORDER BY ct.last_seen_at DESC, ct.id DESC LIMIT $5`,
        [b, q.search ? likePattern(q.search) : null, c?.t ?? null, c?.id ?? null, q.limit + 1]);
      const items = r.rows.map((x) => ({
        id: x.id, name: x.name, phone: x.phone_e164, identity: x.phone_e164 ?? String(x.whatsapp_jid).split('@')[0],
        identityType: String(x.whatsapp_jid).endsWith('@lid') ? 'LID' : 'PHONE', hasLid: Boolean(x.whatsapp_lid),
        businessId: x.business_id, businessName: x.business_name, status: x.status,
        firstSeenAt: x.first_seen_at, lastSeenAt: x.last_seen_at, lastConversationId: x.conversation_id, lastMessageAt: x.last_message_at,
      }));
      return paginate(items, q.limit, (v) => ({ t: v.lastSeenAt, id: v.id }));
    }, ctx, { readOnly: true });
  }

  async getContact(ctx: TenantContext, id: string) {
    return this.tx.inTenant(async (db) => {
      const r = await db.query(
        `SELECT ct.*, b.name AS business_name FROM app.contacts ct JOIN app.businesses b ON b.id = ct.business_id
          WHERE ct.id = $1 AND ct.deleted_at IS NULL`, [id]);
      const x = r.rows[0];
      if (!x) throw new WhatsAppError('NOT_FOUND');
      assertBusinessScope(ctx, x.business_id);
      const conversations = (await db.query(`${CONVERSATION_VIEW_SQL} WHERE c.contact_id = $1 ORDER BY c.last_message_at DESC LIMIT 20`, [id])).rows.map(toConversationView);
      const recent = (await db.query(`${MESSAGE_VIEW_SQL} WHERE m.contact_id = $1 ORDER BY m.message_timestamp DESC, m.id DESC LIMIT 20`, [id])).rows.map((m) => toMessageView(m, 500));
      const bookings = (await db.query(
        `SELECT id, booking_type AS "type", status, start_at AS "startAt", end_at AS "endAt", timezone FROM app.bookings
          WHERE contact_id = $1 ORDER BY start_at DESC LIMIT 20`, [id])).rows;
      // metadata is free-form JSON supplied by integrations: shallow, string-only rendering on the client.
      const metadata = Object.fromEntries(Object.entries(x.metadata ?? {}).slice(0, 50).map(([k, v]) => [k.slice(0, 64), typeof v === 'string' ? v.slice(0, 500) : JSON.stringify(v).slice(0, 500)]));
      return {
        id: x.id, name: x.display_name ?? x.profile_name, displayName: x.display_name, profileName: x.profile_name, email: x.email,
        phone: x.phone_e164, identity: { type: String(x.whatsapp_jid).endsWith('@lid') ? 'LID' : 'PHONE', value: x.phone_e164 ?? String(x.whatsapp_jid).split('@')[0], hasLid: Boolean(x.whatsapp_lid) },
        businessId: x.business_id, businessName: x.business_name, status: x.status, source: x.source,
        firstSeenAt: x.first_seen_at, lastSeenAt: x.last_seen_at, metadata, conversations, recentMessages: recent, bookings,
      };
    }, ctx, { readOnly: true });
  }

  // -------------------------------------------------------------- organization
  async getOrganization(ctx: TenantContext) {
    return this.tx.inTenant(async (db) => {
      const r = await db.query(
        `SELECT id, name, slug, status, timezone, country_code AS "countryCode", default_currency AS "currency", created_at AS "createdAt"
           FROM app.organizations WHERE id = app.current_org_id()`);
      return { ...r.rows[0], myRole: ctx.role ?? null };
    }, ctx, { readOnly: true });
  }

  async updateOrganization(ctx: TenantContext, p: { name?: string; timezone?: string; countryCode?: string; currency?: string }) {
    await this.tx.inTenant(async (db) => {
      const r = await db.query(
        `UPDATE app.organizations SET name = coalesce($1, name), timezone = coalesce($2, timezone),
                country_code = coalesce($3, country_code), default_currency = coalesce($4, default_currency)
          WHERE id = app.current_org_id() RETURNING id`, [p.name ?? null, p.timezone ?? null, p.countryCode ?? null, p.currency ?? null]);
      if (!r.rowCount) throw new WhatsAppError('FORBIDDEN', 'only owners and admins can update the organization');
      await this.ops.audit(db, { organizationId: ctx.organizationId, actorType: 'USER', actorUserId: ctx.userId, action: 'ORGANIZATION_UPDATED',
        resourceType: 'ORGANIZATION', resourceId: ctx.organizationId, requestId: ctx.requestId, metadata: { fields: Object.keys(p) } });
    }, ctx);
    return this.getOrganization(ctx);
  }

  // ----------------------------------------------------------------- businesses
  private static readonly BUSINESS_COLS = `id, name, legal_name AS "legalName", industry, description, phone_e164 AS "phone", email, website,
    timezone, currency, country_code AS "countryCode", address, business_hours AS "businessHours", status, created_at AS "createdAt"`;

  async listBusinesses(ctx: TenantContext) {
    return this.tx.inTenant(async (db) => (await db.query(
      `SELECT ${WorkspaceService.BUSINESS_COLS} FROM app.businesses WHERE deleted_at IS NULL AND ($1::uuid IS NULL OR id = $1) ORDER BY created_at`,
      [ctx.businessId ?? null])).rows, ctx, { readOnly: true });
  }

  async getBusiness(ctx: TenantContext, id: string) {
    assertBusinessScope(ctx, id);
    const r = await this.tx.inTenant((db) => db.query(`SELECT ${WorkspaceService.BUSINESS_COLS} FROM app.businesses WHERE id = $1 AND deleted_at IS NULL`, [id]), ctx, { readOnly: true });
    if (!r.rows[0]) throw new WhatsAppError('NOT_FOUND');
    return r.rows[0];
  }

  async upsertBusiness(ctx: TenantContext, id: string | null, p: BusinessInput) {
    const phone = p.phone ? toE164(p.phone, (p.countryCode ?? undefined) as never) : p.phone === '' ? null : undefined;
    const businessId = await this.tx.inTenant(async (db) => {
      try {
        if (id === null) {
          const r = await db.query(
            `INSERT INTO app.businesses (organization_id, name, industry, description, phone_e164, email, website, timezone, currency, country_code, address, business_hours)
             VALUES (app.current_org_id(), $1, $2, $3, $4, $5, $6, coalesce($7, 'UTC'), coalesce($8, 'INR'), $9, coalesce($10, '{}'::jsonb), coalesce($11, '{}'::jsonb))
             RETURNING id`,
            [p.name, p.industry ?? null, p.description ?? null, phone ?? null, p.email ?? null, p.website ?? null, p.timezone ?? null, p.currency ?? null,
             p.countryCode ?? null, p.address ? JSON.stringify(p.address) : null, p.businessHours ? JSON.stringify(p.businessHours) : null]);
          await this.ops.audit(db, { organizationId: ctx.organizationId, actorType: 'USER', actorUserId: ctx.userId, action: 'BUSINESS_CREATED',
            resourceType: 'BUSINESS', resourceId: r.rows[0].id, requestId: ctx.requestId });
          return r.rows[0].id as string;
        }
        const r = await db.query(
          `UPDATE app.businesses SET name = coalesce($2, name), industry = CASE WHEN $3::text = '' THEN NULL ELSE coalesce($3, industry) END,
                  description = coalesce($4, description), phone_e164 = CASE WHEN $5::boolean THEN $6 ELSE phone_e164 END,
                  email = CASE WHEN $7::text = '' THEN NULL ELSE coalesce($7, email) END, website = CASE WHEN $8::text = '' THEN NULL ELSE coalesce($8, website) END,
                  timezone = coalesce($9, timezone), currency = coalesce($10, currency), country_code = coalesce($11, country_code),
                  address = coalesce($12, address), business_hours = coalesce($13, business_hours)
            WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
          [id, p.name ?? null, p.industry ?? null, p.description ?? null, phone !== undefined, phone ?? null, p.email ?? null, p.website ?? null,
           p.timezone ?? null, p.currency ?? null, p.countryCode ?? null, p.address ? JSON.stringify(p.address) : null,
           p.businessHours ? JSON.stringify(p.businessHours) : null]);
        if (!r.rowCount) throw new WhatsAppError('NOT_FOUND');
        await this.ops.audit(db, { organizationId: ctx.organizationId, actorType: 'USER', actorUserId: ctx.userId, action: 'BUSINESS_UPDATED',
          resourceType: 'BUSINESS', resourceId: id, requestId: ctx.requestId, metadata: { fields: Object.keys(p) } });
        return id;
      } catch (err) {
        if (isPgError(err, PgCode.CHECK_VIOLATION)) throw new WhatsAppError('VALIDATION_FAILED', `invalid value (${(err as { constraint?: string }).constraint ?? 'check'})`);
        throw err;
      }
    }, ctx);
    return this.getBusiness(ctx, businessId);
  }

  // ------------------------------------------------------------------------ team
  async listMembers(ctx: TenantContext) {
    return this.tx.inTenant(async (db) => (await db.query(
      `SELECT m.user_id AS "userId", m.role, m.status, m.joined_at AS "joinedAt", m.created_at AS "invitedAt",
              u.email, nullif(btrim(coalesce(u.first_name,'') || ' ' || coalesce(u.last_name,'')), '') AS name
         FROM app.organization_members m JOIN app.users u ON u.id = m.user_id
        WHERE m.organization_id = app.current_org_id() AND m.status IN ('ACTIVE','INVITED','SUSPENDED')
        ORDER BY (m.role = 'OWNER') DESC, m.created_at`)).rows, ctx, { readOnly: true });
  }

  async invite(ctx: TenantContext, email: string, role: MemberRole) {
    if (!ROLES.includes(role)) throw new WhatsAppError('VALIDATION_FAILED', 'invalid role');
    if (role === 'OWNER' && ctx.role !== 'OWNER') throw new WhatsAppError('FORBIDDEN', 'only owners can invite owners');
    await this.tx.inTenant(async (db) => {
      await this.entitlements.assertCanAdd(db, 'TEAM_MEMBERS');
      const u = await db.query('SELECT app_auth.find_active_user_for_invite($1) AS id', [email]);
      const userId = u.rows[0]?.id;
      if (!userId) throw new WhatsAppError('NOT_FOUND', 'No account with this email. Ask them to register first, then invite them.');
      try {
        await db.query(`INSERT INTO app.organization_members (organization_id, user_id, role, status, invited_by_user_id)
                        VALUES (app.current_org_id(), $1, $2, 'INVITED', $3)`, [userId, role, ctx.userId]);
      } catch (err) {
        if (isPgError(err, PgCode.UNIQUE_VIOLATION)) throw new WhatsAppError('CONFLICT', 'This person is already a member or invited.');
        throw err;
      }
      await this.ops.audit(db, { organizationId: ctx.organizationId, actorType: 'USER', actorUserId: ctx.userId, action: 'TEAM_MEMBER_INVITED',
        resourceType: 'USER', resourceId: userId, requestId: ctx.requestId, metadata: { role } });
    }, ctx);
    return this.listMembers(ctx);
  }

  async changeRole(ctx: TenantContext, userId: string, role: MemberRole) {
    if (!ROLES.includes(role)) throw new WhatsAppError('VALIDATION_FAILED', 'invalid role');
    await this.tx.inTenant(async (db) => {
      const cur = await db.query('SELECT role FROM app.organization_members WHERE organization_id = app.current_org_id() AND user_id = $1', [userId]);
      if (!cur.rows[0]) throw new WhatsAppError('NOT_FOUND');
      if ((cur.rows[0].role === 'OWNER' || role === 'OWNER') && ctx.role !== 'OWNER') throw new WhatsAppError('FORBIDDEN', 'only owners can grant or change the owner role');
      try {
        const r = await db.query('UPDATE app.organization_members SET role = $2 WHERE organization_id = app.current_org_id() AND user_id = $1', [userId, role]);
        if (!r.rowCount) throw new WhatsAppError('FORBIDDEN');
      } catch (err) {
        if (isPgError(err, PgCode.CHECK_VIOLATION)) throw new WhatsAppError('CONFLICT', 'An organization must keep at least one owner.');
        throw err;
      }
      await this.ops.audit(db, { organizationId: ctx.organizationId, actorType: 'USER', actorUserId: ctx.userId, action: 'TEAM_MEMBER_ROLE_CHANGED',
        resourceType: 'USER', resourceId: userId, requestId: ctx.requestId, metadata: { from: cur.rows[0].role, to: role } });
    }, ctx);
    return this.listMembers(ctx);
  }

  async removeMember(ctx: TenantContext, userId: string) {
    await this.tx.inTenant(async (db) => {
      const cur = await db.query('SELECT role FROM app.organization_members WHERE organization_id = app.current_org_id() AND user_id = $1', [userId]);
      if (!cur.rows[0]) throw new WhatsAppError('NOT_FOUND');
      if (cur.rows[0].role === 'OWNER' && ctx.role !== 'OWNER') throw new WhatsAppError('FORBIDDEN', 'only owners can remove owners');
      try {
        const r = await db.query('DELETE FROM app.organization_members WHERE organization_id = app.current_org_id() AND user_id = $1', [userId]);
        if (!r.rowCount) throw new WhatsAppError('FORBIDDEN');
      } catch (err) {
        if (isPgError(err, PgCode.CHECK_VIOLATION)) throw new WhatsAppError('CONFLICT', 'An organization must keep at least one owner.');
        throw err;
      }
      await this.ops.audit(db, { organizationId: ctx.organizationId, actorType: 'USER', actorUserId: ctx.userId, action: 'TEAM_MEMBER_REMOVED',
        resourceType: 'USER', resourceId: userId, requestId: ctx.requestId });
    }, ctx);
    return { removed: true };
  }

  // -------------------------------------------------------------- usage / billing
  async usage(ctx: TenantContext, period: 'current' | 'previous') {
    return this.tx.inTenant(async (db) => {
      const tz = (await db.query('SELECT timezone FROM app.organizations WHERE id = app.current_org_id()')).rows[0].timezone;
      const r = await db.query(
        `WITH p AS (SELECT (date_trunc('month', now() AT TIME ZONE $1) - CASE WHEN $2 THEN interval '1 month' ELSE interval '0' END) AT TIME ZONE $1 AS start)
         SELECT p.start, (p.start AT TIME ZONE $1 + interval '1 month') AT TIME ZONE $1 AS "end",
                coalesce(jsonb_object_agg(t.code, coalesce(u.total, 0)), '{}'::jsonb) AS totals
           FROM p CROSS JOIN app.usage_event_types t
           LEFT JOIN LATERAL (SELECT sum(quantity)::bigint AS total FROM app.usage_events e
                               WHERE e.organization_id = app.current_org_id() AND e.event_type = t.code
                                 AND e.occurred_at >= p.start AND e.occurred_at < (p.start AT TIME ZONE $1 + interval '1 month') AT TIME ZONE $1) u ON true
          GROUP BY p.start`, [tz, period === 'previous']);
      const x = r.rows[0];
      return { period, timezone: tz, from: x.start, to: x.end, totals: x.totals, aiEnabled: false };
    }, ctx, { readOnly: true });
  }

  async billing(ctx: TenantContext) {
    return this.tx.inTenant(async (db) => {
      const s = (await db.query(
        `SELECT s.status, s.provider, s.current_period_start AS "periodStart", s.current_period_end AS "periodEnd", s.trial_end AS "trialEnd",
                s.cancel_at_period_end AS "cancelAtPeriodEnd", p.code AS "planCode", p.name AS "planName", p.price_minor_units AS "priceMinorUnits",
                p.currency, p.billing_interval AS "interval"
           FROM app.subscriptions s JOIN app.subscription_plans p ON p.id = s.plan_id
          WHERE s.organization_id = app.current_org_id() ORDER BY s.created_at DESC LIMIT 1`)).rows[0] ?? null;
      const invoices = (await db.query(
        `SELECT id, invoice_number AS "number", status, currency, total_minor AS "totalMinorUnits", issued_at AS "issuedAt", paid_at AS "paidAt"
           FROM app.invoices ORDER BY created_at DESC LIMIT 24`)).rows;
      return { subscription: s, entitlements: await this.entitlements.summary(db), invoices,
               paymentsEnabled: false, paymentsNote: 'Online plan changes and payments are not enabled yet.' };
    }, ctx, { readOnly: true });
  }

  // -------------------------------------------------------------- audit / notifications
  async auditLog(ctx: TenantContext, q: { cursor?: string; limit: number }) {
    const c = decodeCursor(q.cursor);
    return this.tx.inTenant(async (db) => {
      const r = await db.query(
        `SELECT a.id, a.created_at, a.actor_type, a.action, a.resource_type, a.resource_id, a.metadata,
                coalesce(nullif(btrim(coalesce(u.first_name,'') || ' ' || coalesce(u.last_name,'')), ''), u.email) AS actor_name,
                k.key_prefix AS actor_key
           FROM app.audit_logs a LEFT JOIN app.users u ON u.id = a.actor_user_id LEFT JOIN app.api_keys k ON k.id = a.actor_api_key_id
          WHERE a.organization_id = app.current_org_id() AND ($1::timestamptz IS NULL OR (a.created_at, a.id) < ($1, $2::uuid))
          ORDER BY a.created_at DESC, a.id DESC LIMIT $3`, [c?.t ?? null, c?.id ?? null, q.limit + 1]);
      const items = r.rows.map((x) => ({ id: x.id, at: x.created_at, actorType: x.actor_type, actor: x.actor_name ?? x.actor_key ?? null,
        action: x.action, resourceType: x.resource_type, resourceId: x.resource_id, metadata: x.metadata }));
      return paginate(items, q.limit, (v) => ({ t: v.at, id: v.id }));
    }, ctx, { readOnly: true });
  }

  async notifications(ctx: TenantContext, q: { cursor?: string; limit: number; unreadOnly: boolean }) {
    const c = decodeCursor(q.cursor);
    return this.tx.inTenant(async (db) => {
      const r = await db.query(
        `SELECT id, type, title, body, data, read_at, created_at FROM app.notifications
          WHERE ($1 = false OR read_at IS NULL) AND ($2::timestamptz IS NULL OR (created_at, id) < ($2, $3::uuid))
          ORDER BY created_at DESC, id DESC LIMIT $4`, [q.unreadOnly, c?.t ?? null, c?.id ?? null, q.limit + 1]);
      const unread = (await db.query('SELECT count(*)::int AS n FROM app.notifications WHERE read_at IS NULL')).rows[0].n;
      const items = r.rows.map((x) => ({ id: x.id, type: x.type, title: x.title, body: x.body,
        instanceId: x.data?.instance_id ?? null, webhookEndpointId: x.data?.webhook_endpoint_id ?? null, readAt: x.read_at, createdAt: x.created_at }));
      return { ...paginate(items, q.limit, (v) => ({ t: v.createdAt, id: v.id })), unread };
    }, ctx, { readOnly: true });
  }

  async markNotificationsRead(ctx: TenantContext, id?: string) {
    await this.tx.inTenant((db) => db.query(`UPDATE app.notifications SET read_at = now() WHERE read_at IS NULL AND ($1::uuid IS NULL OR id = $1)`, [id ?? null]), ctx);
    return { ok: true };
  }

  // ------------------------------------------------------------ instance activity
  async instanceActivity(ctx: TenantContext, instanceId: string, q: { cursor?: string; limit: number }) {
    const c = decodeCursor(q.cursor);
    return this.tx.inTenant(async (db) => {
      const inst = await db.query('SELECT business_id FROM app.whatsapp_instances WHERE id = $1', [instanceId]);
      if (!inst.rows[0]) throw new WhatsAppError('WHATSAPP_INSTANCE_NOT_FOUND');
      assertBusinessScope(ctx, inst.rows[0].business_id);
      const r = await db.query(
        `SELECT id, event_type, previous_status, new_status, reason, metadata, created_at FROM app.whatsapp_instance_events
          WHERE instance_id = $1 AND ($2::timestamptz IS NULL OR (created_at, id) < ($2, $3::uuid))
          ORDER BY created_at DESC, id DESC LIMIT $4`, [instanceId, c?.t ?? null, c?.id ?? null, q.limit + 1]);
      // Only allow-listed, non-sensitive metadata leaves the server.
      const safe = (m: Record<string, unknown>) => Object.fromEntries(Object.entries(m ?? {})
        .filter(([k]) => ['attempt', 'delay_ms', 'method', 'expires_at', 'signal_keys_deleted', 'reconnect_attempts'].includes(k)));
      const items = r.rows.map((x) => ({ id: x.id, type: x.event_type, previousStatus: x.previous_status, status: x.new_status,
        reason: x.reason, details: safe(x.metadata), at: x.created_at }));
      return paginate(items, q.limit, (v) => ({ t: v.at, id: v.id }));
    }, ctx, { readOnly: true });
  }
}

export interface BusinessInput {
  name?: string; industry?: string; description?: string; phone?: string; email?: string; website?: string;
  timezone?: string; currency?: string; countryCode?: string; address?: Record<string, string>; businessHours?: Record<string, unknown>;
}
