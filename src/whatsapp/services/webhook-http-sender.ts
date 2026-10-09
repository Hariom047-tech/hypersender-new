import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import type { HttpSender } from '../../services/webhook.service.js';

const MAX_RESPONSE_BYTES = 4096;

/**
 * Addresses a webhook may never reach: loopback, RFC1918, CGNAT, link-local
 * (incl. cloud metadata 169.254.169.254 / fd00:ec2::254), multicast, reserved,
 * unspecified, IPv6 ULA / link-local, IPv4-mapped forms of all of these.
 */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') ||
    v.startsWith('fea') || v.startsWith('feb') || v.startsWith('ff') || v.startsWith('64:ff9b:');
}

export class UnsafeWebhookTargetError extends Error {}

/**
 * DNS lookup used BY THE CONNECTION ITSELF: every resolved address is validated
 * and the socket connects to exactly the address that passed validation. This
 * closes the DNS-rebinding window between "check" and "connect".
 */
export function guardedLookup(allowPrivate: boolean): LookupFunction {
  return ((hostname: string, options: object, callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) => {
    dnsLookup(hostname, { ...(options as object), all: true }, (err, addresses) => {
      if (err) return callback(err, '', 0);
      const list = addresses as LookupAddress[];
      if (!allowPrivate && (list.length === 0 || list.some((a) => isPrivateAddress(a.address)))) {
        return callback(Object.assign(new UnsafeWebhookTargetError('webhook host resolves to a private/internal address'), { code: 'EHOSTUNSAFE' }), '', 0);
      }
      if ((options as { all?: boolean }).all) return callback(null, list);
      callback(null, list[0].address, list[0].family);
    });
  }) as LookupFunction;
}

/** Early validation for create/update (friendly error). Delivery re-validates at connect time. */
export async function assertSafeWebhookUrl(url: string, allowPrivate: boolean): Promise<void> {
  let u: URL;
  try { u = new URL(url); } catch { throw new UnsafeWebhookTargetError('invalid URL'); }
  if (u.protocol !== 'https:') throw new UnsafeWebhookTargetError('webhook URL must use https');
  if (u.username || u.password) throw new UnsafeWebhookTargetError('credentials in the URL are not allowed');
  if (allowPrivate) return;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new UnsafeWebhookTargetError('internal hostnames are not allowed');
  }
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (addrs.length === 0) throw new UnsafeWebhookTargetError('webhook host does not resolve');
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new UnsafeWebhookTargetError('webhook host resolves to a private/internal address');
}

/**
 * Outbound webhook HTTP client:
 *  - HTTPS only, certificate verification on, redirects NOT followed;
 *  - SSRF: guardedLookup validates the exact address being connected to;
 *    IP-literal hosts are validated directly;
 *  - hard timeout, response read capped at 4 KB.
 */
export class SafeWebhookSender implements HttpSender {
  constructor(private readonly timeoutMs: number, private readonly allowPrivateNetworks: boolean) {}

  post(url: string, body: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
    const u = new URL(url);
    if (u.protocol !== 'https:') return Promise.reject(new Error('webhook URL must use https'));
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) && !this.allowPrivateNetworks && isPrivateAddress(host)) {
      return Promise.reject(new UnsafeWebhookTargetError('webhook host is a private/internal address'));
    }
    return new Promise((resolve, reject) => {
      const req = request(u, {
        method: 'POST',
        headers: { ...headers, 'content-length': Buffer.byteLength(body).toString() },
        lookup: guardedLookup(this.allowPrivateNetworks),
        timeout: this.timeoutMs,
      }, (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (c: Buffer) => {
          if (total < MAX_RESPONSE_BYTES) { chunks.push(c); total += c.length; }
          if (total >= MAX_RESPONSE_BYTES) res.destroy();
        });
        const done = () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8').slice(0, MAX_RESPONSE_BYTES) });
        res.on('end', done);
        res.on('close', done);
        res.on('error', done);
      });
      req.on('timeout', () => req.destroy(new Error(`timed out after ${this.timeoutMs}ms`)));
      req.on('error', reject);
      req.end(body);
    });
  }
}

/** @deprecated kept for backward compatibility of imports; use SafeWebhookSender. */
export const FetchWebhookSender = SafeWebhookSender;
