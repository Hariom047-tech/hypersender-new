import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
export const KEY_BYTES = 32;

/**
 * AES-256-GCM authenticated encryption.
 * Output layout (what the database stores): nonce(12) || ciphertext || tag(16).
 * `aad` binds the ciphertext to its context (tenant, instance, key id...):
 * decrypting it under any other context fails authentication.
 */
export function aesGcmEncrypt(key: Buffer, plaintext: Buffer, aad: Buffer): Buffer {
  if (key.length !== KEY_BYTES) throw new Error('AES-256-GCM requires a 32-byte key');
  const nonce = randomBytes(NONCE_BYTES); // random 96-bit nonce per message
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]);
}

export function aesGcmDecrypt(key: Buffer, blob: Buffer, aad: Buffer): Buffer {
  if (key.length !== KEY_BYTES) throw new Error('AES-256-GCM requires a 32-byte key');
  if (blob.length < NONCE_BYTES + TAG_BYTES + 1) throw new Error('ciphertext too short');
  const nonce = blob.subarray(0, NONCE_BYTES);
  const tag = blob.subarray(blob.length - TAG_BYTES);
  const ciphertext = blob.subarray(NONCE_BYTES, blob.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Canonical AAD string: fields joined with '|', each validated to contain no separator. */
export function aad(...parts: string[]): Buffer {
  for (const p of parts) if (p.includes('|')) throw new Error('AAD part must not contain "|"');
  return Buffer.from(parts.join('|'), 'utf8');
}
