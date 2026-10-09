import { pino, type DestinationStream, type Logger } from 'pino';

/**
 * Structured JSON logging (pino).
 *
 * Standard bindings: request_id, organization_id, business_id, instance_id,
 * worker_id, event_name.
 *
 * NEVER logged: QR strings, pairing codes, message bodies (unless
 * LOG_MESSAGE_CONTENT=true), auth creds, signal keys, API keys, webhook
 * secrets, ciphertext. The redact list is a backstop - call sites must not pass
 * such values in the first place.
 */
export const REDACT_PATHS = [
  'qr', '*.qr', 'pairingCode', '*.pairingCode', 'pairing_code', '*.pairing_code',
  'creds', '*.creds', 'keys', '*.keys', 'auth', '*.auth', 'authState', '*.authState',
  'noiseKey', '*.noiseKey', 'signedIdentityKey', '*.signedIdentityKey', 'signedPreKey', '*.signedPreKey',
  'advSecretKey', '*.advSecretKey', 'privateKey', '*.privateKey', 'private', '*.private',
  'secret', '*.secret', 'password', '*.password', 'apiKey', '*.apiKey', 'api_key', '*.api_key',
  'authorization', '*.authorization', 'headers.authorization', 'headers["x-api-key"]',
  'token', '*.token', 'text', '*.text', 'textBody', '*.textBody', 'body', '*.body', 'caption', '*.caption',
  'encrypted_credentials', '*.encrypted_credentials', 'encryptedValue', '*.encryptedValue',
];

const CONTENT_PATHS = new Set(['text', '*.text', 'textBody', '*.textBody', 'body', '*.body', 'caption', '*.caption']);

export function createLogger(opts: { level?: string; destination?: DestinationStream; logMessageContent?: boolean; bindings?: Record<string, unknown> } = {}): Logger {
  const paths = opts.logMessageContent ? REDACT_PATHS.filter((p) => !CONTENT_PATHS.has(p)) : REDACT_PATHS;
  const base = pino(
    {
      level: opts.level ?? process.env.LOG_LEVEL ?? 'info',
      redact: { paths, censor: '[REDACTED]' },
      base: { service: 'hypersender', ...opts.bindings },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
    },
    opts.destination,
  );
  return base;
}

export type { Logger };
export const LOGGER = Symbol('LOGGER');
