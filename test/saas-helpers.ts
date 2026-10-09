import request from 'supertest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { HmacSessionService } from '../src/api/auth/session.service.js';
import { REALTIME_BUS, type RealtimeBus } from '../src/whatsapp/realtime/realtime-bus.js';
import { TEST_DB } from './helpers.js';

export interface Api {
  app: NestExpressApplication;
  http: ReturnType<typeof request>;
  bus: RealtimeBus;
  port: number;
  token(userId: string): string;
  as(userId: string, orgId: string): <T extends request.Test>(r: T) => T;
}

/** Real Nest API in-process (test DB, in-memory realtime bus shared with worker rigs). */
export async function startApi(env: Record<string, string> = {}): Promise<Api> {
  process.env.DB_NAME = TEST_DB;
  process.env.REALTIME_BUS = 'memory';
  process.env.SESSION_SECRET ??= 'test-session-secret-0123456789-abcdefghij';
  process.env.MEDIA_STORAGE_PROVIDER = 'LOCAL_DEV';
  Object.assign(process.env, env);
  const { createApiApp } = await import('../src/api/app-factory.js');
  const app = await createApiApp({ swagger: false });
  await app.init();
  const server = app.getHttpServer();
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  const sessions = app.get(HmacSessionService);
  const http = request(server);
  return {
    app, http, bus: app.get(REALTIME_BUS), port,
    token: (userId) => sessions.issue(userId),
    as: (userId, orgId) => (r) => r.set('authorization', `Bearer ${sessions.issue(userId)}`).set('x-organization-id', orgId),
  };
}

export interface SseClient { events: Array<{ type: string; data: any }>; raw: () => string; status: number; close: () => Promise<void> }

/** Opens an SSE stream and collects parsed events until closed. */
export async function openSse(port: number, path: string, headers: Record<string, string>): Promise<SseClient> {
  const ctrl = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers, signal: ctrl.signal });
  const events: SseClient['events'] = [];
  let buf = '';
  let raw = '';
  const pump = (async () => {
    if (!res.body || res.status !== 200) return;
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value).toString();
        raw += chunk;
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const type = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (type) events.push({ type, data: data ? JSON.parse(data) : null });
        }
      }
    } catch { /* aborted */ }
  })();
  return { events, raw: () => raw, status: res.status, close: async () => { ctrl.abort(); await pump; } };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
