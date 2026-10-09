# HyperSender AI

Multi-tenant WhatsApp (Baileys) + AI assistant + inbox/CRM + booking SaaS.

* **Phase 1 - database foundation:** [docs/architecture.md](docs/architecture.md), [docs/er-diagram.md](docs/er-diagram.md)
* **Phase 2 - WhatsApp gateway:** [docs/whatsapp-gateway.md](docs/whatsapp-gateway.md),
  [docs/baileys-auth-storage.md](docs/baileys-auth-storage.md), [docs/webhook-events.md](docs/webhook-events.md),
  [docs/whatsapp-local-testing.md](docs/whatsapp-local-testing.md), OpenAPI [docs/openapi.json](docs/openapi.json) (UI at `/docs`)
* **Phase 3 - business-owner SaaS app (`apps/web`):** [docs/dashboard.md](docs/dashboard.md), [docs/inbox.md](docs/inbox.md),
  [docs/realtime.md](docs/realtime.md), [docs/instance-management.md](docs/instance-management.md),
  [docs/frontend-security.md](docs/frontend-security.md), [docs/tenant-ui-isolation.md](docs/tenant-ui-isolation.md)
* **Phase 4 - AI assistants (templates + tools):** [docs/ai-assistant-architecture.md](docs/ai-assistant-architecture.md),
  [docs/assistant-runtime.md](docs/assistant-runtime.md), [docs/tool-registry.md](docs/tool-registry.md), [docs/template-system.md](docs/template-system.md),
  [docs/prompt-architecture.md](docs/prompt-architecture.md), [docs/human-handoff.md](docs/human-handoff.md), [docs/ai-security.md](docs/ai-security.md),
  [docs/assistant-testing.md](docs/assistant-testing.md), [docs/template-design-system.md](docs/template-design-system.md), screens in `docs/screenshots/`

**WhatsApp engine: `baileys@7.0.0-rc14`** (exact pin; npm `latest` tag at time of writing, a release candidate - rerun
`npm test` on any upgrade). All dependencies are pinned to exact versions. TypeScript is pinned to 6.0.3 (the Nest 12
Swagger toolchain does not support TS 7 yet).

## Repository structure

```
db/
  bootstrap/            superuser-only, idempotent: roles, database, extensions (NOT migrations)
  migrations/           0001…0019 numbered, checksummed (0012-0013 = Phase 2, 0014-0017 = Phase 3, 0018-0019 = Phase 4; 0015-0017, 0019 are
                        `-- migrate:no-transaction` CREATE INDEX CONCURRENTLY)
    down/               rollback script per migration (dev/staging; production prefers forward fixes)
  seeds/                platform-only seed data (plans, entitlements, lookup types, AI tools, 8 templates)
scripts/
  bootstrap.ts          creates roles/db/extensions        (superuser credentials)
  migrate.ts            up / status / down runner           (hs_owner credentials)
  seed.ts               idempotent platform seeds          (hs_owner credentials)
  export-openapi.ts     writes docs/openapi.json
  dev.ts                dev:start / dev:stop / dev:status - PID-recorded processes (.data/dev-pids.json)
  cleanup-smoke-data.ts dev-only removal of smoke-*/live-* organizations (dry run unless --yes; refuses production)
  whatsapp-acceptance.ts operator-guided real-WhatsApp acceptance (A-U) -> .data/acceptance-report-*.json
  explain-queries.ts    EXPLAIN ANALYZE of inbox/contacts queries on the TEST database only
apps/web/               Phase 3 Next.js dashboard (BFF proxy, pages, components, tests/, e2e/)
src/
  main.ts / worker.ts                    API process (hs_app) / WhatsApp gateway worker process (hs_worker)
  api/                                   app factory, OpenAPI, error filter, dashboard session auth, scopes/roles, platform controllers
  config/whatsapp.config.ts              typed, validated WHATSAPP_* configuration
  common/logger.ts, concurrency.ts       pino with redaction; semaphore, per-instance limiter, backoff, rate limiter
  common/uuid.ts                         UUIDv7
  database/
    pools.ts                             hs_app / hs_worker pools (owner never loaded at runtime)
    transaction-runner.ts                THE way to touch the DB: tx + transaction-local tenant context
    tenant-context.ts                    AsyncLocalStorage tenant context
    database.module.ts                   Nest module: forApi() / forWorker()
    errors.ts                            SQLSTATE mapping (unique, exclusion, RLS, lease lost…)
  tenancy/tenant-context.middleware.ts   auth (API key | session) → membership check → ALS context
  security/
    crypto/aes-gcm.ts, key-provider.ts   AES-256-GCM, envelope encryption (AWS KMS / local dev)
    passwords.ts                         scrypt (OWASP params), PHC-style string
    api-key-crypto.ts                    key generation, HMAC-SHA256 + pepper
    redact.ts                            secret redaction for logs / audit / tool-call traces
  repositories/                          SQL per domain (identity, whatsapp, messaging, webhook, ai, booking, knowledge, ops)
  services/                              transaction strategies (ingestion, outbound, AI, booking, webhooks, API keys, outbox relay, onboarding)
  ai/                                    Phase 4 AI assistants: model provider, tool registry + gate, runtime, admin, sandbox
  whatsapp/                              Phase 2 gateway (see docs/whatsapp-gateway.md)
    domain/                              provider-neutral types/events/errors, WhatsAppProvider interface, phone<->JID helpers
    providers/baileys/                   the ONLY Baileys imports: session, auth store, normalizer, error mapper, provider
    services/                            session manager, connection state machine, instance/message services, webhook bridge
    controllers/, dto/                   REST + SSE endpoints, OpenAPI schemas
    realtime/, media/, repositories/     realtime bus + QR cache, media storage, gateway SQL
    postgres-auth-state.ts               encrypted, fenced auth-state store
test/                                    145 tests (see below); fakes/ = Baileys socket fake; e2e/stack.ts = E2E stack (test-only)
docs/                                    architecture, ER diagram, gateway, auth storage, webhooks, local testing, openapi.json
docker-compose.yml                       pgvector/pgvector:pg17 on port 55432
```

