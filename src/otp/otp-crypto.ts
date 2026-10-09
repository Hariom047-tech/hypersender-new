import { createHmac, randomInt } from 'node:crypto';

const DIGITS = '0123456789';
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** Link codes avoid look-alikes (0/O, 1/I) because people may also type them by hand. */
const LINK_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const LINK_CODE_LENGTH = 8;

export interface CodeOptions { length: number; useLetter: boolean; useNumber: boolean; allCapital: boolean }

/** Uniform random code (crypto.randomInt: no modulo bias). */
export function generateCode(o: CodeOptions): string {
  const alphabet = (o.useNumber ? DIGITS : '') + (o.useLetter ? (o.allCapital ? UPPER : LOWER + UPPER) : '');
  if (!alphabet) throw new Error('code alphabet is empty');
  let out = '';
  for (let i = 0; i < o.length; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

export function generateLinkCode(): string {
  let out = '';
  for (let i = 0; i < LINK_CODE_LENGTH; i++) out += LINK_ALPHABET[randomInt(LINK_ALPHABET.length)];
  return out;
}

/** Candidate link codes inside a user's WhatsApp message (case-insensitive, whole words). */
export function findLinkCodes(text: string): string[] {
  const re = new RegExp(`(?:^|[^A-Za-z0-9])([A-Za-z0-9]{${LINK_CODE_LENGTH}})(?=$|[^A-Za-z0-9])`, 'g');
  const found = new Set<string>();
  for (const m of text.matchAll(re)) {
    const c = m[1].toUpperCase();
    if ([...c].every((ch) => LINK_ALPHABET.includes(ch))) found.add(c);
    if (found.size >= 5) break;
  }
  return [...found];
}

function pepper(): string {
  const p = process.env.OTP_PEPPER ?? process.env.API_KEY_PEPPER;
  if (!p || p.length < 32) throw new Error('OTP_PEPPER (or API_KEY_PEPPER) must be configured with at least 32 characters');
  return p;
}

/**
 * Codes are stored only as keyed HMACs bound to the instance (and, for sent codes, the recipient), so a
 * database dump cannot be used to read or brute-force live codes. The API and worker share the pepper.
 */
export function hashOtpCode(instanceId: string, code: string, phoneE164?: string | null): Buffer {
  return createHmac('sha256', pepper()).update(`otp:v1:${instanceId}:${phoneE164 ?? ''}:${code}`, 'utf8').digest();
}
