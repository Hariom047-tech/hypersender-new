import type { Db } from '../../database/transaction-runner.js';

/** Owner-facing behaviour settings (validated on save; stored in ai_agents *_config columns). */
export interface ToneSettings {
  tone: 'FRIENDLY' | 'PROFESSIONAL' | 'WARM' | 'CASUAL';
  formality: 'FORMAL' | 'NEUTRAL' | 'INFORMAL';
  responseLength: 'SHORT' | 'MEDIUM' | 'DETAILED';
  emoji: 'NONE' | 'LIGHT' | 'EXPRESSIVE';
  languageMode: 'AUTO' | 'FIXED';
  greetingStyle?: string;
}
export interface WelcomeSettings { enabled: boolean; style?: string; guidedOptions: string[] }
export interface HandoffSettings {
  /** What a genuine human reply (dashboard or phone) does to the AI. */
  takeover: 'PAUSE_AI' | 'KEEP_AI';
  /** How the AI comes back after a takeover/handoff. */
  resume: 'MANUAL' | 'AUTO_AFTER' | 'UNTIL_RESOLVED';
  resumeAfterMinutes: number;
  fallbackMessage?: string;
}

export const DEFAULT_TONE: ToneSettings = { tone: 'FRIENDLY', formality: 'NEUTRAL', responseLength: 'SHORT', emoji: 'LIGHT', languageMode: 'AUTO' };
export const DEFAULT_HANDOFF: HandoffSettings = { takeover: 'PAUSE_AI', resume: 'MANUAL', resumeAfterMinutes: 120 };

/** Everything the runtime needs about an assistant. Snapshotted into ai_agent_versions.configuration on publish. */
export interface AssistantSnapshot {
  assistantId: string;
  organizationId: string;
  businessId: string;
  name: string;
  status: string;
  templateKey: string | null;
  templateVersion: number | null;
  templateInstructions: string | null;
  customInstructions: string | null;
  /** SIMPLE/ADVANCED = added to the template; CUSTOM_PROMPT = replaces the template's instructions. */
  instructionsMode: 'SIMPLE' | 'ADVANCED' | 'CUSTOM_PROMPT';
  tone: ToneSettings;
  languages: { primary: string; supported: string[] };
  welcome: WelcomeSettings;
  handoff: HandoffSettings;
  responseWaitMs: number;
  maxToolIterations: number;
  model: { provider: string; name: string; temperature: number | null; reasoningEffort: 'minimal' | 'low' | 'medium' | 'high'; maxOutputTokens: number };
  defaults: { bookingType?: string; resourceTypes?: string[]; requiresPartySize?: boolean; resourceLabel?: string };
  tools: Array<{ key: string; config: Record<string, unknown> }>;
  confirmationTtlMinutes: number;
  configRevision: number;
}

const obj = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {});

/** Current (draft) configuration of an assistant, read under the caller's tenant transaction. */
export async function loadDraftSnapshot(db: Db, assistantId: string): Promise<AssistantSnapshot | null> {
  const r = await db.query(
    `SELECT a.*, t.default_config AS template_config, t.model_settings AS template_model
       FROM app.ai_agents a LEFT JOIN app.ai_assistant_templates t ON t.id = a.template_id
      WHERE a.id = $1 AND a.deleted_at IS NULL`, [assistantId]);
  const a = r.rows[0];
  if (!a) return null;
  const tools = await db.query(
    `SELECT t.key, at.configuration FROM app.ai_agent_tools at JOIN app.ai_tools t ON t.id = at.tool_id
      WHERE at.ai_agent_id = $1 AND at.enabled ORDER BY t.key`, [assistantId]);
  const tc = obj(a.template_config);
  const tm = obj(a.template_model);
  const behavior = obj(a.behavior_config);
  return {
    assistantId: a.id, organizationId: a.organization_id, businessId: a.business_id, name: a.name, status: a.status,
    templateKey: a.template_key, templateVersion: a.template_version, templateInstructions: a.template_instructions,
    customInstructions: a.custom_instructions,
    instructionsMode: a.instructions_mode ?? 'SIMPLE',
    tone: { ...DEFAULT_TONE, ...obj(a.tone_config) } as ToneSettings,
    languages: { primary: a.primary_language, supported: a.supported_languages },
    welcome: { enabled: true, guidedOptions: [], ...obj(a.welcome_config) } as WelcomeSettings,
    handoff: { ...DEFAULT_HANDOFF, ...obj(a.handoff_config) } as HandoffSettings,
    responseWaitMs: a.response_wait_ms, maxToolIterations: a.max_tool_iterations,
    model: { provider: a.model_provider, name: a.model_name, temperature: a.temperature === null ? null : Number(a.temperature),
      reasoningEffort: behavior.reasoningEffort ?? tm.reasoningEffort ?? 'low', maxOutputTokens: Number(behavior.maxOutputTokens ?? tm.maxOutputTokens ?? 700) },
    defaults: { bookingType: tc.booking_type, resourceTypes: tc.resource_types, requiresPartySize: Boolean(tc.requires_party_size), resourceLabel: tc.resource_label },
    tools: tools.rows.map((x) => ({ key: x.key, config: obj(x.configuration) })),
    confirmationTtlMinutes: Number(behavior.confirmationTtlMinutes ?? 15),
    configRevision: a.config_revision,
  };
}