## Running it

Requirements: Node ≥ 20, Docker (or PostgreSQL ≥ 15 with pgvector, btree_gist, pgcrypto).

```bash
cp .env.example .env            # dev-only values; never commit real secrets
npm install
npm run db:up                   # PostgreSQL 17 + pgvector in Docker (port 55432)
npm run db:bootstrap            # roles hs_owner / hs_app / hs_worker, database, extensions
npm run db:migrate              # apply migrations (as hs_owner)
npm run db:seed                 # platform seed data
npm run db:migrate:status
npm test                        # recreates hypersender_test, migrates, seeds, runs all tests (no WhatsApp account needed)
npm run typecheck
npm run start:api               # REST + SSE on :3100, OpenAPI UI at /docs
npm run start:worker            # WhatsApp gateway worker (Baileys sessions, outbox, webhooks)
npm run openapi                 # regenerate docs/openapi.json
```
Phase 2 environment variables are listed (with dev-only values) in `.env.example`; see
[docs/whatsapp-local-testing.md](docs/whatsapp-local-testing.md) for the first real QR test.

Production:

* `db:bootstrap` is run once by the DBA/master user; afterwards CI runs only `db:migrate` + `db:seed` with the
  `hs_owner` credentials. Application pods get **only** `hs_app` (API) or `hs_worker` (workers) credentials.
* Configure `KMS_KEY_ID` (the `LocalKeyProvider` refuses to start with `NODE_ENV=production`) and load
  `API_KEY_PEPPER` from a secrets manager.
* Migrations are never edited once applied (the runner verifies SHA-256 checksums and aborts). Fix forward with a new
  numbered file — `0011_outbox_conflict_privileges.sql` is a real example found by the test suite.
* `db:migrate:down` is refused in production unless `--allow-production`; index builds on large tables should use
  a `-- migrate:no-transaction` migration with `CREATE INDEX CONCURRENTLY`.

## Using the data layer (NestJS)

```ts
// Request path: TenantContextMiddleware has put { organizationId, userId, role } in AsyncLocalStorage.
@Injectable()
export class ContactsService {
  constructor(@Inject(APP_TX) private readonly tx: TransactionRunner, private readonly messaging: MessagingRepository) {}
  listThread(conversationId: string) {
    // Never pass organization_id from request input: the runner sets it from the context, RLS enforces it.
    return this.tx.inTenant((db) => this.messaging.listThread(db, conversationId));
  }
}

// Worker path: context comes from the claimed row, never from the payload.
await workerTx.inTenant((db) => handle(db, event), { organizationId: event.organizationId });
```

## Tests

