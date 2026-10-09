import type { TenantContext } from '../../database/tenant-context.js';
import type { Db, TransactionRunner } from '../../database/transaction-runner.js';
import { isPgError, PgCode } from '../../database/errors.js';
import { OpsRepository } from '../../repositories/ops.repository.js';
import { EntitlementService } from '../../services/entitlement.service.js';
import { WhatsAppError } from '../../whatsapp/domain/whatsapp-errors.js';
import { applyDefaults, validateSchema, type JsonSchema } from '../json-schema.js';
import { KNOWLEDGE_INGEST_REQUESTED } from '../knowledge/ingestion.js';
import type { ModelProviderRegistry } from '../model/model-provider.js';
import { DEFAULT_MODEL_PROVIDER, defaultModelName } from '../model/providers-from-env.js';
import { DEFAULT_HANDOFF, DEFAULT_TONE, loadDraftSnapshot, type HandoffSettings, type ToneSettings } from '../runtime/assistant-config.js';
import { PLATFORM_INSTRUCTIONS_VERSION, renderAssistantLayers } from '../runtime/prompt-builder.js';
import { CONFIRM_TOOL_KEY } from '../tools/registry.js';
import { starterKnowledge } from '../../havan/knowledge/starter-knowledge.js';
import { computeReadiness, KNOWN_REQUIREMENT_KEYS } from './readiness.js';

const TEMPLATE_PUBLIC_COLS = `t.id, t.key, t.version, t.name, t.description AS "shortDescription", t.long_description AS "longDescription", t.category,
  t.marketplace_category AS "marketplaceCategory", t.industry, t.icon_key AS "iconKey", t.welcome_behavior AS "welcome",
  t.supported_languages AS "supportedLanguages", t.demo_conversations AS "demoConversations", t.setup_requirements AS "setupRequirements",
  t.recommended_for AS "recommendedFor", t.setup_minutes AS "setupMinutes", t.display_order AS "displayOrder"`;

const STATUS_TRANSITIONS: Record<string, string[]> = { PAUSED: ['ACTIVE'], ACTIVE: ['PAUSED'], ARCHIVED: ['DRAFT', 'TESTING', 'PAUSED', 'ACTIVE'] };
const LANG_RE = /^[a-z]{2,3}(-[A-Z]{2})?$/;

function pick<T extends string>(v: unknown, allowed: readonly T[], field: string): T | undefined {
  if (v === undefined) return undefined;
  if (!allowed.includes(v as T)) throw new WhatsAppError('VALIDATION_FAILED', `${field} must be one of ${allowed.join(', ')}`);
  return v as T;
}
const str = (v: unknown, field: string, max: number, min = 0): string | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.trim().length < min || v.length > max) throw new WhatsAppError('VALIDATION_FAILED', `${field} must be ${min}-${max} characters`);
  return v.trim();
};

export interface AssistantPatch {
  name?: unknown; description?: unknown; tone?: Record<string, unknown>; primaryLanguage?: unknown; supportedLanguages?: unknown;
  customInstructions?: unknown; instructionsMode?: unknown; welcome?: Record<string, unknown>; handoff?: Record<string, unknown>; responseWaitMs?: unknown;
}

/**
 * Dashboard management of AI assistants (hs_app, tenant context from the
 * request). Platform templates are READ-ONLY here: installing COPIES template
 * data into the tenant's own ai_agents / ai_agent_tools rows.
 */
export class AssistantAdminService {
  private readonly ops = new OpsRepository();
  private readonly entitlements = new EntitlementService();

  constructor(private readonly tx: TransactionRunner, private readonly models: ModelProviderRegistry) {}

  // ------------------------------------------------------------- catalog ---
  async catalog(): Promise<unknown[]> {
    return this.tx.inTenant(async (db) => {
      const t = (await db.query(`SELECT ${TEMPLATE_PUBLIC_COLS} FROM app.ai_assistant_templates t WHERE t.status = 'ACTIVE' ORDER BY t.display_order, t.name`)).rows;
      const caps = await this.templateCapabilities(db, t.map((x) => x.id));
      return t.map((x) => ({ ...x, capabilities: caps.get(x.id) ?? [] }));
    }, undefined, { readOnly: true });
  }

  async template(key: string): Promise<unknown> {
    return this.tx.inTenant(async (db) => {
      const t = (await db.query(`SELECT ${TEMPLATE_PUBLIC_COLS} FROM app.ai_assistant_templates t WHERE t.key = $1 AND t.status = 'ACTIVE'`, [key])).rows[0];
      if (!t) throw new WhatsAppError('NOT_FOUND', 'template not found');
      return { ...t, capabilities: (await this.templateCapabilities(db, [t.id])).get(t.id) ?? [] };
    }, undefined, { readOnly: true });
  }

  private async templateCapabilities(db: Db, ids: string[]) {
    const r = await db.query(
      `SELECT tt.template_id, t.key, t.capability_name AS name, t.capability_description AS description, t.category, t.availability,
              tt.required, tt.default_enabled AS "defaultEnabled", tt.display_order
         FROM app.ai_template_tools tt JOIN app.ai_tools t ON t.id = tt.tool_id
        WHERE tt.template_id = ANY($1::uuid[]) AND t.status = 'ACTIVE' ORDER BY tt.display_order`, [ids]);
    const m = new Map<string, unknown[]>();
    for (const x of r.rows) {
      const { template_id: tid, display_order: _o, ...rest } = x;
      m.set(tid, [...(m.get(tid) ?? []), { ...rest, available: x.availability === 'READY' }]);
    }
    return m;
  }

