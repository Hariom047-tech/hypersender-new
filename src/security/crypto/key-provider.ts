import { randomBytes } from 'node:crypto';
import { DecryptCommand, GenerateDataKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import { aesGcmDecrypt, aesGcmEncrypt, KEY_BYTES } from './aes-gcm.js';

/**
 * Envelope encryption key provider.
 *
 *   master key (KMS, never leaves KMS, never in PostgreSQL)
 *     -> generateDataKey(): fresh 256-bit data key (DEK), returned both in
 *        plaintext (used in memory, then discarded) and wrapped (stored in DB)
 *     -> decryptDataKey(): unwraps a stored DEK
 *
 * `context` is bound to the wrapped key (KMS EncryptionContext / AAD), so a
 * wrapped DEK copied to another tenant's row cannot be unwrapped there.
 */
export interface DataKey {
  plaintext: Buffer;
  wrapped: Buffer;
  keyReference: string;
}

export type KeyContext = Record<string, string>;

export interface KeyProvider {
  generateDataKey(context: KeyContext): Promise<DataKey>;
  decryptDataKey(wrapped: Buffer, keyReference: string, context: KeyContext): Promise<Buffer>;
}

export const KEY_PROVIDER = Symbol('KEY_PROVIDER');

function canonicalContext(context: KeyContext): Buffer {
  const sorted = Object.keys(context).sort().map((k) => [k, context[k]]);
  return Buffer.from(JSON.stringify(sorted), 'utf8');
}

/** Production provider backed by AWS KMS. */
export class AwsKmsKeyProvider implements KeyProvider {
  constructor(private readonly kms: KMSClient, private readonly keyId: string) {}

  async generateDataKey(context: KeyContext): Promise<DataKey> {
    const out = await this.kms.send(new GenerateDataKeyCommand({
      KeyId: this.keyId, KeySpec: 'AES_256', EncryptionContext: context,
    }));
    if (!out.Plaintext || !out.CiphertextBlob) throw new Error('KMS GenerateDataKey returned no key');
    return { plaintext: Buffer.from(out.Plaintext), wrapped: Buffer.from(out.CiphertextBlob), keyReference: out.KeyId ?? this.keyId };
  }

  async decryptDataKey(wrapped: Buffer, keyReference: string, context: KeyContext): Promise<Buffer> {
    const out = await this.kms.send(new DecryptCommand({
      CiphertextBlob: wrapped, KeyId: keyReference, EncryptionContext: context,
    }));
    if (!out.Plaintext) throw new Error('KMS Decrypt returned no plaintext');
    return Buffer.from(out.Plaintext);
  }
}

/**
 * Development/test provider: wraps DEKs with a local 32-byte master key from the
 * environment. Refuses to run in production.
 */
export class LocalKeyProvider implements KeyProvider {
  private readonly master: Buffer;
  private readonly reference: string;

  constructor(masterKeyBase64: string, reference = 'local-dev:v1') {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('LocalKeyProvider must not be used in production; configure AWS KMS');
    }
    this.master = Buffer.from(masterKeyBase64, 'base64');
    if (this.master.length !== KEY_BYTES) throw new Error('LOCAL_MASTER_KEY_BASE64 must decode to 32 bytes');
    this.reference = reference;
  }

  async generateDataKey(context: KeyContext): Promise<DataKey> {
    const plaintext = randomBytes(KEY_BYTES);
    return { plaintext, wrapped: aesGcmEncrypt(this.master, plaintext, canonicalContext(context)), keyReference: this.reference };
  }

  async decryptDataKey(wrapped: Buffer, keyReference: string, context: KeyContext): Promise<Buffer> {
    if (keyReference !== this.reference) throw new Error(`unknown key reference ${keyReference}`);
    return aesGcmDecrypt(this.master, wrapped, canonicalContext(context));
  }
}

export function keyProviderFromEnv(): KeyProvider {
  if (process.env.KMS_KEY_ID) {
    return new AwsKmsKeyProvider(new KMSClient({ region: process.env.AWS_REGION }), process.env.KMS_KEY_ID);
  }
  const local = process.env.LOCAL_MASTER_KEY_BASE64;
  if (!local) throw new Error('Configure KMS_KEY_ID (production) or LOCAL_MASTER_KEY_BASE64 (development)');
  return new LocalKeyProvider(local);
}
