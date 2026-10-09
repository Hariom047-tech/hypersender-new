# Template & assistant UI design system

Original HyperSender designs, built with the existing primitives (`apps/web/components/ui`) and the AI components in `apps/web/components/ai`. Screenshots (captured by the E2E run from the real app with test data): `docs/screenshots/01…06`.

| # | Screen | Route | Screenshot |
|---|---|---|---|
| 1 | Template marketplace | `/ai-assistants/templates` | `01-template-marketplace.png` |
| 2 | Template preview | `/ai-assistants/templates/:key` | `02-template-preview.png` |
| 3 | Assistant builder: capabilities + settings drawer | `/ai-assistants/:id` (Capabilities) | `03-assistant-builder-capabilities.png` |
| 4 | Knowledge & business setup | `/ai-assistants/:id` (Knowledge) | `04-knowledge-setup.png` |
| 5 | WhatsApp test simulator | `/ai-assistants/:id/test` | `05-test-simulator.png` |
| 6 | Live assistant | `/ai-assistants/:id` (Overview, ACTIVE) | `06-live-assistant.png` |

## Building blocks

- **TemplateIcon**: emoji glyph on a soft coloured tile, keyed by `icon_key` (stethoscope, tooth, utensils, scissors, building, store, bed, headset, chart, bag). Decorative (`aria-hidden`); the name is always text.
- **Capability badge**: emerald pill using the customer-facing capability name (never a tool key).
- **WhatsAppChat**: phone-style thread with a green header, beige chat surface, white customer bubbles and green assistant bubbles, and a centred "✓ Checked availability" chip for capability steps.
  - The header carries a label: **DEMO PREVIEW** (static platform demos) or **LIVE TEST** (real runtime).
  - Text renders as React text only (XSS-safe, tested).
- **AssistantStatusBadge**: Draft (slate), Testing (blue), **Live** (green), Paused (amber), Archived. Always words, never colour alone.
- **WizardStepper**: the 8-step journey *Preview → Business → Configure → Capabilities → Knowledge → WhatsApp → Test → Publish* (`aria-current="step"`). Steps 1–4 happen in the template page; 5–8 in the builder, driven by readiness.
- **ReadinessCard**: circular score, "Missing" list with a fix hint per item (required ● red, recommended ○ amber).
- **Settings drawer**: native `<dialog>` sheet from the right. Form fields are generated from the capability's `config_schema` with friendly labels ("Maximum advance booking (days)", "Minimum notice (minutes)", "Confirmation required" …). Server-side validation is authoritative.

## Content rules

- User-facing words: *AI Assistant, Template, Capabilities, Knowledge, Instructions, Test Assistant, WhatsApp Connection, Publish*. Never LLM, function calling, tool schema, orchestrator, vector database or Baileys.
- Demo data is always labelled as demo. Previews never show internal prompts.
- Unavailable capabilities say "Coming soon" and can't be switched on (e.g. payment links, PDF and website import).
- Marketplace filters: All · Appointments · Sales · Support · Hospitality · Real Estate · General.
- Accessibility: switches are `role="switch"` with labels, filters use `aria-pressed`, tabs use the shared `Tabs`, live chat regions are `aria-live="polite"`, and focus is visible.

## Screens in brief

1. **Marketplace**
   - Cards: icon, name, short description, up to 4 capability badges, a two-bubble demo preview, and *Preview* / *Use Template*.
2. **Preview**
   - Left: what it can do (✓ included, ☐ optional), required setup, recommended for, setup time, languages, *Customize Template* / *Use Template*.
   - Right: the WhatsApp demo with tabs between example conversations.
3. **Builder**
   - Header: icon, name, status, *Test Assistant*, *Pause Assistant* / *Resume*, *Publish* / *Publish changes*.
   - Tabs: Overview · Instructions · Capabilities · Knowledge · WhatsApp · Test · Activity.
   - Capabilities: ON/OFF switches plus a *Settings* drawer.
4. **Knowledge**
   - "Train <assistant>" progress chips (Business details, Services, Staff & resources, Knowledge n/m, WhatsApp).
   - Add FAQ / Add Text (PDF and Website marked "soon"); sources with READY/Learning/Failed; business data counts; readiness side card.
5. **Simulator**
   - Left: configuration (Safe Test, not sending real messages, draft settings) and test customer.
   - Centre: the live-test chat with capability chips.
   - Right: the trace (intent, capabilities, knowledge, status, response time).
6. **Live assistant**
   - Today's conversations handled, resolved automatically, human handoffs, bookings created.
   - WhatsApp number and status with *Open Inbox*, active capabilities, readiness, template version, published version.
