# WhatsApp Gateway (Phase 2)

Provider: **Baileys `7.0.0-rc14`** (npm package `baileys`, pinned exactly). No browser automation.

```
Business owner ──HTTP──► API process (hs_app) ──transactional outbox──► Gateway worker (hs_worker) ──Baileys──► WhatsApp
      ▲                        │   ▲                                         │
      └── SSE (QR/status) ─────┘   └──── realtime bus (encrypted LISTEN/NOTIFY) ◄┘
```

| Process | Credentials | Responsibilities |
|---|---|---|
| `npm run start:api` | `hs_app` | REST + SSE, auth (dashboard session or API key), validation, enqueue commands/sends |
| `npm run start:worker` | `hs_worker` | Baileys sockets, session ownership, ingestion, sends, receipts, outbox relay, webhook delivery |

Code map (`src/whatsapp/`):

| Path | Role |
|---|---|
| `domain/` | provider-neutral types, events, errors, `WhatsAppProvider` interface, phone/JID helpers. **No Baileys imports.** |
| `providers/baileys/` | the only place Baileys is imported: session (socket lifetime), auth store binding, message normalizer, error mapper |
| `services/whatsapp-session-manager.service.ts` | live sockets of this worker, lease/fencing, heartbeat, restore, reconnect, commands, sends |
| `services/whatsapp-connection.service.ts` + `connection-state-machine.ts` | state transitions (fenced, evented) |
| `services/whatsapp-instance.service.ts`, `whatsapp-message.service.ts` | API-side lifecycle + sends |
| `services/whatsapp-webhook-bridge.ts`, `webhook-http-sender.ts` | normalised webhook payloads, safe HTTP delivery |
| `realtime/` | `RealtimeBus` (in-memory / encrypted pg NOTIFY), QR cache |
| `media/` | `MediaStorageService` (local dev / private S3 port) |
| `gateway-worker.ts`, `../worker.ts` | worker composition + entry point (signals) |

## Provider abstraction

`WhatsAppProvider.createConnection / restoreConnection` → `WhatsAppConnection` with `sendText / sendImage / sendDocument /
sendAudio / sendVideo / sendLocation / getConnectionState / disconnect / logout / generateMessageId`; events are delivered
through the `onEvent` callback as provider-neutral `ProviderEvent`s. `restart` is a session-manager operation
(close + restore). A `MetaCloudWhatsAppProvider` would implement the same interface (no QR; `generateMessageId()` returns
`null` because Cloud API assigns ids server-side).

## Connection flow & state machine

```
CREATED ─connect─► WAITING_FOR_QR ─scan / pairing code─► PAIRING ─(515 restart)─► CONNECTED
CONNECTED ─network drop─► RECONNECTING ─backoff─► CONNECTED
CONNECTED ─user disconnect─► DISCONNECTED            (auth kept; RESTART reconnects without QR)
*        ─logout / 401 / 411 / bad creds─► LOGGED_OUT (auth destroyed; new QR needed)
WAITING_FOR_QR ─QR window over─► DISCONNECTED (QR_EXPIRED)
*        ─440 replaced / 403 forbidden / reconnects exhausted─► ERROR (stopped)
worker SIGTERM: CONNECTED ─► RECONNECTING, lease released, no logout ─► restored by next worker
```

Baileys `DisconnectReason` → our category (`baileys-error-mapper.ts`): 401 LOGGED_OUT · 515 RESTART_REQUIRED (immediate
reconnect) · 440 CONNECTION_REPLACED · 411 AUTH_INVALID · 500 AUTH_INVALID if unregistered else TRANSIENT · 403 FORBIDDEN ·
408/428/503/unknown TRANSIENT when registered, QR_EXPIRED when not. Provider codes never reach public APIs.

Every transition, in ONE worker transaction: lease assertion → `whatsapp_instances` update → `whatsapp_instance_events`
row (`QR_GENERATED`, `PAIRING_STARTED`, `CONNECTED`, `RECONNECTING`, `RESTARTED`, `DISCONNECTED`, `LOGGED_OUT`,
`CREDENTIALS_DESTROYED`, `ERROR`) → outbox `INSTANCE_STATUS_CHANGED` (+ `INSTANCE_CONNECTED` / `INSTANCE_DISCONNECTED`).

### QR flow
1. `POST /v1/whatsapp/instances/{id}/connect` (scope `instances:write`) validates tenant, business scope, subscription,
   status; writes an `INSTANCE_COMMAND {CONNECT}` outbox event with `target_instance_id`; returns **202**.