| Suite | Command | Result |
|---|---|---|
| Backend (Phases 1-4) | `npm test` | 184/184 (145 before Phase 4 + 39 new), run repeatedly |
| Web component/unit (jsdom) | `cd apps/web && npm test` | 20/20 |
| Web E2E (Playwright, real API+worker+DB, fake WhatsApp socket, simulated AI model) | `cd apps/web && npm run e2e:full` | 8/8 |

Phase 3 backend (20 tests): `saas-api.test.ts` (registration/idempotent onboarding, account auth, invitations + role
rules, entitlements incl. a 5-way concurrent instance-limit race, API_ACCESS gating and downgrade, webhook/team limits,
API keys shown once, webhook SSRF + connect-time guard, webhook lifecycle, tenant-bound media tokens, cross-tenant 404s,
dashboard/usage/billing/audit data) and `inbox-realtime.test.ts` (live inbound per tenant,
double-submit -> one message, QUEUED->SENT->DELIVERED->READ over SSE without duplicates, phone-typed messages,
pagination, LID->PN identity, notifications).

Phase 2 (59 tests, no WhatsApp account required):

| File | Proves |
|---|---|
| `whatsapp-unit.test.ts` | normalizer (all types, groups/status/broadcast/newsletter ignored, history cut-off, revoke/edit, LID vs PN, fromMe, garbage never throws), disconnect/ack mapping, close policy, backoff, rate limiters, phone<->JID, Baileys BufferJSON compatibility, session tokens |
| `whatsapp-gateway.test.ts` | real session manager + real Baileys adapter + PostgreSQL with a fake socket: CREATED→WAITING_FOR_QR→PAIRING→(515)→CONNECTED, safe socket config, QR only on the bus (not in any table or log), inbound text, duplicates idempotent, fromMe stored and never re-sent, reaction/revoke/unknown/group policy, media stored/failed, outbound with pre-assigned id and **echo loop prevention**, delivered/read status + history, image/document sends, retry sends once, normalised signed webhook, CONNECTED→RECONNECTING→CONNECTED, DISCONNECT keeps auth + RESTART without QR, 401 → LOGGED_OUT + auth destroyed, re-link needs new QR, LOGOUT destroys auth, log hygiene |
| `whatsapp-sessions.test.ts` | restore after graceful shutdown by a NEW manager with decrypted auth and no QR, restore concurrency bound, ownership conflict, stale takeover + fenced stale writes, heartbeat drop, dead-worker reaping + send TTL failure, pairing code, QR expiry, **real `makeWASocket` against a local WebSocket server** |
| `whatsapp-api-security.test.ts` | HTTP (real Nest app): A cannot get/connect/restart/disconnect/logout/delete B's instance, fetch B's QR, subscribe to B's stream, send via B, read B's message; spoofed realtime events filtered; API keys: cross-tenant, business-restricted, missing scope 403, revoked/expired 401; forged org header 403; VIEWER limits; 429 rate limit; stable error codes, no stack traces; ops health; OpenAPI coverage |

Phase 1 (66 tests):

| File | Proves |
|---|---|
| `rls-isolation.test.ts` | every tenant table has RLS forced; runtime roles can't bypass; A cannot SELECT/INSERT/UPDATE/DELETE B data (all 40 tables scanned); cannot attach agent to B's instance; cannot book with B's contact/resource; cannot post into B's conversation; forged org context sees nothing; membership escalation blocked; default deny without context; knowledge retrieval isolation; sign-up works under RLS; API cannot grant paid plan |
| `secrets.test.ts` | API key plaintext stored nowhere, hash unreadable by API role; revoked/expired/tampered keys fail (revocation cuts in-flight contexts); Baileys creds + signal keys encrypted at rest, round-trip, AAD prevents cross-tenant ciphertext swap; API role can't read ciphertext; logout destroys credentials; stale worker writes rejected by fencing; no QR storage; plaintext password rejected; webhook secret encrypted; audit metadata secret guard |
| `concurrency.test.ts` | 8 concurrent duplicate deliveries → 1 message/event/usage row; same provider id across tenants OK; receipts forward-only; outbound idempotency; 8 simultaneous bookings → exactly 1; overlap vs adjacency; AI tool retry → same booking; 8 workers claim one instance → 1 winner + token fencing; 8 AI workers → 1 run & 1 reply; tool call executes once; 3 webhook dispatchers never share a delivery; webhook precedence/dedup; retry scheduling; parallel outbox relays exactly-once |
| `constraints-privacy.test.ts` | live-phone uniqueness, single primary responder, CHECKs, org keeps an OWNER, immutable ledgers, retention floors, anonymisation, conversation purge, organization purge retains financial/audit data |
| `migrations.test.ts` | full up on empty DB, idempotent re-run, tamper detection, full down + up round trip |

