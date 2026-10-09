# Webhook Events

Endpoints are created with `POST /v1/webhooks` (scope `webhooks:manage`) at organization, business or instance scope.
The signing secret (`whsec_...`) is returned **once**; it is stored AES-256-GCM encrypted.
Precedence: fan-out is additive; the same URL at several scopes receives an event once, via the most specific endpoint.

## Delivery
`POST <your https URL>` with `content-type: application/json` and:

| Header | Value |
|---|---|
| `X-Webhook-Id` | `evt_<uuid>` - stable across retries (use for de-duplication) |
| `X-Webhook-Timestamp` | Unix seconds at signing time |
| `X-Webhook-Signature` | `v1=<hex HMAC-SHA256(secret, "<X-Webhook-Id>.<X-Webhook-Timestamp>.<raw body>")>` |
| `Authorization` | only if the endpoint has an **Authorization header** value set (`authorizationHeader` on create/PATCH; `null` removes it). Stored encrypted, never readable back. |

* 2xx = delivered. Anything else, timeouts (`WEBHOOK_TIMEOUT_MS`, default 10 s), network errors → retry with exponential
  backoff (30 s · 2^(attempt-1), capped at 24 h) up to 12 attempts, then `DEAD`. Redirects are not followed.
* Only the first 4 KB of your response is kept for diagnostics.
* Delivery runs on its own worker loop: a slow or failing webhook never delays WhatsApp ingestion.
* At-least-once: de-duplicate on `X-Webhook-Id`.

### Verifying (Node.js)
```js
import { createHmac, timingSafeEqual } from 'node:crypto';
function verify(rawBody, headers, secret) {
  const id = headers['x-webhook-id'], ts = headers['x-webhook-timestamp'], sig = headers['x-webhook-signature'] ?? '';
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;           // replay window
  const expected = 'v1=' + createHmac('sha256', secret).update(`${id}.${ts}.${rawBody}`).digest('hex');
  return sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}
```
Use the **raw** request body bytes, not re-serialised JSON.

## Envelope (normalised; never raw Baileys objects)
```json
{
  "id": "evt_01a0e30f-...",
  "type": "MESSAGE_RECEIVED",
  "createdAt": "2026-09-27T13:30:25.941Z",
  "organizationId": "…",
  "businessId": "…",
  "instance": { "id": "…", "phone": "+919900011122" },
  "conversation": { "id": "…" },
  "contact": { "id": "…", "phone": "+919811112222", "name": "Rahul" },
  "message": {
    "id": "…", "providerMessageId": "3EB0…", "direction": "INBOUND", "origin": "CONTACT", "fromMe": false,
    "from": "+919811112222", "to": "+919900011122", "type": "TEXT", "text": "Hello", "status": "RECEIVED",
    "timestamp": "…", "replyToProviderMessageId": null,
    "attachments": [ { "id": "…", "mediaType": "IMAGE", "mimeType": "image/jpeg", "fileName": null, "fileSize": 18231, "status": "STORED" } ],
    "errorCode": null
  }
}
```
Instance events carry `instance: { id, phone, status, previousStatus, reason }` instead of `message/contact/conversation`.

Never included: credentials, signal keys, API key hashes, webhook secrets, encryption metadata, provider protobufs,
raw JIDs, media bytes or media URLs.

## Event types

| Type | When | `message.origin` examples |
|---|---|---|
| `INSTANCE_CONNECTED` | status became CONNECTED | – |
| `INSTANCE_DISCONNECTED` | left CONNECTED | – |
| `INSTANCE_STATUS_CHANGED` | any status change (QR wait, pairing, reconnecting, logged out, error) | – |
| `MESSAGE_RECEIVED` | inbound contact message stored | CONTACT |
| `MESSAGE_SENT` | platform send accepted by WhatsApp, **or** owner typed on the phone | API, DASHBOARD, AI, LINKED_DEVICE |
| `MESSAGE_DELIVERED` / `MESSAGE_READ` | recipient receipts | – |
| `MESSAGE_FAILED` | send failed permanently / expired in queue (`message.errorCode`) | – |
| `MESSAGE_REVOKED` | message deleted for everyone | – |
| `OTP_VERIFIED` | a user sent the code of a "login by WhatsApp" link (see developer-api.md). Carries `otp: { id, kind, status, phone, name, verifiedAt }` | – |
| `MESSAGE_REACTION` | contact reacted (`message.type = REACTION`, `text` = emoji or null when removed, `replyToProviderMessageId` = target) | CONTACT |

OpenAPI: `components.schemas.WebhookEvent` in `docs/openapi.json`.