2. A worker with capacity claims it, claims the instance lease, creates fresh encrypted credentials, opens the socket.
3. Baileys emits `connection.update { qr }` → worker publishes `whatsapp.instance.qr {qr, expiresAt}` on the realtime
   bus. The first QR of an attempt records `QR_GENERATED` (expiry only). **The QR string is never written to PostgreSQL,
   logs, audit or analytics.**
4. API processes receive it (encrypted NOTIFY), keep only the latest per instance in memory until it expires, and
   forward it to `GET /instances/{id}/events` (SSE) subscribers of **that tenant** (ownership verified through RLS
   before subscribing; every event is filtered by organization and instance) or `GET /instances/{id}/qr`.

SSE was chosen over WebSocket: the flow is one-directional, it reuses the exact same auth middleware and RLS checks
(no second auth path), and works through ordinary HTTP infrastructure. Clients that need custom headers use a
fetch-based EventSource.

### Pairing code
`POST /instances/{id}/pairing-code {phoneNumber}` enqueues CONNECT with the number; when Baileys is ready (first `qr`
signal) the adapter calls `sock.requestPairingCode()` instead of emitting a QR; the code travels over the bus back to the
waiting API request (bounded wait, `WHATSAPP_PAIRING_CODE_WAIT_MS`). Never stored or logged.

## Session ownership (workers)

* **Lease + fencing token** in `whatsapp_instances` (`worker_id`, `worker_lease_expires_at`, `worker_lease_token`),
  claimed by atomic compare-and-set (`app.claim_instance_lease`, and `app.claim_instance_lease_for_link` for explicit
  user re-links after logout - migration 0013).
* Every credential/key/state write runs `app.assert_instance_lease(instance, worker, token)` in the same transaction.
  A worker that lost the lease gets `HS_LEASE_LOST` and stops its socket **without writing anything**.
* **Heartbeat** (`WHATSAPP_WORKER_HEARTBEAT_INTERVAL_MS`): renews leases of live sockets, updates
  `whatsapp_workers.last_heartbeat_at / active_sessions / status`, reaps workers stale for `WHATSAPP_WORKER_STALE_AFTER_MS`
  (→ `DEAD`). A session whose lease could not be renewed is dropped locally at once.
* **Orphan scan** (`WHATSAPP_ORPHAN_SCAN_INTERVAL_MS`) + boot restore: sessions in `CONNECTED/RECONNECTING` whose lease is
  free/expired are claimed and restored with `WHATSAPP_RESTORE_CONCURRENCY` bounding **simultaneous handshakes** (a
  restore slot is held until the socket opens/closes/times out).
* A dead worker's leases simply expire; its row never blocks a session.
* **Command/send routing**: `outbox_events.target_instance_id` (migration 0012). A worker claims routed work only for
  instances it holds a live lease on, plus CONNECT/LOGOUT commands for unowned instances (when it has capacity), sends
  whose instance stayed unreachable past `WHATSAPP_SEND_QUEUE_TTL_SECONDS` (to fail them), and work for deleted
  unowned instances.

**Future Redis strategy** (not needed yet): Redis pub/sub replaces pg NOTIFY behind `RealtimeBus`; a Redis lock may front
the DB lease as a fast-path, but the DB fencing token stays authoritative (a Redis lock alone is not safe against GC
pauses/partitions). Per-instance send queues could move to Redis Streams if outbox polling becomes a bottleneck.

## Reconnect policy

Transient close → `RECONNECTING`, delay = uniform random in `[min, min(max, min·2^attempt)]`
(`WHATSAPP_RECONNECT_MIN_DELAY_MS`, `WHATSAPP_RECONNECT_MAX_DELAY_MS`) - exponential, capped, full jitter; after
`WHATSAPP_MAX_RECONNECT_ATTEMPTS` → `ERROR`. 515 reconnects immediately. Logout/invalid auth never reconnects.
Reconnects reuse encrypted stored auth (no QR). Pending credential writes are flushed before any reconnect.

## Incoming pipeline

Baileys `messages.upsert` → `normalizeBaileysMessage()` → `NormalizedIncomingMessage` (no protobuf leaves the adapter) →
`MessageIngestionService.ingest()` - one transaction: contact (PN JID, or reuse by LID) → open conversation → message
`ON CONFLICT (instance, provider_message_id) DO NOTHING` → timestamps/unread → attachment metadata → outbox event →
usage. Duplicates stop at the conflict (no events/usage/unread). Per-session events are processed sequentially.

