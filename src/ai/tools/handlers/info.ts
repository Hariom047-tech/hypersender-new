import type { Db } from '../../../database/transaction-runner.js';
import { fail, ok, withDb, type AssistantTool, type ToolDeps, type ToolExecutionContext, type ToolOutcome } from '../types.js';
import { clip, DAY_KEYS, DAY_NAMES, localLabel, money, searchWords } from './format.js';

/*
 * Read-only business capabilities. Every query is scoped to ctx.businessId
 * (explicit filter) inside a tenant transaction (RLS on organization). Ids the
 * model passes (service_id, resource_id) are looked up under that scope, so a
 * foreign tenant's/business's id simply resolves to NOT_FOUND.
 */

async function business(db: Db, ctx: ToolExecutionContext) {
  const r = await db.query(
    `SELECT name, description, industry, phone_e164, email, website, address, timezone, currency, business_hours
       FROM app.businesses WHERE id = $1 AND deleted_at IS NULL`, [ctx.businessId]);
  return r.rows[0] ?? null;
}

function addressText(a: Record<string, string> | null | undefined): string | null {
  if (!a) return null;
  const parts = [a.line1, a.line2, a.city, a.state, a.postalCode, a.country].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

export const getBusinessInfo: AssistantTool = {
  handlerKey: 'business.info', isReadOnly: true,
  async execute(ctx, _input, deps) {
    const b = await withDb(ctx, deps, (db) => business(db, ctx));
    if (!b) return fail('NOT_FOUND', 'business not found');
    return ok({ business: { name: b.name, description: clip(b.description, 600), industry: b.industry, phone: b.phone_e164, email: b.email,
      website: b.website, address: addressText(b.address), timezone: b.timezone, currency: b.currency } });
  },
};

export const getBusinessHours: AssistantTool<{ date?: string }> = {
  handlerKey: 'business.hours', isReadOnly: true,
  async execute(ctx, input, deps) {
    return withDb(ctx, deps, async (db) => {
      const b = await business(db, ctx);
      if (!b) return fail('NOT_FOUND');
      const hours = (b.business_hours ?? {}) as Record<string, Array<[string, string]>>;
      const weekly = DAY_KEYS.map((k, i) => ({ day: DAY_NAMES[i], open: Boolean(hours[k]?.length),
        ranges: (hours[k] ?? []).map(([from, to]) => ({ from, to })) }));
      const configured = weekly.some((d) => d.open);
      if (!configured) return fail('HOURS_NOT_CONFIGURED', 'The business has not published opening hours.');
      let date: Record<string, unknown> | undefined;
      if (input.date) {
        const dow = (new Date(`${input.date}T12:00:00Z`).getUTCDay() + 6) % 7; // 0 = Monday
        const closedAllDay = await db.query(
          `SELECT reason FROM app.availability_exceptions
            WHERE business_id = $1 AND resource_id IS NULL AND type IN ('HOLIDAY','BLOCKED')
              AND tstzrange(start_at, end_at, '[)') @> tstzrange(($2::date)::timestamp AT TIME ZONE $3, (($2::date + 1)::timestamp AT TIME ZONE $3), '[)')`,
          [ctx.businessId, input.date, b.timezone]);
        date = closedAllDay.rows[0]
          ? { date: input.date, day: DAY_NAMES[dow], open: false, reason: clip(closedAllDay.rows[0].reason, 120) ?? 'Closed' }
          : { date: input.date, day: DAY_NAMES[dow], open: weekly[dow].open, ranges: weekly[dow].ranges };
      }
      return ok({ timezone: b.timezone, weekly, ...(date ? { date } : {}) });
    });
  },
};

export const getBusinessLocation: AssistantTool = {
  handlerKey: 'business.location', isReadOnly: true,
  async execute(ctx, _input, deps) {
    return withDb(ctx, deps, async (db) => {
      const r = await db.query(
        `SELECT name, address, phone_e164, latitude, longitude, is_primary FROM app.business_locations
          WHERE business_id = $1 AND deleted_at IS NULL AND status = 'ACTIVE' ORDER BY is_primary DESC, name LIMIT 10`, [ctx.businessId]);
      const locations = r.rows.map((l) => ({ name: l.name, address: addressText(l.address), phone: l.phone_e164, primary: l.is_primary,
        mapUrl: l.latitude !== null && l.longitude !== null ? `https://maps.google.com/?q=${Number(l.latitude)},${Number(l.longitude)}` : null }));
      if (locations.length === 0) {
        const b = await business(db, ctx);
        const addr = addressText(b?.address);
        if (!addr) return fail('LOCATION_NOT_CONFIGURED', 'The business has not published an address.');
        locations.push({ name: b.name, address: addr, phone: b.phone_e164, primary: true, mapUrl: null });
      }
      return ok({ locations });
    });
  },
};

const SERVICE_COLS = `s.id, s.name, s.description, s.duration_minutes, s.price_minor_units, s.currency`;
const serviceView = (s: any, detail = false) => ({
  id: s.id, name: s.name, description: clip(s.description, detail ? 800 : 160), durationMinutes: s.duration_minutes,
  price: money(s.price_minor_units, s.currency),
});

export const getServices: AssistantTool<{ query?: string; limit?: number }> = {
  handlerKey: 'catalog.services', isReadOnly: true,
  async execute(ctx, input, deps) {
    return withDb(ctx, deps, async (db) => {
      const r = await db.query(
        `SELECT ${SERVICE_COLS} FROM app.services s
          WHERE s.business_id = $1 AND s.active AND s.deleted_at IS NULL
            AND ($2::text IS NULL OR s.name ILIKE '%' || $2 || '%' OR s.description ILIKE '%' || $2 || '%')
          ORDER BY s.name LIMIT $3`, [ctx.businessId, input.query?.trim() || null, input.limit ?? 15]);
      if (r.rows.length === 0) return fail(input.query ? 'NO_MATCH' : 'NO_SERVICES', input.query ? 'No service matches that name.' : 'No services are listed.');
      return ok({ services: r.rows.map((s) => serviceView(s)) });
    });
  },
};

async function serviceById(db: Db, ctx: ToolExecutionContext, id: string) {
  const r = await db.query(`SELECT ${SERVICE_COLS} FROM app.services s WHERE s.id = $1 AND s.business_id = $2 AND s.active AND s.deleted_at IS NULL`,
    [id, ctx.businessId]);
  return r.rows[0] ?? null;
}

export const getServiceDetails: AssistantTool<{ service_id: string }> = {
  handlerKey: 'catalog.service_details', isReadOnly: true,
  async execute(ctx, input, deps) {
    return withDb(ctx, deps, async (db) => {
      const s = await serviceById(db, ctx, input.service_id);
      if (!s) return fail('NOT_FOUND', 'No such service.');
      const providers = await db.query(
        `SELECT r.id, r.name, r.resource_type FROM app.resource_services rs JOIN app.business_resources r ON r.id = rs.resource_id
          WHERE rs.service_id = $1 AND r.active AND r.deleted_at IS NULL ORDER BY r.name LIMIT 20`, [s.id]);
      return ok({ service: { ...serviceView(s, true), providedBy: providers.rows.map((p) => ({ id: p.id, name: p.name, type: p.resource_type })) } });
    });
  },
};

export const getServicePrice: AssistantTool<{ service_id?: string; query?: string }> = {
  handlerKey: 'catalog.service_price', isReadOnly: true,
  async execute(ctx, input, deps): Promise<ToolOutcome> {
    if (!input.service_id && !input.query) return fail('INVALID_ARGUMENTS', 'Provide service_id or query.');
    return withDb(ctx, deps, async (db) => {
      const rows = input.service_id
        ? [await serviceById(db, ctx, input.service_id)].filter(Boolean)
        : (await db.query(
            `SELECT ${SERVICE_COLS} FROM app.services s
              WHERE s.business_id = $1 AND s.active AND s.deleted_at IS NULL AND s.name ILIKE '%' || $2 || '%'
              ORDER BY length(s.name), s.name LIMIT 5`, [ctx.businessId, input.query!.trim()])).rows;
      if (rows.length === 0) return fail('NOT_FOUND', 'No matching service in the price list.');
      const prices = rows.map((s) => ({ serviceId: s.id, name: s.name, durationMinutes: s.duration_minutes,
        price: money(s.price_minor_units, s.currency), priceListed: s.price_minor_units !== null }));
      return ok({ prices, note: prices.some((p) => !p.priceListed) ? 'Some services have no listed price: do not quote one.' : undefined });
    });
  },
};

export const getResources: AssistantTool<{ service_id?: string; resource_type?: string; query?: string }> = {
  handlerKey: 'catalog.resources', isReadOnly: true,
  async execute(ctx, input, deps) {
    return withDb(ctx, deps, async (db) => {
      const r = await db.query(
        `SELECT r.id, r.name, r.resource_type, r.description, r.capacity FROM app.business_resources r
          WHERE r.business_id = $1 AND r.active AND r.deleted_at IS NULL
            AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM app.resource_services rs WHERE rs.resource_id = r.id AND rs.service_id = $2))
            AND ($3::text IS NULL OR r.resource_type = upper($3))
            AND ($4::text IS NULL OR r.name ILIKE '%' || $4 || '%')
          ORDER BY r.name LIMIT 25`,
        [ctx.businessId, input.service_id ?? null, input.resource_type ?? null, input.query?.trim() || null]);
      if (r.rows.length === 0) return fail('NOT_FOUND', 'No matching staff or resources.');
      return ok({ resources: r.rows.map((x) => ({ id: x.id, name: x.name, type: x.resource_type, description: clip(x.description, 160), capacity: x.capacity })) });
    });
  },
};

export const searchKnowledge: AssistantTool<{ query: string; limit?: number }> = {
  handlerKey: 'knowledge.search', isReadOnly: true, timeoutMs: 10_000,
  async execute(ctx, input, deps) {
    const limit = Math.min(input.limit ?? Number(ctx.config.maxResults ?? 4), 8);
    let vector: number[] | null = null;
    if (deps.embedder?.configured) {
      try { [vector] = await deps.embedder.embed([input.query], 8_000); } catch { vector = null; } // fall back to keywords
    }
    return withDb(ctx, deps, async (db) => {
      const scope = { organizationId: ctx.organizationId, businessId: ctx.businessId, aiAgentId: ctx.assistantId };
      let chunks = vector ? await deps.knowledge.search(db, { ...scope, embedding: vector, embeddingModel: deps.embedder!.model, limit }) : [];
      chunks = chunks.filter((c) => c.distance < 0.75);
      if (chunks.length === 0) chunks = await deps.knowledge.searchLexical(db, { ...scope, words: searchWords(input.query), limit });
      if (chunks.length === 0) return fail('NO_RESULTS', 'Nothing relevant in the business knowledge.');
      const titles = await deps.knowledge.sourceTitles(db, [...new Set(chunks.map((c) => c.knowledgeSourceId))]);
      return ok({ results: chunks.map((c) => ({ source: c.title ?? titles.get(c.knowledgeSourceId) ?? 'Knowledge', text: clip(c.content, 1200) })) });
    });
  },
};

export const getCustomerContext: AssistantTool = {
  handlerKey: 'customer.context', isReadOnly: true,
  async execute(ctx, _input, deps) {
    if (!ctx.contactId) {
      return ok({ customer: { name: ctx.sandboxCustomer?.name ?? null, returning: false, upcomingBookings: [], openEnquiry: null, sandbox: true } });
    }
    return withDb(ctx, deps, async (db) => {
      const c = (await db.query(
        `SELECT coalesce(display_name, profile_name) AS name, phone_e164 IS NOT NULL AS has_phone, first_seen_at,
                (SELECT count(*)::int FROM app.conversations v WHERE v.contact_id = c.id) AS conversations
           FROM app.contacts c WHERE c.id = $1 AND c.business_id = $2`, [ctx.contactId, ctx.businessId])).rows[0];
      if (!c) return fail('NOT_FOUND');
      const bookings = await db.query(
        `SELECT b.id, b.start_at, b.timezone, b.status, s.name AS service, r.name AS resource
           FROM app.bookings b LEFT JOIN app.services s ON s.id = b.service_id LEFT JOIN app.business_resources r ON r.id = b.resource_id
          WHERE b.contact_id = $1 AND b.business_id = $2 AND b.status IN ('PENDING','CONFIRMED') AND b.start_at > now()
          ORDER BY b.start_at LIMIT 3`, [ctx.contactId, ctx.businessId]);
      const lead = await deps.leads.getOpen(db, ctx.businessId, ctx.contactId!);
      const memory = await deps.ordering.memory(db, ctx.businessId, ctx.contactId!);
      return ok({ customer: {
        name: c.name, knownPhone: c.has_phone, returning: c.conversations > 1, customerSince: c.first_seen_at,
        upcomingBookings: bookings.rows.map((b) => ({ id: b.id, status: b.status, service: b.service, with: b.resource, startAt: b.start_at, local: localLabel(b.start_at, b.timezone) })),
        openEnquiry: lead ? { intent: lead.intent, interest: lead.interest, location: lead.location, qualification: lead.qualification } : null,
        preferences: memory.preferences, savedAddresses: memory.savedAddresses, recentOrders: memory.recentOrders,
      } });
    });
  },
};

// ------------------------------------------------------------------ leads ---
type LeadInput = { intent?: 'BUY' | 'RENT' | 'SELL' | 'INVEST' | 'ENQUIRY' | 'OTHER'; interest?: string; property_type?: string; location?: string;
  bedrooms?: number; budget_min?: number; budget_max?: number; timeline?: string; qualification?: 'WARM' | 'HOT' | 'COLD' | 'UNQUALIFIED'; notes?: string };

const toFields = (i: LeadInput, currency: string) => ({
  intent: i.intent, interest: i.interest, propertyType: i.property_type, location: i.location, bedrooms: i.bedrooms,
  budgetMinMinor: i.budget_min !== undefined ? Math.round(i.budget_min * 100) : undefined,
  budgetMaxMinor: i.budget_max !== undefined ? Math.round(i.budget_max * 100) : undefined,
  currency: i.budget_min !== undefined || i.budget_max !== undefined ? currency : undefined,
  timeline: i.timeline, qualification: i.qualification, notes: i.notes,
});

const leadOut = (l: any) => ({ id: l.id, status: l.status, intent: l.intent, interest: l.interest, propertyType: l.propertyType, location: l.location,
  bedrooms: l.bedrooms, budgetMin: l.budgetMinMinor === null ? null : l.budgetMinMinor / 100, budgetMax: l.budgetMaxMinor === null ? null : l.budgetMaxMinor / 100,
  currency: l.currency, timeline: l.timeline, qualification: l.qualification });

function leadTool(handlerKey: 'lead.create' | 'lead.update'): AssistantTool<LeadInput> {
  return {
    handlerKey, isReadOnly: false,
    async execute(ctx, input, deps) {
      if (!ctx.contactId) return fail('NO_CUSTOMER');
      const res = await deps.leads.upsert({ ...ctx.dbContext, organizationId: ctx.organizationId }, {
        businessId: ctx.businessId, contactId: ctx.contactId, conversationId: ctx.conversationId, aiAgentId: ctx.assistantId,
        source: 'AI_WHATSAPP', idempotencyKey: ctx.idempotencyKey, fields: toFields(input, ctx.currency), createOnly: handlerKey === 'lead.update' ? false : undefined,
      });
      if (!res.lead) return fail('NO_OPEN_LEAD', 'No open enquiry to update; create one first.');
      if (res.lead.qualification === 'HOT' && ctx.config.notifyTeamOnHot !== false && deps.notifications) {
        await deps.notifications.notifyAdmins(ctx.organizationId, { type: 'AI_HOT_LEAD', dedupeKey: `hot-lead:${res.lead.id}`,
          title: 'Hot lead from WhatsApp', body: clip([res.lead.intent, res.lead.propertyType, res.lead.location].filter(Boolean).join(' · '), 180) ?? 'New qualified lead',
          data: { lead_id: res.lead.id, conversation_id: ctx.conversationId } }).catch(() => undefined);
      }
      return ok({ lead: leadOut(res.lead), created: res.created }, { leadId: res.lead.id, wrote: true });
    },
    async dryRun(ctx, input) {
      return ok({ dryRun: true, wouldSave: { ...toFields(input, ctx.currency) } });
    },
  };
}
export const createLead = leadTool('lead.create');
export const updateLead = leadTool('lead.update');

export const getLead: AssistantTool = {
  handlerKey: 'lead.get', isReadOnly: true,
  async execute(ctx, _input, deps: ToolDeps) {
    if (!ctx.contactId) return ok({ lead: null });
    const lead = await withDb(ctx, deps, (db) => deps.leads.getOpen(db, ctx.businessId, ctx.contactId!));
    return ok({ lead: lead ? leadOut(lead) : null });
  },
};
