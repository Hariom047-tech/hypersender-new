import type { DbContext } from '../../database/tenant-context.js';
import type { Db, TransactionRunner } from '../../database/transaction-runner.js';
import type { KnowledgeRepository } from '../../repositories/knowledge.repository.js';
import type { BookingService } from '../../services/booking.service.js';
import type { LeadService } from '../../services/lead.service.js';
import type { NotificationService } from '../../services/notification.service.js';
import type { OpsRepository } from '../../repositories/ops.repository.js';
import type { OrderingService } from '../../ordering/ordering.service.js';
import type { EmbeddingProvider } from '../model/model-provider.js';
import type { GoogleCalendarService } from '../../integrations/google-calendar.js';

export type ToolMode = 'LIVE' | 'DRY_RUN';
export type ToolRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

/**
 * Trusted execution context. Built ONLY from backend state (the claimed
 * conversation, the assistant row, the authenticated tester) - never from model
 * output. The model cannot name an organization, business, contact or
 * conversation: those are fixed here.
 */
export interface ToolExecutionContext {
  readonly organizationId: string;
  readonly businessId: string;
  readonly assistantId: string;
  readonly conversationId: string | null;
  readonly contactId: string | null;
  readonly whatsappInstanceId: string | null;
  /** ai_runs.id (live) or the sandbox turn id. */
  readonly requestId: string;
  readonly toolCallId: string;
  /** Stable key for write tools: identical retries of the same run never duplicate effects. */
  readonly idempotencyKey: string;
  readonly mode: ToolMode;
  /** DB session context for this process's role (hs_worker live; hs_app + user for the sandbox). */
  readonly dbContext: DbContext;
  readonly timezone: string;
  readonly currency: string;
  readonly now: Date;
  /** Per-assistant tool configuration, validated and defaults applied. */
  readonly config: Record<string, unknown>;
  /** Template defaults such as booking_type / resource_types. */
  readonly assistantDefaults: { bookingType?: string; resourceTypes?: string[]; requiresPartySize?: boolean };
  /** Sandbox only: the simulated customer and its test session (owner of a sandbox cart). */
  readonly sandboxCustomer?: { name?: string };
  readonly testSessionId?: string;
  readonly signal: AbortSignal;
}

/** Structured, machine-readable tool result (what the model sees). */
export type ToolResult = { success: boolean; errorCode?: string; message?: string; dryRun?: boolean } & Record<string, unknown>;

/** Backend side effects the runtime must react to (never shown to the model). */
export interface ToolEffects { handoff?: boolean; paused?: boolean; bookingId?: string; leadId?: string; wrote?: boolean }

export interface ToolOutcome { result: ToolResult; effects?: ToolEffects }

/** What a confirmation-requiring tool shows the customer before it may run. */
export type ConfirmationPreview = { ok: true; text: string; details: Record<string, unknown> } | { ok: false; outcome: ToolOutcome };

export interface ToolDeps {
  tx: TransactionRunner;
  bookings: BookingService;
  leads: LeadService;
  knowledge: KnowledgeRepository;
  ops: OpsRepository;
  notifications?: NotificationService;
  embedder?: EmbeddingProvider;
  ordering: OrderingService;
  /** Pandit Ji's connected Google Calendar (havan tools). Absent = no calendar checks. */
  calendar?: GoogleCalendarService;
}

/**
 * One backend capability. Key/description/schemas/risk live in the platform
 * catalog (app.ai_tools); this object is the implementation bound to it by
 * handler_key. Start-up validation checks the two agree (isReadOnly).
 */
export interface AssistantTool<I = Record<string, unknown>> {
  readonly handlerKey: string;
  readonly isReadOnly: boolean;
  /**
   * Draft-state tools (cart edits, quotes) that are safe to really execute in the Test Assistant
   * because they only touch the test session's own cart - never orders, bookings or customers.
   */
  readonly sandboxSafe?: boolean;
  /** Timeout for one execution (normalised to TOOL_TIMEOUT). */
  readonly timeoutMs?: number;
  execute(ctx: ToolExecutionContext, input: I, deps: ToolDeps): Promise<ToolOutcome>;
  /** Required for write tools: validate everything, write nothing. */
  dryRun?(ctx: ToolExecutionContext, input: I, deps: ToolDeps): Promise<ToolOutcome>;
  /** Required for tools that may need customer confirmation: validate and describe, write nothing. */
  preview?(ctx: ToolExecutionContext, input: I, deps: ToolDeps): Promise<ConfirmationPreview>;
}

export const ok = (data: Record<string, unknown> = {}, effects?: ToolEffects): ToolOutcome => ({ result: { success: true, ...data }, effects });
export const fail = (errorCode: string, message?: string, extra: Record<string, unknown> = {}): ToolOutcome =>
  ({ result: { success: false, errorCode, ...(message ? { message } : {}), ...extra } });

/** Runs a tenant-scoped, business-scoped read/write unit of work for a tool. */
export function withDb<T>(ctx: ToolExecutionContext, deps: ToolDeps, fn: (db: Db) => Promise<T>, readOnly = true): Promise<T> {
  return deps.tx.inTenant(fn, ctx.dbContext, { readOnly });
}

/** Arguments the model may never supply: tenant/ownership identifiers come only from context. */
export const FORBIDDEN_ARGUMENT_KEYS = new Set([
  'organization_id', 'organizationid', 'org_id', 'orgid', 'tenant_id', 'tenantid', 'business_id', 'businessid',
  'contact_id', 'contactid', 'conversation_id', 'conversationid', 'assistant_id', 'assistantid', 'agent_id', 'ai_agent_id',
  'whatsapp_instance_id', 'instance_id', 'user_id', 'userid', 'sql', 'query_sql', 'table',
]);
