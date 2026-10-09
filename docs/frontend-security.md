# Frontend security (apps/web)

## Session: BFF, HttpOnly cookie

* The browser never sees a bearer token or API key. `POST /api/auth/login|register` (Next route handlers) call the API
  server-side and store the session token in the **`hs_session` cookie: HttpOnly, SameSite=Lax, Secure in
  production, Path=/, 12 h**. Logout deletes it.
* All data calls go to `/api/v1/*` (`app/api/v1/[...path]/route.ts`), which attaches `Authorization: Bearer <cookie>`
  server-side, forwards only an allow-list of headers, streams the response (SSE / media), never forwards `Set-Cookie`,
  and refuses to proxy `/v1/auth/*`. Upstream failures return a generic 502 without internals.
* Authorization is **not** done in the frontend. The backend re-checks membership, role/scope and RLS on every call;
  the UI's `can()` only hides controls.

## CSRF

Mutating requests to the BFF must carry `x-hs-csrf: 1` **and** an `Origin` equal to the host; cross-site forms can do
neither, and the cookie is SameSite=Lax. Tested in E2E (`tenant-isolation.spec.ts`: request without them → 403).

## XSS

* Customer content (message text, contact names, file names) is rendered as React text only. No
  `dangerouslySetInnerHTML` anywhere in the app. Tested with `<script>`/`onerror` payloads (`components.test.tsx`).
* Content-Security-Policy (`next.config.ts`): `default-src 'self'`; `script-src 'self' 'unsafe-inline'` (required by
  Next.js inline bootstrap scripts without a nonce middleware; `'unsafe-eval'` only in development – moving to nonces is a
  listed follow-up); `img-src 'self' data: blob:` + the configured S3
  origin; `connect-src 'self'`; `frame-ancestors 'none'`; `object-src 'none'`; `base-uri 'self'`; `form-action 'self'`.
  Plus `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, HSTS in production.

## Secrets shown once

* API key plaintext and webhook signing secret are shown once in a dismissible alert, held only in component state,
  never in storage/URL/logs; after refresh only the prefix is visible (E2E `developers.spec.ts` checks page content,
  storage and every DB table/log for the plaintext).
* QR codes: see [instance-management.md](instance-management.md) – local rendering, memory only.

## What the browser stores

`localStorage`: `hs.org` (selected organization id) and `hs.biz.<orgId>` (selected business id) – identifiers only.
`sessionStorage`: onboarding progress (organization slug for idempotent retry). Nothing else; E2E tests assert that no
QR, token or key ever appears there.

## Media

Attachments load via `GET /v1/attachments/:id/url` → short-lived URL: S3 presigned GET or, for local storage, an HMAC
capability token (`/v1/media/download/<token>`, 5 min, bound to org + attachment) served with
`Content-Disposition: attachment` for non-images and `nosniff`.

## Webhook SSRF (server side)

Webhook URLs must be HTTPS; private, loopback, link-local, CGNAT, multicast and metadata ranges are rejected at
creation and **again at connect time** (`guardedLookup` validates the resolved address used by the socket, defeating
DNS rebinding). Redirects are not followed.
