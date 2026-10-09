# Developer API (use a WhatsApp number from your own app)

Any customer can connect a WhatsApp number on the platform and use it from their own product - for login OTPs,
booking confirmations, alerts or a two-way chat - exactly like a WhatsApp gateway:

1. **Instances → New instance → Connect** (scan the QR).
2. **Instance page → Instance ID + Api Key (Bearer Token).** The key is created automatically with the instance;
   copy both (copy icon / eye to show) into your app's server config.
3. **Instance → API tab → + Connect a webhook.** Enter your app's HTTPS URL, pick events, optionally an
   `Authorization` header value. Copy the signing secret.

```
Base URL       PUBLIC_API_URL (e.g. https://api.sendkaro.in)
Auth           Authorization: Bearer hs_live_xxxxxxxx_...      (X-Api-Key: ... also works)
WhatsApp API   {base}/api/whatsapp/v1/{instanceId}/...
OTP API        {base}/api/otp/v1/{instanceId}/...
```

## Instance API key

* Bound to **one** instance. It can call only `/api/whatsapp/v1/{that instance}/...` and `/api/otp/v1/{that instance}/...`.
  Any other path (inbox, contacts, settings, other instances - even of the same business) answers 403/404.
* Created automatically when the instance is created (`POST /v1/whatsapp/instances`); instances created earlier get
  one the first time their page is opened. Authentication uses the peppered HMAC; the plaintext is also stored
  encrypted (AES-256-GCM, KMS-wrapped data key) so OWNER/ADMIN can copy it again via
  `POST /v1/whatsapp/instances/{id}/api-key/reveal` (audited as `API_KEY_REVEALED`). Organization API keys stay
  show-once. "Generate new key" revokes the previous key in the same transaction (`api_keys_one_live_per_instance_uq`).
* Only OWNER/ADMIN dashboard users can create/rotate it (`POST /v1/whatsapp/instances/{id}/api-key`).
* Organization API keys (Developers → API keys) also work on these routes, limited by their scopes/business.

## WhatsApp API

| Method | Path | Body |
|---|---|---|
| POST | `/send-text` | `to` or `chatId`, `text`, `idempotencyKey?` |
| POST | `/send-image` | `to`/`chatId`, `dataBase64`, `mimeType` (jpeg/png/webp), `caption?` |
| POST | `/send-file` | `to`/`chatId`, `dataBase64`, `mimeType`, `fileName`, `caption?` |
| GET | `/messages/{messageId}` | – |
| GET | `/status` | – |

* `to`: E.164 (`+919812345678`) or national format of the business country. `chatId`: `919812345678@c.us`
  (gateway style; groups are not supported).
* Sends are queued → `202 { queued, messageId, status: "QUEUED", duplicate, statusUrl }`. Delivery progress via
  `GET /messages/{id}` or the `MESSAGE_SENT / DELIVERED / READ / FAILED` webhooks.
* Same `idempotencyKey` = never sent twice.

## OTP API

### Code (`request-code` → `validate-code`)
```json
POST /api/otp/v1/{instance}/request-code
{ "to": "+919812345678", "name": "PanditSuggest", "length": 6, "expires": 600 }
→ 201 { "id": "...", "kind": "CODE", "status": "PENDING", "to": "+919812345678", "code": "482913", "expiresAt": "...", "messageId": "..." }

POST /api/otp/v1/{instance}/validate-code
{ "to": "+919812345678", "code": "482913" }
→ 200 { "valid": true, "reason": "OK", "otp": { "status": "VERIFIED", ... } }
```
* Options: `length` 4-10 (6), `useNumber` (true), `useLetter` (false), `allCapital` (false), `expires` 60-86400 s (1800),
  `template` (must contain `{code}`; also `{name}`, `{minutes}`).
* Only the newest pending code per number is valid; 5 wrong tries lock it; max 5 codes per number per 10 minutes (429).
* `validate-code` is always 200: `reason` = `OK | INVALID_CODE (attemptsLeft) | EXPIRED | TOO_MANY_ATTEMPTS | NOT_FOUND`.
* Codes are stored as `HMAC(OTP_PEPPER, instance:phone:code)` only. `OTP_PEPPER` falls back to `API_KEY_PEPPER`;
  the API and the gateway worker must share it.

### Login by WhatsApp (`generate-link`)
```json
POST /api/otp/v1/{instance}/generate-link
{ "name": "PanditSuggest", "expires": 600,
  "message": { "prompt": "Log me in to {name}", "success": "You are logged in to {name} ✅", "expired": "This link has expired." } }
→ 201 { "id": "...", "kind": "LINK", "status": "PENDING", "code": "K7QX4M2P", "text": "...", "whatsappLink": "https://wa.me/91...?text=..." }
```
1. Show `whatsappLink` to the user (button / QR).
2. The user sends the prefilled message to the instance number.
3. The worker matches the 8-character code on the inbound message (same instance only), marks the request `VERIFIED`
   with the **sender's phone**, replies with `message.success` (or `message.expired`), and emits `OTP_VERIFIED`.
   The AI assistant on that number does not answer this message.
4. Your app learns the result from the `OTP_VERIFIED` webhook or `GET /api/otp/v1/{instance}/requests/{id}`.

## Webhooks
Webhook Logs (Developers → Webhook Logs, `GET /v1/webhook-logs`) lists every call to every endpoint with HTTP status,
response time, retries, the payload sent and the response received; failed calls can be retried.

See [webhook-events.md](webhook-events.md). Create one scoped to the instance (Developers → Webhooks, or the instance's
API tab). Every delivery is HMAC-signed; you may also set a static `Authorization` header value (stored encrypted,
never readable back).

## Differences from Hypersender (by design)
* No `send-text-safe`: the outbound queue already paces per instance; there is no fake "typing" delay.
* Media is sent as base64 (no fetch-by-URL, which would need SSRF-guarded downloads).
* OTP link results arrive as a signed webhook (`OTP_VERIFIED`) instead of per-request callback URLs, so they get
  retries, delivery logs and signatures like every other event.
