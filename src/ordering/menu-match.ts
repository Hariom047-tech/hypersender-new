/**
 * Fuzzy menu matching for WhatsApp-style text ("chees brger", "pijja", "cold cofee",
 * "paneer wala"). Deterministic and dependency-free; menus are small (hundreds of
 * items), so scoring in memory is fine. The assistant still clarifies when two
 * items score alike - the tool returns ranked candidates, never a silent guess.
 */
const STOP = new Set(['wala', 'wali', 'wale', 'ek', 'do', 'aur', 'bhi', 'me', 'mein', 'ka', 'ki', 'ke', 'the', 'a', 'an', 'and', 'of', 'with',
  'add', 'karo', 'kar', 'dena', 'chahiye', 'chaiye', 'please', 'plz', 'bhai', 'order', 'one', 'two', 'large', 'small', 'medium', 'regular']);

/** Phonetic-ish normalisation for Hinglish spellings. */
export function normalizeToken(w: string): string {
  let t = w.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '');
  t = t.replace(/ph/g, 'f').replace(/z/g, 'j').replace(/w/g, 'v').replace(/ck/g, 'k').replace(/q/g, 'k')
    .replace(/ee/g, 'i').replace(/oo/g, 'u').replace(/y$/g, 'i').replace(/(.)\1+/g, '$1');
  return t;
}

export function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !STOP.has(w)).map(normalizeToken).filter((w) => w.length > 1);
}

/** Damerau-Levenshtein (optimal string alignment). */
function distance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

function tokenSimilarity(q: string, t: string): number {
  if (q === t) return 1;
  if (t.startsWith(q) && q.length >= 3) return 0.9;
  if (q.startsWith(t) && t.length >= 3) return 0.85;
  const dist = distance(q, t);
  const sim = 1 - dist / Math.max(q.length, t.length);
  return sim >= 0.6 ? sim : 0;
}

/** Score 0..1: how well the query words are covered by the candidate's name (+ weaker: category/tags/description). */
export function matchScore(query: string, candidate: { name: string; category?: string | null; tags?: string[]; description?: string | null }): number {
  const q = tokens(query);
  if (q.length === 0) return 0;
  const nameT = tokens(candidate.name);
  const extraT = [...tokens(candidate.category ?? ''), ...tokens((candidate.tags ?? []).join(' '))];
  const descT = tokens(candidate.description ?? '');
  let total = 0;
  for (const w of q) {
    const best = Math.max(0, ...nameT.map((t) => tokenSimilarity(w, t)));
    const extra = Math.max(0, ...extraT.map((t) => tokenSimilarity(w, t))) * 0.7;
    const desc = Math.max(0, ...descT.map((t) => tokenSimilarity(w, t))) * 0.4;
    total += Math.max(best, extra, desc);
  }
  const coverage = total / q.length;
  // Prefer names that are mostly explained by the query ("cheese burger" > "cheese burger meal combo").
  const nameCover = nameT.length ? nameT.filter((t) => q.some((w) => tokenSimilarity(w, t) >= 0.75)).length / nameT.length : 0;
  return Math.round((coverage * 0.8 + nameCover * 0.2) * 1000) / 1000;
}

export function rankMenu<T extends { name: string; category?: string | null; tags?: string[]; description?: string | null }>(query: string, items: T[], min = 0.55):
  Array<T & { score: number }> {
  return items.map((i) => ({ ...i, score: matchScore(query, i) })).filter((i) => i.score >= min).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}
