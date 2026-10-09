import type { AssistantTool } from './types.js';
import { cancelBooking, checkAvailability, createBooking, getBooking, rescheduleBooking } from './handlers/booking.js';
import { humanHandoff, notifyTeam, pauseAutomation } from './handlers/conversation.js';
import { HAVAN_TOOLS } from './handlers/havan.js';
import { ORDERING_TOOLS } from './handlers/ordering.js';
import { createLead, getBusinessHours, getBusinessInfo, getBusinessLocation, getCustomerContext, getLead, getResources, getServiceDetails,
  getServicePrice, getServices, searchKnowledge, updateLead } from './handlers/info.js';

/** handler_key of the built-in confirmation tool (executed by ToolExecutor itself). */
export const CONFIRM_HANDLER = 'system.confirm_pending_action';
export const CONFIRM_TOOL_KEY = 'CONFIRM_PENDING_ACTION';

/**
 * Code side of the capability registry: handler_key -> implementation.
 * There is intentionally NO generic data-access tool (no SQL, no row
 * update/delete, no code execution) - only narrow business capabilities.
 */
export class ToolRegistry {
  private readonly handlers = new Map<string, AssistantTool<any>>();

  constructor(tools: AssistantTool<any>[] = DEFAULT_TOOLS) {
    for (const t of tools) {
      if (this.handlers.has(t.handlerKey)) throw new Error(`duplicate tool handler ${t.handlerKey}`);
      if (!t.isReadOnly && !t.dryRun && !t.sandboxSafe) throw new Error(`write tool ${t.handlerKey} must implement dryRun or be sandboxSafe`);
      this.handlers.set(t.handlerKey, t);
    }
  }

  get(handlerKey: string | null | undefined): AssistantTool<any> | undefined {
    return handlerKey ? this.handlers.get(handlerKey) : undefined;
  }

  has(handlerKey: string): boolean { return handlerKey === CONFIRM_HANDLER || this.handlers.has(handlerKey); }

  /**
   * Start-up/CI consistency check against the platform catalog: every READY tool
   * has a handler whose read-only flag matches; no handler claims a key that the
   * catalog marks NOT_READY.
   */
  validateCatalog(catalog: Array<{ key: string; handlerKey: string | null; availability: string; isReadOnly: boolean; requiresConfirmation: boolean }>): string[] {
    const problems: string[] = [];
    for (const t of catalog) {
      if (t.availability !== 'READY') continue;
      if (!t.handlerKey || !this.has(t.handlerKey)) { problems.push(`${t.key}: READY but no handler ${t.handlerKey}`); continue; }
      const h = this.handlers.get(t.handlerKey);
      if (h && h.isReadOnly !== t.isReadOnly) problems.push(`${t.key}: read-only flag mismatch`);
      if (h && t.requiresConfirmation && !h.preview) problems.push(`${t.key}: confirmation required but handler has no preview`);
    }
    return problems;
  }
}

export const DEFAULT_TOOLS: AssistantTool<any>[] = [
  getBusinessInfo, getBusinessHours, getBusinessLocation, getServices, getServiceDetails, getServicePrice, getResources, searchKnowledge,
  checkAvailability, createBooking, getBooking, rescheduleBooking, cancelBooking, getCustomerContext, createLead, updateLead, getLead,
  humanHandoff, pauseAutomation, notifyTeam, ...ORDERING_TOOLS, ...HAVAN_TOOLS,
];
