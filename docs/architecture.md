# HyperSender AI — Database Architecture

Status: MVP schema implemented and verified (migrations `0001`–`0011`, 66 automated tests).
Engine: PostgreSQL 17 + pgvector, pgcrypto, btree_gist. Node.js/TypeScript (NestJS-compatible).

---

## A. Architecture assessment

### A.1 Tenancy model

```
User (platform identity) ──< organization_members >── Organization  ◄── TENANT BOUNDARY
                                                          │
                                                          └──< Business ──< WhatsApp instances, contacts,
                                                                           conversations, messages, AI agents,
                                                                           knowledge, services, resources, bookings
```

* **`organization_id` is the tenant boundary**, never `user_id`. A user can belong to many organizations with a
  different role in each (`organization_members.role`); users carry no tenant roles.
* **Shared database, shared schema.** Every tenant-owned table carries `organization_id` (40 tables), even where it
  is derivable through a parent. This redundancy is what RLS, per-tenant indexes, analytics and composite FKs key on.
* **Business** is the operational unit inside a tenant (ABC Dental and ABC Pharmacy under "Ayush Ventures").
  Business-scoped tables also carry `business_id`.

### A.2 Ownership & integrity boundaries (composite keys)

Foreign-key checks **bypass RLS**. A plain `business_id REFERENCES businesses(id)` would let tenant A insert a row
pointing at tenant B's business (the RLS `WITH CHECK` only looks at the new row's own `organization_id`). Therefore:

* Referenced parents expose `UNIQUE (id, organization_id)` and, where business consistency matters,
  `UNIQUE (id, organization_id, business_id)`.
* Children reference them compositely, e.g.
  `FOREIGN KEY (whatsapp_instance_id, organization_id, business_id) REFERENCES whatsapp_instances (id, organization_id, business_id)`.
* `messages` references `conversations (id, organization_id, business_id, whatsapp_instance_id)`: one constraint
  pins tenant, business *and* instance consistency with the thread.
* Assignments reference **memberships**, not users: `conversations (organization_id, assigned_user_id) → organization_members`,
  `notifications (organization_id, user_id) → organization_members`. You cannot assign or notify a non-member.
* `ON DELETE SET NULL (col)` (PG ≥ 15 column-list form) is used on composite FKs so only the reference is cleared,
  never `organization_id`.

### A.3 Security boundaries

| Layer | Mechanism |
|---|---|
| DB roles | `hs_owner` (migrations; owns objects; BYPASSRLS) · `hs_app` (API; NOBYPASSRLS) · `hs_worker` (workers; NOBYPASSRLS). Runtime roles own nothing, cannot create objects, and have explicit column-level grants. |
| Tenant context | `set_config('app.current_organization_id' / 'app.current_user_id' / 'app.current_api_key_id', …, is_local => true)` as the first statement of every transaction (`TransactionRunner`). Transaction-local ⇒ never leaks across pooled connections. |
| RLS | `ENABLE` + `FORCE` on all 42 tenant/identity tables. No policy for `PUBLIC` ⇒ default deny. Unset context ⇒ `NULL` ⇒ no rows. Malformed context ⇒ cast error (fails closed). |
| Context validation | For `hs_app`, `tenant_isolation_app` also requires `app.tenant_context_valid()`: the acting user must be an **ACTIVE member** of the org, or the acting API key must be **live** and belong to it. A middleware bug that trusts a forged `X-Organization-Id` still reads nothing. Revoking a key cuts off in-flight requests on their next statement. |
| Escalation | `organization_members` has per-command policies: only OWNER/ADMIN may insert/update members; the bootstrap path only admits the org creator as first OWNER; a trigger keeps ≥ 1 active OWNER. The API can only insert a `TRIALING/NONE` subscription (restrictive policy) — paid states come from the billing worker. |
| Secrets | See §A.5 and §42 table in README. Hash columns (`password_hash`, `key_hash`) and ciphertext columns are **not SELECT-able by `hs_app`**. |
| Pre-tenant paths | Only three `SECURITY DEFINER` functions in `app_auth` (login candidate lookup, API-key authentication, invite resolution), each with `SET search_path` and `EXECUTE` granted to `hs_app` only. |

