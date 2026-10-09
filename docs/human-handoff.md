# Human handoff, takeover, pause and confirmations

`conversations.handling_mode` is the single source of truth: `AI` / `HYBRID` = the assistant may reply; `HUMAN` / `PAUSED` = it does not. The runtime checks the mode **before every turn and again right before sending**.

## Handoff by the assistant (`HUMAN_HANDOFF`)

- **Input:** `reason`, `priority` (LOW / NORMAL / HIGH / URGENT), `summary`.
- **Effect:**
  - `handling_mode = HUMAN`
  - `ai_conversation_states.handoff_reason/priority/at` recorded
  - OWNER/ADMIN notification `AI_HANDOFF`, de-duplicated
  - usage `AI_HANDOFF`
- **Result:** `{ status: HANDED_OFF, handlingMode: HUMAN }`. The runtime then removes all tools so the model can send only one closing message ("A team member will reply here").
- **Fallback:** a failed model call, an unconfirmed claim, or too many tool iterations also hands off, as `AI_ASSISTANT_FAILING`.

## Human takeover (a person replies)

| Who sends | `messages.origin` | Effect with the default policy `PAUSE_AI` |
|---|---|---|
| Customer | CONTACT | none |
| AI assistant | AI | none; its own WhatsApp echo is de-duplicated by provider message id, so it can never pause itself |
| Team member in the dashboard | DASHBOARD | conversation → HUMAN |
| Owner typing on the linked phone | LINKED_DEVICE | conversation → HUMAN |
| External system via API key | API | none (automation, not a human) |

Detection runs on the `MESSAGE_SENT` outbox event, i.e. after the gateway actually sent or observed the message. Independently, the delivery step drops an AI reply if any DASHBOARD/LINKED_DEVICE message appeared after the batch started, so the AI never talks over a person who is typing.

The inbox shows **"AI replying · <assistant>"** or **"Team handling · AI paused"** with **Take over** / **Resume AI** buttons (`POST /v1/conversations/:id/handling {mode}`).

## Resume policy (per assistant, `handoff_config`)

| `resume` | Behaviour |
|---|---|
| `MANUAL` (default) | only "Resume AI" |
| `AUTO_AFTER` | `ai_paused_until = last human message + resumeAfterMinutes`. Every further human message pushes it out, so the AI never resumes while a human is active. |
| `UNTIL_RESOLVED` | resolving the conversation hands it back to the AI |

`takeover = KEEP_AI` disables automatic pausing (not recommended).

## Pause on request (`PAUSE_AUTOMATION`)

When a customer asks the bot to stop: `handling_mode = PAUSED` with `ai_paused_until` (default 24 h). The assistant auto-resumes after that time.

## Assistant status

- **PAUSED:** the assistant answers nobody.
- **DRAFT / unpublished:** never answers live customers.
- **ARCHIVED:** channel detached.

All of these are tested.

## Confirmations

Side-effect tools with confirmation on (default: book, reschedule, cancel, payment link; configurable per capability) never run on the first request.

1. The executor calls the handler's `preview` with real data (slot free? booking belongs to this customer?). It stores a **pending action** in `ai_pending_actions`:
   - `WAITING`, arguments AES-GCM encrypted, a customer-facing summary, expires in 15 min (configurable)
   - at most one open per conversation
   It returns `CONFIRMATION_REQUIRED` + the text, and the model asks the customer ("Book … on Mon 4:00 pm under Rahul?").
2. On the customer's next message the context says *"WAITING FOR CUSTOMER CONFIRMATION: …"* and the internal `CONFIRM_PENDING_ACTION {CONFIRM|DECLINE}` tool is loaded.
3. `CONFIRM` executes the **stored** arguments (not the model's memory) with idempotency key `pending:<id>`, then marks the action EXECUTED or FAILED. `DECLINE` → CANCELLED.
4. **Guards:**
   - Expired → `CONFIRMATION_EXPIRED`, nothing executes.
   - The action must have been created in an *earlier* turn, so the model cannot confirm its own request (`CONFIRMATION_NOT_FROM_CUSTOMER`).
   - A disabled capability is refused.

In the Test Assistant the same flow runs against session-scoped state, and the confirmed action is a dry run.
