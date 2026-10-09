# WhatsApp Local Testing

Use a **dedicated test WhatsApp account** (a spare number), never a production business number. No phone number or
secret is hard-coded anywhere; everything comes from `.env`.

## 0. Prerequisites
Node ≥ 20, Docker. `cp .env.example .env` and set at least `SESSION_SECRET`, `REALTIME_BUS_KEY`, `INTERNAL_OPS_TOKEN`
(dev values in the example are fine locally). Optionally set a stable `WHATSAPP_WORKER_ID` (a UUID) so a restarted worker
reclaims its own sessions immediately.

## 1. Start the database
```bash
npm install
npm run db:up && npm run db:bootstrap && npm run db:migrate && npm run db:seed
```
PostgreSQL + pgvector on `localhost:55432` (unchanged from Phase 1).

## 2. Start the app (two terminals)
```bash
npm run start:api      # http://localhost:3100, OpenAPI UI at /docs
npm run start:worker   # WhatsApp gateway worker
```

## 3. Create organization and business
```bash
curl -s -X POST localhost:3100/v1/auth/signup -H 'content-type: application/json' \
  -d '{"email":"you@example.test","password":"a long passphrase","organizationName":"Test Org","organizationSlug":"test-org"}'
# -> { userId, organizationId, token }
export TOKEN=...; export ORG=...
H=(-H "authorization: Bearer $TOKEN" -H "x-organization-id: $ORG" -H 'content-type: application/json')
curl -s -X POST localhost:3100/v1/businesses "${H[@]}" -d '{"name":"Test Clinic","countryCode":"IN"}'   # -> { id }
export BIZ=...
```

## 4. Create a WhatsApp instance
```bash
curl -s -X POST localhost:3100/v1/whatsapp/instances "${H[@]}" -d "{\"businessId\":\"$BIZ\",\"name\":\"test\"}"   # status CREATED
export INST=...
```

## 5. Connect
```bash
curl -N localhost:3100/v1/whatsapp/instances/$INST/events "${H[@]}" &     # SSE stream (keep open)
curl -s -X POST localhost:3100/v1/whatsapp/instances/$INST/connect "${H[@]}"   # 202
```
The stream prints `event: whatsapp.instance.qr` with `data: {"qr":"...","expiresAt":"..."}`.

## 6. Scan the QR
Render the `qr` string as a QR image (e.g. `npx qrcode-terminal "<qr>"` in a throwaway shell, or any local QR tool - do
**not** paste it into online services; it is a login credential). On the test phone: WhatsApp → Settings → Linked
devices → Link a device → scan. The stream shows `PAIRING` then `CONNECTED`;
`GET /v1/whatsapp/instances/$INST/status` shows the phone number and `worker.healthy: true`.
Alternative: `POST /v1/whatsapp/instances/$INST/pairing-code {"phoneNumber":"+91..."}` and enter the code under
"Link with phone number instead".

## 7. Inbound test
From another phone send "hello gateway" to the test number. Check:
```sql
-- docker exec -it hypersender-postgres psql -U postgres -d hypersender
SELECT direction, message_type, text_body, origin FROM app.messages ORDER BY created_at DESC LIMIT 3;
SELECT event_type FROM app.outbox_events ORDER BY created_at DESC LIMIT 3;   -- MESSAGE_RECEIVED
```

## 8. Outbound test
```bash
curl -s -X POST localhost:3100/v1/whatsapp/messages/text "${H[@]}" \
  -d "{\"instanceId\":\"$INST\",\"to\":\"+91XXXXXXXXXX\",\"text\":\"hello from gateway\"}"   # 202 QUEUED
curl -s localhost:3100/v1/whatsapp/messages/<messageId> "${H[@]}"                          # SENT -> DELIVERED -> READ
```

## 9. Restart the worker
Stop the worker (Ctrl+C = graceful: sockets closed **without logout**, status `RECONNECTING`, lease released), start it
again.

## 10. Verify session restore
Within seconds the instance is `CONNECTED` again with **no new QR**. Send another inbound message and confirm it is
stored.

---

# Manual real-WhatsApp smoke checklist (optional)

| Step | Action | Expected |
|---|---|---|
| A | Create instance | `CREATED` |
| B | Connect + scan QR | QR only on SSE / `GET /qr`; nothing in DB/logs |
| C | Status | `CONNECTED`, phone set, `worker.healthy` |
| D | Another phone sends "hello gateway" | – |
| E | DB | contact, conversation, INBOUND message, `MESSAGE_RECEIVED` outbox (+ webhook delivery if an endpoint is configured) |
| F | API reply "hello from gateway" | 202 QUEUED |
| G | Phone | message arrives once; DB status SENT → DELIVERED → READ |
| H | Restart the Node worker | graceful shutdown, `RECONNECTING` |
| I | After restart | `CONNECTED` without QR |
| J | Send another inbound message | – |
| K | DB | stored |
| L | `POST /instances/{id}/logout` | device disappears from phone's Linked devices |
| M | DB | `LOGGED_OUT`; `whatsapp_auth_credentials` / `whatsapp_signal_keys` rows gone; next connect shows a new QR |

Also try: type a message on the linked phone → stored as OUTBOUND `origin=LINKED_DEVICE`, `MESSAGE_SENT` webhook, not
re-sent. Put the phone in airplane mode → messages still flow (linked devices work independently); stop the network of the
worker host briefly → `RECONNECTING` → `CONNECTED`.

## Useful checks
```bash
curl -s localhost:3100/internal/health/whatsapp -H "x-ops-token: $INTERNAL_OPS_TOKEN"
grep -c '"level":"error"' worker.log
```
Automated tests (`npm test`) never need a WhatsApp account.