  /** Platform-side validation for a template version (used by admin tooling and tests before publishing a version). */
  async validateTemplate(db: Db, templateId: string): Promise<string[]> {
    const problems: string[] = [];
    const t = (await db.query('SELECT key, base_system_prompt, demo_conversations, setup_requirements FROM app.ai_assistant_templates WHERE id = $1', [templateId])).rows[0];
    if (!t) return ['template not found'];
    if (!t.base_system_prompt?.trim()) problems.push('missing instructions');
    for (const r of t.setup_requirements ?? []) if (!KNOWN_REQUIREMENT_KEYS.has(r.key)) problems.push(`unknown setup requirement ${r.key}`);
    const tools = (await db.query(
      `SELECT t.key, t.availability, t.handler_key, t.config_schema, tt.required, tt.default_enabled, tt.default_configuration
         FROM app.ai_template_tools tt JOIN app.ai_tools t ON t.id = tt.tool_id WHERE tt.template_id = $1`, [templateId])).rows;
    const keys = new Set(tools.map((x) => x.key));
    for (const x of tools) {
      if (x.required && x.availability !== 'READY') problems.push(`required tool ${x.key} has no handler`);
      if (x.default_enabled && x.availability !== 'READY') problems.push(`tool ${x.key} enabled by default but not ready`);
      const issues = validateSchema(x.config_schema as JsonSchema, x.default_configuration);
      if (issues.length) problems.push(`${x.key} default configuration invalid: ${issues[0].message}`);
    }
    for (const conv of t.demo_conversations ?? []) {
      if (!Array.isArray(conv.messages) || conv.messages.length === 0) problems.push('empty demo conversation');
      for (const m of conv.messages ?? []) if (m.from === 'tool' && !keys.has(m.tool)) problems.push(`demo uses tool ${m.tool} that the template does not include`);
    }
    const deps = (await db.query(
      `SELECT a.key AS tool, b.key AS dep FROM app.ai_tool_dependencies d JOIN app.ai_tools a ON a.id = d.tool_id JOIN app.ai_tools b ON b.id = d.depends_on_tool_id
        WHERE d.relation = 'REQUIRES'`)).rows;
    for (const d of deps) if (keys.has(d.tool) && !keys.has(d.dep)) problems.push(`${d.tool} requires ${d.dep}`);
    return problems;
  }

  // ------------------------------------------------------------- install ---
  async install(ctx: TenantContext, input: { templateKey: string; businessId: string; name: string; tone?: Record<string, unknown>;
    primaryLanguage?: string; supportedLanguages?: string[]; capabilities?: Record<string, boolean>; customInstructions?: string }): Promise<{ id: string }> {
    const name = str(input.name, 'name', 100, 1)!;
    const created = await this.tx.inTenant(async (db) => {
      await this.entitlements.assertCanAdd(db, 'MAX_AI_AGENTS');
      const t = (await db.query(`SELECT * FROM app.ai_assistant_templates WHERE key = $1 AND status = 'ACTIVE'`, [input.templateKey])).rows[0];
      if (!t) throw new WhatsAppError('NOT_FOUND', 'template not found');
      const biz = (await db.query('SELECT id, timezone FROM app.businesses WHERE id = $1 AND deleted_at IS NULL', [input.businessId])).rows[0];
      if (!biz) throw new WhatsAppError('NOT_FOUND', 'business not found');
      if (ctx.businessId && ctx.businessId !== biz.id) throw new WhatsAppError('NOT_FOUND', 'business not found');
      const langs = input.supportedLanguages ?? t.supported_languages;
      const primary = input.primaryLanguage ?? langs[0] ?? 'en';
      if (![primary, ...langs].every((l) => LANG_RE.test(l)) || !langs.includes(primary)) throw new WhatsAppError('VALIDATION_FAILED', 'invalid languages');
      const tone = this.tone({ ...DEFAULT_TONE, ...(input.tone ?? {}) });
      const cfg = t.default_config ?? {};
      const a = (await db.query(
        `INSERT INTO app.ai_agents (organization_id, business_id, template_id, template_key, template_version, template_instructions, name, description,
                                    status, primary_language, supported_languages, timezone, tone_config, behavior_config, welcome_config, handoff_config,
                                    custom_instructions, human_handoff_enabled, auto_reply_enabled, model_provider, model_name, temperature, response_wait_ms, created_by_user_id)
         VALUES (app.current_org_id(), $1, $2, $3, $4, $5, $6, $7, 'DRAFT', $8, $9, $10, $11, $12, $13, $14, $15, true, false, $16, $17, NULL, $18, $19)
         RETURNING id`,
        [biz.id, t.id, t.key, t.version, t.base_system_prompt, name, t.description, primary, langs, biz.timezone, JSON.stringify(tone),
         JSON.stringify({ reasoningEffort: t.model_settings?.reasoningEffort ?? 'low', maxOutputTokens: t.model_settings?.maxOutputTokens ?? 700, confirmationTtlMinutes: 15 }),
         JSON.stringify(t.welcome_behavior ?? {}), JSON.stringify(DEFAULT_HANDOFF), input.customInstructions ? str(input.customInstructions, 'customInstructions', 40000) : null,
         DEFAULT_MODEL_PROVIDER, t.recommended_model ?? defaultModelName(), Number(cfg.response_wait_ms ?? 4000), ctx.userId ?? null])).rows[0];
      // Copy capabilities: template defaults (+ owner's choices for optional ones). NOT_READY tools are copied disabled.
      const tools = (await db.query(
        `SELECT tt.tool_id, t.key, t.availability, tt.required, tt.default_enabled, tt.default_configuration
           FROM app.ai_template_tools tt JOIN app.ai_tools t ON t.id = tt.tool_id WHERE tt.template_id = $1 AND t.status = 'ACTIVE'`, [t.id])).rows;
      for (const x of tools) {
        const wanted = x.required ? true : input.capabilities?.[x.key] ?? x.default_enabled;
        await db.query(`INSERT INTO app.ai_agent_tools (organization_id, ai_agent_id, tool_id, enabled, configuration) VALUES (app.current_org_id(), $1, $2, $3, $4)`,
          [a.id, x.tool_id, wanted && x.availability === 'READY', JSON.stringify(x.default_configuration ?? {})]);
      }
      // The confirmation mechanism is part of every assistant (loaded only while a confirmation is open).
      await db.query(
        `INSERT INTO app.ai_agent_tools (organization_id, ai_agent_id, tool_id, enabled) SELECT app.current_org_id(), $1, id, true FROM app.ai_tools WHERE key = $2
         ON CONFLICT (ai_agent_id, tool_id) DO NOTHING`, [a.id, CONFIRM_TOOL_KEY]);
      await this.audit(db, ctx, 'ASSISTANT_CREATED', a.id, { template_key: t.key, template_version: t.version, business_id: biz.id });
      await this.audit(db, ctx, 'TEMPLATE_INSTALLED', a.id, { template_key: t.key, template_version: t.version });
      return { id: a.id as string };
    }, ctx, { retries: 2 });
    // Researched starter knowledge (e.g. Havan Booking): copied into the tenant's knowledge so it is editable.
    // A plan without knowledge storage simply installs without it.
    if (starterKnowledge(input.templateKey).length) {
      await this.addStarterKnowledge(ctx, created.id).catch((err) => {
        if (!(err instanceof WhatsAppError)) throw err;
      });
    }
    return created;
  }

