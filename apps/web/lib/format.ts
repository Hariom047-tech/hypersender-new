import { locale, msg, t } from './i18n';

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return t('just now');
  if (s < 3600) return t('{n}m ago', { n: Math.round(s / 60) });
  if (s < 86400) return t('{n}h ago', { n: Math.round(s / 3600) });
  if (s < 7 * 86400) return t('{n}d ago', { n: Math.round(s / 86400) });
  return new Date(iso).toLocaleDateString(locale());
}

export function dateTime(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString(locale()) : '—';
}

export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
}

export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function money(minor: number | null | undefined, currency: string): string {
  if (minor === null || minor === undefined) return '—';
  return new Intl.NumberFormat(locale(), { style: 'currency', currency }).format(minor / 100);
}

/** Display name for a contact without inventing data. */
export function contactLabel(c: { name: string | null; phone: string | null; identity: string }): string {
  return c.name || c.phone || c.identity;
}

export const INSTANCE_STATUS_TEXT: Record<string, string> = {
  CREATED: msg('Not connected'),
  WAITING_FOR_QR: msg('Waiting for QR scan'),
  PAIRING: msg('Pairing…'),
  CONNECTED: msg('Connected'),
  RECONNECTING: msg('Reconnecting…'),
  DISCONNECTED: msg('WhatsApp disconnected'),
  LOGGED_OUT: msg('Logged out — scan QR to reconnect'),
  ERROR: msg('Connection problem'),
  SUSPENDED: msg('Suspended'),
};

export const MESSAGE_STATUS_TEXT: Record<string, string> = {
  QUEUED: msg('Queued'), SENT: msg('Sent'), DELIVERED: msg('Delivered'), READ: msg('Read'), FAILED: msg('Failed'), REVOKED: msg('Deleted'), RECEIVED: msg('Received'),
};
