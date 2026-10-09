import { AIModelProvider, EmbeddingProvider, ModelError, type ModelItem, type ModelRequest, type ModelResponse } from './model-provider.js';

/**
 * OpenAI adapter (Responses API, function tools) over plain fetch - no SDK types
 * escape this file. The application owns tool execution: the model only returns
 * `function_call` items; results go back as `function_call_output`.
 *
 * Privacy: `store: false` (responses are not retained for later retrieval by
 * id). Reasoning is requested only as encrypted content so multi-step tool
 * turns keep working with reasoning models; it is replayed within the same turn
 * and never persisted, logged or shown.
 */
export interface OpenAIConfig { apiKey?: string; baseUrl?: string; organization?: string; embeddingModel?: string }

const isReasoningModel = (model: string) => /^(gpt-5|o\d)/i.test(model);

export class OpenAIProvider implements AIModelProvider {
  readonly name = 'OPENAI';
  private readonly baseUrl: string;
  constructor(private readonly cfg: OpenAIConfig) { this.baseUrl = (cfg.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, ''); }
  get configured(): boolean { return Boolean(this.cfg.apiKey); }

  async generate(req: ModelRequest): Promise<ModelResponse> {
    if (!this.cfg.apiKey) throw new ModelError('MODEL_NOT_CONFIGURED', false, 'OPENAI_API_KEY is not set');
    const reasoning = isReasoningModel(req.model);
    const body: Record<string, unknown> = {
      model: req.model,
      instructions: req.instructions,
      input: req.items.flatMap((i) => toInput(i)),
      tools: req.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false })),
      tool_choice: req.tools.length ? 'auto' : undefined,
      parallel_tool_calls: true,
      store: false,
      max_output_tokens: req.maxOutputTokens ?? 800,
    };
    if (reasoning) {
      body.reasoning = { effort: req.reasoningEffort ?? 'low' };
      body.include = ['reasoning.encrypted_content'];
    } else if (req.temperature !== null && req.temperature !== undefined) {
      body.temperature = req.temperature;
    }
    const json = await this.post('/responses', body, req.timeoutMs);
    return parseResponse(json, req.model);
  }

  private async post(path: string, body: unknown, timeoutMs: number): Promise<any> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST', signal: ctrl.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.apiKey}`,
                   ...(this.cfg.organization ? { 'openai-organization': this.cfg.organization } : {}) },
        body: JSON.stringify(body),
      });
    } catch (err) {
      if (ctrl.signal.aborted) throw new ModelError('MODEL_TIMEOUT', true);
      throw new ModelError('MODEL_UNAVAILABLE', true, (err as Error).message.slice(0, 200));
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 429) throw new ModelError('MODEL_RATE_LIMITED', true);
    if (res.status >= 500) throw new ModelError('MODEL_UNAVAILABLE', true, `HTTP ${res.status}`);
    if (res.status === 401 || res.status === 403) throw new ModelError('MODEL_NOT_CONFIGURED', false, `HTTP ${res.status}`);
    // Error bodies are not logged verbatim (they can echo request content).
    if (!res.ok) throw new ModelError('MODEL_BAD_REQUEST', false, `HTTP ${res.status}`);
    try { return await res.json(); } catch { throw new ModelError('MODEL_BAD_RESPONSE', true); }
  }

  /** Embeddings for knowledge retrieval (same credentials). */
  embeddings(model: string): EmbeddingProvider {
    const self = this;
    return {
      model,
      get configured() { return self.configured; },
      async embed(texts: string[], timeoutMs = 20_000): Promise<number[][]> {
        if (!self.cfg.apiKey) throw new ModelError('MODEL_NOT_CONFIGURED', false);
        const json = await self.post('/embeddings', { model, input: texts }, timeoutMs);
        const data = (json?.data ?? []) as Array<{ index: number; embedding: number[] }>;
        if (data.length !== texts.length) throw new ModelError('MODEL_BAD_RESPONSE', true);
        return data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
      },
    };
  }
}

function toInput(i: ModelItem): unknown[] {
  switch (i.kind) {
    case 'user': return [{ role: 'user', content: i.text }];
    case 'assistant': return [{ role: 'assistant', content: i.text }];
    case 'tool_call': return [{ type: 'function_call', call_id: i.callId, name: i.name, arguments: i.arguments }];
    case 'tool_result': return [{ type: 'function_call_output', call_id: i.callId, output: i.output }];
    case 'opaque': return i.provider === 'OPENAI' ? [i.data] : [];
  }
}

export function parseResponse(json: any, model: string): ModelResponse {
  if (!json || !Array.isArray(json.output)) throw new ModelError('MODEL_BAD_RESPONSE', true);
  const outputItems: ModelItem[] = [];
  const toolCalls: ModelResponse['toolCalls'] = [];
  const texts: string[] = [];
  for (const o of json.output) {
    if (o?.type === 'function_call' && typeof o.name === 'string') {
      const call = { callId: String(o.call_id), name: o.name, arguments: typeof o.arguments === 'string' ? o.arguments : '{}' };
      toolCalls.push(call);
      outputItems.push({ kind: 'tool_call', ...call });
    } else if (o?.type === 'message') {
      const t = (o.content ?? []).filter((c: any) => c?.type === 'output_text').map((c: any) => String(c.text)).join('');
      if (t) { texts.push(t); outputItems.push({ kind: 'assistant', text: t }); }
    } else if (o?.type === 'reasoning' && o.encrypted_content) {
      // Opaque, encrypted; kept in memory for this turn only. Summaries are never requested.
      outputItems.push({ kind: 'opaque', provider: 'OPENAI', data: { type: 'reasoning', id: o.id, encrypted_content: o.encrypted_content, summary: [] } });
    }
  }
  const usage = json.usage ?? {};
  return {
    text: texts.length ? texts.join('\n').trim() : null,
    toolCalls, outputItems, model: json.model ?? model,
    usage: { inputTokens: Number(usage.input_tokens ?? 0), outputTokens: Number(usage.output_tokens ?? 0),
             cachedTokens: Number(usage.input_tokens_details?.cached_tokens ?? 0) },
  };
}