  // ---------------------------------------------------------------- read ---
  async list(ctx: TenantContext): Promise<unknown[]> {
    return this.tx.inTenant(async (db) => (await db.query(
      `SELECT a.id, a.name, a.status, a.business_id AS "businessId", b.name AS "businessName", a.template_key AS "templateKey",
              t.name AS "templateName", t.icon_key AS "iconKey", a.updated_at AS "updatedAt", a.published_version_id IS NOT NULL AS published,
              i.id AS "whatsappInstanceId", i.instance_name AS "whatsappName", i.status AS "whatsappStatus",
              (SELECT count(*)::int FROM app.ai_agent_tools x JOIN app.ai_tools tl ON tl.id = x.tool_id WHERE x.ai_agent_id = a.id AND x.enabled AND tl.key <> $2) AS "capabilityCount"
         FROM app.ai_agents a JOIN app.businesses b ON b.id = a.business_id
         LEFT JOIN app.ai_assistant_templates t ON t.id = a.template_id
         LEFT JOIN app.ai_agent_channels ch ON ch.ai_agent_id = a.id AND ch.enabled
         LEFT JOIN app.whatsapp_instances i ON i.id = ch.whatsapp_instance_id AND i.deleted_at IS NULL
        WHERE a.deleted_at IS NULL AND ($1::uuid IS NULL OR a.business_id = $1)
        ORDER BY a.status = 'ARCHIVED', a.updated_at DESC`, [ctx.businessId ?? null, CONFIRM_TOOL_KEY])).rows, ctx, { readOnly: true });
  }