| Normalised type | From Baileys | Notes |
|---|---|---|
| TEXT | `conversation`, `extendedTextMessage` | quoted id kept |
| IMAGE / VIDEO / AUDIO / VOICE (ptt) / DOCUMENT / STICKER | media messages | metadata row immediately; bytes downloaded after commit |
| LOCATION | `locationMessage`, `liveLocationMessage` | coords in `raw_metadata` |
| CONTACT | `contactMessage(s)` | display name only; vCard phone numbers (3rd-party PII) dropped |
| REACTION | `reactionMessage` | stored linked to target; `MESSAGE_REACTION`; not counted unread |
| POLL | `pollCreationMessage(V2/V3)` | question + options; votes (encrypted) ignored |
| — (revoke) | `protocolMessage REVOKE`, stub REVOKE | target → `REVOKED`, `MESSAGE_REVOKED` |
| UNKNOWN | anything else with content | `raw_metadata.contentType` only; never crashes |
| ignored | groups, status, broadcast, newsletter, protocol (edits, key shares, history notices), history older than `linked_at` | not stored |

**fromMe (owner typed on the phone / another linked device)**: stored `OUTBOUND`, `status SENT`, `origin LINKED_DEVICE`,
outbox `MESSAGE_SENT` (webhook), **never** a send job, no usage.

**Loop prevention**: for every platform send the worker **pre-assigns** the provider message id
(`generateMessageIDV2`) to the QUEUED row *before* calling Baileys; Baileys' own echo (`fromMe` upsert) collides with the
`(instance, provider_message_id)` unique key and is ignored. Tested.

**Group policy**: group/broadcast/newsletter JIDs are passed to Baileys `shouldIgnoreJid` (not even decrypted) and the
normalizer drops them again. No group contacts, conversations or AI triggers.

**History / data minimisation**: `syncFullHistory: false`; `shouldSyncHistoryMessage` accepts only `INITIAL_BOOTSTRAP`,
`PUSH_NAME`, `NON_BLOCKING_DATA` (identity/LID mappings - see "Known Baileys findings"); message-history syncs (`RECENT`,
`FULL`, `ON_DEMAND`, status) are refused; `messaging-history.set` is never subscribed; messages older than
`linked_at - 60 s` are dropped. Offline messages received while a worker was down are ingested on reconnect.

## Outgoing pipeline

`POST /v1/whatsapp/messages/{text|image|document}` → validate instance (tenant, business scope, `CONNECTED`) → phone →
E.164 (libphonenumber, business country as default) → explicit JID → contact + conversation → message `QUEUED` +
routed outbox `MESSAGE_SEND_REQUESTED` (one transaction) → **202**. Worker: per-instance serial limiter
(`WHATSAPP_SEND_MIN_INTERVAL_MS`) → pre-assign id → provider send → `markSent` (status event, conversation, outbox
`MESSAGE_SENT`, usage). Retryable failures back off through the outbox; permanent/expired → `FAILED` + `MESSAGE_FAILED`.
Receipts (`messages.update.status`): SERVER_ACK→SENT, DELIVERY_ACK→DELIVERED, READ/PLAYED→READ, ERROR→FAILED; unknown
values ignored; status only moves forward; history in `message_status_events`.

Implemented outbound types: text, image, document (API + worker); audio, video, location in the provider only.

## Media

`MediaStorageService`: `LocalMediaStorage` (dev, path-traversal-safe keys) and `S3MediaStorage` over a small `S3Like`
port (SSE-KMS expected; **no AWS SDK client is wired yet**). Keys: `org/<org>/msg/<message>/<attachment>` (inbound),
`org/<org>/out/<id>/<id>` (outbound). DB stores provider, key, mime, size, sha256 - never bytes, never URLs. Inbound
download is best-effort after commit (bounded concurrency, 60 s timeout, `WHATSAPP_MEDIA_MAX_BYTES`); failure marks the
attachment `FAILED`, the message stays. Signed download URLs are future work.

## Rate safety
Per-instance serial send limiter with minimum spacing (worker); per-principal fixed-window API limit
(`WHATSAPP_API_SEND_RATE_PER_MINUTE`, per API process). No bulk/broadcast tooling exists.

## Presence, appear_online, proxy
Presence/typing events are ignored. `markOnlineOnConnect` is **false** unless `WHATSAPP_HONOUR_APPEAR_ONLINE=true` **and**
the instance has `appear_online` (showing "online" suppresses phone notifications - off by default). Proxies:
`proxy_enabled` stays false; no proxy infrastructure exists (Baileys `agent` would be the hook). Not faked.