---

## Self-audit

**Total tables: 49** (+ `public.schema_migrations` ledger). 101 RLS policies, 170 indexes, 231 CHECK constraints,
100 foreign keys. Migrations run cleanly on an empty database; all security isolation tests pass.

**Tenant-scoped (40, carry `organization_id`)**: organization_members, businesses, business_locations,
whatsapp_instances, whatsapp_auth_credentials, whatsapp_signal_keys, whatsapp_instance_events, api_keys,
webhook_endpoints, webhook_event_subscriptions, webhook_events, webhook_deliveries, contacts, conversations, messages,
message_status_events, message_attachments, ai_agents, ai_agent_versions, ai_agent_channels, ai_agent_tools, ai_runs,
ai_tool_calls, knowledge_sources, knowledge_chunks, services, business_resources, resource_services,
availability_rules, availability_exceptions, bookings, booking_events, subscriptions, invoices, payments,
usage_events, audit_logs*, notifications, outbox_events*, data_retention_policies — plus the tenant root
**organizations**. (*`organization_id` nullable for platform-level rows, which runtime roles can never see.)

**Platform-scoped (8)**: users (identity; RLS-protected), whatsapp_workers, ai_assistant_templates, ai_tools,
subscription_plans, plan_entitlements, webhook_event_types, usage_event_types.

**RLS enabled + forced (42)**: all 40 tenant tables + organizations + users. No RLS (7): the platform catalogs and
whatsapp_workers — they contain no tenant data; runtime roles have SELECT only (workers: full on whatsapp_workers).

**Sensitive tables**: users (password hash, PII), whatsapp_auth_credentials, whatsapp_signal_keys, api_keys,
webhook_endpoints, contacts, messages, message_attachments, knowledge_chunks, bookings (customer PII), payments,
invoices, audit_logs (IP / user agent).

| Secret | Protection |
|---|---|
| Passwords | **hashed** — scrypt N=2¹⁷ r=8 p=1 (CHECK rejects anything not `$scrypt$`/`$argon2id$`); not SELECT-able by hs_app |
| API keys | **hashed** — HMAC-SHA256 with KMS-held pepper; plaintext shown once; hash not SELECT-able by hs_app |
| Webhook signing secrets | **encrypted** — AES-256-GCM, per-endpoint KMS-wrapped key, AAD-bound; not SELECT-able by hs_app |
| Baileys credentials | **encrypted** — AES-256-GCM, per-instance KMS-wrapped key, AAD-bound, fenced writes |
| Signal keys | **encrypted** — same per-instance key, AAD per (type, id) |
| Payment secrets / cards | **never stored** — only provider ids and method category |
| OAuth tokens | none stored yet; use the same envelope pattern as webhook secrets when added |
| QR codes | **never persisted** (Redis TTL only) |

**High-volume tables to partition when volume justifies**: messages, message_status_events, usage_events,
webhook_events, webhook_deliveries, outbox_events, audit_logs, ai_runs (UUIDv7 range on `id`); whatsapp_signal_keys
is hot but bounded per instance (tuned via fillfactor/autovacuum instead).

### Remaining architectural risks / follow-ups

1. **RLS depends on the runner.** Code that bypasses `TransactionRunner` still can't read foreign data (no context ⇒
   default deny), but reviewers should reject raw `pool.query` in application code (add a lint rule).
2. **Worker cross-tenant surfaces** (outbox, webhook deliveries, instance scheduler) are readable across tenants by
   `hs_worker`. Keep payloads minimal (ids, not message text) — current producers follow this.
3. **Crypto-shredding is not absolute**: deleted ciphertext/wrapped keys persist in WAL/backups until they expire.
   For stronger guarantees use per-organization KMS keys (schedule key deletion on org purge) and bounded backup
   retention.
4. **`tenant_context_valid()` costs one indexed lookup per statement** (verified as InitPlan). Fine at target scale;
   revisit if statement rates reach the tens of thousands per second.