### A.4 High-volume tables

`messages`, `message_status_events`, `whatsapp_signal_keys` (hot updates), `usage_events`, `webhook_events`,
`webhook_deliveries`, `outbox_events`, `audit_logs`, `ai_runs`. All append-mostly ones use **UUIDv7** primary keys
(enforced by `CHECK (uuid_extract_version(id) = 7)`), giving right-leaning B-trees and making future range
partitioning on `id` possible without changing any FK. Queue tables use **partial "due" indexes** so the hot index
stays tiny regardless of history size. `messages` has a BRIN index on `created_at` for retention scans.

### A.5 WhatsApp authentication storage (Baileys)

* **No filesystem auth.** `usePostgresAuthState()` (src/whatsapp/postgres-auth-state.ts) replaces `useMultiFileAuthState`.
* `whatsapp_auth_credentials` (1 row/instance) = `AuthenticationCreds`; `whatsapp_signal_keys` = `SignalKeyStore`
  (`UNIQUE (instance_id, key_type, key_id)` serves batched `get(type, ids[])`, upserts and bulk delete; `fillfactor=80`
  for HOT updates; aggressive autovacuum).
* **Envelope encryption in the application**: KMS master key (never in PostgreSQL) → per-instance 256-bit data key,
  stored only *wrapped* (`wrapped_data_key`, KMS EncryptionContext = org/purpose/instance) → AES-256-GCM of the creds
  JSON and of every signal key, `nonce(12) ‖ ciphertext ‖ tag(16)`.
* **AAD** binds each blob to `(org, instance, key_type, key_id)`: ciphertext swapped between rows/tenants fails
  authentication (tested).
* The plaintext data key lives in worker memory for the socket lifetime and is zeroised on close. Nothing is logged.
* **Fencing**: every credential/key write runs `app.assert_instance_lease(instance, worker, token)` in the same
  transaction (`FOR SHARE` on the instance row). A worker whose lease was taken over gets `HS_LEASE_LOST` and must
  close its socket — a session is never intentionally live on two workers.
* **QR codes are never persisted** (no column exists — asserted by a test). They live in Redis with a short TTL.
* **Logout / org deletion**: `app.destroy_whatsapp_auth()` hard-deletes credentials (cascade → all keys), clears the
  lease, sets `LOGGED_OUT`, writes a `CREDENTIALS_DESTROYED` event.

### A.6 AI template vs tenant agent

* `ai_assistant_templates` and `ai_tools` are **platform** catalogs (no tenant data, read-only for runtime roles).
* Installing a template **copies** it into a tenant-owned `ai_agents` row plus an immutable `ai_agent_versions`
  snapshot (`effective_system_prompt`, `configuration`, template provenance). Editing/deprecating a template never
  changes a tenant's live agent; `template_id` is `SET NULL` on template removal.
* `ai_agent_channels` maps agents to channels (many-to-many; `channel_type` ready for web chat/Instagram/Messenger).
  `UNIQUE (whatsapp_instance_id) WHERE is_primary AND enabled` ⇒ at most one auto-responder per number.
* Model provider/name are **data** (`model_provider`, `model_name`), not code.
* The model never touches SQL. Tools are backend functions; `ai_tool_calls` records redacted arguments and the
  backend's result idempotently (`UNIQUE (ai_run_id, provider_tool_call_id)`). A booking is reported as done only
  after `BookingService` committed it.

---

## B. Entity relationship map

See [er-diagram.md](er-diagram.md) (Mermaid, three diagrams).

---

## C. Table inventory (49 tables)

Scope: **P** = platform, **T** = tenant (`organization_id`, RLS forced), **I** = identity (RLS forced).
All PKs are `uuid` (UUIDv7 default) except the two lookup tables (`code text`) and `resource_services` (composite).

