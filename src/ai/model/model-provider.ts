import type { JsonSchema } from '../json-schema.js';

/**
 * Provider-neutral model interface. The rest of the codebase only ever sees
 * these types - no provider SDK/HTTP types leak out of src/ai/model/.
 */
export type ModelItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool_call'; callId: string; name: string; arguments: string }
  | { kind: 'tool_result'; callId: string; output: string }
  /** Provider-private item (e.g. encrypted reasoning) replayed within ONE turn only; never persisted or shown. */
  | { kind: 'opaque'; provider: string; data: unknown };

export interface ModelToolDefinition { name: string; description: string; parameters: JsonSchema }

export interface ModelRequest {
  model: string;
  instructions: string;
  items: ModelItem[];
  tools: ModelToolDefinition[];
  temperature?: number | null;
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  maxOutputTokens?: number;
  timeoutMs: number;
  /** Stable per logical request (retries of the same step reuse it). */
  requestId: string;
}

export interface ModelToolCall { callId: string; name: string; arguments: string }

export interface ModelResponse {
  text: string | null;
  toolCalls: ModelToolCall[];
  /** Everything the model produced, in order, to append to the next request of the same turn. */
  outputItems: ModelItem[];
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number };
  model: string;
}

export interface AIModelProvider {
  readonly name: string;                 // e.g. 'OPENAI' (matches ai_agents.model_provider)
  readonly configured: boolean;
  generate(req: ModelRequest): Promise<ModelResponse>;
}

export interface EmbeddingProvider {
  readonly model: string;
  readonly configured: boolean;
  embed(texts: string[], timeoutMs?: number): Promise<number[][]>;
}

/** Normalised model failure; `retryable` drives the runtime's conservative retry. */
export class ModelError extends Error {
  constructor(readonly code: 'MODEL_NOT_CONFIGURED' | 'MODEL_TIMEOUT' | 'MODEL_RATE_LIMITED' | 'MODEL_UNAVAILABLE' | 'MODEL_BAD_REQUEST' | 'MODEL_BAD_RESPONSE',
              readonly retryable: boolean, message?: string) {
    super(message ?? code);
    this.name = 'ModelError';
  }
}

export const AI_MODEL_PROVIDER = Symbol('AI_MODEL_PROVIDER');
export const EMBEDDING_PROVIDER = Symbol('EMBEDDING_PROVIDER');

/** Registry of providers by name, so assistants can choose provider/model as data. */
export class ModelProviderRegistry {
  private readonly byName = new Map<string, AIModelProvider>();
  constructor(providers: AIModelProvider[]) { for (const p of providers) this.byName.set(p.name, p); }
  get(name: string): AIModelProvider | undefined { return this.byName.get(name); }
}