5. **Group chats / LID migration**: ingestion assumes 1:1 chats; `whatsapp_lid` is stored but identity merging
   between JID and LID is not implemented. Message idempotency is scoped per instance (WhatsApp ids are per-chat in
   theory; collision risk is negligible but noted).
6. **Resource-less bookings** (capacity-based venues) are not protected by the exclusion constraint; model
   tables/rooms as resources, or add capacity counting under the per-resource advisory lock.
7. **Entitlement enforcement** (`app.current_entitlement`) is available, but limit checks (e.g. max instances) must
   be applied by services under an advisory lock to be race-free — not yet wired.
8. **Baileys itself isn't a dependency here**: the auth adapter is structurally compatible (BufferJSON format,
   `SignalKeyStore` shape); verify against the pinned Baileys version (e.g. `app-state-sync-key` proto revival via
   `deserializeKey`).
9. Out of MVP scope and not built: invitations table/tokens, platform-admin support role, usage rollups, campaigns.

---

## Phase 2 self-audit (WhatsApp gateway)

* **Baileys:** `baileys@7.0.0-rc14` (exact). Compiled and type-checked against its real types; a real `makeWASocket`
  is constructed in the automated suite against a local WebSocket server.
* **Migrations added:** `0012_whatsapp_gateway.sql` (messages.origin, instance linked_at/reconnect/health columns,
  outbox target_instance_id + index, worker-health grant, `app_ops.whatsapp_health_summary`),
  `0013_link_lease.sql` (`claim_instance_lease_for_link`). No applied migration was modified.
* **Tests:** 125 passing (66 Phase 1 + 59 Phase 2), typecheck clean.
* **Verification levels** - AUTOMATED: everything in the tables above (fake socket / local socket server, real
  PostgreSQL, real HTTP stack). LIVE AGAINST REAL WHATSAPP SERVERS (no account): real Baileys handshake, real QR
  received and relayed worker→API over the encrypted bus and SSE; QR absent from all DB tables and logs; DISCONNECT and
  LOGOUT paths; re-link after logout. NOT YET VERIFIED WITH A REAL ACCOUNT: QR scan/pairing, message send/receive,
  receipts, restore of a paired session - follow [docs/whatsapp-local-testing.md](docs/whatsapp-local-testing.md).
* Full report, risks and limitations: [docs/whatsapp-gateway.md](docs/whatsapp-gateway.md).

---

## Phase 3 - business-owner app

```bash
npm run dev:start                     # API :3100 + worker; PIDs recorded in .data/dev-pids.json
cd apps/web && npm install && cp .env.example .env.local && npm run dev   # http://localhost:3200
npm run dev:status / npm run dev:stop # stop kills ONLY the recorded PIDs (taskkill /PID <pid> /T)
npm run dev:cleanup-smoke             # dry run: lists smoke-*/live-* orgs; add -- --yes to delete (dev DB only)
npm run whatsapp:acceptance           # guided real-WhatsApp test with a dedicated test account
npm run perf:explain                  # EXPLAIN ANALYZE on the test DB
```

**Process safety rule.** Development and test tooling never kills processes by image name (`taskkill /IM node.exe`
is forbidden). `scripts/dev.ts` records every PID it starts and stops only those; Playwright starts and stops its own
E2E servers.

**Single-process limits (documented, deliberate).** Realtime fan-out works across processes (encrypted pg
LISTEN/NOTIFY), but the QR cache (last QR for late subscribers) and the API send rate limiter are per API process.
Behind N API processes the effective rate limit is N x the configured value; a browser reconnecting to another process
waits for the next QR. A shared store (Redis) is the follow-up if strict global limits are required.

**EXPLAIN results** (see [docs/inbox.md](docs/inbox.md)): inbox open list 94 ms -> 3.4 ms, contacts 5.1 ms -> 0.27 ms.

## Phase 3 self-audit

Verification levels are kept separate. **AUTOMATED VERIFIED** = executed in this repository's automated suites
(real PostgreSQL, real Nest API, real gateway worker, real Next.js production build in Chrome; only the WhatsApp socket
is fake). **REAL WHATSAPP VERIFIED** = performed by a person with a real, dedicated test WhatsApp account.

