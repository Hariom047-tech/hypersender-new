# AI Assistants — architecture (Phase 4)

An **AI Assistant** is not one autonomous agent. It is a small orchestration loop (the "assistant brain") that understands the conversation and chooses among **narrow, authorised business capabilities (tools)**. The backend executes every tool with normal business logic under the tenant's RLS context. The model never touches the database, never runs code and never "declares" success.

```
WhatsApp customer ──► gateway worker (ingestion) ──► outbox MESSAGE_RECEIVED
                                                        │ debounce (response_wait_ms)
                                                        ▼
                                           AI_TURN_DUE (dedicated queue, per-conversation lease)
                                                        │
          ┌──────────────── AssistantRuntime (src/ai/runtime) ────────────────┐
          │ prompt layers 1-6 ─► AIModelProvider (OpenAI Responses API)        │
          │        ▲                  │ function calls                          │
          │        │ structured       ▼                                         │
          │        │ results     ToolExecutor: exists? ACTIVE? enabled? handler?│
          │        └──────────── schema-valid? no tenant ids? confirmation? ────┤
          │                           ▼                                         │
          │               handlers (src/ai/tools/handlers) ─► BookingService,   │
          │               LeadService, Knowledge, Notifications (RLS, per biz)  │
          └──────────────────────────┬──────────────────────────────────────────┘
                                     ▼
                  reply ─► outbox MESSAGE_SEND_REQUESTED ─► our WhatsApp gateway
```

The same runtime powers every template (doctor, restaurant, salon, real estate, general …). Templates differ only in **data**: instructions, capabilities, defaults and setup requirements.

## Code map

| Path | Responsibility |
|---|---|
| `src/ai/model/` | `AIModelProvider` abstraction, `OpenAIProvider` (Responses API via fetch; no SDK types leak), embeddings, env wiring |
| `src/ai/tools/types.ts` | `AssistantTool` interface, trusted `ToolExecutionContext`, structured `ToolResult` |
| `src/ai/tools/registry.ts` | handler_key → implementation; catalog consistency check |
| `src/ai/tools/executor.ts` | the security gate, confirmation flow, timeouts, idempotency keys, redacted logging |
| `src/ai/tools/handlers/` | business-level capabilities (info, catalog, knowledge, booking, customer, leads, handoff, pause, team) |
| `src/ai/runtime/prompt-builder.ts` | layered instructions (platform → template → business config → tenant → context) |
| `src/ai/runtime/assistant-runtime.ts` | model ↔ tool loop, parallel/sequential batches, anti-fabrication guard, fallback |
| `src/ai/runtime/live-assistant.service.ts` | live WhatsApp turns: debounce, lease, takeover, persistence, reply through the gateway |
| `src/ai/runtime/assistant-worker.ts` | dedicated AI queue + outbox handlers (worker process) |
| `src/ai/admin/` | install / configure / capabilities / channel / readiness / publish / knowledge (API), Test Assistant sandbox |
| `src/api/ai.controllers.ts` | REST: `/v1/ai/templates`, `/v1/ai/assistants/...` |
| `apps/web/app/(app)/ai-assistants/` | marketplace, preview + wizard, builder, knowledge, simulator |

Related: [assistant-runtime.md](assistant-runtime.md) · [tool-registry.md](tool-registry.md) · [template-system.md](template-system.md) · [prompt-architecture.md](prompt-architecture.md) · [human-handoff.md](human-handoff.md) · [ai-security.md](ai-security.md) · [assistant-testing.md](assistant-testing.md) · [template-design-system.md](template-design-system.md)

## Terminology

The product UI says *AI Assistant, Template, Capabilities, Knowledge, Instructions, Test Assistant, WhatsApp Connection, Publish*. Internally the code keeps the Phase 1 names (`ai_agents`, `ai_tools`, …). Tables were **not** renamed for aesthetics.

## Database review (migrations 0018, 0019)

### Existing tables reused (unchanged semantics)

`ai_assistant_templates` (platform templates), `ai_tools` (capability registry), `ai_agents` (tenant assistants), `ai_agent_versions` (immutable publish snapshots), `ai_agent_channels` (assistant ↔ WhatsApp number; the existing partial unique index enforces one primary enabled assistant per number), `ai_agent_tools` (enabled capabilities + settings), `ai_runs` (one row per assistant turn; `UNIQUE(trigger_message_id)` = one reply per batch), `ai_tool_calls` (redacted operational log), `knowledge_sources` / `knowledge_chunks` (pgvector), `bookings` / `booking_events` / `services` / `business_resources` / `availability_*`, `conversations.handling_mode` / `ai_paused_until` (AI vs human), `messages.origin` (already distinguishes `AI`, `DASHBOARD` = dashboard human, `LINKED_DEVICE` = WhatsApp-phone human, `SYSTEM`; **no new origin column was needed**), `usage_events`, `audit_logs`, `notifications`, `outbox_events`.

### New tables

