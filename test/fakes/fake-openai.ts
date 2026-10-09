import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';

/**
 * TEST-ONLY local stand-in for the OpenAI HTTP API (POST /v1/responses and
 * /v1/embeddings). The production OpenAIProvider talks to it over real HTTP, so
 * request building and response parsing are exercised. The "model" is a
 * deterministic script supplied by each test - never presented as a real LLM.
 */
export interface FakeTurn {
  instructions: string;
  tools: string[];
  /** Latest customer text(s) of this turn (consecutive user items at the end of history). */
  userTexts: string[];
  /** Tool results already returned in this turn, in order. */
  results: Array<{ name: string; output: any }>;
  body: any;
}
export interface FakeReply { text?: string; calls?: Array<{ name: string; args: Record<string, unknown> }>; reasoningMarker?: string }
export type Brain = (t: FakeTurn) => FakeReply | Promise<FakeReply>;

export class FakeOpenAI {
  readonly requests: FakeTurn[] = [];
  brain: Brain = () => ({ text: 'OK' });
  /** Next N responses fail with this HTTP status. */
  failNext = 0;
  failStatus = 500;
  delayMs = 0;
  private server!: Server;
  url = '';
  private n = 0;

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', async () => {
        const body = raw ? JSON.parse(raw) : {};
        if (req.headers.authorization !== 'Bearer test-openai-key') { res.writeHead(401).end('{}'); return; }
        if (req.url === '/v1/embeddings') {
          res.writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify({ data: (body.input as string[]).map((t, index) => ({ index, embedding: embed(t) })), model: body.model }));
          return;
        }
        if (req.url !== '/v1/responses') { res.writeHead(404).end('{}'); return; }
        if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
        if (this.failNext > 0) { this.failNext--; res.writeHead(this.failStatus).end('{"error":{"message":"boom"}}'); return; }
        const turn = toTurn(body);
        this.requests.push(turn);
        let reply: FakeReply;
        try { reply = await this.brain(turn); } catch (err) { res.writeHead(500).end(JSON.stringify({ error: String(err) })); return; }
        const output: any[] = [];
        if (reply.reasoningMarker) output.push({ type: 'reasoning', id: `rs_${this.n}`, encrypted_content: reply.reasoningMarker, summary: [] });
        for (const c of reply.calls ?? []) {
          output.push({ type: 'function_call', id: `fc_${this.n}`, call_id: `call_${++this.n}`, name: c.name, arguments: JSON.stringify(c.args) });
        }
        if (reply.text) output.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: reply.text }] });
        res.writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ id: `resp_${this.n}`, model: body.model, output, usage: { input_tokens: 120, output_tokens: 25, input_tokens_details: { cached_tokens: 0 } } }));
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as { port: number }).port}/v1`;
    return this;
  }
  async stop(): Promise<void> { await new Promise<void>((r) => this.server.close(() => r())); }
  reset(brain?: Brain): void { this.requests.length = 0; this.failNext = 0; this.delayMs = 0; if (brain) this.brain = brain; }
}

function toTurn(body: any): FakeTurn {
  const input: any[] = body.input ?? [];
  let lastUser = -1;
  input.forEach((it, i) => { if (it.role === 'user') lastUser = i; });
  let firstUser = lastUser;
  while (firstUser > 0 && input[firstUser - 1]?.role === 'user') firstUser--;
  const names = new Map<string, string>();
  for (const it of input) if (it.type === 'function_call') names.set(it.call_id, it.name);
  const results = input.slice(lastUser + 1).filter((it) => it.type === 'function_call_output')
    .map((it) => ({ name: names.get(it.call_id) ?? '?', output: JSON.parse(it.output) }));
  return { instructions: body.instructions ?? '', tools: (body.tools ?? []).map((t: any) => t.name),
    userTexts: lastUser >= 0 ? input.slice(firstUser, lastUser + 1).map((it) => String(it.content)) : [], results, body };
}

/** Deterministic bag-of-words embedding (64 dims) so vector search is exercised without a real model. */
export function embed(text: string): number[] {
  const v = new Array(64).fill(0);
  for (const w of text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []) v[createHash('md5').update(w).digest()[0] % 64] += 1;
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}