| Area | AUTOMATED VERIFIED | REAL WHATSAPP VERIFIED |
|---|---|---|
| Registration, onboarding, org/business switching | yes (every E2E spec, API tests) | n/a |
| Tenant isolation (API, realtime, UI, cache) | yes (`tenant-isolation.spec.ts`, `saas-api`, `rls-isolation`) | n/a |
| Instance create + plan limit incl. concurrency | yes (`plan-limit.spec.ts`, `saas-api`) | NO |
| QR shown locally, never stored/logged/persisted in browser | yes (`instance-qr.spec.ts`, `qr-and-sse.test.tsx`) | NO |
| Pairing-code flow | yes (backend, fake socket) | NO |
| Live inbound message in inbox | yes (`inbox.spec.ts`) | NO |
| Reply QUEUED->SENT->DELIVERED->READ, no duplicates | yes (`inbox.spec.ts`, `inbox-realtime`) | NO |
| Message typed on phone shown once, never re-sent | yes (`inbox.spec.ts`) | NO |
| Media display via signed URLs | yes (API tests) | NO |
| Reconnect / logout / restore notifications | yes (backend) | NO |
| API keys (plan gate, once-only plaintext, revoke) | yes (`developers.spec.ts`) | n/a |
| Webhooks (SSRF, secret once, test delivery, edit, delete) | yes (`developers.spec.ts`, `saas-api`) | n/a |
| XSS-safe rendering, CSRF, HttpOnly session | yes (component + E2E) | n/a |

Nothing in the "REAL WHATSAPP VERIFIED" column has been performed: no real account was used in this work. Run
`npm run whatsapp:acceptance` with a spare/test number (never a personal production business) to fill it in; the
script records only what the operator confirms.

* **Migrations added:** `0014_saas_app` (invitation functions, `WEBHOOK_TEST`), `0015`-`0017` concurrent indexes, each
  with a down file. No applied migration was edited; RLS was not weakened; the database was not reset (tests use
  `hypersender_test` / `hypersender_e2e_test`, whose names must end in `_test`).
* **Dependencies:** Baileys, NestJS, TypeScript, pg unchanged. New, pinned, web-only: next 16.3.6, react 19.3.0,
  @tanstack/react-query 5.104.0, qrcode 1.5.4, tailwindcss 4.3.3; dev: vitest, testing-library, jsdom,
  @playwright/test 1.63.0 (runs on the locally installed Chrome; set `E2E_BROWSER_CHANNEL=msedge` for Edge).
* **Not implemented (by spec or deferred):** AI replies/RAG, bulk sends/broadcasts, forgot-password/email
  verification, email invitations for people without an account, webhook latency metrics, CSP nonces
  (`script-src 'unsafe-inline'` is currently required by Next.js), global (multi-process) rate limiting.
* **Smoke data:** `npm run dev:cleanup-smoke` (dry run) lists `smoke-1790515089`, `live-1790515823` and 2 users in
  the dev DB. They were **not** deleted; run with `-- --yes` yourself if you want them gone.

---

## Phase 4 - AI assistants

One orchestration runtime + narrow business capabilities, configured per business from versioned templates
([architecture](docs/ai-assistant-architecture.md)). Set `OPENAI_API_KEY` (see `.env.example`) for real replies; without it
assistants never answer live customers and the Test Assistant says the AI service is not configured.

Owner flow: **AI Assistants -> Templates** (marketplace) -> Preview -> Use Template (business, name/tone/languages, capabilities)
-> Knowledge -> WhatsApp -> **Test Assistant** (safe dry run) -> **Publish** -> live replies in the Inbox, with **Take over / Resume AI**.

## Phase 4 self-audit

Verification levels:

* **AUTOMATED VERIFIED** - real PostgreSQL, real API/worker/runtime/tool gate/gateway (fake WhatsApp socket), **with a simulated model**:
  a local fake of the OpenAI HTTP API driven by deterministic scripts.
* **REAL MODEL VERIFIED** - against the real OpenAI API.
* **REAL WHATSAPP VERIFIED** - on a real WhatsApp account.

No real model call and no real WhatsApp account were used.

### Templates

* 10 active: General Business, Doctor Appointment, Dental Clinic, Restaurant Reservation, Salon/Spa, Real Estate Lead,
  Hotel Reception, Customer Support, E-commerce Support, Sales & Lead Qualification.
* Tools per template (on by default / mapped): 8/9, 14/16, 14/16, 13/14, 15/17, 9/11, 8/9, 7/7, 6/6, 9/10.
* Each has required setup and 1-3 demo conversations: [template-system.md](docs/template-system.md).
* All pass template validation (automated).

