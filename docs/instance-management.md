# WhatsApp instance management (dashboard)

Routes: `/whatsapp/instances` (list + create), `/whatsapp/instances/:id` (tabs Overview · Connection · API ·
Webhooks · Activity). Gateway internals: [whatsapp-gateway.md](whatsapp-gateway.md).

## Lifecycle as the owner sees it

| Status | Badge text | Owner action |
|---|---|---|
| `CREATED` | Not connected | Connect |
| `WAITING_FOR_QR` / `PAIRING` | Waiting for QR scan / Pairing… | scan QR or enter pairing code |
| `CONNECTED` | Connected | – |
| `RECONNECTING` | Reconnecting… | none (automatic, notification if it lasts) |
| `DISCONNECTED` | WhatsApp disconnected | Reconnect (no QR needed) |
| `LOGGED_OUT` | Logged out — scan QR to reconnect | Connect (new QR) |
| `ERROR` | Connection problem | Restart / contact support |
| `SUSPENDED` | Suspended | contact support |

Badges always carry text (never colour alone).

## Connecting

1. **Create** (`POST /v1/whatsapp/instances`) – subject to the plan limit `MAX_WHATSAPP_INSTANCES`, checked under a
   per-organization advisory lock (`EntitlementService.assertCanAdd`), so parallel requests cannot exceed it
   (E2E `plan-limit.spec.ts`: 6 concurrent creates → exactly 1 succeeds).
2. **Connection tab** subscribes to `GET /v1/whatsapp/instances/:id/events` **before** calling `POST …/connect`, so the
   first QR cannot be missed.
3. **QR code**: the raw QR string is turned into a PNG `data:` URL **in the browser** (`qrcode` library) and kept only in
   React state. It is cleared on status change, expiry (countdown shown), replacement by a new QR and unmount. It is
   never written to the URL, localStorage/sessionStorage, logs, analytics or a third-party QR service, and it is never
   stored in the database (E2E `instance-qr.spec.ts` scans every DB table and all process logs for the value).
4. **Pairing code** alternative: enter the phone number, the 8-character code is shown with instructions.
5. On `CONNECTED` the QR disappears and a success notice links to the Inbox.

## Actions (all behind a confirmation dialog)

| Action | Effect | Needs new QR? |
|---|---|---|
| Restart | closes and reopens the socket | no |
| Disconnect | stops the session, keeps encrypted auth | no |
| Log out | unlinks the device, destroys stored credentials | yes |
| Delete | log out + soft-delete the instance (typed confirmation) | – |

Roles: OWNER/ADMIN/MANAGER can connect and act (`instances:write`); AGENT/VIEWER see status only. The UI mirror
(`apps/web/lib/permissions.ts`) is compared against the backend mapping in a unit test; the backend is authoritative.

## Notifications

`WHATSAPP_LOGGED_OUT` (not initiated by a user), `WHATSAPP_ERROR`, and `WHATSAPP_RECONNECT_TROUBLE` (instance still not
connected after `WHATSAPP_RECONNECT_ALERT_GRACE_SECONDS`, default 300 s) go to owners/admins, de-duplicated for 6 h.

## Real-account verification

Automated tests use a fake socket. Verification with a real, **dedicated test** WhatsApp account is operator-guided:
`npm run whatsapp:acceptance` (steps A–U, writes `.data/acceptance-report-<timestamp>.json`). See
[whatsapp-local-testing.md](whatsapp-local-testing.md).
