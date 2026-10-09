# Template system

Templates are **platform data** (`ai_assistant_templates` + `ai_template_tools`). Tenants can read them but can never modify them.

## Templates (10 active)

| Key (version) | Marketplace | Capabilities on by default | Required setup | Demos |
|---|---|---|---|---|
| GENERAL_BUSINESS_ASSISTANT (v2) | General | business info, knowledge, hours, location, services, prices, create lead, handoff (8) | business profile | 1 |
| DOCTOR_APPOINTMENT (v2) | Appointments | info, knowledge, hours, location, services, prices, doctors, availability, book, get/reschedule/cancel booking, customer context, handoff (14) | services, doctor, availability, business hours | 3 |
| DENTAL_RECEPTIONIST (v2) | Appointments | same as doctor (14) | services, dentist, availability, hours | 1 |
| RESTAURANT_RESERVATION (v2) | Hospitality | info, knowledge, hours, location, menu (services), prices, table availability, reservations (create/get/reschedule/cancel), customer context, handoff (13); party size mandatory | hours, location, tables, reservation hours | 2 |
| SALON_BOOKING (v2) | Appointments | info, knowledge, hours, location, services, service details, prices, stylists, availability, bookings (4), customer context, handoff (15) | services, prices, stylists, availability | 1 |
| REAL_ESTATE_LEAD (v2) | Real Estate | info, knowledge, location, create/update/get lead, customer context, handoff, notify team (9); site-visit booking optional (off) | business profile | 1 |
| HOTEL_RECEPTION (v2) | Hospitality | info, knowledge, location, room types, rates, stay enquiry (lead), customer context, handoff (8) | profile, location | 1 |
| CUSTOMER_SUPPORT (v1) | Support | info, knowledge, hours, customer context, notify team, pause automation, handoff (7) | knowledge | 1 |
| ECOMMERCE_SUPPORT (v2) | Support | info, knowledge, products, prices, enquiry, handoff (6) | knowledge | 1 |
| SALES_LEAD_QUALIFICATION (v1) | Sales | info, knowledge, offerings, prices, create/update/get lead, notify team, handoff (9) | services, profile | 1 |

`CREATE_PAYMENT_LINK` is mapped (off, "coming soon") where relevant but can't be enabled until a payment integration exists.

### Doctor example (spec §58)

| Setting | Tools |
|---|---|
| Required | GET_BUSINESS_INFO, SEARCH_KNOWLEDGE, HUMAN_HANDOFF |
| On by default | GET_SERVICES, GET_SERVICE_PRICE, GET_RESOURCES, CHECK_AVAILABILITY, CREATE_BOOKING, RESCHEDULE_BOOKING, CANCEL_BOOKING |
| Off by default | CREATE_PAYMENT_LINK |

## What a template contains

- **Short description** (`description`), long description, industry, marketplace category, icon.
- **Instructions** (`base_system_prompt`), structured as ROLE / OBJECTIVE / CONVERSATION STYLE / BUSINESS RULES / TOOL USAGE / WHEN TO ASK / WHEN TO CONFIRM / WHEN TO HAND OFF / ERROR BEHAVIOUR / PROHIBITIONS. No customer or tenant data.
- `welcome_behavior` (style and guided options), supported languages, recommended model and model settings.
- **`demo_conversations`**: 1–3 per template, clearly labelled *Demo preview* in the UI.
- **`setup_requirements`**: keys from a fixed vocabulary (`BUSINESS_PROFILE`, `BUSINESS_HOURS`, `LOCATION`, `SERVICES`, `SERVICE_PRICES`, `RESOURCES` with resource types, `AVAILABILITY`, `KNOWLEDGE`).
- Recommended-for list, approximate setup minutes.
- Capabilities via `ai_template_tools` (required, default on, order, default settings).

## Installation (copy, not reference)

`POST /v1/ai/assistants { templateKey, businessId, name, tone?, languages?, capabilities? }` does the following:

1. Checks `MAX_AI_AGENTS` under an advisory lock.
2. Creates a **DRAFT** `ai_agents` row with the template key and version, and a **snapshot of the template instructions** (`template_instructions`).
3. Copies defaults for tone, welcome, handoff, model and response wait.
4. Copies the template's capabilities into `ai_agent_tools`. NOT_READY tools are copied disabled; the owner's choices apply to optional tools.
5. Audits `ASSISTANT_CREATED` and `TEMPLATE_INSTALLED`.

Knowledge is **not** cloned; it belongs to the business or the assistant.

After install the assistant is independent: editing it never touches the template (tested byte-for-byte). Switching domains means **"Create from another template"**; an installed Doctor assistant is never turned into a Restaurant assistant.

## Versioning

- `(key, version)` is unique, with exactly one ACTIVE version per key.
- Seed 003 published v2 of the Phase 1 templates by deprecating v1, which shows the mechanism works.
- Because assistants snapshot `template_instructions` and `template_version`, a new platform version **never changes a live assistant silently**.
- The builder shows "a newer template version is available (vN)". The *Keep current / Review update / Apply update* flow is prepared (installed vs latest version is exposed by the API) but applying updates is not built yet.

## Platform admin (prepared, not built)

`AssistantAdminService.validateTemplate` implements the pre-publication checks for a template version:

- required tools exist and have handlers
- default-enabled tools are READY
- default configurations validate against each tool's config schema
- instructions exist
- setup requirement keys are known
- demo conversations only use included tools
- `REQUIRES` dependencies are satisfied

All 10 templates pass (tested). Admin screens for creating, editing, publishing and deprecating templates are not built. Tenants have no write grant on templates at all.

## Publishing an assistant

`POST /v1/ai/assistants/:id/publish`:

1. Runs readiness (see [assistant-testing.md](assistant-testing.md#publish-validation)).
2. If publishable, snapshots layers 2–4 and the full configuration into a new immutable `ai_agent_versions` row, sets `published_version_id`, and moves the assistant to **ACTIVE** with auto-reply on.
3. Later edits mark "unpublished changes" (`config_revision` vs. the snapshot's revision).
4. Turning a capability **off** takes effect immediately (the runtime intersects the snapshot with currently enabled tools); turning one on needs a publish.

Statuses: DRAFT (never answers live customers), TESTING (reserved), ACTIVE, PAUSED (no replies), ARCHIVED (historical; channel detached).