  async get(ctx: TenantContext, id: string): Promise<Record<string, unknown>> {
    await this.tx.inTenant((db) => this.syncTemplateTools(db, id), ctx);
    return this.tx.inTenant(async (db) => {
      const a = (await db.query(
        `SELECT a.*, b.name AS business_name, t.name AS template_name, t.icon_key, t.version AS template_catalog_version,
                (SELECT max(version) FROM app.ai_assistant_templates x WHERE x.key = a.template_key AND x.status = 'ACTIVE') AS latest_template_version,
                v.version_number, v.published_at, v.configuration->>'configRevision' AS published_revision
           FROM app.ai_agents a JOIN app.businesses b ON b.id = a.business_id
           LEFT JOIN app.ai_assistant_templates t ON t.id = a.template_id
           LEFT JOIN app.ai_agent_versions v ON v.id = a.published_version_id
          WHERE a.id = $1 AND a.deleted_at IS NULL`, [id])).rows[0];
      if (!a || (ctx.businessId && a.business_id !== ctx.businessId)) throw new WhatsAppError('NOT_FOUND', 'assistant not found');
      const caps = (await db.query(
        `SELECT t.key, coalesce(t.capability_name, t.name) AS name, t.capability_description AS description, t.category, t.risk_level AS "riskLevel",
                t.is_read_only AS "readOnly", t.availability, t.config_schema AS "configSchema", t.requires_confirmation AS "confirmationDefault",
                at.enabled, at.configuration, coalesce(tt.required, false) AS required, coalesce(tt.display_order, 999) AS ord
           FROM app.ai_agent_tools at JOIN app.ai_tools t ON t.id = at.tool_id
           LEFT JOIN app.ai_template_tools tt ON tt.template_id = $2 AND tt.tool_id = t.id
          WHERE at.ai_agent_id = $1 AND t.key <> $3 AND t.status = 'ACTIVE' ORDER BY ord, t.key`, [id, a.template_id, CONFIRM_TOOL_KEY])).rows;
      const channel = (await db.query(
        `SELECT i.id, i.instance_name AS name, i.phone_e164 AS phone, i.status FROM app.ai_agent_channels ch
           JOIN app.whatsapp_instances i ON i.id = ch.whatsapp_instance_id WHERE ch.ai_agent_id = $1 AND ch.enabled AND i.deleted_at IS NULL`, [id])).rows[0] ?? null;
      return {
        id: a.id, name: a.name, description: a.description, status: a.status, businessId: a.business_id, businessName: a.business_name,
        template: a.template_key ? { key: a.template_key, name: a.template_name, iconKey: a.icon_key, installedVersion: a.template_version,
          latestVersion: a.latest_template_version, updateAvailable: a.latest_template_version !== null && a.latest_template_version > a.template_version } : null,
        tone: { ...DEFAULT_TONE, ...a.tone_config }, primaryLanguage: a.primary_language, supportedLanguages: a.supported_languages,
        customInstructions: a.custom_instructions, instructionsMode: a.instructions_mode, welcome: { enabled: true, guidedOptions: [], ...a.welcome_config },
        handoff: { ...DEFAULT_HANDOFF, ...a.handoff_config }, responseWaitMs: a.response_wait_ms, model: { provider: a.model_provider, name: a.model_name },
        capabilities: caps.map(({ ord: _o, configuration, ...c }) => ({ ...c, available: c.availability === 'READY',
          configuration: applyDefaults(c.configSchema as JsonSchema, configuration ?? {}) })),
        whatsapp: channel,
        publishedVersion: a.version_number ?? null, publishedAt: a.published_at ?? null,
        unpublishedChanges: a.published_version_id ? Number(a.published_revision) !== a.config_revision : true,
        createdAt: a.created_at, updatedAt: a.updated_at,
      };
    }, ctx, { readOnly: true });
  }

  // --------------------------------------------------------------- update ---
  private tone(t: Record<string, unknown>): ToneSettings {
    return {
      tone: pick(t.tone, ['FRIENDLY', 'PROFESSIONAL', 'WARM', 'CASUAL'] as const, 'tone') ?? DEFAULT_TONE.tone,
      formality: pick(t.formality, ['FORMAL', 'NEUTRAL', 'INFORMAL'] as const, 'formality') ?? DEFAULT_TONE.formality,
      responseLength: pick(t.responseLength, ['SHORT', 'MEDIUM', 'DETAILED'] as const, 'responseLength') ?? DEFAULT_TONE.responseLength,
      emoji: pick(t.emoji, ['NONE', 'LIGHT', 'EXPRESSIVE'] as const, 'emoji') ?? DEFAULT_TONE.emoji,
      languageMode: pick(t.languageMode, ['AUTO', 'FIXED'] as const, 'languageMode') ?? DEFAULT_TONE.languageMode,
      ...(t.greetingStyle !== undefined ? { greetingStyle: str(t.greetingStyle, 'greetingStyle', 300) } : {}),
    };
  }

