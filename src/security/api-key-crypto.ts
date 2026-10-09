import { createHmac, randomBytes } from 'node:crypto';

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function randomAlnum(length: number): string {
  const bytes = randomBytes(length * 2);
  let out = '';
  for (let i = 0; out.length < length && i < bytes.length; i++) {
    if (bytes[i] < 248) out += ALNUM[bytes[i] % 62]; // rejection sampling: no modulo bias
  }
  if (out.length < length) return randomAlnum(length);
  return out;
}

export interface GeneratedApiKey {
  /** Shown to the user exactly once. Never persisted, never logged. */
  plaintext: string;
  /** Non-secret display prefix, e.g. "hs_live_Ab3dE6gH". */
  prefix: string;
}

/** Format: hs_<env>_<8 alnum public id>_<43 char base64url secret (256 bits)> */
export function generateApiKey(environment: 'live' | 'test' = 'live'): GeneratedApiKey {
  const prefix = `hs_${environment}_${randomAlnum(8)}`;
  return { prefix, plaintext: `${prefix}_${randomBytes(32).toString('base64url')}` };
}

export function looksLikeApiKey(value: string): boolean {
  return /^hs_(live|test)_[A-Za-z0-9]{8}_[A-Za-z0-9_-]{43}$/.test(value);
}

/**
 * HMAC-SHA256 with a server-side pepper (kept in KMS/Secrets Manager, not in the
 * DB). The key already has 256 bits of entropy, so a slow KDF is unnecessary;
 * the pepper means a leaked database alone cannot verify guesses offline.
 */
export function hashApiKey(plaintext: string, pepper: string): Buffer {
  if (pepper.length < 32) throw new Error('API key pepper must be at least 32 characters');
  return createHmac('sha256', pepper).update(plaintext, 'utf8').digest();
}
