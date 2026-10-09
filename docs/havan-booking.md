# Havan Booking Assistant (Pandit Ji / PanditSuggest)

Template `HAVAN_BOOKING`: a WhatsApp seva desk for a Pandit receiving PanditSuggest leads. The prompt is [havan-booking-assistant-prompt.md](havan-booking-assistant-prompt.md); it is copied verbatim into `db/seeds/007_havan_booking_template.sql`, and `test/havan-booking.test.ts` fails if the two differ.

## Design rules

| Rule | Where it is enforced |
|---|---|
| Dakshina is never quoted in chat | No price column exists for havan packages. `GET_DAKSHINA_POLICY` returns only the policy. The test asserts that no tool output contains an amount. |
| Facts only from tools | Religious answers come from `SEARCH_BAGLAMUKHI_KNOWLEDGE`. Temple facts come from Pandit Ji's settings. Festivals come from the calendar. Online facilities are per-package flags. |
| Online havan steps are only those Pandit Ji really offers | `GET_HAVAN_SERVICE_DETAILS.online` lists `liveVideoCall`, `recording`, `photos`, `prasadCourier` and `internationalCourier` as true/false. |
| No booking without explicit confirmation | `CREATE_HAVAN_BOOKING`, `RESCHEDULE_HAVAN_BOOKING` and `CANCEL_HAVAN_BOOKING` need confirmation (preview → `CONFIRM_PENDING_ACTION`). |
| No double booking | These tools wrap the generic booking handlers: slot re-check plus the DB exclusion constraint. |
| Reminders are real, not claimed | Reminders are rows plus outbox events. The tool result reports `SCHEDULED` or `NOT_SCHEDULED` per audience. |
| Call-back never blocks the chat | `REQUEST_PANDIT_HANDOFF` with `type: CALLBACK` notifies Pandit Ji and the assistant keeps helping. `CHAT_HANDOFF` switches the chat to HUMAN. |
| Tenant isolation | Every table has tenant RLS. Handlers filter by `ctx.businessId`. A customer only sees their own bookings, leads and reminders. |

## Capabilities (16)

| Prompt name | Tool key | Kind | What it does |
|---|---|---|---|
| search_baglamukhi_knowledge | `SEARCH_BAGLAMUKHI_KNOWLEDGE` | read | Semantic, then keyword, search over the knowledge Pandit Ji uploads. Reuses handler `knowledge.search`. |
| get_temple_information | `GET_TEMPLE_INFORMATION` | read | Returns temple name, address, map, darshan timings, how to reach, rules and notes from `havan_settings`, plus matching knowledge passages (history, legends). |
| get_service_details | `GET_HAVAN_SERVICE_DETAILS` | read | Covers the three tiers: herb count (and names if listed), samagri, duration, number of Pandits, Nalkheda/online availability, online facilities and yajman preparation. |
| get_service_pricing | `GET_DAKSHINA_POLICY` | read | Returns `policy: CALL_ONLY` and `canQuoteInChat: false`. It never returns an amount. |
| get_current_festival_context | `GET_FESTIVAL_CONTEXT` | read | Returns today's date in the temple timezone, `navratriStatus` (`NAVRATRI_ACTIVE`, `BEFORE_NAVRATRI`, `AFTER_NAVRATRI` or `NO_NAVRATRI_NEAR`), active and upcoming festivals, and Pandit Ji's special dates. |
| get_lead | `GET_YAJMAN_LEAD` | read | Returns the stored enquiry: stage, havan interest, mode, preferred date, whether a call-back was already requested, and upcoming bookings. |
| update_lead | `UPDATE_YAJMAN_LEAD` | write | Merges havan fields into `leads.attributes`. The stage maps to qualification (for example `HIGH_INTENT` or `CALLBACK_REQUESTED` → HOT). |
| check_pandit_availability | `CHECK_PANDIT_AVAILABILITY` | read | Checks one date, with an optional `preferred_time` that returns `requestedTimeFree`. The tier gives the havan's duration. |
| get_available_slots | `GET_AVAILABLE_SLOTS` | read | Returns free slots over a range of up to 7 days, filtered by tier or time of day. |
| create_booking | `CREATE_HAVAN_BOOKING` | write, confirm | Creates the booking, stores `havan_booking_details` (mode, gotra, sankalp, address) and schedules the Pandit Ji and yajman reminders. |
| get_booking | `GET_HAVAN_BOOKING` | read | Returns bookings with havan type, mode, dakshina status and pending reminders. |
| reschedule_booking | `RESCHEDULE_HAVAN_BOOKING` | write, confirm | Moves the booking in one step, copies the details, cancels the old reminders and schedules new ones. |
| cancel_booking | `CANCEL_HAVAN_BOOKING` | write, confirm | Cancels the booking and its pending reminders. |
| create_yajman_reminder | `CREATE_YAJMAN_REMINDER` | write | A WhatsApp reminder to this yajman, only on request. It must be 5 minutes to 60 days ahead, with at most 5 pending per yajman. |
| create_pandit_reminder | `CREATE_PANDIT_REMINDER` | write | A note to Pandit Ji, sent now or later. The yajman's name and number are added automatically. At most 10 can be pending per yajman. |
| request_pandit_handoff | `REQUEST_PANDIT_HANDOFF` | write | `CALLBACK`: validates the number (`use_whatsapp_number` for "isi number par"), keeps one open request per yajman, marks the lead `CALLBACK_REQUESTED` and notifies Pandit Ji now. `CHAT_HANDOFF`: switches the chat to HUMAN and notifies Pandit Ji. |