| # | Table | Scope | Purpose | Important FKs |
|---|---|---|---|---|
| 1 | users | I | Login identity (no tenant roles) | — |
| 2 | organizations | T (root) | Tenant/workspace | created_by_user_id → users (SET NULL) |
| 3 | organization_members | T | User↔org with role | org (RESTRICT), user (CASCADE) |
| 4 | businesses | T | Operational unit | org (RESTRICT) |
| 5 | business_locations | T | Branches | (business, org) RESTRICT |
| 6 | whatsapp_workers | P | Gateway process registry | — |
| 7 | whatsapp_instances | T | One WA connection | (business, org) RESTRICT; worker (SET NULL) |
| 8 | whatsapp_auth_credentials | T | Encrypted Baileys creds | (instance, org) CASCADE |
| 9 | whatsapp_signal_keys | T | Encrypted Signal keys | (instance, org) → credentials CASCADE |
| 10 | whatsapp_instance_events | T | Connection history | (instance, org) CASCADE |
| 11 | api_keys | T | Hashed gateway API keys | org, (business, org) RESTRICT |
| 12 | webhook_event_types | P | Event type catalog | — |
| 13 | webhook_endpoints | T | Endpoint + encrypted secret | (business, org) RESTRICT; (instance, org, business) CASCADE |
| 14 | webhook_event_subscriptions | T | Endpoint ↔ event type | endpoint CASCADE; type RESTRICT |
| 15 | webhook_events | T | Internal event fact | business/instance SET NULL(col) |
| 16 | webhook_deliveries | T | HTTP delivery state | event CASCADE, endpoint CASCADE |
| 17 | contacts | T | Customer per business | (business, org) RESTRICT |
| 18 | conversations | T | Inbox thread | instance/contact (org, business) RESTRICT; assignee → membership SET NULL(col) |
| 19 | messages | T | Messages | conversation (org, business, instance) RESTRICT; contact RESTRICT; reply SET NULL(col) |
| 20 | message_status_events | T | Receipt timeline | message CASCADE |
| 21 | message_attachments | T | Media metadata (bytes in S3) | message CASCADE |
| 22 | ai_assistant_templates | P | Template catalog | — |
| 23 | ai_tools | P | Tool catalog | — |
| 24 | ai_agents | T | Tenant assistant | (business, org) RESTRICT; template SET NULL; published version SET NULL(col) |
| 25 | ai_agent_versions | T | Immutable prompt/config snapshots | agent CASCADE |
| 26 | ai_agent_channels | T | Agent ↔ channel | agent & instance (org, business) CASCADE |
| 27 | ai_agent_tools | T | Enabled tools | agent CASCADE; tool RESTRICT |
| 28 | ai_runs | T | Execution trace | agent/conversation/trigger RESTRICT; response SET NULL(col) |
| 29 | ai_tool_calls | T | Tool call trace | run CASCADE; tool RESTRICT |
| 30 | knowledge_sources | T | Documents/FAQ/URLs | (business, org) RESTRICT; agent RESTRICT |
| 31 | knowledge_chunks | T | Text + pgvector embedding | source (org, business) CASCADE |
| 32 | services | T | Bookable services | (business, org) RESTRICT; location SET NULL(col) |
| 33 | business_resources | T | Doctor/stylist/table/room | (business, org) RESTRICT |
| 34 | resource_services | T | Resource ↔ service | both CASCADE |
| 35 | availability_rules | T | Weekly hours | resource/location CASCADE |
| 36 | availability_exceptions | T | Leave/holiday/blocks | resource/location CASCADE |
| 37 | bookings | T | Generic booking | contact & resource RESTRICT; service/location/conversation/agent SET NULL(col) |
| 38 | booking_events | T | Booking history | booking CASCADE |
| 39 | subscription_plans | P | Plans | — |
| 40 | plan_entitlements | P | Limits as data | plan CASCADE |
| 41 | usage_event_types | P | Metering catalog | — |
| 42 | subscriptions | T | Org subscription | org, plan RESTRICT |
| 43 | invoices | T | Invoices (retained) | org, subscription RESTRICT |
| 44 | payments | T | Provider payments (retained, no card data) | org, invoice RESTRICT |
| 45 | usage_events | T | Immutable metering ledger | org RESTRICT; type RESTRICT |
| 46 | audit_logs | T (org nullable) | Immutable audit | org RESTRICT; no user FK (history) |
| 47 | notifications | T | In-app notifications | (org, user) → membership CASCADE |
| 48 | outbox_events | T (org nullable) | Transactional outbox | org RESTRICT |
| 49 | data_retention_policies | T | Retention configuration | org RESTRICT; business CASCADE |

