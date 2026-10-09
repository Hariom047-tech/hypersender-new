import type { Db } from '../database/transaction-runner.js';

/*
 * Marketing consent.
 *
 * A contact may receive campaign messages only when BOTH hold:
 *   * they are not opted out, and
 *   * they messaged the business before (they know it) or an opt-in is recorded.
 * STOP-type replies opt a contact out; START opts them back in. Only a message
 * that is JUST the keyword counts, so "stop by the shop tomorrow" does nothing.
 */

const STOP_WORDS = new Set([
  'stop', 'stop all', 'stopall', 'unsubscribe', 'opt out', 'optout', 'cancel offers', 'no more messages',
  'band', 'band karo', 'bandh', 'bandh karo', 'band kardo', 'band kar do', 'mat bhejo', 'message mat bhejo', 'messages mat bhejo',
  'स्टॉप', 'बंद', 'बंद करो', 'बंद कर दो', 'मत भेजो', 'मैसेज मत भेजो',
]);
const START_WORDS = new Set(['start', 'subscribe', 'unstop', 'स्टार्ट', 'शुरू करो', 'chalu karo']);

export type Keyword = 'STOP' | 'START' | null;

/** STOP / START when the whole message is one of the keywords. */
export function marketingKeyword(text: string | null | undefined): Keyword {
  if (!text || text.length > 40) return null;
  const t = text.toLowerCase().normalize('NFC').replace(/[.!?,।🙏\s]+/gu, ' ').trim();
  if (STOP_WORDS.has(t)) return 'STOP';
  if (START_WORDS.has(t)) return 'START';
  return null;
}

/** Records a keyword opt-out / opt-in from an inbound message (worker, tenant tx). */
export async function recordKeywordPreference(db: Db, p: { organizationId: string; businessId: string; contactId: string; text: string | null | undefined }): Promise<Keyword> {
  const k = marketingKeyword(p.text);
  if (!k) return null;
  await db.query(
    `INSERT INTO app.marketing_contact_prefs (organization_id, business_id, contact_id, status, source, note, changed_at)
     VALUES ($1, $2, $3, $4, 'KEYWORD', $5, now())
     ON CONFLICT (contact_id) DO UPDATE SET status = EXCLUDED.status, source = 'KEYWORD', note = EXCLUDED.note, changed_by_user_id = NULL, changed_at = now()`,
    [p.organizationId, p.businessId, p.contactId, k === 'STOP' ? 'OPTED_OUT' : 'OPTED_IN', `Customer replied "${String(p.text).trim().slice(0, 40)}"`]);
  return k;
}

export type Audience = { type: 'ALL' } | { type: 'RECENT'; days: number } | { type: 'SELECTED'; contactIds: string[] };

/**
 * SQL for the contacts of $1 (business id) who may receive a campaign, narrowed
 * by the audience. Extra parameters start at $2.
 */
export function eligibleContactsSql(a: Audience): { where: string; params: unknown[] } {
  const base = `c.business_id = $1 AND c.deleted_at IS NULL AND c.status = 'ACTIVE' AND c.whatsapp_jid NOT LIKE '%@g.us'
    AND coalesce(p.status, '') <> 'OPTED_OUT'
    AND (p.status = 'OPTED_IN' OR EXISTS (SELECT 1 FROM app.messages m WHERE m.contact_id = c.id AND m.direction = 'INBOUND'))`;
  if (a.type === 'RECENT') {
    return { where: `${base} AND (p.status = 'OPTED_IN' AND p.changed_at >= now() - make_interval(days => $2)
      OR EXISTS (SELECT 1 FROM app.messages m WHERE m.contact_id = c.id AND m.direction = 'INBOUND' AND m.created_at >= now() - make_interval(days => $2)))`, params: [a.days] };
  }
  if (a.type === 'SELECTED') return { where: `${base} AND c.id = ANY($2::uuid[])`, params: [a.contactIds] };
  return { where: base, params: [] };
}
