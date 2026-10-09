/** Typed mapping of PostgreSQL SQLSTATEs the services react to. */
export const PgCode = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  EXCLUSION_VIOLATION: '23P01',
  INSUFFICIENT_PRIVILEGE: '42501',
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK_DETECTED: '40P01',
  LOCK_NOT_AVAILABLE: '55P03',
} as const;

export interface PgError extends Error {
  code?: string;
  constraint?: string;
  hint?: string;
}

export function isPgError(err: unknown, code?: string): err is PgError {
  return typeof err === 'object' && err !== null && 'code' in err && (code === undefined || (err as PgError).code === code);
}

export function isRetryable(err: unknown): boolean {
  return isPgError(err) && (err.code === PgCode.SERIALIZATION_FAILURE || err.code === PgCode.DEADLOCK_DETECTED);
}

/** RLS WITH CHECK failures surface as 42501 "new row violates row-level security policy". */
export function isRlsViolation(err: unknown): boolean {
  return isPgError(err, PgCode.INSUFFICIENT_PRIVILEGE) && /row-level security/i.test(err.message);
}

export class LeaseLostError extends Error {
  constructor(instanceId: string) {
    super(`WhatsApp session lease lost for instance ${instanceId}; this worker must stop the socket`);
  }
}

export function isLeaseLost(err: unknown): boolean {
  return isPgError(err, PgCode.LOCK_NOT_AVAILABLE) && (err as PgError).hint === 'HS_LEASE_LOST';
}
