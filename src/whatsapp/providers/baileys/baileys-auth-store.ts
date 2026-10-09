import { BufferJSON, initAuthCreds, proto, type AuthenticationCreds, type SignalKeyStore } from 'baileys';
import type { TransactionRunner } from '../../../database/transaction-runner.js';
import { WhatsAppRepository } from '../../../repositories/whatsapp.repository.js';
import type { KeyProvider } from '../../../security/crypto/key-provider.js';
import type { ProviderAuthPort } from '../../domain/whatsapp-provider.interface.js';
import { usePostgresAuthState } from '../../postgres-auth-state.js';

export interface BaileysAuthState {
  creds: AuthenticationCreds;
  keys: SignalKeyStore;
}

/**
 * Binds the encrypted PostgreSQL auth store to the EXACT Baileys 7 types:
 *   - initAuthCreds() for brand-new sessions,
 *   - Baileys' own BufferJSON (it also revives numeric-key byte objects, which
 *     our generic codec does not),
 *   - proto revival for 'app-state-sync-key' (same as useMultiFileAuthState).
 * Typed against the installed package, so a Baileys upgrade that changes the
 * auth contract fails compilation instead of corrupting sessions.
 */
export function createBaileysAuthPort(o: {
  tx: TransactionRunner;
  repo: WhatsAppRepository;
  keys: KeyProvider;
  organizationId: string;
  instanceId: string;
  workerId: string;
  leaseToken: number;
}): ProviderAuthPort {
  return {
    async load({ requireExisting }) {
      const store = await usePostgresAuthState<AuthenticationCreds>({
        ...o,
        initCreds: initAuthCreds,
        codec: BufferJSON,
        requireExisting,
        deserializeKey: (type, value) =>
          type === 'app-state-sync-key' && value ? proto.Message.AppStateSyncKeyData.fromObject(value as object) : value,
      });
      const state: BaileysAuthState = { creds: store.state.creds, keys: store.state.keys as unknown as SignalKeyStore };
      return { state, saveCreds: store.saveCreds, isNew: store.isNew, close: store.close };
    },
  };
}