### Tools

* 22 registered: the 21 from the spec plus the internal CONFIRM_PENDING_ACTION.
* Implemented handlers: 21. Unavailable: 1 - CREATE_PAYMENT_LINK (no payment provider; NOT_READY, cannot be enabled).
* Read-only: 12. Side-effect: 10. Confirmation by default: 4 (create/reschedule/cancel booking, payment link).
* No generic SQL, data or code tool exists (asserted by a test).

### AI

* **Provider:** `AIModelProvider` abstraction; `OpenAIProvider` (Responses API, function tools, `store:false`) over HTTP.
* **Model:** per assistant (data), default `gpt-5-mini` (`AI_DEFAULT_MODEL`). Embeddings: `text-embedding-3-small`, with keyword-search fallback.
* **Loop:** model -> validated tools (parallel for independent reads, sequential otherwise) -> structured results -> model.
  * Max tool iterations: 6 (configurable 1-12 per assistant).
  * 1 retry on transient model errors.
  * Anti-fabrication claim guard; safe fallback + handoff.
* **Context:** 6 prompt layers - platform rules in code, template snapshot, business config, tenant instructions,
  conversation context (local date/time, summary, open confirmation), tool definitions. Last 24 messages plus a rolling summary every ~30 messages.
* **Debounce:** `response_wait_ms` (default 4 s) per assistant; one lease-holding cycle per conversation.

### Security

All AUTOMATED VERIFIED; details in [ai-security.md](docs/ai-security.md).

* **Tenant isolation:** context never comes from the model; FORBIDDEN_ARGUMENT; business filter + RLS; composite FKs.
* **Tool authorisation:** only enabled + ACTIVE + READY tools are loaded or executed; disabling applies immediately.
* **Prompt isolation:** platform layer immutable, tenant text delimited, the publish review blocks override attempts.
* **Knowledge isolation:** org + business + assistant scoping.
* **Confirmation handling:** durable encrypted pending actions, confirmation only in a later turn, expiry.
* **Idempotency:** run + tool + args keys, replay lookup before validation, one run per trigger, reply key.

### WhatsApp

| Flow | Automated (fake socket) | Real WhatsApp |
|---|---|---|
| inbound -> assistant | VERIFIED | NO |
| assistant -> outbound through our gateway | VERIFIED | NO |
| human takeover (dashboard + phone, AI echo ignored) | VERIFIED | NO |

### UI

Built and exercised by the E2E journey, with screenshots in `docs/screenshots/01-06`:
template marketplace, template preview, assistant builder (capabilities + settings drawer), knowledge setup,
Test Assistant simulator, live assistant overview, inbox takeover controls.

### Testing

* Backend: 145 before -> 184 now (39 new); 2 consecutive full runs green.
* Web component: 18 -> 20. E2E: 7 -> 8; full E2E run green.
* Root and web TypeScript clean; Next.js production build succeeds; OpenAPI regenerated (70 paths).
* Migrations 0018-0019 up/down round trip tested.
* Fixed a pre-existing time-of-day flake in `rls-isolation.test.ts`: it booked "now + 24 h" and failed between 23:30 and 00:00 IST.
  It now books tomorrow at 12:00 IST; the assertion is unchanged.

### Known risks / not done

* **No real-LLM evaluation.** Tool choice, language quality (Hindi/Hinglish), instruction following and the claim guard's regex
  have only been exercised with a simulated model. Run the manual acceptance in [assistant-testing.md](docs/assistant-testing.md) before launch.
* **Claim guard** is a multilingual regex: it can miss creative phrasing or (rarely) block a legitimate sentence.
  Enforcement of the actions themselves does not depend on it.
* **Instruction review** is pattern-based and can miss creative override attempts; enforcement is in code.
* **Not built:** PDF/DOCX/website knowledge import, payment links, the template update apply flow, platform-admin template screens,
  sandbox mutation mode, multi-assistant routing. The UI says "coming soon" where visible.
* **Conversation summarisation** (every ~30 messages) is implemented but not covered by an automated test.
* **Knowledge keyword fallback** uses the `simple` text-search config (no stemming); vector search needs `OPENAI_API_KEY`.
* **Cost estimates:** `ai_model_pricing` is empty, so there are none until admins enter verified prices.
* **Monthly AI quota** uses calendar months in UTC.
* **Availability** for businesses without bookable resources has no capacity limit.
