/**
 * Minimal, strict JSON-Schema validator for the subset used by the tool
 * registry (tool arguments and tool configuration). Deliberately small and
 * dependency-free: every tool argument the model produces is validated here,
 * server-side, before any handler runs.
 *
 * Supported: type (string|integer|number|boolean|object|array|null, or a list),
 * properties, required, additionalProperties:false, enum, minLength/maxLength,
 * minimum/maximum, items, maxItems, format (uuid, date, date-time, time), default.
 */
export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  enum?: unknown[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  items?: JsonSchema;
  maxItems?: number;
  format?: 'uuid' | 'date' | 'date-time' | 'time' | string;
  default?: unknown;
  description?: string;
}

export interface SchemaIssue { path: string; message: string }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function formatOk(format: string, v: string): boolean {
  switch (format) {
    case 'uuid': return UUID_RE.test(v);
    case 'date': return DATE_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
    case 'time': return TIME_RE.test(v);
    case 'date-time': return DATETIME_RE.test(v) && !Number.isNaN(Date.parse(v));
    default: return true;
  }
}

export function validateSchema(schema: JsonSchema, value: unknown, path = '$'): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const actual = typeOf(value);
  if (schema.type) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    const ok = allowed.some((t) => t === actual || (t === 'number' && actual === 'integer'));
    if (!ok) return [{ path, message: `expected ${allowed.join('|')}, got ${actual}` }];
  }
  if (schema.enum && !schema.enum.some((e) => e === value)) issues.push({ path, message: `must be one of ${schema.enum.join(', ')}` });
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) issues.push({ path, message: `shorter than ${schema.minLength}` });
    if (schema.maxLength !== undefined && value.length > schema.maxLength) issues.push({ path, message: `longer than ${schema.maxLength}` });
    if (schema.format && !formatOk(schema.format, value)) issues.push({ path, message: `invalid ${schema.format}` });
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) issues.push({ path, message: 'not a finite number' });
    if (schema.minimum !== undefined && value < schema.minimum) issues.push({ path, message: `below ${schema.minimum}` });
    if (schema.maximum !== undefined && value > schema.maximum) issues.push({ path, message: `above ${schema.maximum}` });
  }
  if (actual === 'array') {
    const arr = value as unknown[];
    if (schema.maxItems !== undefined && arr.length > schema.maxItems) issues.push({ path, message: `more than ${schema.maxItems} items` });
    if (schema.items) arr.forEach((v, i) => issues.push(...validateSchema(schema.items!, v, `${path}[${i}]`)));
  }
  if (actual === 'object') {
    const obj = value as Record<string, unknown>;
    for (const r of schema.required ?? []) if (obj[r] === undefined) issues.push({ path: `${path}.${r}`, message: 'is required' });
    for (const [k, v] of Object.entries(obj)) {
      const sub = schema.properties?.[k];
      if (!sub) {
        if (schema.additionalProperties === false) issues.push({ path: `${path}.${k}`, message: 'is not allowed' });
        continue;
      }
      if (v === undefined) continue;
      issues.push(...validateSchema(sub, v, `${path}.${k}`));
    }
  }
  return issues;
}

/** Fills `default` values of top-level properties (tool configuration). */
export function applyDefaults(schema: JsonSchema, value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...value };
  for (const [k, sub] of Object.entries(schema.properties ?? {})) if (out[k] === undefined && sub.default !== undefined) out[k] = sub.default;
  return out;
}
