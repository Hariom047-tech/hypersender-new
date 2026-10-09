# Assistant runtime

`AssistantRuntime.runTurn` (`src/ai/runtime/assistant-runtime.ts`) is provider-, storage- and channel-agnostic. Live WhatsApp turns and the Test Assistant use the same code.

## Live turn lifecycle (`LiveAssistantService`, worker process)

1. **Schedule (debounce).** Ingestion commits the inbound message and emits `MESSAGE_RECEIVED`. The handler finds the number's responder (primary channel whose assistant is `ACTIVE` and auto-reply on, with a published version). It sets `ai_conversation_states.respond_after = now() + response_wait_ms` and enqueues `AI_TURN_DUE` with that delay.
   - Default wait: 4 s, configurable 0–30 s.
   - Each new message pushes `respond_after` out.
   - Fragments like "Hi / price / dental implant / ka kya hai" become **one** turn, and the model receives all of them.
2. **Claim (one cycle per conversation).** `AssistantWorker` claims `AI_TURN_DUE` from a dedicated queue (bounded concurrency, default 4). The general relay never runs model calls. It then:
   - Row-locks the state. If `respond_after` is still in the future (database clock), the event is not due, and the later message's event will run.
   - If another worker holds the lease (`run_lock_owner/until`, 120 s), the event is deferred 2 s.
   - Otherwise it takes the lease, builds the batch (inbound messages after `last_processed_message_id`), and applies the gates:
     - handling mode (HUMAN/PAUSED, with policy-based auto-resume)
     - plan quota `MONTHLY_AI_MESSAGES`
     - `ai_runs` claim with `trigger_message_id` = last message of the batch (unique)
   - A crashed worker's run is taken over with the **same run id**, so idempotency keys stay identical.
3. **Think (no transaction open).**
   - Load the published snapshot and dynamically load tools (see [tool-registry.md](tool-registry.md)).
   - Build context: the last 24 messages with team messages marked, the rolling summary, customer name and whether they are returning, the open confirmation, and the business's local date/time.
   - Run the loop.
4. **Deliver.** One transaction:
   - Re-check that no human replied (dashboard or phone) since the batch started and that the mode is still AI. If a human did, the reply is dropped and the run ends `SKIPPED_HUMAN` / `CANCELLED`.
   - Otherwise enqueue the reply through the transactional outbox (`ai-run:<runId>` idempotency, `origin = AI`, `is_ai_generated`). The routed send goes through **our** WhatsApp gateway.
   - Record run metrics and usage: `AI_ASSISTANT_RUN`, `AI_INPUT_TOKENS`, `AI_OUTPUT_TOKENS`, `AI_TOOL_CALL`.
   - Advance `last_processed_message_id`, set `greeted_at`, release the lease.
5. **Memory.** Every ~30 messages a short factual summary (≤ 6 bullets, no reasoning) is refreshed with a separate model call and stored in `ai_conversation_states.summary`.

## The loop

```
for iteration in 0..max_tool_iterations (default 6):
  response = model(instructions, history + this turn's items, enabled tools)   # 1 retry on transient errors
  if no tool calls:
     if reply claims a completed action and no capability confirmed one this turn:
        one corrective re-ask (instructions get a CORRECTION section), else safe fallback
     return reply
  batch = response.tool_calls
  all read-only and >1 call -> run concurrently   (GET_BUSINESS_HOURS + GET_BUSINESS_LOCATION)
  otherwise                -> run in the model's order (CHECK_AVAILABILITY -> CREATE_BOOKING)
  append structured results; after HUMAN_HANDOFF/PAUSE the tools are removed so only a closing message can follow
exceeded -> safe fallback
```

- **Multi-tool turns.** Several calls per response and several iterations per turn are both supported. Tested with "Kal 5 baje cleaning book kar do aur address bhi bhej dena": a parallel read batch → availability → booking confirmation, answered in one reply.
- **Structured results.** Every tool returns `{ success, errorCode?, …data }` (e.g. `SLOT_NOT_AVAILABLE` with `alternatives`). The model never gets prose-only backend answers.
- **Failure behaviour.**
  - Model errors are retried once (transient: timeout, 429, 5xx); then the customer gets a safe fallback.
  - The fallback is configurable per assistant; defaults are Hindi or English.
  - The conversation goes to HUMAN, admins are notified (`AI_ASSISTANT_FAILING`), and the run is `FAILED/FALLBACK`.
  - The customer's message is never lost.
  - Tool failures and timeouts (`TOOL_TIMEOUT`, default 8–10 s) return normalised errors, and the platform rules forbid claiming success.
- **Model provider not configured** (no `OPENAI_API_KEY`): live turns send the fallback and hand off. The sandbox says so explicitly.

## Model provider

- `AIModelProvider` is provider-neutral. `OpenAIProvider` uses the Responses API with function tools and `store: false`.
- Reasoning models (gpt-5 family) are asked for `reasoning.effort` and encrypted reasoning items only. These are replayed **within the same turn** to keep multi-step tool use coherent. They are never persisted, logged or shown.
- `temperature` is sent only to non-reasoning models.
- Model per assistant is data: `ai_agents.model_provider/model_name`, defaulting to the template's `recommended_model` or `AI_DEFAULT_MODEL` (`gpt-5-mini`).
- Embeddings: `AI_EMBEDDING_MODEL` (`text-embedding-3-small`).

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `OPENAI_API_KEY` | — | required for real replies |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | tests point this at a local fake |
| `AI_DEFAULT_MODEL` | `gpt-5-mini` | fallback model name |
| `AI_EMBEDDING_MODEL` | `text-embedding-3-small` | knowledge embeddings |
| `AI_MODEL_TIMEOUT_MS` | 30000 | per model call |
| `AI_ASSISTANTS_ENABLED` | true | `false` disables assistant turns in a worker |
| `AI_SANDBOX_TURNS_PER_10_MIN` | 60 | per assistant, sandbox rate limit |

## Cost tracking

Tokens (input/output/cached) are recorded on `ai_runs` and as usage events. `estimated_cost_micros` is filled **only** from `ai_model_pricing` rows maintained by platform admins; prices are never hard-coded or guessed.