Plus `public.schema_migrations` (migration ledger, owner-only).

---

## D–E. Schema, constraints, indexes, RLS

Implemented in `db/migrations/0001…0011`. Highlights:

* **231 CHECK constraints**: E.164 phones, ISO currency/country, timezone validity, JSON object shapes, status
  vocabularies, state consistency (`CLOSED ⇒ closed_at`, `DELIVERED ⇒ delivered_at`, `OUTBOUND ⇔ from_me`, inbound
  requires provider id/timestamp, AI message ⇒ agent), money ≥ 0, invoice arithmetic, ciphertext minimum lengths,
  password-hash format, HTTPS webhooks, no secret keys in audit metadata.
* **Uniqueness that encodes business rules**: `messages (whatsapp_instance_id, provider_message_id)`,
  `(organization_id, idempotency_key)` on messages/bookings/usage/webhook_events, one live phone per org, one
  active thread per (instance, contact), one primary auto-responder per instance, one live subscription per org,
  one ACTIVE template version per key, one primary location per business.
* **Exclusion constraint** `bookings_no_overlap`: `EXCLUDE USING gist (resource_id WITH =, tstzrange(start_at, end_at) WITH &&) WHERE status IN ('PENDING','CONFIRMED')`.

### Major indexes and why

| Index | Serves |
|---|---|
| `organization_members (organization_id, user_id)` UNIQUE + `(user_id, status)` | membership checks on every statement (`tenant_context_valid`), org switcher |
| `whatsapp_instances (organization_id, business_id, status)` partial live | dashboard |
| `whatsapp_instances (worker_lease_expires_at)` partial | scheduler finding unowned sessions |
| `whatsapp_signal_keys (instance_id, key_type, key_id)` UNIQUE | Baileys key get/set/delete |
| `contacts (business_id, whatsapp_jid)` UNIQUE partial | ingestion upsert |
| `contacts (organization_id, business_id, phone_e164)` | CRM lookup |
| `conversations (organization_id, status, last_message_at DESC)` / `(business_id, …)` / `(assigned_user_id, …)` | inbox views |
| `conversations (whatsapp_instance_id, contact_id)` UNIQUE WHERE status<>'CLOSED' | ingestion upsert |
| `messages (whatsapp_instance_id, provider_message_id)` UNIQUE | idempotent ingestion |
| `messages (conversation_id, message_timestamp DESC, id DESC)` | thread keyset pagination |
| `messages (contact_id)`, `(reply_to_message_id)`, `(ai_agent_id)` partial | FK support: parent deletes would otherwise seq-scan the largest table |
| `messages USING brin (created_at)` | retention / export by time |
| `bookings (organization_id, business_id, start_at)`, `(resource_id, start_at, status)`, GiST exclusion | calendars, availability |
| `webhook_deliveries (next_retry_at) WHERE status IN (PENDING,RETRYING,PROCESSING)` | dispatcher hot path |
| `outbox_events (available_at) WHERE status IN (PENDING,PROCESSING,FAILED)` | relay hot path |
| `usage_events (organization_id, occurred_at, event_type)` | quota & billing aggregation |
| `knowledge_chunks (organization_id, business_id, knowledge_source_id)` | retrieval pre-filter |

Verified with `EXPLAIN` as `hs_app`: RLS predicates evaluate as one-time **InitPlans** and the inbox/thread queries
use the indexes above.

### RLS policy set

