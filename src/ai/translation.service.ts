import { createHash, randomUUID } from 'node:crypto';
import type { ModelProviderRegistry } from './model/model-provider.js';
import { DEFAULT_MODEL_PROVIDER, defaultModelName } from './model/providers-from-env.js';

/**
 * Translates free text written at runtime (the assistant's call-back notes,
 * summaries) for the dashboard's Hindi view. Fixed UI text uses the static
 * dictionary in the web app; this is only for text nobody could translate in
 * advance. Results are cached in memory; without a model the originals return.
 */
const LANG_NAME: Record<string, string> = { hi: 'Hindi written in Devanagari script' };
const MAX_CACHE = 5_000;

export class TranslationService {
  private readonly cache = new Map<string, string>();

  constructor(private readonly models: ModelProviderRegistry) {}

  async translate(texts: string[], lang: string): Promise<string[]> {
    const target = LANG_NAME[lang];
    if (!target) return texts;
    const key = (t: string) => createHash('sha256').update(`${lang}\u0000${t}`).digest('hex');
    const out = texts.map((t) => (needsWork(t, lang) ? this.cache.get(key(t)) : t));
    const todo = [...new Set(texts.filter((t, i) => out[i] === undefined))];
    if (todo.length) {
      const done = await this.callModel(todo, target).catch(() => null);
      todo.forEach((t, i) => {
        const v = done?.[i];
        if (typeof v === 'string' && v.trim()) this.remember(key(t), v.trim());
      });
    }
    return texts.map((t, i) => out[i] ?? this.cache.get(key(t)) ?? t);
  }

  private remember(k: string, v: string) {
    if (this.cache.size >= MAX_CACHE) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(k, v);
  }

  private async callModel(texts: string[], target: string): Promise<string[] | null> {
    const provider = this.models.get(DEFAULT_MODEL_PROVIDER);
    if (!provider?.configured) return null;
    const res = await provider.generate({
      model: defaultModelName(),
      instructions: `You translate short notes for a Hindu priest's (Pandit Ji's) dashboard into simple, natural ${target}.
Rules: keep the meaning exactly; do not add or drop information; keep names, phone numbers, dates, times and amounts as they are;
keep the words WhatsApp, Online and havan names (Samanya / Vishesh / Maha Vishesh Havan) recognisable in Hindi (सामान्य / विशेष / महा विशेष हवन);
use these words: dakshina = दक्षिणा, yajman = यजमान, in-person / at Nalkheda = नलखेड़ा में आकर, online sankalp = ऑनलाइन संकल्प,
guidance = मार्गदर्शन, call back = कॉल बैक; avoid English words written in Devanagari where a common Hindi word exists;
input may be English or Hinglish. Reply with ONLY a JSON array of strings, one translation per input, same order and same count.`,
      items: [{ kind: 'user', text: JSON.stringify(texts) }],
      tools: [],
      reasoningEffort: 'minimal',
      maxOutputTokens: 2_000,
      timeoutMs: 20_000,
      requestId: randomUUID(),
    });
    const raw = (res.text ?? '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length === texts.length ? parsed.map((x) => String(x)) : null;
  }
}

/** Already in the target script (mostly Devanagari) -> nothing to do. */
function needsWork(text: string, lang: string): boolean {
  if (!text.trim()) return false;
  if (lang !== 'hi') return true;
  const letters = text.match(/\p{L}/gu) ?? [];
  const deva = text.match(/\p{Script=Devanagari}/gu) ?? [];
  return letters.length > 0 && deva.length / letters.length < 0.6;
}
