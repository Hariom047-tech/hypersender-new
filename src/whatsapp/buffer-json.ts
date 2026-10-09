/**
 * JSON (de)serialisation that round-trips Buffers / Uint8Arrays, wire-compatible
 * with Baileys' BufferJSON ({ type: 'Buffer', data: <base64> }), so auth state
 * written by this adapter is identical to what Baileys itself would persist.
 */
export const BufferJSON = {
  replacer(_key: string, value: unknown): unknown {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
      return { type: 'Buffer', data: Buffer.from(value).toString('base64') };
    }
    if (value && typeof value === 'object' && (value as { type?: string }).type === 'Buffer' && Array.isArray((value as { data?: unknown }).data)) {
      // Buffer.toJSON() output ({type:'Buffer', data:[...bytes]}) - normalise to base64
      return { type: 'Buffer', data: Buffer.from((value as { data: number[] }).data).toString('base64') };
    }
    return value;
  },
  reviver(_key: string, value: unknown): unknown {
    if (value && typeof value === 'object' && (value as { type?: string }).type === 'Buffer') {
      const data = (value as { data: unknown }).data;
      if (typeof data === 'string') return Buffer.from(data, 'base64');
      if (Array.isArray(data)) return Buffer.from(data as number[]);
    }
    return value;
  },
};

export function serialize(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value, BufferJSON.replacer), 'utf8');
}

export function deserialize<T>(bytes: Buffer): T {
  return JSON.parse(bytes.toString('utf8'), BufferJSON.reviver) as T;
}