  async update(ctx: TenantContext, id: string, p: AssistantPatch): Promise<Record<string, unknown>> {
    await this.tx.inTenant(async (db) => {
      const a = await this.lockAgent(db, ctx, id);
      const sets: string[] = [];
      const vals: unknown[] = [id];
      const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
      const changed: string[] = [];
      if (p.name !== undefined) { set('name', str(p.name, 'name', 100, 1)); changed.push('name'); }
      if (p.description !== undefined) { set('description', str(p.description, 'description', 500)); changed.push('description'); }
      if (p.tone) { set('tone_config', JSON.stringify(this.tone({ ...a.tone_config, ...p.tone }))); changed.push('tone'); }
      if (p.supportedLanguages !== undefined || p.primaryLanguage !== undefined) {
        const langs = (p.supportedLanguages ?? a.supported_languages) as string[];
        const primary = (p.primaryLanguage ?? a.primary_language) as string;
        if (!Array.isArray(langs) || langs.length < 1 || langs.length > 10 || !langs.every((l) => typeof l === 'string' && LANG_RE.test(l)) || !langs.includes(primary)) {
          throw new WhatsAppError('VALIDATION_FAILED', 'supportedLanguages must include primaryLanguage');
        }
        set('supported_languages', langs); set('primary_language', primary); changed.push('languages');
      }
      if (p.customInstructions !== undefined) { set('custom_instructions', p.customInstructions === null ? null : str(p.customInstructions, 'customInstructions', 40000)); changed.push('instructions'); }
      if (p.instructionsMode !== undefined) set('instructions_mode', pick(p.instructionsMode, ['SIMPLE', 'ADVANCED', 'CUSTOM_PROMPT'] as const, 'instructionsMode'));
      if (p.welcome) {
        const w = { ...a.welcome_config, ...p.welcome };
        if (typeof w.enabled !== 'boolean') throw new WhatsAppError('VALIDATION_FAILED', 'welcome.enabled must be boolean');
        const opts = w.guidedOptions ?? [];
        if (!Array.isArray(opts) || opts.length > 6 || !opts.every((o: unknown) => typeof o === 'string' && o.length >= 1 && o.length <= 40)) {
          throw new WhatsAppError('VALIDATION_FAILED', 'guidedOptions: up to 6 options of 1-40 characters');
        }
        set('welcome_config', JSON.stringify({ enabled: w.enabled, style: str(w.style ?? '', 'welcome.style', 300), guidedOptions: opts }));
        changed.push('welcome');
      }
      if (p.handoff) {
        const h = { ...DEFAULT_HANDOFF, ...a.handoff_config, ...p.handoff } as HandoffSettings;
        pick(h.takeover, ['PAUSE_AI', 'KEEP_AI'] as const, 'handoff.takeover');
        pick(h.resume, ['MANUAL', 'AUTO_AFTER', 'UNTIL_RESOLVED'] as const, 'handoff.resume');
        if (!Number.isInteger(h.resumeAfterMinutes) || h.resumeAfterMinutes < 5 || h.resumeAfterMinutes > 10080) throw new WhatsAppError('VALIDATION_FAILED', 'resumeAfterMinutes 5-10080');
        set('handoff_config', JSON.stringify({ takeover: h.takeover, resume: h.resume, resumeAfterMinutes: h.resumeAfterMinutes,
          ...(h.fallbackMessage ? { fallbackMessage: str(h.fallbackMessage, 'fallbackMessage', 500) } : {}) }));
        changed.push('handoff');
      }
      if (p.responseWaitMs !== undefined) {
        if (!Number.isInteger(p.responseWaitMs) || (p.responseWaitMs as number) < 0 || (p.responseWaitMs as number) > 30000) throw new WhatsAppError('VALIDATION_FAILED', 'responseWaitMs 0-30000');
        set('response_wait_ms', p.responseWaitMs); changed.push('response_wait');
      }
      if (!sets.length) return;
      sets.push('config_revision = config_revision + 1');
      await db.query(`UPDATE app.ai_agents SET ${sets.join(', ')} WHERE id = $1`, vals);
      // Audit names WHAT changed, never the instruction text itself.
      await this.audit(db, ctx, changed.includes('instructions') ? 'INSTRUCTIONS_UPDATED' : 'ASSISTANT_UPDATED', id,
        { fields: changed, ...(changed.includes('instructions') ? { instructions_length: String(p.customInstructions ?? '').length } : {}) });
    }, ctx);
    return this.get(ctx, id);
  }

  async setCapability(ctx: TenantContext, id: string, key: string, p: { enabled?: unknown; configuration?: unknown }): Promise<Record<string, unknown>> {
    await this.tx.inTenant(async (db) => {
      const a = await this.lockAgent(db, ctx, id);
      const row = (await db.query(
        `SELECT at.id, at.enabled, at.configuration, t.availability, t.status, t.config_schema, t.key, coalesce(tt.required, false) AS required
           FROM app.ai_agent_tools at JOIN app.ai_tools t ON t.id = at.tool_id
           LEFT JOIN app.ai_template_tools tt ON tt.template_id = $3 AND tt.tool_id = t.id
          WHERE at.ai_agent_id = $1 AND t.key = $2`, [id, key, a.template_id])).rows[0];
      if (!row || key === CONFIRM_TOOL_KEY) throw new WhatsAppError('NOT_FOUND', 'capability not found for this assistant');
      if (p.enabled !== undefined && typeof p.enabled !== 'boolean') throw new WhatsAppError('VALIDATION_FAILED', 'enabled must be boolean');
      if (p.enabled === true && (row.availability !== 'READY' || row.status !== 'ACTIVE')) throw new WhatsAppError('CONFLICT', 'This capability is not available yet.');
      if (p.enabled === false && row.required) throw new WhatsAppError('CONFLICT', 'This capability is required by the template.');
      let configuration = row.configuration;
      if (p.configuration !== undefined) {
        if (!p.configuration || typeof p.configuration !== 'object' || Array.isArray(p.configuration)) throw new WhatsAppError('VALIDATION_FAILED', 'configuration must be an object');
        const schema = { ...(row.config_schema as JsonSchema), additionalProperties: false };
        const issues = validateSchema(schema, p.configuration);
        if (issues.length) throw new WhatsAppError('VALIDATION_FAILED', `configuration: ${issues[0].path.replace('$.', '')} ${issues[0].message}`);
        configuration = p.configuration;
      }
      await db.query('UPDATE app.ai_agent_tools SET enabled = coalesce($2, enabled), configuration = $3 WHERE id = $1',
        [row.id, p.enabled ?? null, JSON.stringify(configuration)]);
      await db.query('UPDATE app.ai_agents SET config_revision = config_revision + 1 WHERE id = $1', [id]);
      const action = p.enabled === true && !row.enabled ? 'TOOL_ENABLED' : p.enabled === false && row.enabled ? 'TOOL_DISABLED' : 'TOOL_CONFIGURED';
      await this.audit(db, ctx, action, id, { tool: key });
    }, ctx);
    return this.get(ctx, id);
  }