Code:
- Handlers: [src/ai/tools/handlers/havan.ts](../src/ai/tools/handlers/havan.ts)
- Reminders: [src/havan/reminders.ts](../src/havan/reminders.ts)
- Owner API: [src/havan/havan-admin.service.ts](../src/havan/havan-admin.service.ts)
- Catalog: `db/seeds/006_havan_booking_catalog.sql`
- Tables: `db/migrations/0021_havan_booking.sql`

## How a reminder works

```
tool (tenant tx)                          worker relay (when due)                 delivery
─────────────────                         ──────────────────────                  ────────
INSERT scheduled_reminders (PENDING)  ─┐
INSERT outbox_events REMINDER_DUE      │  claim when available_at <= now()
  available_at = due_at               ─┴─► deliverReminder (reminder's org tx) ─► YAJMAN: text in their own chat (origin SYSTEM)
                                           row not PENDING / booking gone → skip   PANDIT: dashboard notification +
                                           mark SENT / SKIPPED                             WhatsApp to havan_settings.pandit_whatsapp_e164
```

- **Due time.** Booking reminders go out `reminder_lead_minutes` before the havan (default 1440, i.e. one day). If that time has already passed, they go out 2 hours before. If even that is too late, the result says `NOT_SCHEDULED`.
- **Reschedule and cancel.** These mark the pending rows CANCELLED. Already-queued events then find a non-PENDING row and do nothing, so redelivery is harmless.
- **Pandit Ji's WhatsApp chat.** It is sent from the business number. That chat is set to `HUMAN`, so the assistant never replies to Pandit Ji. If Pandit Ji's number is the business number itself, only the dashboard notification is used.

## Starter knowledge (researched)

[src/havan/knowledge/starter-knowledge.json](../src/havan/knowledge/starter-knowledge.json) holds 14 FAQ sources with 73 questions and answers in Hinglish. Each source lists the references it was built from.

