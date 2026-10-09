import type { ConnectionParams, WhatsAppConnection, WhatsAppProvider } from '../../domain/whatsapp-provider.interface.js';
import { BaileysSession, type BaileysSessionOptions } from './baileys-session.js';

/** Baileys implementation of the provider abstraction. Nothing Baileys-specific escapes this folder. */
export class BaileysWhatsAppProvider implements WhatsAppProvider {
  readonly name = 'BAILEYS' as const;

  constructor(private readonly opts: BaileysSessionOptions) {}

  createConnection(params: ConnectionParams): Promise<WhatsAppConnection> {
    return BaileysSession.open(params, this.opts);
  }

  restoreConnection(params: Omit<ConnectionParams, 'requireExistingAuth' | 'pairingPhoneE164'>): Promise<WhatsAppConnection> {
    return BaileysSession.open({ ...params, requireExistingAuth: true }, this.opts);
  }
}
