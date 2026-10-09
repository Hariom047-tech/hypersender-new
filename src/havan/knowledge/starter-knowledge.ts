import { readFileSync } from 'node:fs';

/**
 * Researched starter knowledge shipped with a template (FAQ sources). It is
 * copied into the tenant's own knowledge base when the template is installed
 * (or on request), so the owner can review, edit or delete every entry.
 */
export interface StarterSource { title: string; references: string[]; faqs: Array<{ q: string; a: string }> }

const PACKS: Record<string, URL> = {
  HAVAN_BOOKING: new URL('./starter-knowledge.json', import.meta.url),
};

const cache = new Map<string, StarterSource[]>();

export function starterKnowledge(templateKey: string | null | undefined): StarterSource[] {
  if (!templateKey || !PACKS[templateKey]) return [];
  let pack = cache.get(templateKey);
  if (!pack) {
    pack = (JSON.parse(readFileSync(PACKS[templateKey], 'utf8')) as { sources: StarterSource[] }).sources;
    cache.set(templateKey, pack);
  }
  return pack;
}