Topics:
- Maa Baglamukhi: who she is, name meaning, stambhan, swaroop, peela rang/Pitambara, Bhairav
- Prakatya katha: Haridra Sarovar, Madan asur, Brahmastra
- Nalkheda mandir: location, Pandav legend, Trishakti, how to reach, timings, Navratri, havan kund/mirchi havan, stay
- Datia Pitambara Peeth and Kangra Bankhandi
- Puja, jaap, havan and anushthan compared: dashansh, the 3 havan types, duration
- Samagri, havan vidhi, sankalp, purnahuti, bhasm, yajman niyam, bhog
- The online havan process: gotra unknown, abroad, what to do at home
- Mantra: beej, mool, gayatri, jaap niyam, haldi mala, with guidance cautions
- Festivals: Navratri, Gupt Navratri, Jayanti, shubh din
- Labh (dharmik manyata), always without guarantees and with legal/medical disclaimers
- Simple puja at home
- Stotra, kavach and yantra
- Nalkheda yatra: season and nearby darshan
- Common yajman questions

How the pack is used:
- **On install.** Installing `HAVAN_BOOKING` copies the pack into the new assistant's own knowledge as FAQ sources. The owner can edit or delete every entry. A plan without knowledge storage installs without it.
- **For existing assistants.** `POST /v1/ai/assistants/:id/knowledge/starter` adds the pack. It is idempotent by source title.
- **Content rules.** Religious content is written as tradition or belief ("parampara ke anusaar"), legends are not presented as verified history, and there are no prices. The test checks retrieval of key facts and that no amount appears.
- **Search tip.** Avoid `a/b` without spaces in FAQ text. The keyword index treats `puja/havan` as one token.

## Online havan: what the assistant may say

The prompt describes the usual flow of online havan services at Nalkheda:
1. Choose the tier.
2. Call with Pandit Ji (dakshina, date/muhurat).
3. Give name, gotra, family names and sankalp.
4. Fix the date/time, with a reminder.
5. Take the sankalp on a video call.
6. Havan with live darshan, or video/photos afterwards.
7. Purnahuti, then prasad (bhasma, raksha sutra) by courier.

Steps 6 and 7 are only mentioned when the package flags say Pandit Ji offers them. This flow is based on existing Nalkheda online services ([maabaglamukhi.guru](https://maabaglamukhi.guru/blog/baglamukhi-havan-online-booking), [shreeprakash.com](https://shreeprakash.com/maa-baglamukhi-mandir-nalkheda/)).

## Festival calendar

`app.festival_calendar` is platform reference data (seed 006): Sharadiya Navratri 11–19 Oct 2026 (Ashtami and Navami both on 19 Oct), Dussehra 20 Oct 2026, Chaitra Navratri 7–15 Apr 2027 and Baglamukhi Jayanti 13 May 2027. **Add the next year's dates to the seed before they are needed.**

Pandit Ji adds personal dates, such as "mandir band" or a special anushthan, through `/havan/special-dates`. Regional panchangs can differ by a day, so the prompt always leaves the exact muhurat to Pandit Ji.

## Pandit Ji setup (owner API, `/v1/businesses/:bid/havan/...`)

| Endpoint | Purpose |
|---|---|
| `GET/PUT settings` | Pandit Ji's display name and WhatsApp number (validated to E.164), temple information, whether online havan is offered, reminder lead time. |
| `GET packages`, `PUT/DELETE packages/:tier` | The three tiers. `serviceId` links a tier to a bookable service, which sets the calendar duration. Defaults: Vishesh 21 and Maha Vishesh 31 jadi-buti. |
| `GET/POST special-dates`, `DELETE special-dates/:id` | Pandit Ji's own dates. |
| `GET callbacks?status=NEW\|CALLED\|CLOSED\|ALL`, `POST callbacks/:id/status` | The call-back list. |
| `GET bookings`, `POST bookings/:id/dakshina` | Havan bookings with gotra, sankalp and reminders. After the call, Pandit Ji marks dakshina `AGREED_ON_CALL`; the amount is never stored. |

Readiness (publish) checks:

| Check | Severity |
|---|---|
| `HAVAN_PACKAGES`: at least one package linked to a service | required |
| `AVAILABILITY` | required |
| `PANDIT_CONTACT` | recommended |
| `TEMPLE_INFO` | recommended |
| `KNOWLEDGE` | recommended |

Booking also needs Pandit Ji (the bookable resource) linked to the havan service under Business setup → Staff.