## Health
`GET /v1/whatsapp/instances/{id}/status` (tenant): status, phone, display name, timestamps, `qrAvailable`,
`worker.healthy` (lease valid + fresh heartbeat; hostnames not exposed). `GET /internal/health/whatsapp` (header
`X-Ops-Token`): aggregate counts only via `app_ops.whatsapp_health_summary()`.

## Logging & errors
pino JSON with `request_id, organization_id, business_id, instance_id, worker_id, event_name`; redaction backstop for
qr/pairing codes/creds/keys/secrets/tokens/message bodies. Message content is not logged unless `LOG_MESSAGE_CONTENT=true`.
Baileys' own logger is a child at `BAILEYS_LOG_LEVEL` (default `warn`).
Public errors: `{ "error": { "code", "message" } }` with codes `WHATSAPP_INSTANCE_NOT_FOUND` (404; also for other
tenants), `WHATSAPP_INSTANCE_NOT_CONNECTED`, `WHATSAPP_INSTANCE_ALREADY_CONNECTED`, `WHATSAPP_WORKER_OWNERSHIP_CONFLICT`,
`WHATSAPP_LOGGED_OUT`, `WHATSAPP_AUTH_INVALID` (409), `WHATSAPP_QR_EXPIRED` (410), `WHATSAPP_QR_NOT_AVAILABLE` (404),
`WHATSAPP_SEND_FAILED` (502), `WHATSAPP_RATE_LIMITED` (429), `WHATSAPP_UNSUPPORTED_MESSAGE`,
`WHATSAPP_INVALID_RECIPIENT` (422), `WHATSAPP_MEDIA_TOO_LARGE` (413), `WHATSAPP_INSTANCE_LIMIT_REACHED`,
`SUBSCRIPTION_INACTIVE` (402), `FORBIDDEN` (403), `UNAUTHENTICATED` (401). No stack traces are ever returned.

## Security assumptions
* RLS (Phase 1) is the final authority; API checks add authorisation (scopes/roles) on top.
* QR and pairing codes are treated as credentials: write scope to view, tenant-filtered transport, memory-only.
* The realtime bus key (`REALTIME_BUS_KEY`) is shared only by API and worker processes.
* Webhook targets must be HTTPS and public (private/loopback/link-local ranges refused; redirects not followed).
* Workers never hold `hs_owner` credentials; the API never touches sockets.

## Known Baileys findings (compatibility audit against 7.0.0-rc14)
1. **History sync / LID mappings** - refusing *all* sync types logs `DANGER ... PREVENTS BAILEYS FROM ACCESSING INITIAL LID
   MAPPINGS, LEADING TO INSTABILITY AND SESSION ERRORS` (seen in the live smoke test). Fixed by allowing identity/bootstrap
   syncs only; minimisation is enforced in our layer.
2. **BufferJSON** - Baileys' reviver also revives numeric-key byte objects; our Phase 1 codec did not. The adapter now uses
   Baileys' own `BufferJSON`.
3. **Key families** - `lid-mapping`, `device-list`, `tctoken`, `identity-key` are new; they satisfy the existing
   `key_type` format CHECK (no schema change).
4. **Defaults** - `syncFullHistory: true` and `markOnlineOnConnect: true` by default; both overridden.
5. **Own-message echo** - `emitOwnEvents` re-emits sends as `fromMe` upserts; solved by id pre-assignment.
6. `SignalKeyStore.clear()` is optional in v7; implemented (fenced).
7. `claim_instance_lease` refused `LOGGED_OUT`, blocking user re-link → `claim_instance_lease_for_link` (0013).

## Known limitations
* Baileys 7 is a **release candidate** (npm `latest` tag). Pin and re-run the compatibility tests on every upgrade.
* JID and LID contacts discovered separately are not merged.
* Message edits, poll votes, view-once content, calls, groups, statuses, newsletters are not processed.
* Logout while no worker holds the session tries a short restore to unlink; if WhatsApp is unreachable, credentials are
  destroyed locally and the device stays listed on the phone until the user removes it.
* API rate limit and QR cache are per API process (Redis would make them global).
* S3 adapter not wired to the AWS SDK; media signed URLs not implemented.
* Unofficial WhatsApp Web protocol: accounts can be restricted by WhatsApp; use for legitimate conversational messaging.
