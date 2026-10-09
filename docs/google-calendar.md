# Google Calendar for Pandit Ji

A Pandit connects their own Google Calendar under **Havan → Settings & calendar**. After that:
- **Busy time is blocked.** Whenever the calendar is busy, the assistant does not offer that havan slot, and `CREATE_HAVAN_BOOKING` refuses that time.
- **Bookings become events.** Every havan booking becomes an event in the calendar with yajman, mode, gotra, sankalp and dakshina status. A reschedule moves the event and a cancellation deletes it.
- **Only busy/free is read.** The platform never reads other events' titles or details, because the scope is `calendar.freebusy`. It only writes the events it creates itself (`calendar.events`).

## One-time server setup (administrator)

1. Open https://console.cloud.google.com and create or select a project.
2. Go to **APIs & Services → Library**, find **Google Calendar API** and click **Enable**.
3. Go to **APIs & Services → OAuth consent screen**:
   1. Set User type to External, with an app name (e.g. "PanditSuggest Havan") and a support email.
   2. Add these scopes: `openid`, `email`, `https://www.googleapis.com/auth/calendar.freebusy` and `https://www.googleapis.com/auth/calendar.events`.
   3. While the app is in *Testing*, add each Pandit's Gmail under **Test users**. For everyone to connect, publish the app; Google verification is needed for calendar scopes.
4. Go to **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   1. Set Application type to **Web application**.
   2. Under **Authorized redirect URIs**, add `http://localhost:3100/v1/oauth/google/callback` for local use, plus `https://<your-api-domain>/v1/oauth/google/callback` for production.
5. Put the client ID and secret into the API **and** worker environment (`.env`):

   ```
   GOOGLE_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=xxxxxxxx
   # Only needed when the defaults (localhost) are wrong:
   API_PUBLIC_URL=https://api.example.com         # redirect URI = API_PUBLIC_URL + /v1/oauth/google/callback
   WEB_APP_URL=https://app.example.com            # where the browser returns after connecting
   ```

6. Restart the API and the worker.

Until the variables are set, the dashboard shows the card with a notice and the connect button is disabled.

## What the Pandit does (shown on the settings page)

1. Click **"Google Calendar jodein"**.
2. Sign in with the Google account whose calendar they use on their phone.
3. Allow "See your free/busy" and "View and edit events".
4. They are sent back to the settings page, which now shows **Juda hua** with the account email.

They can disconnect from the same page, which also revokes the token at Google. Access can also be removed at myaccount.google.com → Security → Third-party access; the page then shows the error and asks them to reconnect.

## How it works

| Piece | Where |
|---|---|
| Tables `calendar_connections` (one per business) and `calendar_event_links` (booking ↔ event) | `db/migrations/0022_google_calendar.sql` |
| OAuth (signed 15-minute state), encrypted refresh token, freeBusy, event sync | `src/integrations/google-calendar.ts` |
| Busy filtering and clash check in the havan tools | `src/ai/tools/handlers/havan.ts` (`slots`, `calendarClash`) |
| Event writes | Outbox event `CALENDAR_SYNC`, written in the booking's own transaction. The worker relay calls Google and retries on failure. |
| API | `GET/DELETE /v1/businesses/:bid/havan/google-calendar`, `POST .../google-calendar/connect`, public `GET /v1/oauth/google/callback` |

- **Refresh token storage.** The token is envelope-encrypted with AES-256-GCM, using a per-row data key wrapped by KMS or the local master key and an AAD bound to the organization and business. Access tokens are only kept in memory.
- **When Google cannot be read.** Slots are still offered, marked tentative ("Pandit Ji will confirm"), so a Google outage does not stop bookings.
- **Tests.** `test/havan-booking.test.ts` covers "Pandit Ji's Google Calendar" against a local fake Google server (`test/fakes/fake-google.ts`).
