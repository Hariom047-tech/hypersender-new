import { ModelProviderRegistry, type EmbeddingProvider } from './model-provider.js';
import { OpenAIProvider } from './openai.provider.js';

/**
 * Providers from configuration. Without OPENAI_API_KEY the provider exists but
 * reports configured=false: live turns fall back to a safe handoff and the
 * sandbox says the AI model is not configured - nothing is faked.
 */
export function aiProvidersFromEnv(env: NodeJS.ProcessEnv = process.env): { models: ModelProviderRegistry; embedder: EmbeddingProvider } {
  const openai = new OpenAIProvider({ apiKey: env.OPENAI_API_KEY || undefined, baseUrl: env.OPENAI_BASE_URL || undefined, organization: env.OPENAI_ORGANIZATION || undefined });
  return { models: new ModelProviderRegistry([openai]), embedder: openai.embeddings(env.AI_EMBEDDING_MODEL ?? 'text-embedding-3-small') };
}

export const DEFAULT_MODEL_PROVIDER = 'OPENAI';
export const defaultModelName = (env: NodeJS.ProcessEnv = process.env) => env.AI_DEFAULT_MODEL ?? 'gpt-5-mini';
