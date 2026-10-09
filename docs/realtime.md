# Realtime (dashboard live updates)

## Pipeline

```
worker tx (message stored / status changed / instance state)            API process(es)
  └─ outbox_events row (same tx)                                          ┌─ GET /v1/realtime/stream (SSE, org-wide)
       └─ outbox relay → app-events-bridge ──► RealtimeBus ──────────────►│   filtered per org / business / user
                                                (pg LISTEN/NOTIFY,        └─ GET /v1/whatsapp/instances/:id/events
                                                 AES-GCM encrypted)           (per instance: QR, pairing, status)
```

* Events are produced **from committed rows only** (outbox relay after the tx), so the UI never shows a message the
  DB rolled back. `src/whatsapp/services/app-events-bridge.ts` loads a *view* of the row (`src/api/views.ts`) – the
  same shape the REST API returns – so REST and realtime payloads are interchangeable in the client cache.
* `RealtimeBus` = PostgreSQL `LISTEN/NOTIFY` with AES-256-GCM payloads (`REALTIME_BUS_KEY`), so any number of API
  processes receive every event without Redis. Tests use the in-memory bus. Payload text is truncated to
  `REALTIME_TEXT_LIMIT` (1,500 chars); the client refetches the full message when needed.

## Streams

| Stream | Scope required | Carries |
|---|---|---|
| `GET /v1/realtime/stream[?businessId=]` | `messages:read` | `ready`, `ping` (25 s), `conversation.created`, `conversation.updated`, `message.created`, `message.status_updated`, `instance.status_updated`, `notification.created` |
| `GET /v1/whatsapp/instances/:id/events` | `instances:write` | `whatsapp.instance.qr`, `whatsapp.instance.pairing_code`, `whatsapp.instance.status` for **one** instance |

Server-side filters (never the browser's job): organization of the caller; business restriction (business-scoped API
key or `?businessId=`); recipient user for `notification.created`. QR codes are **never** on the org-wide stream.

## Client (`apps/web/lib/sse.ts`, `lib/realtime.tsx`)

* SSE over `fetch` (not `EventSource`) so the `X-Organization-Id` header can be sent; the session cookie is attached
  by the BFF. Exponential backoff with jitter (1 s → 30 s); 401/403/404 are fatal (no retry storm).
* **Reconnect = refetch.** SSE is best-effort; on every reconnect the provider invalidates `['org', orgId]` so every
  visible list is reloaded from the DB (the source of truth). Missed events are therefore harmless.
* Merge rules (`lib/cache-merge.ts`), all idempotent:
  * messages are upserted **by id** – the POST response and the `message.created` event for the same message never
    produce two bubbles;
  * status is **forward-only** (`QUEUED < SENT < DELIVERED < READ`, `FAILED` terminal) – a late `DELIVERED` never
    downgrades `READ`;
  * conversations are upserted into every cached list of the organization whose filter (`open/unread/resolved/all`,
    business, instance, search) they match, removed from lists they no longer match, and moved to the top.
* Switching organization removes all cached queries of the old organization and remounts the page tree, then the
  stream is reopened with the new header.

## Limits

* The per-instance **QR cache** (last QR for late subscribers) is per API process and short-lived by design (QR codes
  must not be persisted). Behind a load balancer the browser simply waits for the next QR (~20 s) if it reconnects to a
  different API process.
* SSE connections are held by API processes; size the process count for concurrent dashboard users (one stream per tab).
