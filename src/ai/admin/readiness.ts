import type { Db } from '../../database/transaction-runner.js';
import { validateInstructions, type InstructionIssue } from './instruction-validator.js';

export interface ReadinessCheck { key: string; label: string; severity: 'REQUIRED' | 'RECOMMENDED'; ok: boolean; detail?: string; fix?: string; href?: string }
export interface Readiness {
  score: number;
  publishable: boolean;
  checks: ReadinessCheck[];
  capabilityErrors: string[];
  instructionIssues: InstructionIssue[];
  counts: { services: number; resources: number; locations: number; knowledgeReady: number; knowledgeTotal: number };
}

export const KNOWN_REQUIREMENT_KEYS = new Set(['BUSINESS_PROFILE', 'BUSINESS_HOURS', 'LOCATION', 'SERVICES', 'SERVICE_PRICES', 'RESOURCES', 'AVAILABILITY', 'KNOWLEDGE',
  'MENU', 'ORDERING_SETTINGS', 'DELIVERY_AREA', 'HAVAN_PACKAGES', 'PANDIT_CONTACT', 'TEMPLE_INFO']);

/** Dashboard page where the owner fixes each requirement. */
export const FIX_HREF: Record<string, string> = {
  BUSINESS_PROFILE: '/settings/business', BUSINESS_HOURS: '/settings/business', LOCATION: '/setup/locations', SERVICES: '/setup/services',
  SERVICE_PRICES: '/setup/services', RESOURCES: '/setup/resources', AVAILABILITY: '/setup/availability', KNOWLEDGE: '?tab=knowledge',
  MENU: '/restaurant/menu', ORDERING_SETTINGS: '/restaurant/settings', DELIVERY_AREA: '/restaurant/settings', WHATSAPP: '?tab=whatsapp',
  HAVAN_PACKAGES: '?tab=havan&section=types', PANDIT_CONTACT: '?tab=havan&section=settings', TEMPLE_INFO: '?tab=havan&section=settings',
};

const HAVAN_AVAILABILITY_FIX = 'Havan -> Settings & calendar: set when a havan can be booked.';

const FIX: Record<string, string> = {
  BUSINESS_PROFILE: 'Settings -> Business: add a description or contact phone.',
  BUSINESS_HOURS: 'Settings -> Business: set your opening hours.',
  LOCATION: 'Business setup -> Branches: add your address.',
  SERVICES: 'Business setup -> Services: add at least one service.', SERVICE_PRICES: 'Business setup -> Services: add prices.',
  RESOURCES: 'Business setup -> Staff & tables: add who or what customers can book.', AVAILABILITY: 'Business setup -> Availability: set when customers can book.',
  KNOWLEDGE: 'Knowledge: add an FAQ or text about your business.', WHATSAPP: 'WhatsApp tab: choose the number this assistant answers.',
  MENU: 'Restaurant -> Menu: add dishes with prices.', ORDERING_SETTINGS: 'Restaurant -> Ordering settings: turn on ordering, delivery/pickup and payment.',
  DELIVERY_AREA: 'Restaurant -> Ordering settings: add delivery pincodes or a radius (and a branch map pin).',
  HAVAN_PACKAGES: 'Havan -> Havan types: save at least one of Samanya / Vishesh / Maha Vishesh havan.',
  PANDIT_CONTACT: 'Havan -> Settings: add the WhatsApp number of Pandit Ji for call-back requests and reminders.',
  TEMPLE_INFO: 'Havan -> Settings: add the temple address and darshan timings.',
};

/**
 * Publish validation: template setup requirements (data the assistant needs),
 * capability integrity (required/available/dependencies), WhatsApp channel,
 * model configuration, plan entitlement and the instruction review.
 */
