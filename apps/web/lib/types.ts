/** Shapes returned by the documented backend API (see docs/openapi.json). */
export type Role = 'OWNER' | 'ADMIN' | 'MANAGER' | 'AGENT' | 'VIEWER';
export type InstanceStatus = 'CREATED' | 'WAITING_FOR_QR' | 'PAIRING' | 'CONNECTED' | 'RECONNECTING' | 'DISCONNECTED' | 'LOGGED_OUT' | 'ERROR' | 'SUSPENDED';
export type MessageStatus = 'RECEIVED' | 'QUEUED' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED' | 'REVOKED';

export interface Page<T> { items: T[]; nextCursor: string | null }

export interface Me {
  user: { id: string; email: string; firstName: string | null; lastName: string | null };
  organizations: Array<{ id: string; name: string; slug: string; role: Role; timezone: string; countryCode: string | null; currency: string; businessCount: number }>;
  invitations: Array<{ organizationId: string; organizationName: string; role: Role; invitedBy: string | null; invitedAt: string }>;
}

export interface Business {
  id: string; name: string; legalName: string | null; industry: string | null; description: string | null; phone: string | null;
  email: string | null; website: string | null; timezone: string; currency: string; countryCode: string | null;
  address: Record<string, string>; businessHours: Record<string, unknown>; status: string; createdAt: string;
}

export interface Instance {
  id: string; businessId: string; name: string; description: string | null; provider: string; status: InstanceStatus;
  phoneNumber: string | null; displayName: string | null; connectedAt: string | null; lastSeenAt: string | null; createdAt: string;
}

export interface InstanceHealth {
  instanceId: string; status: InstanceStatus; phoneNumber: string | null; displayName: string | null; connectedAt: string | null;
  lastSeenAt: string | null; qrAvailable: boolean; worker: { assigned: boolean; healthy: boolean };
}

export interface Attachment { id: string; mediaType: string; mimeType: string; fileName: string | null; fileSize: number | null; status: string }

export interface Message {
  id: string; conversationId: string; instanceId: string; businessId: string; direction: 'INBOUND' | 'OUTBOUND'; origin: string | null;
  fromMe: boolean; type: string; text: string | null; textTruncated?: boolean; status: MessageStatus; timestamp: string;
  errorCode: string | null; isAiGenerated: boolean; replyTo: { id: string; providerMessageId: string | null; preview: string | null } | null;
  attachments: Attachment[];
}

export interface Conversation {
  id: string; status: 'OPEN' | 'WAITING' | 'RESOLVED' | 'CLOSED'; unreadCount: number; lastMessageAt: string; businessId: string; businessName: string;
  instanceId: string; instanceName: string;
  contact: { id: string; name: string | null; phone: string | null; identity: string; identityType: 'PHONE' | 'LID' };
  lastMessage: { id: string; direction: string; type: string; preview: string | null; status: string; origin: string | null; timestamp: string } | null;
  handlingMode?: 'AI' | 'HUMAN' | 'HYBRID' | 'PAUSED';
  aiPausedUntil?: string | null;
  assistant?: { id: string; name: string } | null;
}

export interface ContactRow {
  id: string; name: string | null; phone: string | null; identity: string; identityType: 'PHONE' | 'LID'; hasLid: boolean; businessId: string;
  businessName: string; status: string; firstSeenAt: string; lastSeenAt: string; lastConversationId: string | null; lastMessageAt: string | null;
}

export interface Webhook {
  id: string; name: string; url: string; enabled: boolean; secretLast4: string | null; hasAuthHeader: boolean; scope: 'ORGANIZATION' | 'BUSINESS' | 'INSTANCE';
  businessId: string | null; businessName: string | null; instanceId: string | null; instanceName: string | null; events: string[];
  consecutiveFailures: number; disabledReason: string | null; lastSuccessAt: string | null; lastFailureAt: string | null; createdAt: string;
}

export const WEBHOOK_EVENTS = ['INSTANCE_CONNECTED', 'INSTANCE_DISCONNECTED', 'INSTANCE_STATUS_CHANGED', 'MESSAGE_RECEIVED', 'MESSAGE_SENT',
  'MESSAGE_DELIVERED', 'MESSAGE_READ', 'MESSAGE_FAILED', 'MESSAGE_REVOKED', 'MESSAGE_REACTION', 'OTP_VERIFIED'] as const;

export const API_SCOPES = ['instances:read', 'instances:write', 'messages:send', 'messages:read', 'webhooks:manage'] as const;

