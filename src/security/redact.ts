/**
 * Recursively redacts secret-bearing fields before anything is logged, put in
 * audit metadata, stored in ai_tool_calls.arguments, or sent to a model.
 * The audit_logs table additionally rejects top-level secret keys via CHECK.
 */
const SECRET_KEY = /((^|[_-])(pin|otp|cvv)([_-]|$)|password|passwd|passphrase|secret|token|api[_-]?key|key[_-]?hash|credential|private[_-]?key|authorization|cookie|card[_-]?number)/i;

export const REDACTED = '[REDACTED]';

export function redact<T>(value: T, depth = 0): T {
  if (depth > 20) return REDACTED as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as unknown as T;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return REDACTED as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? REDACTED : redact(v, depth + 1);
    }
    return out as T;
  }
  return value;
}