export async function computeReadiness(db: Db, assistantId: string, opts: { modelConfigured: boolean }): Promise<Readiness | null> {
  const a = (await db.query(
    `SELECT a.id, a.business_id, a.custom_instructions, a.template_key, t.setup_requirements
       FROM app.ai_agents a LEFT JOIN app.ai_assistant_templates t ON t.id = a.template_id
      WHERE a.id = $1 AND a.deleted_at IS NULL`, [assistantId])).rows[0];
  if (!a) return null;
  const biz = a.business_id;
  const c = (await db.query(
    `SELECT (SELECT count(*)::int FROM app.services WHERE business_id = $1 AND active AND deleted_at IS NULL) AS services,
            (SELECT count(*)::int FROM app.services WHERE business_id = $1 AND active AND deleted_at IS NULL AND price_minor_units IS NOT NULL) AS priced,
            (SELECT count(*)::int FROM app.business_locations WHERE business_id = $1 AND deleted_at IS NULL AND status = 'ACTIVE') AS locations,
            (SELECT count(*)::int FROM app.availability_rules WHERE business_id = $1) AS rules,
            (SELECT count(*)::int FROM app.knowledge_sources WHERE business_id = $1 AND deleted_at IS NULL AND (ai_agent_id IS NULL OR ai_agent_id = $2) AND status = 'READY') AS kready,
            (SELECT count(*)::int FROM app.knowledge_sources WHERE business_id = $1 AND deleted_at IS NULL AND (ai_agent_id IS NULL OR ai_agent_id = $2)) AS ktotal,
            b.name, b.description, b.phone_e164, b.website, b.address, b.business_hours
       FROM app.businesses b WHERE b.id = $1`, [biz, assistantId])).rows[0];
  const requirements = (a.setup_requirements ?? []) as Array<{ key: string; label: string; severity: 'REQUIRED' | 'RECOMMENDED'; resourceTypes?: string[] }>;
  const checks: ReadinessCheck[] = [];
  // Havan templates keep bookable hours on the havan settings page.
  const havan = requirements.some((r) => r.key === 'HAVAN_PACKAGES');
  for (const r of requirements) {
    let ok = false;
    let detail: string | undefined;
    switch (r.key) {
      case 'BUSINESS_PROFILE': ok = Boolean(c.name && (c.description || c.phone_e164 || c.website)); break;
      case 'BUSINESS_HOURS': ok = Object.values(c.business_hours ?? {}).some((v) => Array.isArray(v) && v.length > 0); break;
      case 'LOCATION': ok = c.locations > 0 || Object.values(c.address ?? {}).some(Boolean); break;
      case 'SERVICES': ok = c.services > 0; detail = `${c.services} services`; break;
      case 'SERVICE_PRICES': ok = c.priced > 0; detail = `${c.priced} with prices`; break;
      case 'RESOURCES': {
        const n = (await db.query(
          `SELECT count(*)::int AS n FROM app.business_resources WHERE business_id = $1 AND active AND deleted_at IS NULL AND ($2::text[] IS NULL OR resource_type = ANY($2))`,
          [biz, r.resourceTypes?.length ? r.resourceTypes : null])).rows[0].n;
        ok = n > 0; detail = `${n} found`; break;
      }
      case 'AVAILABILITY': ok = c.rules > 0; break;
      case 'KNOWLEDGE': ok = c.kready > 0; detail = `${c.kready} ready`; break;
      case 'MENU': {
        const n = (await db.query(`SELECT count(*)::int AS n FROM app.menu_items WHERE business_id = $1 AND deleted_at IS NULL AND available`, [biz])).rows[0].n;
        ok = n > 0; detail = `${n} dishes`; break;
      }
      case 'ORDERING_SETTINGS': ok = Boolean((await db.query('SELECT enabled FROM app.ordering_settings WHERE business_id = $1', [biz])).rows[0]?.enabled); break;
      case 'DELIVERY_AREA': {
        const os = (await db.query('SELECT fulfillment_modes, delivery_pincodes, delivery_radius_km FROM app.ordering_settings WHERE business_id = $1', [biz])).rows[0];
        const delivers = os?.fulfillment_modes?.includes('DELIVERY');
        const pinned = (await db.query('SELECT 1 FROM app.business_locations WHERE business_id = $1 AND deleted_at IS NULL AND latitude IS NOT NULL LIMIT 1', [biz])).rows.length > 0;
        ok = !delivers || os.delivery_pincodes.length > 0 || (os.delivery_radius_km !== null && pinned);
        detail = !delivers ? 'no delivery' : undefined; break;
      }
      case 'HAVAN_PACKAGES': {
        const p = (await db.query(
          `SELECT count(*)::int AS n FROM app.havan_packages WHERE business_id = $1 AND active AND deleted_at IS NULL`, [biz])).rows[0];
        ok = p.n > 0; detail = `${p.n} havan types`; break;
      }
      case 'PANDIT_CONTACT':
        ok = Boolean((await db.query('SELECT pandit_whatsapp_e164 FROM app.havan_settings WHERE business_id = $1', [biz])).rows[0]?.pandit_whatsapp_e164); break;
      case 'TEMPLE_INFO': {
        const s = (await db.query('SELECT temple_address, darshan_timings FROM app.havan_settings WHERE business_id = $1', [biz])).rows[0];
        ok = Boolean(s?.temple_address && s?.darshan_timings); break;
      }
      default: ok = false; detail = 'Unknown requirement';
    }
    checks.push({ key: r.key, label: r.label, severity: r.severity, ok, detail, fix: ok ? undefined : havan && r.key === 'AVAILABILITY' ? HAVAN_AVAILABILITY_FIX : FIX[r.key],
      href: havan && r.key === 'AVAILABILITY' ? FIX_HREF.PANDIT_CONTACT : FIX_HREF[r.key] });
  }
  const channel = (await db.query(
    `SELECT i.id, i.instance_name, i.status FROM app.ai_agent_channels ch JOIN app.whatsapp_instances i ON i.id = ch.whatsapp_instance_id
      WHERE ch.ai_agent_id = $1 AND ch.enabled AND i.deleted_at IS NULL`, [assistantId])).rows[0];
  checks.push({ key: 'WHATSAPP', label: 'WhatsApp number selected', severity: 'REQUIRED', ok: Boolean(channel), fix: channel ? undefined : FIX.WHATSAPP,
    detail: channel ? `${channel.instance_name} (${String(channel.status).toLowerCase().replace(/_/g, ' ')})` : undefined, href: FIX_HREF.WHATSAPP });
  if (channel && channel.status !== 'CONNECTED') {
    checks.push({ key: 'WHATSAPP_CONNECTED', label: 'WhatsApp connected', severity: 'RECOMMENDED', ok: false,
      detail: 'You can publish now; replies start once the number is connected.' });
  }
  checks.push({ key: 'AI_MODEL', label: 'AI service available', severity: 'REQUIRED', ok: opts.modelConfigured,
    fix: opts.modelConfigured ? undefined : 'The AI service is not configured on this server (administrator: set OPENAI_API_KEY).' });
  const ent = (await db.query(`SELECT enabled FROM app.current_entitlement('MONTHLY_AI_MESSAGES')`)).rows[0];
  checks.push({ key: 'PLAN', label: 'Plan includes AI replies', severity: 'REQUIRED', ok: Boolean(ent?.enabled), fix: ent?.enabled ? undefined : 'Upgrade your plan to use AI replies.' });

  // Capability integrity.
  const caps = (await db.query(
    `SELECT t.key, t.availability, t.status, at.enabled, coalesce(tt.required, false) AS required
       FROM app.ai_agent_tools at JOIN app.ai_tools t ON t.id = at.tool_id
       LEFT JOIN app.ai_agents a ON a.id = at.ai_agent_id
       LEFT JOIN app.ai_template_tools tt ON tt.template_id = a.template_id AND tt.tool_id = t.id
      WHERE at.ai_agent_id = $1`, [assistantId])).rows;
  const enabled = new Set(caps.filter((x) => x.enabled).map((x) => x.key));
  const capabilityErrors: string[] = [];
  for (const x of caps) {
    if (x.required && !x.enabled) capabilityErrors.push(`${x.key} is required by the template`);
    if (x.enabled && (x.availability !== 'READY' || x.status !== 'ACTIVE')) capabilityErrors.push(`${x.key} is not available yet`);
  }
  const deps = (await db.query(
    `SELECT a.key AS tool, b.key AS dep FROM app.ai_tool_dependencies d JOIN app.ai_tools a ON a.id = d.tool_id JOIN app.ai_tools b ON b.id = d.depends_on_tool_id
      WHERE d.relation = 'REQUIRES'`)).rows;
  for (const d of deps) if (enabled.has(d.tool) && !enabled.has(d.dep)) capabilityErrors.push(`${d.tool} needs ${d.dep} enabled`);
  if (enabled.size === 0) capabilityErrors.push('No capabilities enabled');

  const instructionIssues = validateInstructions(a.custom_instructions, { handoffEnabled: enabled.has('HUMAN_HANDOFF'),
    medical: ['DOCTOR_APPOINTMENT', 'DENTAL_RECEPTIONIST'].includes(a.template_key) });
  const required = checks.filter((x) => x.severity === 'REQUIRED');
  const weight = (x: ReadinessCheck) => (x.severity === 'REQUIRED' ? 2 : 1);
  const total = checks.reduce((s, x) => s + weight(x), 0);
  const got = checks.reduce((s, x) => s + (x.ok ? weight(x) : 0), 0);
  return {
    score: total ? Math.round((got / total) * 100) : 100,
    publishable: required.every((x) => x.ok) && capabilityErrors.length === 0 && !instructionIssues.some((i) => i.severity === 'ERROR'),
    checks, capabilityErrors, instructionIssues,
    counts: { services: c.services, resources: (await db.query('SELECT count(*)::int AS n FROM app.business_resources WHERE business_id = $1 AND active AND deleted_at IS NULL', [biz])).rows[0].n,
      locations: c.locations, knowledgeReady: c.kready, knowledgeTotal: c.ktotal },
  };
}
