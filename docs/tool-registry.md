# Tool (capability) registry

Two halves bound by `handler_key`:

- **Catalog (data)** in `app.ai_tools`, seeded by `db/seeds/003_ai_assistants_catalog.sql`. It holds key, name, model-facing description (business language only, never tables or SQL), category, input/output/config JSON schemas, risk level, read-only flag, confirmation default, version, and `availability` (READY / NOT_READY). It also holds the customer-facing capability name and description used by the UI.
- **Implementations (code)**: `AssistantTool` objects in `src/ai/tools/handlers`, registered in `ToolRegistry`. Every write tool must implement `dryRun`; every tool that may require confirmation must implement `preview`. `ToolRegistry.validateCatalog` (run in tests) proves that every READY tool has a matching handler with the same read-only flag.

A tool without a handler is **NOT_READY**. It can never be enabled (API returns 409) or executed (not loaded).

## Catalog (22 tools)

| Key | Category | Kind | Confirmation default | Status |
|---|---|---|---|---|
| GET_BUSINESS_INFO | BUSINESS_INFO | read | – | READY |
| GET_BUSINESS_HOURS | BUSINESS_INFO | read | – | READY |
| GET_BUSINESS_LOCATION | BUSINESS_INFO | read | – | READY |
| GET_SERVICES | BUSINESS_INFO | read | – | READY |
| GET_SERVICE_DETAILS | BUSINESS_INFO | read | – | READY |
| GET_SERVICE_PRICE | BUSINESS_INFO | read | – | READY |
| GET_RESOURCES | BUSINESS_INFO | read | – | READY |
| SEARCH_KNOWLEDGE | KNOWLEDGE | read | – | READY |
| CHECK_AVAILABILITY | BOOKING | read | – | READY |
| GET_BOOKING | BOOKING | read | – | READY |
| CREATE_BOOKING | BOOKING | side effect (MEDIUM) | yes | READY |
| RESCHEDULE_BOOKING | BOOKING | side effect (MEDIUM) | yes | READY |
| CANCEL_BOOKING | BOOKING | side effect (MEDIUM) | yes | READY |
| GET_CUSTOMER_CONTEXT | CUSTOMER | read | – | READY |
| CREATE_LEAD | SALES | side effect | – | READY |
| UPDATE_LEAD | SALES | side effect | – | READY |
| GET_LEAD | SALES | read | – | READY |
| HUMAN_HANDOFF | COMMUNICATION | side effect | – | READY |
| NOTIFY_TEAM | COMMUNICATION | side effect | – | READY |
| PAUSE_AUTOMATION | SYSTEM | side effect | – | READY |
| CONFIRM_PENDING_ACTION | SYSTEM (internal) | side effect | – | READY (never shown as a capability; loaded only while a confirmation is open) |
| CREATE_PAYMENT_LINK | PAYMENT | external (HIGH) | yes | **NOT_READY**: no payment provider integration exists |

That is 12 read-only tools and 10 with side effects; 4 have confirmation by default.

Vertical capabilities are catalogued separately: restaurant ordering (seed 004) and havan booking (16 tools, seed 006, see [havan-booking.md](havan-booking.md)). There is intentionally **no** `execute_sql`, `query_database`, `update_row`, `delete_row` or code-execution tool (a test asserts this).

## Execution interface

```ts
interface AssistantTool<I> {
  handlerKey: string; isReadOnly: boolean; timeoutMs?: number;
  execute(ctx: ToolExecutionContext, input: I, deps): Promise<ToolOutcome>;
  dryRun?(ctx, input, deps): Promise<ToolOutcome>;       // write tools: validate, write nothing
  preview?(ctx, input, deps): Promise<ConfirmationPreview>; // confirmation text from real data
}
```

`ToolExecutionContext` comes from trusted backend state:

- `organizationId`, `businessId`, `assistantId`, `conversationId`, `contactId`, `whatsappInstanceId`
- `requestId` (run id), `idempotencyKey`
- `mode` (LIVE / DRY_RUN), the DB session context, timezone, currency, the per-assistant tool configuration (validated, with defaults), and template defaults

The model supplies only business arguments.

## The gate (`ToolExecutor.execute`), in order

1. The tool is in this run's loaded set. Only tools that are ACTIVE, READY, enabled for this assistant and in its published snapshot are loaded. Otherwise `TOOL_NOT_ENABLED`.
2. The handler exists, else `TOOL_UNAVAILABLE`.
3. Arguments are a JSON object, else `INVALID_ARGUMENTS`.
4. No tenant or ownership keys (`organization_id`, `business_id`, `contact_id`, `conversation_id`, `assistant_id`, `instance_id`, `user_id`, `sql`, `table` …) at any depth, else `FORBIDDEN_ARGUMENT`.
5. The strict schema validates, including `additionalProperties: false`, formats and ranges, else `INVALID_ARGUMENTS` with issues.
6. The tenant context is fixed by the scope; handlers query with an explicit `business_id` filter **and** RLS. Ids of other tenants or businesses resolve to `NOT_FOUND`.
7. Business rules run in handlers and services: booking window, notice, same-day, party size, resource ↔ service, availability, exclusion constraint.
8. Confirmation policy (see [human-handoff.md](human-handoff.md#confirmations)).
9. Execute with a timeout. `DRY_RUN` calls `dryRun` for write tools.
10. Log a redacted, size-bounded summary to `ai_tool_calls` (idempotent per run and call id).

## Idempotency

The key for a side-effect tool is `<runId>:<TOOL>:<sha256(canonical args)>`, or `pending:<id>` for confirmed actions.

- `CREATE_BOOKING` looks up the key **before** re-validating the slot, so a retried run returns its original booking instead of reporting its own slot as taken. This bug was found by the tests and fixed.
- Leads use the same key.
- `RESCHEDULE_BOOKING` puts it on the new booking.

## Business-level, not CRUD

`CREATE_BOOKING` validates availability itself and picks a free resource. `RESCHEDULE_BOOKING` is one transaction: lock the calendar, move the booking, keep the original on failure. Dependencies in `ai_tool_dependencies` are hints and validations, never a CRUD sequence the model must follow.

## Adding a tool

1. Implement the handler, adding `dryRun`/`preview` if it writes.
2. Register it in `DEFAULT_TOOLS`.
3. Add or seed the catalog row with `availability = 'READY'` and the `handler_key`.
4. Map it to templates in `ai_template_tools`.
5. Run tests: `validateCatalog` and the template validation must pass.
