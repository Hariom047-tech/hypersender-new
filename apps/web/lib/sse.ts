/**
 * Server-Sent Events over fetch (EventSource cannot send the organization
 * header). Reconnects automatically with capped exponential backoff + jitter
 * and calls onReconnect so callers can REFETCH: events may have been missed
 * while disconnected - the database is the source of truth.
 */
export interface SseHandle { close(): void }

export function openEventStream(opts: {
  url: string;
  headers?: Record<string, string>;
  onEvent: (type: string, data: unknown) => void;
  onOpen?: () => void;
  onReconnect?: () => void;
  onFatal?: (status: number) => void;
  maxDelayMs?: number;
}): SseHandle {
  let closed = false;
  let ctrl: AbortController | null = null;
  let attempt = 0;
  let connectedOnce = false;

  const run = async (): Promise<void> => {
    while (!closed) {
      ctrl = new AbortController();
      try {
        const res = await fetch(opts.url, { headers: { accept: 'text/event-stream', ...(opts.headers ?? {}) }, signal: ctrl.signal, cache: 'no-store' });
        if (res.status === 401 || res.status === 403 || res.status === 404) { opts.onFatal?.(res.status); return; }
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        if (connectedOnce) opts.onReconnect?.();
        connectedOnce = true;
        attempt = 0;
        opts.onOpen?.();
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            let type = 'message';
            const data: string[] = [];
            for (const line of block.split('\n')) {
              if (line.startsWith('event:')) type = line.slice(6).trim();
              else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
            }
            if (!data.length) continue;
            try { opts.onEvent(type, JSON.parse(data.join('\n'))); } catch { /* malformed event: ignore */ }
          }
        }
      } catch {
        if (closed) return;
      }
      if (closed) return;
      const ceiling = Math.min(opts.maxDelayMs ?? 30_000, 1000 * 2 ** Math.min(attempt++, 5));
      await new Promise((r) => setTimeout(r, 500 + Math.random() * ceiling));
    }
  };
  void run();
  return { close: () => { closed = true; ctrl?.abort(); } };
}
