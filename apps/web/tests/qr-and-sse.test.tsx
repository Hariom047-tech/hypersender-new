import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openEventStream } from '@/lib/sse';

vi.mock('@/lib/workspace', () => ({ useWorkspace: () => ({ orgId: 'org-1' }) }));

/** A controllable fake SSE response body. */
function sseResponse() {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; } });
  const enc = new TextEncoder();
  return {
    res: new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    send: (type: string, data: unknown) => ctrl.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)),
    end: () => ctrl.close(),
  };
}

describe('openEventStream', () => {
  afterEach(() => vi.restoreAllMocks());

  it('parses events, reconnects after a drop, and signals the caller to refetch', async () => {
    const first = sseResponse();
    const second = sseResponse();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(first.res).mockResolvedValueOnce(second.res);
    const events: string[] = [];
    let reconnected = 0;
    const h = openEventStream({ url: '/x', headers: { 'x-organization-id': 'o' }, onEvent: (t) => events.push(t), onReconnect: () => reconnected++, maxDelayMs: 10 });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    first.send('message.created', { a: 1 });
    first.end();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), { timeout: 3000 });
    second.send('message.status_updated', { b: 2 });
    await waitFor(() => expect(events).toEqual(['message.created', 'message.status_updated']));
    expect(reconnected).toBe(1);
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({ 'x-organization-id': 'o' });
    h.close();
  });

  it('stops on 403/404 (no retry storm against a forbidden stream)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 404 }));
    let fatal = 0;
    openEventStream({ url: '/x', onEvent: () => undefined, onFatal: () => fatal++ });
    await waitFor(() => expect(fatal).toBe(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('ConnectionPanel QR lifecycle', () => {
  let setItem: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { setItem = vi.spyOn(Storage.prototype, 'setItem'); });
  afterEach(() => vi.restoreAllMocks());

  it('renders the QR locally, removes it on CONNECTED, never persists it, never calls a third party', async () => {
    const stream = sseResponse();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/events')) return stream.res;
      return new Response(JSON.stringify({ accepted: true }), { status: 202 });
    });
    const { ConnectionPanel } = await import('@/components/whatsapp/connection-panel');
    const qc = new QueryClient();
    const { container, unmount } = render(<QueryClientProvider client={qc}><ConnectionPanel instanceId="inst-1" status="CREATED" canWrite /></QueryClientProvider>);
    await act(async () => { screen.getByRole('button', { name: 'Connect WhatsApp' }).click(); });
    const RAW = '2@SECRET-QR-VALUE,abc,def';
    await act(async () => { stream.send('whatsapp.instance.qr', { qr: RAW, expiresAt: new Date(Date.now() + 30_000).toISOString() }); });
    const img = await screen.findByAltText(/WhatsApp linking QR code/);
    expect(img.getAttribute('src')).toMatch(/^data:image\/png;base64,/); // generated locally
    expect(container.innerHTML).not.toContain(RAW);                       // raw value never in the DOM
    await act(async () => { stream.send('whatsapp.instance.status', { status: 'CONNECTED' }); });
    await waitFor(() => expect(screen.queryByAltText(/WhatsApp linking QR code/)).toBeNull());
    expect(screen.getByText(/WhatsApp is connected/)).toBeTruthy();
    for (const call of fetchMock.mock.calls) expect(String(call[0])).toMatch(/^\/api\/v1\//); // only our own BFF
    expect(setItem.mock.calls.some((c: unknown[]) => String(c[1]).includes('SECRET-QR'))).toBe(false);
    expect(window.location.href).not.toContain('SECRET');
    unmount();
  });
});
