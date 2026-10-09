import type { DisconnectCategory } from '../domain/whatsapp-events.js';
import type { InstanceStatus } from '../domain/whatsapp-types.js';

/**
 * Pure mapping from provider signals to our instance state machine.
 *
 *   CREATED ──connect──► WAITING_FOR_QR ──scan / pairing code──► PAIRING ──open──► CONNECTED
 *   CONNECTED ──transient close──► RECONNECTING ──open──► CONNECTED
 *   CONNECTED ──user disconnect──► DISCONNECTED (auth kept)
 *   * ──logged out / auth invalid──► LOGGED_OUT (auth destroyed, new QR required)
 *   WAITING_FOR_QR ──QR window elapsed──► DISCONNECTED (reason QR_EXPIRED)
 *   * ──connection replaced / forbidden / reconnects exhausted──► ERROR (stopped)
 */
export type CloseAction =
  | { action: 'RECONNECT_NOW'; status: null; eventType: 'RESTARTED'; reason: string }
  | { action: 'RECONNECT_BACKOFF'; status: 'RECONNECTING'; eventType: 'RECONNECTING'; reason: string }
  | { action: 'DESTROY_AUTH'; status: 'LOGGED_OUT'; eventType: 'LOGGED_OUT'; reason: string }
  | { action: 'STOP'; status: 'DISCONNECTED' | 'ERROR'; eventType: 'DISCONNECTED' | 'ERROR'; reason: string }
  | { action: 'NONE'; status: null; eventType: null; reason: string };

export function onClose(category: DisconnectCategory, reconnectAttempts: number, maxReconnectAttempts: number): CloseAction {
  switch (category) {
    case 'RESTART_REQUIRED':
      return { action: 'RECONNECT_NOW', status: null, eventType: 'RESTARTED', reason: 'PROVIDER_RESTART_REQUIRED' };
    case 'TRANSIENT':
      return reconnectAttempts >= maxReconnectAttempts
        ? { action: 'STOP', status: 'ERROR', eventType: 'ERROR', reason: 'RECONNECT_ATTEMPTS_EXHAUSTED' }
        : { action: 'RECONNECT_BACKOFF', status: 'RECONNECTING', eventType: 'RECONNECTING', reason: 'CONNECTION_LOST' };
    case 'LOGGED_OUT':
      return { action: 'DESTROY_AUTH', status: 'LOGGED_OUT', eventType: 'LOGGED_OUT', reason: 'LOGGED_OUT_FROM_PHONE' };
    case 'AUTH_INVALID':
      return { action: 'DESTROY_AUTH', status: 'LOGGED_OUT', eventType: 'LOGGED_OUT', reason: 'AUTH_INVALID' };
    case 'QR_EXPIRED':
      return { action: 'STOP', status: 'DISCONNECTED', eventType: 'DISCONNECTED', reason: 'QR_EXPIRED' };
    case 'CONNECTION_REPLACED':
      return { action: 'STOP', status: 'ERROR', eventType: 'ERROR', reason: 'CONNECTION_REPLACED' };
    case 'FORBIDDEN':
      return { action: 'STOP', status: 'ERROR', eventType: 'ERROR', reason: 'ACCOUNT_RESTRICTED' };
    case 'LOCAL_CLOSE':
      return { action: 'NONE', status: null, eventType: null, reason: 'LOCAL_CLOSE' };
  }
}

/** Statuses from which a worker should automatically (re)establish the session. */
export const RESTORABLE_STATUSES: ReadonlySet<InstanceStatus> = new Set(['CONNECTED', 'RECONNECTING']);
/** Statuses in which a user may request a new connection. */
export const CONNECTABLE_STATUSES: ReadonlySet<InstanceStatus> = new Set(['CREATED', 'DISCONNECTED', 'LOGGED_OUT', 'ERROR', 'WAITING_FOR_QR', 'PAIRING', 'RECONNECTING']);
