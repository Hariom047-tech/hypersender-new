import type { TransactionRunner } from '../database/transaction-runner.js';
import { isLeaseLost, LeaseLostError } from '../database/errors.js';
import { WhatsAppRepository } from '../repositories/whatsapp.repository.js';
import { aad, aesGcmDecrypt, aesGcmEncrypt } from '../security/crypto/aes-gcm.js';
import type { KeyProvider } from '../security/crypto/key-provider.js';
import { BufferJSON } from './buffer-json.js';

/**
 * Provider-neutral encrypted auth-state store. The Baileys adapter
 * (providers/baileys/baileys-auth-store.ts) binds it to the real Baileys
 * types, `initAuthCreds` and Baileys' own BufferJSON codec.
 */
export type SignalDataSet = Record<string, Record<string, unknown | null | undefined> | undefined>;
export interface SignalKeyStore {
  get(type: string, ids: string[]): Promise<Record<string, unknown>>;
  set(data: SignalDataSet): Promise<void>;
  clear(): Promise<void>;
}
export interface AuthState<C> { creds: C; keys: SignalKeyStore }

export interface JsonCodec {
  replacer: (key: string, value: any) => any;
  reviver: (key: string, value: any) => any;
}

export class AuthStateMissingError extends Error {
  constructor(instanceId: string) { super(`no stored WhatsApp credentials for instance ${instanceId}`); }
}

export interface PostgresAuthStateOptions<C> {
  tx: TransactionRunner;              // hs_worker runner
  repo: WhatsAppRepository;
  keys: KeyProvider;
  organizationId: string;             // from the instance row, never from provider payloads
  instanceId: string;
  workerId: string;
  leaseToken: number;                 // fencing token from claim_instance_lease()
  initCreds: () => C;                 // e.g. Baileys initAuthCreds
  deserializeKey?: (type: string, value: unknown) => unknown;
  /** JSON codec. Baileys adapter passes Baileys' BufferJSON for exact wire compatibility. */
  codec?: JsonCodec;
  /** Restore mode: fail instead of silently creating fresh credentials (which would need a new QR). */
  requireExisting?: boolean;
}

const ENCRYPTION_VERSION = 1;

/**
 * PostgreSQL-backed replacement for useMultiFileAuthState.
 *  - Credentials and every signal key are AES-256-GCM encrypted in the app with
 *    a per-instance data key; the data key is wrapped by KMS and cached in
 *    memory only for the lifetime of this session.
 *  - AAD binds each blob to (org, instance, type, id): a row copied to another
 *    instance or tenant fails to decrypt.
 *  - Signal keys are written per key (batched upsert/delete of only the changed
 *    ids) - the full auth state is never rewritten.
 *  - Every write re-checks the fencing token inside the same transaction; a
 *    worker that lost its lease gets LeaseLostError and must close its socket.
 *  - Nothing is logged; plaintext never leaves process memory.
 */
export async function usePostgresAuthState<C>(o: PostgresAuthStateOptions<C>): Promise<{
  state: AuthState<C>;
  saveCreds: () => Promise<void>;
  close: () => void;
  isNew: boolean;
}> {
  const codec = o.codec ?? BufferJSON;
  const serialize = (v: unknown) => Buffer.from(JSON.stringify(v, codec.replacer), 'utf8');
  const deserialize = <T>(b: Buffer) => JSON.parse(b.toString('utf8'), codec.reviver) as T;

  const ctx = { organizationId: o.organizationId };
  const keyContext = { organization_id: o.organizationId, purpose: 'whatsapp_auth', resource_id: o.instanceId };
  const credsAad = aad('wa-creds', 'v1', o.organizationId, o.instanceId);
  const keyAad = (type: string, id: string) => aad('wa-key', 'v1', o.organizationId, o.instanceId, type, id.replace(/\|/g, '%7C'));

  const guarded = async <T>(fn: Parameters<TransactionRunner['inTenant']>[0]): Promise<T> => {
    try {
      return (await o.tx.inTenant(fn, ctx)) as T;
    } catch (err) {
      if (isLeaseLost(err)) throw new LeaseLostError(o.instanceId);
      throw err;
    }
  };

  let dataKey: Buffer;
  let creds: C;
  let isNew = false;

  const existing = await o.tx.inTenant((db) => o.repo.getCredentials(db, o.instanceId), ctx);
  if (existing) {
    dataKey = await o.keys.decryptDataKey(existing.wrappedDataKey, existing.keyReference, keyContext);
    creds = deserialize<C>(aesGcmDecrypt(dataKey, existing.encryptedCredentials, credsAad));
  } else {
    if (o.requireExisting) throw new AuthStateMissingError(o.instanceId);
    isNew = true;
    const dk = await o.keys.generateDataKey(keyContext);
    dataKey = dk.plaintext;
    creds = o.initCreds();
    const encryptedCredentials = aesGcmEncrypt(dataKey, serialize(creds), credsAad);
    await guarded(async (db) => {
      await o.repo.assertLease(db, o.instanceId, o.workerId, o.leaseToken);
      await o.repo.insertCredentials(db, { organizationId: o.organizationId, instanceId: o.instanceId, encryptedCredentials,
        wrappedDataKey: dk.wrapped, keyReference: dk.keyReference, encryptionVersion: ENCRYPTION_VERSION });
    });
  }

  const keys: SignalKeyStore = {
    async get(type, ids) {
      const rows = await o.tx.inTenant((db) => o.repo.getSignalKeys(db, o.instanceId, type, ids), ctx);
      const out: Record<string, unknown> = {};
      for (const row of rows) {
        const value = deserialize<unknown>(aesGcmDecrypt(dataKey, row.encryptedValue, keyAad(type, row.keyId)));
        out[row.keyId] = o.deserializeKey ? o.deserializeKey(type, value) : value;
      }
      return out;
    },
    async set(data) {
      const upserts: Array<{ keyType: string; keyId: string; encryptedValue: Buffer }> = [];
      const deletes: Array<{ keyType: string; keyId: string }> = [];
      for (const [keyType, entries] of Object.entries(data)) {
        for (const [keyId, value] of Object.entries(entries ?? {})) {
          if (value === null || value === undefined) deletes.push({ keyType, keyId });
          else upserts.push({ keyType, keyId, encryptedValue: aesGcmEncrypt(dataKey, serialize(value), keyAad(keyType, keyId)) });
        }
      }
      if (upserts.length === 0 && deletes.length === 0) return;
      // One transaction per batch: Baileys' transaction layer commits a whole
      // logical change set through a single set() call, so it lands atomically.
      await guarded(async (db) => {
        await o.repo.assertLease(db, o.instanceId, o.workerId, o.leaseToken);
        await o.repo.upsertSignalKeys(db, o.organizationId, o.instanceId, upserts);
        await o.repo.deleteSignalKeys(db, o.instanceId, deletes);
      });
    },
    async clear() {
      await guarded(async (db) => {
        await o.repo.assertLease(db, o.instanceId, o.workerId, o.leaseToken);
        await db.query('DELETE FROM app.whatsapp_signal_keys WHERE instance_id = $1', [o.instanceId]);
      });
    },
  };

  return {
    state: { creds, keys },
    isNew,
    saveCreds: async () => {
      const encrypted = aesGcmEncrypt(dataKey, serialize(creds), credsAad);
      await guarded(async (db) => {
        await o.repo.assertLease(db, o.instanceId, o.workerId, o.leaseToken);
        await o.repo.updateCredentials(db, o.instanceId, encrypted);
      });
    },
    close: () => dataKey.fill(0), // zeroise the cached data key when the socket closes
  };
}
