import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { scan, missingHindi } = require('../scripts/i18n-scan.cjs') as {
  scan: () => { keys: Map<string, string>; problems: string[] };
  missingHindi: (keys: Map<string, string>) => { missing: string[]; hi: Map<string, string> };
};

/**
 * The whole dashboard must be available in Hindi: every user-visible English
 * string goes through t()/msg(), and every key has a Hindi translation.
 */
describe('Hindi translation coverage', () => {
  const { keys, problems } = scan();

  it('no user-visible English text is left outside t()/msg()', () => {
    expect(problems).toEqual([]);
  });

  it('every translation key has Hindi text that keeps its {placeholders}', () => {
    const { missing, hi } = missingHindi(keys);
    expect(missing).toEqual([]);
    const broken = [...keys.keys()].filter((k) => {
      const want = (k.match(/\{\w+\}/g) ?? []).sort().join();
      const got = ((hi.get(k) ?? k).match(/\{\w+\}/g) ?? []).sort().join();
      return want !== got;
    });
    expect(broken).toEqual([]);
  });
}, 120_000);
