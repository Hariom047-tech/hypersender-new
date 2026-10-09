/** Bounded concurrency (restore storms, media downloads). */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly limit: number) {
    if (limit < 1) throw new Error('semaphore limit must be >= 1');
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
  get inFlight(): number { return this.active; }
}

/**
 * Per-instance outgoing limiter: one send at a time, at least `minIntervalMs`
 * between sends. Conservative on purpose - this gateway is for legitimate
 * conversational messaging, not bulk sending.
 */
export class SerialRateLimiter {
  private tail: Promise<unknown> = Promise.resolve();
  private last = 0;
  constructor(private readonly minIntervalMs: number, private readonly now: () => number = Date.now) {}
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(async () => {
      const wait = this.last + this.minIntervalMs - this.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try {
        return await fn();
      } finally {
        this.last = this.now();
      }
    });
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/** Exponential backoff with full jitter, capped: uniform in [min, min(max, min * 2^attempt)]. */
export function backoffDelay(attempt: number, minMs: number, maxMs: number, random: () => number = Math.random): number {
  const ceiling = Math.min(maxMs, minMs * 2 ** Math.min(attempt, 30));
  return Math.round(minMs + random() * Math.max(0, ceiling - minMs));
}

/** Fixed-window per-key limiter (per process). Future: Redis-backed for multi-replica APIs. */
export class WindowRateLimiter {
  private readonly hits = new Map<string, { windowStart: number; count: number }>();
  constructor(private readonly limit: number, private readonly windowMs: number, private readonly now: () => number = Date.now) {}
  tryAcquire(key: string): boolean {
    const t = this.now();
    const h = this.hits.get(key);
    if (!h || t - h.windowStart >= this.windowMs) {
      this.hits.set(key, { windowStart: t, count: 1 });
      if (this.hits.size > 50_000) this.gc(t);
      return true;
    }
    if (h.count >= this.limit) return false;
    h.count++;
    return true;
  }
  private gc(t: number): void {
    for (const [k, v] of this.hits) if (t - v.windowStart >= this.windowMs) this.hits.delete(k);
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); }),
  ]);
}