| Policy | Roles | Tables |
|---|---|---|
| `tenant_isolation_app` — `organization_id = ctx AND tenant_context_valid()` | hs_app | all 40 tenant tables (via `app_admin.apply_tenant_rls`) |
| `tenant_isolation_worker` — `organization_id = ctx` | hs_worker | all 40 tenant tables |
| cross-tenant claim (`USING true`) | hs_worker only | `outbox_events` (select/update/delete processed), `webhook_deliveries` (select/update), `whatsapp_instances` (select/update — column grants restrict writable columns) |
| custom | hs_app | `users` (self + co-members), `organizations` (member read, creator bootstrap, admin update), `organization_members` (per-command, admin-only writes), `notifications` (restrictive: own only), `subscriptions` (restrictive: trial-only insert) |

A catalog test asserts every table with an `organization_id` column has RLS enabled **and forced** with policies,
so a future migration that forgets RLS fails CI.

---

## Background workers across tenants

Workers connect as `hs_worker` (NOBYPASSRLS). The rule is **claim across tenants, process inside one tenant**:

1. **Claim** with no tenant context — only possible on the three queue surfaces that have a worker-only
   cross-tenant policy (outbox, webhook deliveries, instance leases). Claims use `FOR UPDATE SKIP LOCKED` plus a
   visibility timeout (`available_at` / `next_retry_at` pushed forward), and completion is conditional on
   `locked_by = me`.
2. **Process** each claimed item in `TransactionRunner.inTenant({ organizationId: item.organization_id })`.
   All reads/writes (messages, secrets, payloads) are then RLS-scoped to that tenant. A handler bug cannot read
   another tenant's data because the context is taken from the claimed row, not from the payload.
3. Baileys sessions: the gateway claims an instance lease (cross-tenant scheduler policy), then every auth-state and
   ingestion operation for that socket runs in the instance's tenant context with the fencing token.
4. The owner role (`hs_owner`) is never available to workers. Truly global maintenance (org purge, partition
   management) runs as audited admin jobs.

---

## J. Transaction strategies

Rule for all: **no network I/O inside a transaction**; external side effects go through `outbox_events`.

| Flow | Transaction(s) | Idempotency / concurrency |
|---|---|---|
| **Incoming WhatsApp message** (`MessageIngestionService.ingest`, worker) | ONE tx: upsert contact → upsert open conversation → `INSERT message ON CONFLICT (instance, provider_message_id) DO NOTHING` → (only if inserted) bump counters, attachment metadata, outbox `MESSAGE_RECEIVED`, usage `WHATSAPP_MESSAGE_IN`. | Duplicate deliveries return `DUPLICATE` with no side effects (tested with 8 concurrent deliveries). Webhook/AI never block ingestion. |
| **Outgoing message** (`OutboundMessageService`) | T1 enqueue (QUEUED row + outbox) → gateway sends via Baileys → T2 `markSent` (conditional `QUEUED→SENT`, status event, outbox, usage). Receipts: forward-only `UPDATE … WHERE rank(status) < rank(new)`. | `(organization_id, idempotency_key)`; T2 conditional update is replay-safe; duplicate / out-of-order receipts are no-ops. |
| **AI response** (`AiResponseService`) | T1 claim: responder resolution + `INSERT ai_runs ON CONFLICT (trigger_message_id) DO NOTHING`. Model call outside tx. Tools: idempotent `ai_tool_calls` + backend service tx. T2 complete: enqueue reply (`ai-run:<id>`) + mark run + usage. | Exactly one run per inbound message; exactly one reply per run; a replayed tool call returns the stored result without re-executing. |
| **Booking creation** (`BookingService`) | ONE tx: `pg_advisory_xact_lock(resource)` → idempotency lookup → resource-provides-service + availability check → INSERT (exclusion constraint) → booking event + outbox + usage. Result `{ok:true}` only after COMMIT. | Advisory lock removes exclusion-constraint deadlocks (found by the concurrency test) and makes outcomes deterministic; the exclusion constraint remains the hard guarantee; idempotency key `<ai_run>:<tool_call>`. |
| **Webhook creation** (`WebhookService.createEndpoint`) | KMS data key generated **before** the tx; ONE tx: endpoint (encrypted secret) + subscriptions + audit. Plaintext secret returned once. | Delivery: fan-out tx (`webhook_events` idempotency key → deliveries `ON CONFLICT DO NOTHING`), dispatch = claim tx → HTTP (no tx) → outcome tx guarded by `locked_by`. |