// ------------------------------------------------------------------ AI assistants
export interface DemoMessage { from: 'customer' | 'assistant' | 'tool'; text?: string; tool?: string; label?: string }
export interface TemplateCapability { key: string; name: string | null; description: string | null; category: string; available: boolean; required: boolean; defaultEnabled: boolean }
export interface AssistantTemplate {
  id: string; key: string; version: number; name: string; shortDescription: string; longDescription: string | null; category: string;
  marketplaceCategory: 'APPOINTMENTS' | 'SALES' | 'SUPPORT' | 'HOSPITALITY' | 'REAL_ESTATE' | 'GENERAL'; industry: string | null; iconKey: string;
  welcome: { enabled?: boolean; style?: string; guidedOptions?: string[] }; supportedLanguages: string[];
  demoConversations: Array<{ title: string; messages: DemoMessage[] }>; setupRequirements: Array<{ key: string; label: string; severity: 'REQUIRED' | 'RECOMMENDED' }>;
  recommendedFor: string[]; setupMinutes: number | null; capabilities: TemplateCapability[];
}
export type AssistantStatus = 'DRAFT' | 'TESTING' | 'ACTIVE' | 'PAUSED' | 'ARCHIVED';
export interface AssistantSummary {
  id: string; name: string; status: AssistantStatus; businessId: string; businessName: string; templateKey: string | null; templateName: string | null;
  iconKey: string | null; updatedAt: string; published: boolean; whatsappInstanceId: string | null; whatsappName: string | null; whatsappStatus: string | null; capabilityCount: number;
}
export interface JsonSchemaLite { type?: string; properties?: Record<string, JsonSchemaLite & { default?: unknown; minimum?: number; maximum?: number }>; enum?: string[] }
export interface Capability {
  key: string; name: string; description: string | null; category: string; riskLevel: 'LOW' | 'MEDIUM' | 'HIGH'; readOnly: boolean; availability: string;
  available: boolean; configSchema: JsonSchemaLite; confirmationDefault: boolean; enabled: boolean; required: boolean; configuration: Record<string, unknown>;
}
export interface Tone { tone: 'FRIENDLY' | 'PROFESSIONAL' | 'WARM' | 'CASUAL'; formality: 'FORMAL' | 'NEUTRAL' | 'INFORMAL'; responseLength: 'SHORT' | 'MEDIUM' | 'DETAILED';
  emoji: 'NONE' | 'LIGHT' | 'EXPRESSIVE'; languageMode: 'AUTO' | 'FIXED'; greetingStyle?: string }
export interface Assistant {
  id: string; name: string; description: string | null; status: AssistantStatus; businessId: string; businessName: string;
  template: { key: string; name: string; iconKey: string; installedVersion: number; latestVersion: number | null; updateAvailable: boolean } | null;
  tone: Tone; primaryLanguage: string; supportedLanguages: string[]; customInstructions: string | null; instructionsMode: 'SIMPLE' | 'ADVANCED' | 'CUSTOM_PROMPT';
  welcome: { enabled: boolean; style?: string; guidedOptions: string[] };
  handoff: { takeover: 'PAUSE_AI' | 'KEEP_AI'; resume: 'MANUAL' | 'AUTO_AFTER' | 'UNTIL_RESOLVED'; resumeAfterMinutes: number; fallbackMessage?: string };
  responseWaitMs: number; model: { provider: string; name: string }; capabilities: Capability[];
  whatsapp: { id: string; name: string; phone: string | null; status: string } | null;
  publishedVersion: number | null; publishedAt: string | null; unpublishedChanges: boolean; createdAt: string; updatedAt: string;
}
export interface ReadinessCheck { key: string; label: string; severity: 'REQUIRED' | 'RECOMMENDED'; ok: boolean; detail?: string; fix?: string; href?: string }
export interface InstructionIssue { severity: 'ERROR' | 'WARNING' | 'INFO'; code: string; message: string }
export interface Readiness { score: number; publishable: boolean; checks: ReadinessCheck[]; capabilityErrors: string[]; instructionIssues: InstructionIssue[];
  counts: { services: number; resources: number; locations: number; knowledgeReady: number; knowledgeTotal: number } }
export interface KnowledgeSource { id: string; type: string; title: string; status: 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED' | 'ARCHIVED'; error: string | null;
  chunks: number | null; bytes: number | null; scope: 'BUSINESS' | 'ASSISTANT'; createdAt: string }
export interface TraceEntry { tool: string; status: 'SUCCEEDED' | 'FAILED' | 'REJECTED' | 'CONFIRMATION_REQUIRED' | 'DRY_RUN'; errorCode?: string; summary: Record<string, unknown>; latencyMs: number }
export interface TestTurnResult { reply: string | null; outcome: string; dryRun: true; latencyMs: number;
  trace: { toolsUsed: TraceEntry[]; knowledgeUsed: boolean; outcome: string; iterations: number; errorCode: string | null; model: string; tokens: { input: number; output: number }; waitingFor: string | null } }
export interface AssistantActivity {
  today: { conversations: number; replied: number; handoffs: number; runs: number; bookings: number; leads: number };
  recentRuns: Array<{ id: string; conversationId: string; status: string; outcome: string | null; errorCode: string | null; latencyMs: number | null;
    inputTokens: number | null; outputTokens: number | null; toolIterations: number | null; createdAt: string; tools: Array<{ tool: string; status: string; errorCode: string | null; latencyMs: number | null }> }>;
}
