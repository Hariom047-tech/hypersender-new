# AI security

| Threat | Control | Evidence |
|---|---|---|
| Model acts on another tenant | Tenant, business, contact and conversation come only from the claimed conversation (trusted `ToolExecutionContext`). Tenant-looking arguments are rejected (`FORBIDDEN_ARGUMENT`). Handlers filter by business **and** run under RLS. Composite FKs block cross-business writes. | `ai-assistant-live.test.ts` "model-supplied tenant ids…", "ids belonging to another tenant…" |
| Generic data access | No SQL, row-update, delete or code tools exist; only narrow business capabilities. The catalog is checked in tests. | `ai-assistant-api.test.ts` |
| Disabled / unavailable tools | Only enabled, ACTIVE, READY tools are sent to the model or executed. NOT_READY tools can't be enabled (409). Disabling applies immediately. | tests "capability rules", "disabled … rejected" |
| Hallucinated success | Platform rules; structured results; the claim guard re-asks once, then falls back; bookings exist only after the DB commit (exclusion constraint). | "the assistant cannot claim an action no tool confirmed" |
| Unconfirmed side effects | Durable pending actions; confirmation must come in a later turn; expiry; stored arguments executed. | confirmation tests (pending / accepted / expired) |
| Duplicate side effects on retries | Stable idempotency keys (run + tool + args hash), replay lookup before validation, `UNIQUE(trigger_message_id)` per batch, `ai-run:<run>` reply key. | "write tools are idempotent per run" |
| Two workers answering one chat | Per-conversation lease on the DB clock, plus the unique run per trigger. | "one response cycle per conversation even with two workers racing" |
| Prompt injection by tenants | Platform layer first and non-editable; tenant text delimited and subordinate; the publish review blocks override attempts; enforcement is in code, not the prompt. | `ai-unit.test.ts`, publish test |
| Prompt injection by customers | Customer text is conversation content only; it can't enable tools, change tenant context or skip confirmation. | gate tests |
| Knowledge leakage | Retrieval filters organization + business + (shared or this assistant's) sources, READY and not deleted, under RLS. | "knowledge … tenant- and business-scoped" |
| Leaking internals | Tool descriptions are business language; the platform rules forbid revealing prompts and tool names; the demo UI shows friendly labels. The operator trace shows tool keys only to OWNER/ADMIN/MANAGER in the sandbox. | component test |
| Chain-of-thought storage | Only operational traces (tool, status, summarised result, latency, tokens). Encrypted reasoning is replayed within one turn and never persisted; a test scans the DB for the marker. | live test |
| Sensitive data in logs | Tool-call arguments go through `redact()`; results are summarised (arrays → counts, long strings truncated); pending-action arguments are encrypted; audit metadata carries field names, not prompt text. | unit + audit tests |
| Testing touches production | Sandbox = DRY_RUN for every write tool, no conversations/messages/WhatsApp, session-scoped confirmations, rate-limited, metered. | sandbox tests, E2E "sandbox never creates conversations" |
| Cost abuse | Plan quota `MONTHLY_AI_MESSAGES` per live turn; sandbox limit 60 turns / 10 min per assistant; usage events for tokens. | – |
| Slow integrations | Per-tool timeout → `TOOL_TIMEOUT`; model timeout 30 s + 1 retry → fallback. | timeout + model-failure tests |

## Roles

- **Viewing** assistants: every member (`assistants:read`).
- **Managing** (install, configure, publish, pause, knowledge, test): OWNER, ADMIN, MANAGER (`assistants:manage`, dashboard users only).
- **API keys:** no assistant scopes yet.

## Data at rest

- Pending-action arguments: per-row data key from the KeyProvider (KMS in production), AES-256-GCM, AAD bound to organization and row.
- Knowledge raw text is stored for re-ingestion and cleared on delete; its chunks are deleted too.