  async setChannel(ctx: TenantContext, id: string, instanceId: string | null): Promise<Record<string, unknown>> {
    try {
      await this.tx.inTenant(async (db) => {
        const a = await this.lockAgent(db, ctx, id);
        await db.query('DELETE FROM app.ai_agent_channels WHERE ai_agent_id = $1', [id]);
        if (instanceId) {
          const i = (await db.query('SELECT id, business_id FROM app.whatsapp_instances WHERE id = $1 AND deleted_at IS NULL', [instanceId])).rows[0];
          if (!i) throw new WhatsAppError('NOT_FOUND', 'WhatsApp number not found');
          if (i.business_id !== a.business_id) throw new WhatsAppError('VALIDATION_FAILED', 'Choose a WhatsApp number of the same business');
          const other = (await db.query(
            `SELECT a.name FROM app.ai_agent_channels ch JOIN app.ai_agents a ON a.id = ch.ai_agent_id
              WHERE ch.whatsapp_instance_id = $1 AND ch.enabled AND ch.is_primary AND a.id <> $2 AND a.deleted_at IS NULL`, [instanceId, id])).rows[0];
          if (other) throw new WhatsAppError('CONFLICT', `This WhatsApp number already uses the assistant "${other.name}". Detach it there first.`);
          await db.query(
            `INSERT INTO app.ai_agent_channels (organization_id, business_id, ai_agent_id, channel_type, whatsapp_instance_id, is_primary, enabled)
             VALUES (app.current_org_id(), $1, $2, 'WHATSAPP', $3, true, true)`, [a.business_id, id, instanceId]);
        }
        await this.audit(db, ctx, 'WHATSAPP_CHANNEL_CHANGED', id, { whatsapp_instance_id: instanceId ?? 'none' });
      }, ctx);
    } catch (err) {
      if (isPgError(err, PgCode.UNIQUE_VIOLATION)) throw new WhatsAppError('CONFLICT', 'This WhatsApp number already has an assistant.');
      throw err;
    }
    return this.get(ctx, id);
  }

  async readiness(ctx: TenantContext, id: string) {
    return this.tx.inTenant(async (db) => {
      await this.visibleAgent(db, ctx, id);
      return computeReadiness(db, id, { modelConfigured: await this.modelConfigured(db, id) });
    }, ctx, { readOnly: true });
  }

  private async modelConfigured(db: Db, id: string): Promise<boolean> {
    const a = (await db.query('SELECT model_provider FROM app.ai_agents WHERE id = $1', [id])).rows[0];
    return Boolean(a && this.models.get(a.model_provider)?.configured);
  }

  /** Validate -> snapshot (immutable version) -> ACTIVE. Returns the checks when not publishable. */
  /**
   * Capabilities a template gained AFTER this assistant was created (e.g. the menu tools added to the
   * reservation template) are added to the draft with the template's default on/off. Existing rows and the
   * owner's choices are never touched; live chats change only when the owner publishes.
   */
  private async syncTemplateTools(db: Db, agentId: string): Promise<void> {
    await db.query(
      `INSERT INTO app.ai_agent_tools (organization_id, ai_agent_id, tool_id, enabled, configuration)
       SELECT a.organization_id, a.id, tt.tool_id, (tt.required OR tt.default_enabled) AND t.availability = 'READY', tt.default_configuration
         FROM app.ai_agents a JOIN app.ai_template_tools tt ON tt.template_id = a.template_id JOIN app.ai_tools t ON t.id = tt.tool_id AND t.status = 'ACTIVE'
        WHERE a.id = $1 AND a.deleted_at IS NULL
       ON CONFLICT (ai_agent_id, tool_id) DO NOTHING`, [agentId]);
  }

  async publish(ctx: TenantContext, id: string): Promise<{ published: boolean; version?: number; readiness: unknown }> {
    return this.tx.inTenant(async (db) => {
      await this.lockAgent(db, ctx, id);
      await this.syncTemplateTools(db, id);
      const readiness = await computeReadiness(db, id, { modelConfigured: await this.modelConfigured(db, id) });
      if (!readiness!.publishable) return { published: false, readiness };
      const snap = await loadDraftSnapshot(db, id);
      const n = (await db.query('SELECT coalesce(max(version_number), 0) + 1 AS n FROM app.ai_agent_versions WHERE ai_agent_id = $1', [id])).rows[0].n as number;
      const configuration = { ...snap!, status: 'ACTIVE', platformInstructionsVersion: PLATFORM_INSTRUCTIONS_VERSION };
      const v = (await db.query(
        `INSERT INTO app.ai_agent_versions (organization_id, ai_agent_id, version_number, effective_system_prompt, configuration, template_id, template_version,
                                            created_by_user_id, published_at)
         SELECT app.current_org_id(), a.id, $2, $3, $4, a.template_id, a.template_version, $5, now() FROM app.ai_agents a WHERE a.id = $1 RETURNING id`,
        [id, n, renderAssistantLayers(snap!), JSON.stringify(configuration), ctx.userId ?? null])).rows[0];
      await db.query(`UPDATE app.ai_agents SET published_version_id = $2, status = 'ACTIVE', auto_reply_enabled = true WHERE id = $1`, [id, v.id]);
      await this.audit(db, ctx, 'ASSISTANT_PUBLISHED', id, { version: String(n) });
      return { published: true, version: n, readiness };
    }, ctx);
  }

  async setStatus(ctx: TenantContext, id: string, status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED'): Promise<Record<string, unknown>> {
    await this.tx.inTenant(async (db) => {
      const a = await this.lockAgent(db, ctx, id);
      if (!STATUS_TRANSITIONS[status]?.includes(a.status)) throw new WhatsAppError('CONFLICT', `Cannot change a ${a.status.toLowerCase()} assistant to ${status.toLowerCase()}.`);
      if (status === 'ACTIVE' && !a.published_version_id) throw new WhatsAppError('CONFLICT', 'Publish the assistant first.');
      await db.query('UPDATE app.ai_agents SET status = $2, auto_reply_enabled = $3 WHERE id = $1', [id, status, status === 'ACTIVE']);
      if (status === 'ARCHIVED') await db.query('DELETE FROM app.ai_agent_channels WHERE ai_agent_id = $1', [id]);
      await this.audit(db, ctx, status === 'PAUSED' ? 'ASSISTANT_PAUSED' : status === 'ACTIVE' ? 'ASSISTANT_RESUMED' : 'ASSISTANT_ARCHIVED', id, {});
    }, ctx);
    return this.get(ctx, id);
  }

