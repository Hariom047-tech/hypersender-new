# Tenant isolation in the UI

The database (RLS) and API (membership + scopes) enforce isolation; the UI is designed so that it can never *display*
another tenant's data even transiently.

1. **Every request names its organization** via `X-Organization-Id` (set by `WorkspaceProvider`); the backend verifies
   membership and sets the RLS context from it. A spoofed header → 403; a guessed id from another org → 404
   (existence not revealed).
2. **Every cache key starts with the organization** (`['org', orgId, 'biz', businessId|'all', …]`, `lib/workspace.tsx`).
   Realtime merges only touch keys of the stream's organization.
3. **Switching organization** removes every cached query, closes the realtime stream, remounts the page tree and reopens
   the stream with the new header – no stale list from the old org can flash.
4. **Business switcher** filters lists (conversations, contacts, instances, dashboard) server-side; business-scoped API
   keys cannot widen it.
5. **Deep links** to another tenant's resources render "not found".
6. Only ids are persisted client-side (`hs.org`, `hs.biz.<org>`); if the user loses membership the stored id is ignored
   and the first remaining organization is selected.

## Evidence

| Test | What it proves |
|---|---|
| `apps/web/e2e/tenant-isolation.spec.ts` | two real users/orgs in separate browser contexts: B's open inbox never receives A's live message; B gets 404 for A's conversation/messages/contact/instance/health ids and cannot post into A's conversation; spoofed org header → 403 (REST and realtime); B's lists are empty; deep links show "not found"; session cookie is HttpOnly/SameSite=Lax; backend without the BFF → 401; BFF mutation without CSRF → 403 |
| `apps/web/e2e/instance-qr.spec.ts` | another tenant cannot fetch the QR/instance (404) or use the owner's org header (403) |
| `apps/web/tests/realtime-cache.test.ts` | realtime events only update caches of their own organization |
| `test/saas-api.test.ts`, `test/inbox-realtime.test.ts` | API-level cross-tenant checks for every Phase 3 endpoint and stream |
| `test/rls-isolation.test.ts` | database-level isolation for all tenant tables |
