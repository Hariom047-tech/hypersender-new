import { DisconnectReason, WAMessageStatus } from 'baileys';
import type { DisconnectCategory } from '../../domain/whatsapp-events.js';
import type { ReceiptStatus } from '../../domain/whatsapp-types.js';

/** Extracts the numeric status from a Baileys close error (a @hapi/boom error) without depending on Boom's types. */
export function disconnectStatusCode(error: unknown): number | null {
  const code = (error as { output?: { statusCode?: unknown } } | undefined)?.output?.statusCode;
  return typeof code === 'number' ? code : null;
}

/**
 * Baileys DisconnectReason -> our DisconnectCategory.
 * `registered` = the stored credentials belong to an already-linked device.
 * Unknown codes are TRANSIENT (reconnect with backoff) - never crash.
 */
export function mapDisconnect(error: unknown, registered: boolean): { category: DisconnectCategory; code: number | null } {
  const code = disconnectStatusCode(error);
  switch (code) {
    case DisconnectReason.loggedOut:            return { category: 'LOGGED_OUT', code };
    case DisconnectReason.restartRequired:      return { category: 'RESTART_REQUIRED', code };
    case DisconnectReason.connectionReplaced:   return { category: 'CONNECTION_REPLACED', code };
    case DisconnectReason.multideviceMismatch:  return { category: 'AUTH_INVALID', code };
    case DisconnectReason.badSession:           return { category: registered ? 'TRANSIENT' : 'AUTH_INVALID', code };
    case DisconnectReason.forbidden:            return { category: 'FORBIDDEN', code };
    case DisconnectReason.timedOut:             // 408 (== connectionLost)
      return { category: registered ? 'TRANSIENT' : 'QR_EXPIRED', code };
    default:
      return { category: registered ? 'TRANSIENT' : 'QR_EXPIRED', code };
  }
}

/** WebMessageInfo.Status -> receipt status. PENDING / unknown values -> null (ignored, never thrown). */
export function mapAckStatus(status: number | null | undefined): ReceiptStatus | null {
  switch (status) {
    case WAMessageStatus.SERVER_ACK:   return 'SENT';
    case WAMessageStatus.DELIVERY_ACK: return 'DELIVERED';
    case WAMessageStatus.READ:
    case WAMessageStatus.PLAYED:       return 'READ';
    case WAMessageStatus.ERROR:        return 'FAILED';
    default:                           return null;
  }
}
