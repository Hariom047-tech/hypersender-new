import { describe, expect, it } from 'vitest';
import { TranslationService } from '../src/ai/translation.service.js';
import type { ModelProviderRegistry } from '../src/ai/model/model-provider.js';

function registry(reply: (input: string[]) => string, calls: string[][]) {
  const provider = {
    configured: true,
    async generate(req: { items: Array<{ text: string }> }) {
      const input = JSON.parse(req.items[0]!.text) as string[];
      calls.push(input);
      return { text: reply(input) };
    },
  };
  return { get: () => provider } as unknown as ModelProviderRegistry;
}

describe('TranslationService', () => {
  it('translates English notes to Hindi, caches, and skips text already in Devanagari', async () => {
    const calls: string[][] = [];
    const svc = new TranslationService(registry((xs) => JSON.stringify(xs.map((x) => `हिंदी: ${x}`)), calls));
    const out = await svc.translate(['Wants dakshina', 'दक्षिणा जाननी है', 'Wants dakshina'], 'hi');
    expect(out).toEqual(['हिंदी: Wants dakshina', 'दक्षिणा जाननी है', 'हिंदी: Wants dakshina']);
    expect(calls).toEqual([['Wants dakshina']]);
    await svc.translate(['Wants dakshina'], 'hi');
    expect(calls).toHaveLength(1);
  });

  it('falls back to the original text on bad model output', async () => {
    const svc = new TranslationService(registry(() => 'not json', []));
    expect(await svc.translate(['Call me in the evening'], 'hi')).toEqual(['Call me in the evening']);
    expect(await svc.translate(['x'], 'fr')).toEqual(['x']);
  });
});
