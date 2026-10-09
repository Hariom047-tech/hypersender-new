import type { RealtimeBus, RealtimeEvent } from './realtime-bus.js';

interface Entry { organizationId: string; qr: string; expiresAt: number }

/**
 * Latest QR per instance, held ONLY in API-process memory until it expires
 * (never in PostgreSQL, never logged). Lets a client that subscribes a moment
 * after the QR was produced still render it. Reads are tenant-checked.
 */
export class QrCache {
  private readonly entries = new Map<string, Entry>();
  private readonly unsubscribe: () => void;

  constructor(bus: RealtimeBus, private readonly now: () => number = Date.now) {
    this.unsubscribe = bus.subscribe((e) => this.onEvent(e));
  }

  private onEvent(e: RealtimeEvent): void {
    if (!e.instanceId) return;
    if (e.type === 'whatsapp.instance.qr' && typeof e.data.qr === 'string') {
      this.entries.set(e.instanceId, { organizationId: e.organizationId, qr: e.data.qr, expiresAt: Date.parse(String(e.data.expiresAt)) });
    } else if (e.type === 'whatsapp.instance.status' && e.data.status !== 'WAITING_FOR_QR') {
      this.entries.delete(e.instanceId);
    }
  }

  get(organizationId: string, instanceId: string): { qr: string; expiresAt: Date } | null {
    const e = this.entries.get(instanceId);
    if (!e || e.organizationId !== organizationId) return null;
    if (e.expiresAt <= this.now()) { this.entries.delete(instanceId); return null; }
    return { qr: e.qr, expiresAt: new Date(e.expiresAt) };
  }

  close(): void { this.unsubscribe(); this.entries.clear(); }
}
