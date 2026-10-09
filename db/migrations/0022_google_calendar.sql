-- =============================================================================
-- 0022 GOOGLE CALENDAR (Pandit Ji's own calendar) - ADDITIVE ONLY.
-- One connected Google calendar per business. Busy time on it hides havan
-- slots; every havan booking is written to it as an event (worker, outbox).
-- The OAuth refresh token is envelope-encrypted (AES-256-GCM, per-row data
-- key wrapped by KMS / the local master key) - it is never stored in clear.
-- =============================================================================

CREATE TABLE app.calendar_connections (
  business_id            uuid        PRIMARY KEY,
  organization_id        uuid        NOT NULL,
  provider               text        NOT NULL DEFAULT 'GOOGLE',
  account_email          text,
  calendar_id            text        NOT NULL DEFAULT 'primary',
  refresh_token_enc      bytea       NOT NULL,
  wrapped_key            bytea       NOT NULL,
  key_reference          text        NOT NULL,
  status                 text        NOT NULL DEFAULT 'ACTIVE',
  last_error             text,
  last_synced_at         timestamptz,
  connected_by_user_id   uuid        REFERENCES app.users(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT calendar_connections_business_fk FOREIGN KEY (business_id, organization_id) REFERENCES app.businesses (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT calendar_connections_provider_chk CHECK (provider IN ('GOOGLE')),
  CONSTRAINT calendar_connections_status_chk   CHECK (status IN ('ACTIVE','ERROR')),
  CONSTRAINT calendar_connections_text_chk     CHECK (length(coalesce(account_email,'')) <= 320 AND length(calendar_id) BETWEEN 1 AND 300
                                                      AND length(coalesce(last_error,'')) <= 300)
);
SELECT app_admin.attach_updated_at_trigger('app.calendar_connections');

-- Which calendar event belongs to which booking (rescheduling makes a new booking id).
CREATE TABLE app.calendar_event_links (
  booking_id         uuid        PRIMARY KEY,
  organization_id    uuid        NOT NULL,
  business_id        uuid        NOT NULL,
  provider_event_id  text        NOT NULL,
  calendar_id        text        NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT calendar_event_links_booking_fk FOREIGN KEY (booking_id, organization_id) REFERENCES app.bookings (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT calendar_event_links_text_chk CHECK (length(provider_event_id) BETWEEN 1 AND 1024 AND length(calendar_id) BETWEEN 1 AND 300)
);
SELECT app_admin.attach_updated_at_trigger('app.calendar_event_links');

SELECT app_admin.apply_tenant_rls(t) FROM unnest(ARRAY['app.calendar_connections','app.calendar_event_links']::regclass[]) AS t;

-- Dashboard (hs_app): connect / disconnect / status.
GRANT SELECT, INSERT, UPDATE, DELETE ON app.calendar_connections TO hs_app;
GRANT SELECT ON app.calendar_event_links TO hs_app;
-- Worker (hs_worker): read the connection, record errors, keep booking <-> event links.
GRANT SELECT, UPDATE (status, last_error, last_synced_at) ON app.calendar_connections TO hs_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.calendar_event_links TO hs_worker;
