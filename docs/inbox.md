# Inbox

Route `/inbox` (three panes: conversation list · thread · contact details; single pane with back button on mobile).

## API

| Endpoint | Notes |
|---|---|
| `GET /v1/conversations?filter=open\|unread\|resolved\|all&search=&businessId=&instanceId=&cursor=&limit=` | cursor-paginated by `(last_message_at, id)`; the business switcher sets `businessId` |
| `GET /v1/conversations/:id` | 404 across tenants |
| `GET /v1/conversations/:id/messages?cursor=&limit=` | newest first, cursor pagination – full history is never loaded |
| `POST /v1/conversations/:id/messages` `{ text, clientRequestId }` | idempotency key `ui:<clientRequestId>`; returns `{ message, duplicate }` |
| `POST /v1/conversations/:id/read` | resets `unread_count` |
| `PATCH /v1/conversations/:id` `{ status: OPEN\|RESOLVED }` | |

## Sending from the dashboard

1. The compose box generates a `clientRequestId` (UUID) **per composed message**; retries/double clicks reuse it, so
   exactly one message is created (`duplicate: true` on the second response).
2. The API inserts the message (`QUEUED`, `origin = DASHBOARD`) and an outbox `MESSAGE_SEND_REQUESTED` routed to the
   worker that holds the instance lease – one transaction.
3. The UI shows a pending bubble ("Sending…") until the server copy arrives; it never claims `SENT` on its own.
4. The worker pre-assigns the WhatsApp message id, sends, and marks `SENT`; receipts move it to `DELIVERED` / `READ`.
   Each change reaches the browser as `message.status_updated` (see [realtime.md](realtime.md)).
5. Disconnected instance → `409 WHATSAPP_INSTANCE_NOT_CONNECTED`, shown as "WhatsApp is disconnected. Reconnect it
   before sending." The text stays in the box.

## Messages typed on the phone

A reply written in the WhatsApp app on the linked phone arrives as a `fromMe` echo. It is stored as
`direction = OUTBOUND`, `origin = LINKED_DEVICE`, status `SENT`, labelled **"Sent from phone"**, deduplicated by provider
message id, and **never** enqueued for sending (no echo loop). Proven by the E2E test `inbox.spec.ts` and
`inbox-realtime.test.ts`.

## Rendering customer content

Customer text is untrusted: rendered as React text nodes only (no `dangerouslySetInnerHTML`, no markdown/HTML, links
are not auto-linked). Media is fetched through short-lived signed URLs (`GET /v1/attachments/:id/url`); documents show
name/size as text; unknown types show "Unsupported WhatsApp message". Tested in `apps/web/tests/components.test.tsx`.

## Performance (EXPLAIN ANALYZE, `npm run perf:explain`, test DB; two organizations with 20,000 contacts/conversations each, 10 and 2 messages per conversation)

| Query | Before | After | Change |
|---|---|---|---|
| Inbox list, filter=open | 94 ms (status `= ANY($n)` could not use the partial index) | 3.4 ms | two-step CTE with a constant status predicate + `0016_inbox_open_recent_idx` |
| Inbox list, all | – | index scan on `0015_inbox_recent_idx` | |
| Contacts list | 5.1 ms | 0.27 ms | `0017_contacts_recent_idx` |

All three indexes are `CREATE INDEX CONCURRENTLY` in `-- migrate:no-transaction` migrations (safe on a live table).

## Not included (by specification)

AI replies, bulk sends/broadcasts, templates, assignment/routing rules, internal notes.
