import { isUuid } from './uuid.js';
import { WhatsAppError } from '../whatsapp/domain/whatsapp-errors.js';

/** Minimal explicit request validation (no reflection-based magic). */
type Body = Record<string, unknown> | undefined | null;

const fail = (msg: string): never => { throw new WhatsAppError('VALIDATION_FAILED', msg); };

export function obj(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('request body must be a JSON object');
  return body as Record<string, unknown>;
}

export function str(b: Body, key: string, o: { min?: number; max?: number; optional?: boolean; pattern?: RegExp } = {}): string {
  const v = b?.[key];
  if (v === undefined || v === null || v === '') {
    if (o.optional) return undefined as unknown as string;
    fail(`${key} is required`);
  }
  if (typeof v !== 'string') fail(`${key} must be a string`);
  const s = v as string;
  if (o.min !== undefined && s.length < o.min) fail(`${key} must be at least ${o.min} characters`);
  if (o.max !== undefined && s.length > o.max) fail(`${key} must be at most ${o.max} characters`);
  if (o.pattern && !o.pattern.test(s)) fail(`${key} has an invalid format`);
  return s;
}

export function optStr(b: Body, key: string, o: { min?: number; max?: number; pattern?: RegExp } = {}): string | undefined {
  return str(b, key, { ...o, optional: true }) ?? undefined;
}

export function uuidParam(v: unknown, name = 'id'): string {
  if (!isUuid(v)) throw new WhatsAppError('VALIDATION_FAILED', `${name} must be a UUID`);
  return v;
}

export function strArray(b: Body, key: string, allowed: readonly string[], o: { min?: number } = {}): string[] {
  const v = b?.[key];
  if (!Array.isArray(v) || v.length < (o.min ?? 1)) fail(`${key} must be a non-empty array`);
  for (const x of v as unknown[]) if (typeof x !== 'string' || !allowed.includes(x)) fail(`${key} contains an unsupported value`);
  return [...new Set(v as string[])];
}