---

## Enum strategy (decision)

| Kind | Choice | Why |
|---|---|---|
| Lifecycle/state machines (status, direction, handling_mode, roles) | `text` + named `CHECK` | Adding a value = `DROP CONSTRAINT` + `ADD CONSTRAINT … NOT VALID` + `VALIDATE CONSTRAINT` (no long lock, no table rewrite, transactional). PostgreSQL `ENUM` values cannot be removed/renamed safely and `ADD VALUE` has transaction restrictions. |
| Customer-visible, growing catalogs (webhook event types, usage event types, AI tools, plans, entitlements) | lookup tables with FK | New entries are `INSERT`s (seeds), no DDL at all. |
| Open vocabularies owned by the app (audit actions, outbox event types, resource types, booking types, Baileys key types) | `text` + format `CHECK` (`^[A-Z][A-Z0-9_]+$` etc.) | Never needs a migration; still rejects garbage. |

Deploy order for a new status value: (1) migration widens the CHECK, (2) deploy code that writes it. Removal is
the reverse.

---

## FK delete rules (classification)

* **RESTRICT** — anything under `organizations`/`businesses` (tenants and businesses are soft-deleted; hard delete
  only through `app_admin.purge_organization_data`, where a wrong order fails loudly), messages ← ai_runs,
  contacts ← conversations/messages/bookings, resources ← bookings, all financial records, catalog rows in use.
* **CASCADE** — children with no independent value: credentials → signal keys, instance → credentials/events/
  channels, message → attachments/status events, run → tool calls, source → chunks, endpoint → subscriptions/
  deliveries, booking → booking events, agent → versions/channels/tools, membership → notifications.
* **SET NULL (col)** — historical references: `created_by_user_id`, template of an agent, service/location/
  conversation/agent of a booking, reply-to, response message of a run, business/instance of webhook/usage events.
* **No FK (intentional)** — `audit_logs.actor_user_id`, `whatsapp_instance_events.worker_id`: history must survive
  pruning/anonymisation of the referenced row.

## Soft vs hard delete

* Soft (`deleted_at`): users, organizations, businesses, locations, instances, contacts, AI agents, knowledge
  sources, services, resources, webhook endpoints.
* Hard, explicit procedures:
  * `app.destroy_whatsapp_auth(instance)` — logout.
  * `app.anonymize_contact(contact)` — erasure of one customer (PII stripped from contact, messages, bookings; media
    purge queued).
  * `app.purge_conversation(conversation)` — deletes messages/AI traces, keeps bookings.
  * `app_admin.purge_organization_data(org)` — owner-only, requires prior soft delete; destroys operational data and
    all secrets; **retains** org tombstone, subscriptions, invoices, payments, usage, audit.
* Retention: `data_retention_policies` (per org / business / category, with platform floors: audit ≥ 365 d,
  usage ≥ 730 d) executed by a retention worker in batches using the BRIN/`created_at` indexes.

---

## Scaling notes (100 → 1,000 → 10,000+ organizations)

* **Now:** single PostgreSQL primary, PgBouncer in *transaction* mode (safe — context is transaction-local),
  read replica for analytics. No sharding.
* **Partition when justified** (rule of thumb: `messages` > ~200–500 M rows or retention deletes hurting vacuum):
  `messages`, `message_status_events`, `usage_events`, `webhook_events/deliveries`, `audit_logs`, `outbox_events`,
  `ai_runs` → `PARTITION BY RANGE (id)` on UUIDv7 month boundaries (ids are time-ordered and enforced v7, so all FKs
  to `(id)`/`(id, organization_id)` keep working). The only semantic change: the global unique
  `(whatsapp_instance_id, provider_message_id)` must move to a small non-partitioned `message_ingest_keys` table
  (same `ON CONFLICT` pattern) because unique indexes on partitioned tables must include the partition key.
  Retention then becomes `DETACH/DROP PARTITION`.