  // ------------------------------------------------------------ knowledge ---
  async listKnowledge(ctx: TenantContext, id: string): Promise<unknown[]> {
    return this.tx.inTenant(async (db) => {
      const a = await this.visibleAgent(db, ctx, id);
      return (await db.query(
        `SELECT id, type, title, status, error_message AS "error", chunk_count AS "chunks", content_bytes AS "bytes",
                CASE WHEN ai_agent_id IS NULL THEN 'BUSINESS' ELSE 'ASSISTANT' END AS scope, created_at AS "createdAt", updated_at AS "updatedAt"
           FROM app.knowledge_sources WHERE business_id = $1 AND deleted_at IS NULL AND (ai_agent_id IS NULL OR ai_agent_id = $2)
          ORDER BY created_at DESC LIMIT 200`, [a.business_id, id])).rows;
    }, ctx, { readOnly: true });
  }

  async addKnowledge(ctx: TenantContext, id: string, b: { type?: unknown; title?: unknown; content?: unknown; faqs?: unknown; scope?: unknown }): Promise<unknown> {
    const type = pick(b.type, ['TEXT', 'FAQ', 'CSV', 'PDF', 'DOCX', 'WEBSITE'] as const, 'type');
    if (!type) throw new WhatsAppError('VALIDATION_FAILED', 'type is required');
    if (['PDF', 'DOCX', 'WEBSITE'].includes(type)) throw new WhatsAppError('VALIDATION_FAILED', `${type} import is not available yet. Paste the text or add FAQs instead.`);
    const title = str(b.title, 'title', 300, 1)!;
    let content: string;
    if (type === 'FAQ') {
      if (!Array.isArray(b.faqs) || b.faqs.length < 1 || b.faqs.length > 200) throw new WhatsAppError('VALIDATION_FAILED', 'faqs: 1-200 question/answer pairs');
      content = b.faqs.map((f: any) => {
        const q = str(f?.q, 'question', 500, 2);
        const a = str(f?.a, 'answer', 3000, 1);
        return `Q: ${q}\nA: ${a}`;
      }).join('\n\n');
    } else {
      content = str(b.content, 'content', 500_000, 1)!;
    }
    const scope = pick(b.scope ?? 'ASSISTANT', ['ASSISTANT', 'BUSINESS'] as const, 'scope');
    const bytes = Buffer.byteLength(content, 'utf8');
    return this.tx.inTenant(async (db) => {
      const a = await this.lockAgent(db, ctx, id);
      await this.entitlements.assertSubscriptionActive(db);
      const ent = await this.entitlements.get(db, 'KNOWLEDGE_STORAGE_MB');
      if (!ent?.enabled) throw new WhatsAppError('FEATURE_NOT_IN_PLAN', 'Knowledge is not included in your plan');
      if (ent.limit !== null) {
        const used = Number((await db.query('SELECT coalesce(sum(content_bytes), 0)::bigint AS n FROM app.knowledge_sources WHERE deleted_at IS NULL')).rows[0].n);
        if (used + bytes > ent.limit * 1024 * 1024) throw new WhatsAppError('PLAN_LIMIT_REACHED', `Knowledge storage limit (${ent.limit} MB) reached`);
      }
      const s = (await db.query(
        `INSERT INTO app.knowledge_sources (organization_id, business_id, ai_agent_id, type, title, raw_content, content_bytes, created_by_user_id, checksum)
         VALUES (app.current_org_id(), $1, $2, $3, $4, $5, $6, $7, sha256(convert_to($5, 'UTF8'))) RETURNING id, status`,
        [a.business_id, scope === 'ASSISTANT' ? id : null, type, title, content, bytes, ctx.userId ?? null])).rows[0];
      await this.ops.enqueueOutbox(db, { organizationId: ctx.organizationId, eventType: KNOWLEDGE_INGEST_REQUESTED, aggregateType: 'KNOWLEDGE_SOURCE',
        aggregateId: s.id, payload: { source_id: s.id }, dedupeKey: `knowledge-ingest:${s.id}` });
      await this.ops.recordUsage(db, { organizationId: ctx.organizationId, businessId: a.business_id, eventType: 'KNOWLEDGE_BYTES', quantity: Math.max(bytes, 1),
        resourceType: 'KNOWLEDGE_SOURCE', resourceId: s.id, idempotencyKey: `knowledge:${s.id}` });
      await this.audit(db, ctx, 'KNOWLEDGE_ADDED', id, { source_id: s.id, type });
      return { id: s.id, status: s.status };
    }, ctx);
  }

