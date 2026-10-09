import { msg, t } from './i18n';

/**
 * Browser API client. Talks ONLY to this origin's BFF (/api/*): the session is
 * an HttpOnly cookie the browser JS cannot read. Every call is organization-
 * scoped by header; the backend re-verifies membership and RLS on every request.
 */
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

/** Backend error codes -> language an owner understands. Never shows stack traces/SQL/provider internals. */
const FRIENDLY: Record<string, string> = {
  WHATSAPP_INSTANCE_NOT_CONNECTED: msg('WhatsApp is disconnected. Reconnect it before sending.'),
  WHATSAPP_INSTANCE_ALREADY_CONNECTED: msg('This WhatsApp number is already connected.'),
  WHATSAPP_INSTANCE_LIMIT_REACHED: msg('Your plan’s WhatsApp number limit is reached. Upgrade or remove an instance.'),
  WHATSAPP_INSTANCE_NOT_FOUND: msg('This WhatsApp instance does not exist or you do not have access.'),
  WHATSAPP_QR_NOT_AVAILABLE: msg('No QR code is waiting right now. Press Connect to get a new one.'),
  WHATSAPP_LOGGED_OUT: msg('This WhatsApp is logged out. Connect and scan a new QR code.'),
  WHATSAPP_PAIRING_CODE_UNAVAILABLE: msg('Could not get a pairing code in time. Try again or use the QR code.'),
  WHATSAPP_RATE_LIMITED: msg('You are sending too fast. Wait a moment and try again.'),
  WHATSAPP_INVALID_RECIPIENT: msg('That phone number is not valid.'),
  WHATSAPP_MEDIA_TOO_LARGE: msg('The file is too large.'),
  WHATSAPP_UNSUPPORTED_MESSAGE: msg('This file type is not supported.'),
  SUBSCRIPTION_INACTIVE: msg('Your subscription is not active.'),
  FEATURE_NOT_IN_PLAN: msg('This feature is not included in your current plan.'),
  PLAN_LIMIT_REACHED: msg('Your plan limit is reached.'),
  FORBIDDEN: msg('You do not have permission to do this.'),
  UNAUTHENTICATED: msg('Please sign in again.'),
  NOT_FOUND: msg('Not found, or you do not have access.'),
  INTERNAL_ERROR: msg('Something went wrong on our side. Please try again.'),
};

export function friendlyMessage(err: unknown): string {
  if (err instanceof ApiError) {
    // Validation/permission messages from the backend are written for humans; others map by code.
    if (['VALIDATION_FAILED', 'CONFLICT', 'PLAN_LIMIT_REACHED', 'FEATURE_NOT_IN_PLAN'].includes(err.code) && err.message) return t(err.message);
    return t(FRIENDLY[err.code] ?? err.message ?? msg('Request failed.'));
  }
  return t('Network error. Check your connection and try again.');
}

let currentOrg: string | null = null;
/** Set by the workspace provider whenever the active organization changes. */
export function setApiOrganization(id: string | null): void { currentOrg = id; }

export async function api<T>(path: string, init: { method?: string; body?: unknown; org?: string | null; signal?: AbortSignal } = {}): Promise<T> {
  const org = init.org === undefined ? currentOrg : init.org;
  const res = await fetch(`/api${path}`, {
    method: init.method ?? 'GET',
    headers: {
      accept: 'application/json',
      'x-hs-csrf': '1',
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(org ? { 'x-organization-id': org } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: 'same-origin',
    signal: init.signal,
    cache: 'no-store',
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const e = new ApiError(res.status, data?.error?.code ?? 'HTTP_ERROR', data?.error?.message ?? `HTTP ${res.status}`);
    if (res.status === 401 && typeof window !== 'undefined' && !path.startsWith('/auth/')) window.location.assign('/login');
    throw e;
  }
  return data as T;
}

export function qs(params: Record<string, string | number | null | undefined | false>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== false && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}
