# Testing assistants

## For business owners: Test Assistant

Route: `/ai-assistants/:id/test`. It is a WhatsApp-style chat against the **real runtime**: same prompt layers, model, capability gate and business data. It uses the **draft** configuration, so changes can be tried before publishing.

- **Safe Test (DRY_RUN).** Every capability that would change something (booking, lead, handoff, pause, notify) is simulated: it validates against real data and returns `{ dryRun: true, wouldCreate … }`. Nothing is booked, saved or sent, and no conversation, message or WhatsApp traffic is created. "Allow sandbox mutations" is **not offered** (only `DRY_RUN` exists) because writing test bookings would block real slots.
- **Confirmations** work as in live chats, using session-scoped state.
- **Trace panel** (operational only):
  - intent derived from the capabilities used
  - capabilities with status (✓, simulated, asked to confirm, blocked) and a summarised result
  - whether knowledge was used
  - status (waiting for information/confirmation, handed to team)
  - response time and tokens
  The model's reasoning is never shown.
- **Labels:** the template marketplace and preview show **Demo preview** (static, platform-authored demo data). The simulator shows **Live test** (real runtime).

## Publish validation

`GET /v1/ai/assistants/:id/readiness` → score and checks. **Publishing requires all of these:**

- template setup requirements marked REQUIRED (services, resources of the right type, availability, hours, location, profile, knowledge …)
- a WhatsApp number selected
- the AI service configured
- the plan includes `MONTHLY_AI_MESSAGES`
- capability integrity: required enabled, enabled ones available, `REQUIRES` dependencies met
- no ERROR-level instruction issues

A disconnected number is a warning only; you can publish offline.

## Automated tests (repository)

| Suite | File | Count |
|---|---|---|
| Unit | `test/ai-unit.test.ts` (prompt layering, instruction review, schema validation, OpenAI parsing, chunking, log summaries) | 6 |
| API | `test/ai-assistant-api.test.ts` (marketplace, template validation, install/copy, template never mutated, capability rules, instruction review, publish validation + immutable versions, pause/resume + audit, plan limit, tenant isolation, knowledge isolation, sandbox DRY_RUN, no-model behaviour, roles) | 13 |
| Live | `test/ai-assistant-live.test.ts` (inbound → assistant → availability → confirmation → booking through the gateway; expired confirmation; HUMAN_HANDOFF; phone reply pauses AI and the AI echo doesn't; dashboard reply pauses AI; PAUSED/DRAFT silent; model failure fallback; fabrication guard; multi-tool turn; debounce; concurrency; tool gate security; foreign ids; idempotency + conflict; timeout) | 15 |
| Conversations (§85) | `test/ai-conversations.test.ts` (doctor, restaurant, salon, real estate, general) | 5 |
| Web components | `apps/web/tests/ai-components.test.tsx` | 2 |
| E2E | `apps/web/e2e/ai-assistants.spec.ts`: marketplace → preview → wizard → knowledge → capabilities → WhatsApp → Test Assistant → publish → live reply in the inbox → human takeover (+ 6 screenshots) | 1 |

### The model in tests is simulated

`test/fakes/fake-openai.ts` is a local HTTP stand-in for the OpenAI Responses and Embeddings APIs, so the production `OpenAIProvider` code path (HTTP, request building, parsing) is exercised. The "model" is either a per-test script or `test/fakes/intent-brain.ts`, a keyword router that can only choose among the tools the runtime **offered**.

These tests therefore prove the runtime, gate, tools, persistence and WhatsApp delivery. They do **not** measure a real LLM's language quality or tool-choice accuracy. **No real OpenAI call was made** in this repository's tests (no API key is configured).

### Running

```bash
npm test                                   # backend incl. AI suites (real PostgreSQL)
cd apps/web && npm test && npm run e2e:full   # component + E2E (Playwright, local Chrome)
```

### Before production: real-model acceptance (manual)

1. Set `OPENAI_API_KEY` for the API and the worker. Pick the model per assistant (default `gpt-5-mini`).
2. Use a spare test WhatsApp number and a test business with services, doctors and availability.
3. Run the five §85 conversations and the confirmation, handoff and takeover flows in the Test Assistant first, then live.
4. Check `ai_runs` (tokens, latency, outcome) and `ai_tool_calls` for each turn.
