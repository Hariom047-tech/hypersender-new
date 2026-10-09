# Business-owner dashboard (Phase 3)

Next.js 16 app in `apps/web` (React 19, TanStack Query 5, Tailwind 4), talking to the Nest API through a
backend-for-frontend proxy. Related: [inbox.md](inbox.md) · [realtime.md](realtime.md) ·
[instance-management.md](instance-management.md) · [frontend-security.md](frontend-security.md) ·
[tenant-ui-isolation.md](tenant-ui-isolation.md).

## Running

```bash
npm run dev:start            # API :3100 + worker, PIDs recorded in .data/dev-pids.json
cd apps/web
cp .env.example .env.local   # HS_API_URL=http://localhost:3100
npm install
npm run dev                  # http://localhost:3200
npm run dev:stop             # (repo root) stops ONLY the recorded PIDs
```

## Pages

| Route | Purpose | Minimum role |
|---|---|---|
| `/register`, `/login`, `/onboarding` | account → organization → first business → connect WhatsApp (resumable; pending invitations can be accepted) | – |
| `/dashboard` | today's inbound/outbound, open/unread conversations, instance health, monthly usage vs plan, recent activity | any |
| `/whatsapp/instances`, `/whatsapp/instances/:id` | list/create; QR / pairing; restart/disconnect/logout/delete; API & webhook hints; activity | view: any · act: MANAGER |
| `/inbox` | live three-pane inbox, reply, resolve/reopen | read: any · send: AGENT |
| `/contacts`, `/contacts/:id` | searchable list, contact detail with conversations | any |
| `/developers/api-keys` | create (plaintext once), list, revoke; requires plan `API_ACCESS` | ADMIN |
| `/developers/webhooks`, `/:id` | create (secret once), edit, enable/disable, event picker, test event, delivery log + retry | ADMIN |
| `/team` | members, invite existing users, change role, remove (last OWNER protected) | ADMIN |
| `/usage`, `/billing` | monthly counters vs limits; plan, subscription, invoices (read-only) | ADMIN (billing: OWNER/ADMIN) |
| `/settings/business`, `/settings/organization`, `/settings/audit-log` | profile, hours, timezone; audit trail | ADMIN |
| Notifications bell | WhatsApp logged out / error / reconnect trouble, webhook failing | recipient |

Sidebar items for features outside Phase 3 (AI agents, knowledge base, bookings, broadcasts) are shown disabled with a
"Soon" label; nothing behind them is implemented.

## Backend added for the dashboard

Migrations `0014_saas_app` (invitation functions, `WEBHOOK_TEST` event), `0015`–`0017` (concurrent inbox/contacts
indexes). Controllers: `account` (me, create organization, invitations), dashboard, conversations, contacts,
organization, businesses, team, usage/billing/audit/notifications, webhooks management, API-key listing, realtime
stream, media URLs. Entitlements (`EntitlementService`) enforced on instance/API key/webhook/team creation and API-key
authentication. OpenAPI: `docs/openapi.json`.

## UX rules followed

* Every list has loading skeleton, empty state with a next step, and an error state with retry.
* Backend error codes are mapped to plain sentences (`lib/api.ts friendlyMessage`); internals are never shown.
* Destructive actions use a confirmation dialog (deleting an instance additionally requires typing its name).
* Status is always text + colour. Forms have labels, hints are linked with `aria-describedby`, focus is visible,
  dialogs are native `<dialog>` (focus trap, Esc).

## Tests

| Suite | Command | Count |
|---|---|---|
| Component / unit (jsdom) | `cd apps/web && npm test` | 18 |
| E2E (Playwright, real stack + fake WhatsApp socket) | `cd apps/web && npm run e2e:full` | 7 |
| Backend (incl. Phase 3 API + realtime) | `npm test` (root) | 145 |

The E2E stack (`test/e2e/stack.ts`, test-only) recreates `hypersender_e2e_test`, runs the real migrations + seeds,
starts the API and a gateway worker whose only fake is the WhatsApp socket, plus a loopback control server that plays
"the phone". Playwright starts and stops these processes itself. It uses the locally installed Chrome
(`E2E_BROWSER_CHANNEL=msedge` to use Edge).

## Known limitations

* Forgot-password / email verification are not implemented; team invitations work for existing accounts only
  (no email delivery yet).
* Webhook delivery latency is not recorded (UI says so).
* API rate limiting and the QR cache are per API process (documented in [realtime.md](realtime.md)).