| Table | Why it was necessary | RLS |
|---|---|---|
| `ai_template_tools` | Which capabilities a template ships with (required / default on / order / default settings). Before 0018 this was an untyped JSON list in `default_config`. | platform catalog (no tenant data): SELECT for runtime roles only |
| `ai_tool_dependencies` | Logical dependencies (e.g. RESCHEDULE requires GET_BOOKING) for template validation and publish checks | platform catalog |
| `ai_model_pricing` | Cost estimates as **data** (no hard-coded prices). Empty until admins enter verified prices; runs then carry no estimate | platform catalog |
| `ai_pending_actions` | Durable confirmation state (WAITING/CONFIRMED/CANCELLED/EXPIRED/EXECUTED/FAILED), with **encrypted** arguments (envelope AES-GCM). One open action per conversation (partial unique index) | tenant RLS (app: read, worker: write) |
| `ai_conversation_states` | Debounce window, single-owner run lease, memory summary, greeting marker, handoff reason | tenant RLS |
| `leads` | CREATE_LEAD / UPDATE_LEAD / GET_LEAD had no backend. One open lead per contact and business (partial unique index); idempotency key | tenant RLS |
| `ai_test_sessions`, `ai_test_turns` | Test Assistant sandbox transcripts and traces, so testing **never** touches conversations, messages or WhatsApp | tenant RLS (app role) |

### New columns

- **`ai_assistant_templates`**: `long_description`, `industry`, `icon_key`, `marketplace_category`, `welcome_behavior`, `supported_languages`, `recommended_model`, `model_settings`, `demo_conversations`, `setup_requirements`, `recommended_for`, `setup_minutes`, `display_order`, `published_at`, `deprecated_at`. The existing `description` is the short description.
- **`ai_tools`**: `category`, `handler_key`, `output_schema`, `config_schema`, `risk_level`, `is_read_only`, `has_side_effects`, `version`, `availability` (READY / NOT_READY), `capability_name`, `capability_description`.
  - The flags are derived from the Phase 1 `side_effect` column by a trigger, so older seed statements stay valid.
  - The existing `requires_confirmation` is the confirmation default.
- **`ai_agents`**: `template_key`, `template_version`, `template_instructions` (snapshot at install), `custom_instructions`, `instructions_mode`, `welcome_config`, `handoff_config`, `response_wait_ms`, `max_tool_iterations`, `config_revision`.
- **`ai_runs`**: `tool_iterations`, `trigger_message_count`, `estimated_cost_micros`, `cost_currency`, `outcome`.
- **`ai_tool_calls`**: `idempotency_key`.
- **`knowledge_sources`**: `raw_content` (TEXT/FAQ/CSV sources), `content_bytes`, `chunk_count`.

### New indexes and constraints

- **Indexes:**
  - `ai_template_tools_uq (template_id, tool_id)`, `ai_template_tools_tool_idx`
  - `ai_pending_one_open_uq` (one WAITING/CONFIRMED action per conversation), `ai_pending_org_idx`
  - `leads_org_biz_idx`, `leads_contact_idx`, `leads_idempotency_uq`, `leads_one_open_uq`
  - `ai_test_sessions_agent_idx`, `ai_runs_agent_outcome_idx`
  - `knowledge_chunks_fts_idx` (GIN full-text, 0019, `CREATE INDEX CONCURRENTLY`)
- **Constraints:**
  - CHECKs on every enum-like column, JSON shapes, lengths and ranges
  - `ai_tools_ready_handler_chk` (READY requires a handler key)
  - `ai_template_tools_req_chk` (required ⇒ default enabled)
  - composite FKs keep pending actions, states, leads and test sessions inside one organization and business

### New RLS policies

The standard `tenant_isolation_app` / `tenant_isolation_worker` pair applies (via `app_admin.apply_tenant_rls`) to `ai_pending_actions`, `ai_conversation_states`, `leads`, `ai_test_sessions` and `ai_test_turns`. No existing policy was changed or weakened. Worker cross-tenant access still goes only through the outbox policies.

### Other changes

- **Seeds:** `db/seeds/003_ai_assistants_catalog.sql` adds the 22 tools, the templates (new versions), the template tool mappings, the dependencies, and the usage types `AI_ASSISTANT_RUN`, `AI_TOOL_CALL` and `AI_HANDOFF`.
- **Down files:** 0018 and 0019 both have down files. The full up → down → up round trip is tested.

## Entitlements (data-driven)

- `MAX_AI_AGENTS` (the existing key; the spec's future name is `MAX_AI_ASSISTANTS`) is checked with an advisory lock at install.
- `MONTHLY_AI_MESSAGES` is checked per live turn against `AI_ASSISTANT_RUN` usage.
- `KNOWLEDGE_STORAGE_MB` is checked on knowledge add.
- `ADVANCED_TOOLS` is not defined yet (no advanced tools exist).
- No limits are hard-coded.

## Not built (by design)

Mass campaigns, outbound prospecting, generic SQL or computer-control tools, browser automation, multi-agent swarms, voice, Instagram/Messenger, multi-assistant routing. The schema allows routing later: `ai_agent_channels` is many-to-many with `is_primary`.