* **Usage**: add daily rollups (`usage_daily`) maintained by the outbox relay once quota checks become hot.
* **Vectors**: add a per-model HNSW expression index (`embedding::vector(N)`, partial on `embedding_model`) and
  `hnsw.iterative_scan` when per-business corpora exceed ~50–100 k chunks.
* **Beyond one primary**: shard by `organization_id` (Citus or app-level routing). Every table already carries it and
  every FK is org-scoped, so the schema is co-location-ready.

---

## Phase 2 addendum - WhatsApp gateway

Details: [whatsapp-gateway.md](whatsapp-gateway.md) · [baileys-auth-storage.md](baileys-auth-storage.md) ·
[webhook-events.md](webhook-events.md).

**Process split.** API (`hs_app`) never holds sockets; gateway workers (`hs_worker`) hold them. API → worker traffic
goes through the transactional outbox, routed by `outbox_events.target_instance_id` to the worker holding the instance
lease (commands: CONNECT / RESTART / DISCONNECT / LOGOUT / DELETE; sends: MESSAGE_SEND_REQUESTED). Worker → API
realtime traffic (QR, pairing code, status) uses an AES-GCM-encrypted PostgreSQL LISTEN/NOTIFY bus; nothing is persisted.

**Schema changes (additive):** `0012` - `messages.origin` (CONTACT/API/DASHBOARD/AI/LINKED_DEVICE/SYSTEM, for AI-human
coexistence), `whatsapp_instances.linked_at / reconnect_attempts / last_reconnect_at / last_event_at`,
`outbox_events.target_instance_id` + routed due index, restorable-sessions index, `hs_app` SELECT on worker liveness
columns only, `app_ops.whatsapp_health_summary()` (aggregates only). `0013` - `claim_instance_lease_for_link()`.

**Changes to Phase 1 code (not schema):** ingestion handles fromMe/reactions/quotes/LIDs; `markSent` no longer
downgrades a receipt that raced ahead of it; outbound supports media and routes sends; webhook envelope and signature
headers changed to the documented public contract (`X-Webhook-Id/Timestamp/Signature`); the general outbox relay skips
routed events; explicit `@Inject` tokens so Nest DI works without emitted decorator metadata (tsx/esbuild).

**Transaction strategy additions:** QR/status transitions = 1 fenced worker tx each (state + event + outbox); inbound =
1 tx (unchanged shape, now also fromMe/reaction); outbound = enqueue tx → pre-assign-id tx → provider call (no tx) →
markSent tx; logout = provider call → `destroy_whatsapp_auth` tx.

## Phase 3 addendum - business-owner app

Details: [dashboard.md](dashboard.md) · [realtime.md](realtime.md) · [inbox.md](inbox.md) ·
[frontend-security.md](frontend-security.md) · [tenant-ui-isolation.md](tenant-ui-isolation.md).

```
Browser --(HttpOnly cookie, CSRF header)--> Next.js BFF /api/v1/* --(Bearer, X-Organization-Id)--> Nest API (hs_app, RLS)
   ^                                                                                                 | outbox
   +------------ SSE /v1/realtime/stream <-- RealtimeBus (encrypted pg NOTIFY) <-- gateway worker (hs_worker)
```

* **Read models** (`src/api/views.ts`): one SQL view shape per conversation/message used by REST *and* realtime, so the
  client cache can merge both idempotently.
* **Entitlements** (`EntitlementService`): count-and-insert under a per-organization+feature advisory transaction lock
  in the same transaction as the insert - concurrent requests cannot exceed plan limits.
* **Account endpoints** (`/v1/account/*`) are user-level (my organizations, invitations, create organization) and run
  without a tenant context through the functions added in `0014`; everything else is tenant-scoped.
* **Notifications** are produced by the worker from outbox events (logged out, error, delayed reconnect check,
  webhook dead) and de-duplicated per org/key for 6 h.
* **Indexes** for inbox and contacts lists were chosen from EXPLAIN ANALYZE and built concurrently (`0015`-`0017`).
