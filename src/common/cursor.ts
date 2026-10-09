import { isUuid } from './uuid.js';
import { WhatsAppError } from '../whatsapp/domain/whatsapp-errors.js';

/** Opaque keyset cursor: base64url({ t: ISO timestamp, id: uuid }). No OFFSET pagination anywhere. */
export interface Cursor { t: string; id: string }

export function encodeCursor(t: Date | string, id: string): string {
  return Buffer.from(JSON.stringify({ t: new Date(t).toISOString(), id }), 'utf8').toString('base64url');
}

export function decodeCursor(raw: unknown): Cursor | null {
  if (raw === undefined || raw === null || raw === '') return null;
  try {
    const c = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8')) as Cursor;
    if (!isUuid(c.id) || Number.isNaN(Date.parse(c.t))) throw new Error();
    return c;
  } catch {
    throw new WhatsAppError('VALIDATION_FAILED', 'invalid cursor');
  }
}

export function pageLimit(raw: unknown, def = 30, max = 100): number {
  const n = raw === undefined ? def : Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new WhatsAppError('VALIDATION_FAILED', 'limit must be a positive integer');
  return Math.min(n, max);
}

/** Splits a limit+1 result into a page and the next cursor. */
export function paginate<T>(rows: T[], limit: number, key: (row: T) => { t: Date | string; id: string }): { items: T[]; nextCursor: string | null } {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last ? encodeCursor(key(last).t, key(last).id) : null };
}

/** Escapes LIKE wildcards in user search input. */
export function likePattern(input: string): string {
  return `%${input.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