  /**
   * Copies the template's researched starter knowledge (FAQ sources) into this
   * assistant. Idempotent: sources whose title already exists are skipped.
   */
  async addStarterKnowledge(ctx: TenantContext, id: string): Promise<{ added: number; skipped: number; available: number }> {
    const { templateKey, existing } = await this.tx.inTenant(async (db) => {
      const a = await this.visibleAgent(db, ctx, id);
      const t = (await db.query('SELECT template_key FROM app.ai_agents WHERE id = $1', [a.id])).rows[0];
      const titles = (await db.query(
        `SELECT title FROM app.knowledge_sources WHERE business_id = $1 AND deleted_at IS NULL AND (ai_agent_id IS NULL OR ai_agent_id = $2)`,
        [a.business_id, a.id])).rows.map((r) => r.title as string);
      return { templateKey: t?.template_key as string | null, existing: new Set(titles) };
    }, ctx, { readOnly: true });
    const pack = starterKnowledge(templateKey);
    let added = 0;
    for (const s of pack) {
      if (existing.has(s.title)) continue;
      await this.addKnowledge(ctx, id, { type: 'FAQ', title: s.title, faqs: s.faqs, scope: 'ASSISTANT' });
      added++;
    }
    return { added, skipped: pack.length - added, available: pack.length };
  }

  async deleteKnowledge(ctx: TenantContext, id: string, sourceId: string): Promise<{ deleted: boolean }> {
    return this.tx.inTenant(async (db) => {
      const a = await this.lockAgent(db, ctx, id);
      const r = await db.query(
        `UPDATE app.knowledge_sources SET deleted_at = now(), status = 'ARCHIVED', raw_content = NULL
          WHERE id = $1 AND business_id = $2 AND (ai_agent_id IS NULL OR ai_agent_id = $3) AND deleted_at IS NULL`, [sourceId, a.business_id, id]);
      if (!r.rowCount) throw new WhatsAppError('NOT_FOUND', 'knowledge source not found');
      await db.query('DELETE FROM app.knowledge_chunks WHERE knowledge_source_id = $1', [sourceId]);
      await this.audit(db, ctx, 'KNOWLEDGE_REMOVED', id, { source_id: sourceId });
      return { deleted: true };
    }, ctx);
  }

  // ------------------------------------------------------------- activity ---
  async activity(ctx: TenantContext, id: string): Promise<unknown> {
    return this.tx.inTenant(async (db) => {
      await this.visibleAgent(db, ctx, id);
      const tz = (await db.query('SELECT timezone FROM app.organizations WHERE id = app.current_org_id()')).rows[0]?.timezone ?? 'UTC';
      const today = (await db.query(
        `WITH day AS (SELECT (date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2) AS start)
         SELECT count(DISTINCT r.conversation_id)::int AS conversations,
                count(*) FILTER (WHERE r.outcome = 'REPLIED')::int AS replied,
                count(*) FILTER (WHERE r.outcome IN ('HANDOFF','FALLBACK'))::int AS handoffs,
                count(*)::int AS runs,
                (SELECT count(*)::int FROM app.bookings b, day WHERE b.ai_agent_id = $1 AND b.created_by_type = 'AI' AND b.created_at >= day.start) AS bookings,
                (SELECT count(*)::int FROM app.leads l, day WHERE l.ai_agent_id = $1 AND l.created_at >= day.start) AS leads
           FROM app.ai_runs r, day WHERE r.ai_agent_id = $1 AND r.created_at >= day.start`, [id, tz])).rows[0];
      const runs = (await db.query(
        `SELECT r.id, r.conversation_id AS "conversationId", r.status, r.outcome, r.error_code AS "errorCode", r.latency_ms AS "latencyMs",
                r.input_tokens AS "inputTokens", r.output_tokens AS "outputTokens", r.tool_iterations AS "toolIterations", r.created_at AS "createdAt",
                coalesce((SELECT json_agg(json_build_object('tool', t.key, 'status', c.status, 'errorCode', c.error_code, 'latencyMs', c.latency_ms) ORDER BY c.created_at)
                            FROM app.ai_tool_calls c JOIN app.ai_tools t ON t.id = c.tool_id WHERE c.ai_run_id = r.id), '[]') AS tools
           FROM app.ai_runs r WHERE r.ai_agent_id = $1 ORDER BY r.created_at DESC LIMIT 25`, [id])).rows;
      return { today, recentRuns: runs };
    }, ctx, { readOnly: true });
  }

  // -------------------------------------------------------------- helpers ---
  private async visibleAgent(db: Db, ctx: TenantContext, id: string) {
    const a = (await db.query('SELECT * FROM app.ai_agents WHERE id = $1 AND deleted_at IS NULL', [id])).rows[0];
    if (!a || (ctx.businessId && a.business_id !== ctx.businessId)) throw new WhatsAppError('NOT_FOUND', 'assistant not found');
    return a;
  }

  private async lockAgent(db: Db, ctx: TenantContext, id: string) {
    const a = (await db.query('SELECT * FROM app.ai_agents WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id])).rows[0];
    if (!a || (ctx.businessId && a.business_id !== ctx.businessId)) throw new WhatsAppError('NOT_FOUND', 'assistant not found');
    if (a.status === 'ARCHIVED') throw new WhatsAppError('CONFLICT', 'This assistant is archived.');
    return a;
  }

  private audit(db: Db, ctx: TenantContext, action: string, id: string, metadata: Record<string, unknown>) {
    return this.ops.audit(db, { organizationId: ctx.organizationId, actorType: ctx.apiKeyId ? 'API_KEY' : 'USER', actorUserId: ctx.userId,
      actorApiKeyId: ctx.apiKeyId, action, resourceType: 'AI_ASSISTANT', resourceId: id, requestId: ctx.requestId, metadata });
  }
}
