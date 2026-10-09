-- =============================================================================
-- 0021 HAVAN BOOKING (Pandit Ji / PanditSuggest) - ADDITIVE ONLY.
-- Havan packages (Samanya / Vishesh / Maha Vishesh), the Pandit's temple and
-- contact settings, a platform festival calendar, per-booking havan details
-- (gotra, sankalp, online/offline), Pandit call-back requests and scheduled
-- reminders (delivered by the worker through the outbox at their due time).
-- Dakshina is deliberately NOT stored anywhere: it is told only on a call.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Pandit / temple settings (one row per business)
-- -----------------------------------------------------------------------------
CREATE TABLE app.havan_settings (
  business_id            uuid        PRIMARY KEY,
  organization_id        uuid        NOT NULL,
  pandit_display_name    text,
  pandit_whatsapp_e164   text,
  temple_name            text,
  temple_address         text,
  temple_map_url         text,
  darshan_timings        text,
  how_to_reach           text,
  temple_rules           text,
  temple_notes           text,
  online_havan_offered   boolean     NOT NULL DEFAULT true,
  reminder_lead_minutes  integer     NOT NULL DEFAULT 1440,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT havan_settings_business_fk FOREIGN KEY (business_id, organization_id) REFERENCES app.businesses (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT havan_settings_phone_chk   CHECK (pandit_whatsapp_e164 IS NULL OR pandit_whatsapp_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT havan_settings_lead_chk    CHECK (reminder_lead_minutes BETWEEN 30 AND 4320),
  CONSTRAINT havan_settings_url_chk     CHECK (temple_map_url IS NULL OR (temple_map_url ~ '^https://' AND length(temple_map_url) <= 500)),
  CONSTRAINT havan_settings_text_chk    CHECK (length(coalesce(pandit_display_name,'')) <= 100 AND length(coalesce(temple_name,'')) <= 150
                                               AND length(coalesce(temple_address,'')) <= 500 AND length(coalesce(darshan_timings,'')) <= 1000
                                               AND length(coalesce(how_to_reach,'')) <= 2000 AND length(coalesce(temple_rules,'')) <= 2000
                                               AND length(coalesce(temple_notes,'')) <= 2000)
);
SELECT app_admin.attach_updated_at_trigger('app.havan_settings');

-- -----------------------------------------------------------------------------
-- 2. Havan packages: exactly the three tiers the Pandit offers.
--    service_id links a package to a bookable service (calendar duration).
-- -----------------------------------------------------------------------------
CREATE TABLE app.havan_packages (
  id                     uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id        uuid        NOT NULL,
  business_id            uuid        NOT NULL,
  tier                   text        NOT NULL,
  name                   text        NOT NULL,
  description            text,
  herb_count             integer,
  herbs                  text[]      NOT NULL DEFAULT ARRAY[]::text[],
  samagri_notes          text,
  service_id             uuid,
  duration_minutes       integer,
  pandit_count           integer,
  in_person_available    boolean     NOT NULL DEFAULT true,
  online_available       boolean     NOT NULL DEFAULT true,
  online_live_video      boolean     NOT NULL DEFAULT false,
  online_recording       boolean     NOT NULL DEFAULT false,
  online_photos          boolean     NOT NULL DEFAULT false,
  prasad_courier         boolean     NOT NULL DEFAULT false,
  international_courier  boolean     NOT NULL DEFAULT false,
  yajman_preparation     text,
  active                 boolean     NOT NULL DEFAULT true,
  display_order          integer     NOT NULL DEFAULT 100,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  deleted_at             timestamptz,
  CONSTRAINT havan_packages_business_fk FOREIGN KEY (business_id, organization_id) REFERENCES app.businesses (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT havan_packages_service_fk  FOREIGN KEY (service_id, organization_id, business_id)
    REFERENCES app.services (id, organization_id, business_id) ON DELETE SET NULL (service_id),
  CONSTRAINT havan_packages_tier_chk    CHECK (tier IN ('SAMANYA','VISHESH','MAHA_VISHESH')),
  CONSTRAINT havan_packages_name_chk    CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT havan_packages_herbs_chk   CHECK ((herb_count IS NULL OR herb_count BETWEEN 1 AND 108) AND cardinality(herbs) <= 108),
  CONSTRAINT havan_packages_num_chk     CHECK ((duration_minutes IS NULL OR duration_minutes BETWEEN 15 AND 1440) AND (pandit_count IS NULL OR pandit_count BETWEEN 1 AND 51)),
  CONSTRAINT havan_packages_mode_chk    CHECK (in_person_available OR online_available),
  CONSTRAINT havan_packages_text_chk    CHECK (length(coalesce(description,'')) <= 2000 AND length(coalesce(samagri_notes,'')) <= 2000
                                               AND length(coalesce(yajman_preparation,'')) <= 2000)
);
CREATE UNIQUE INDEX havan_packages_tier_uq ON app.havan_packages (business_id, tier) WHERE deleted_at IS NULL;
SELECT app_admin.attach_updated_at_trigger('app.havan_packages');

-- -----------------------------------------------------------------------------
-- 3. Festival calendar. PLATFORM rows (no tenant) are seeded and read-only;
--    a Pandit adds their own special dates (mandir band, vishesh anushthan...)
--    in havan_special_dates.
-- -----------------------------------------------------------------------------
CREATE TABLE app.festival_calendar (
  id           uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  key          text        NOT NULL UNIQUE,
  name         text        NOT NULL,
  kind         text        NOT NULL,
  starts_on    date        NOT NULL,
  ends_on      date        NOT NULL,
  notes        text,
  source       text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT festival_calendar_key_chk   CHECK (key ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  CONSTRAINT festival_calendar_kind_chk  CHECK (kind IN ('NAVRATRI','JAYANTI','FESTIVAL','TITHI')),
  CONSTRAINT festival_calendar_dates_chk CHECK (ends_on >= starts_on AND ends_on - starts_on <= 15)
);

CREATE TABLE app.havan_special_dates (
  id               uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id  uuid        NOT NULL,
  business_id      uuid        NOT NULL,
  name             text        NOT NULL,
  starts_on        date        NOT NULL,
  ends_on          date        NOT NULL,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT havan_special_dates_business_fk FOREIGN KEY (business_id, organization_id) REFERENCES app.businesses (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT havan_special_dates_name_chk  CHECK (length(btrim(name)) BETWEEN 1 AND 120 AND length(coalesce(notes,'')) <= 500),
  CONSTRAINT havan_special_dates_dates_chk CHECK (ends_on >= starts_on AND ends_on - starts_on <= 60)
);
CREATE INDEX havan_special_dates_idx ON app.havan_special_dates (business_id, starts_on);

-- -----------------------------------------------------------------------------
-- 4. Havan details of a booking (kept apart from app.bookings: gotra and
--    sankalp are personal and only the Pandit needs them).
-- -----------------------------------------------------------------------------
CREATE TABLE app.havan_booking_details (
  booking_id          uuid        PRIMARY KEY,
  organization_id     uuid        NOT NULL,
  business_id         uuid        NOT NULL,
  contact_id          uuid        NOT NULL,
  tier                text,
  participation_mode  text        NOT NULL,
  yajman_name         text        NOT NULL,
  gotra               text,
  family_names        text,
  sankalp             text,
  prasad_address      text,
  dakshina_status     text        NOT NULL DEFAULT 'TO_BE_DISCUSSED_ON_CALL',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT havan_booking_details_booking_fk FOREIGN KEY (booking_id, organization_id) REFERENCES app.bookings (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT havan_booking_details_contact_fk FOREIGN KEY (contact_id, organization_id, business_id)
    REFERENCES app.contacts (id, organization_id, business_id) ON DELETE CASCADE,
  CONSTRAINT havan_booking_details_tier_chk   CHECK (tier IS NULL OR tier IN ('SAMANYA','VISHESH','MAHA_VISHESH')),
  CONSTRAINT havan_booking_details_mode_chk   CHECK (participation_mode IN ('NALKHEDA_IN_PERSON','ONLINE_SANKALP')),
  CONSTRAINT havan_booking_details_dak_chk    CHECK (dakshina_status IN ('TO_BE_DISCUSSED_ON_CALL','AGREED_ON_CALL')),
  CONSTRAINT havan_booking_details_text_chk   CHECK (length(btrim(yajman_name)) BETWEEN 1 AND 100 AND length(coalesce(gotra,'')) <= 80
                                                     AND length(coalesce(family_names,'')) <= 500 AND length(coalesce(sankalp,'')) <= 500
                                                     AND length(coalesce(prasad_address,'')) <= 500)
);
CREATE INDEX havan_booking_details_biz_idx ON app.havan_booking_details (organization_id, business_id, created_at DESC);
SELECT app_admin.attach_updated_at_trigger('app.havan_booking_details');

-- -----------------------------------------------------------------------------
-- 5. Pandit call-back requests (dakshina / havan type / guidance). One open
--    request per customer: a second request updates it instead of piling up.
-- -----------------------------------------------------------------------------
CREATE TABLE app.havan_callback_requests (
  id                    uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id       uuid        NOT NULL,
  business_id           uuid        NOT NULL,
  contact_id            uuid        NOT NULL,
  conversation_id       uuid,
  callback_phone_e164   text        NOT NULL,
  preferred_call_time   text,
  reason                text        NOT NULL,
  tier                  text,
  participation_mode    text,
  summary               text,
  status                text        NOT NULL DEFAULT 'NEW',
  idempotency_key       text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  called_at             timestamptz,
  CONSTRAINT havan_callbacks_contact_fk FOREIGN KEY (contact_id, organization_id, business_id)
    REFERENCES app.contacts (id, organization_id, business_id) ON DELETE CASCADE,
  CONSTRAINT havan_callbacks_conversation_fk FOREIGN KEY (conversation_id, organization_id, business_id)
    REFERENCES app.conversations (id, organization_id, business_id) ON DELETE SET NULL (conversation_id),
  CONSTRAINT havan_callbacks_phone_chk  CHECK (callback_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT havan_callbacks_reason_chk CHECK (reason IN ('DAKSHINA','HAVAN_TYPE','BOOKING','GUIDANCE','OTHER')),
  CONSTRAINT havan_callbacks_tier_chk   CHECK (tier IS NULL OR tier IN ('SAMANYA','VISHESH','MAHA_VISHESH','NOT_DECIDED')),
  CONSTRAINT havan_callbacks_mode_chk   CHECK (participation_mode IS NULL OR participation_mode IN ('NALKHEDA_IN_PERSON','ONLINE_SANKALP','NOT_DECIDED')),
  CONSTRAINT havan_callbacks_status_chk CHECK (status IN ('NEW','CALLED','CLOSED')),
  CONSTRAINT havan_callbacks_text_chk   CHECK (length(coalesce(preferred_call_time,'')) <= 100 AND length(coalesce(summary,'')) <= 500)
);
CREATE UNIQUE INDEX havan_callbacks_one_open_uq ON app.havan_callback_requests (business_id, contact_id) WHERE status = 'NEW';
CREATE UNIQUE INDEX havan_callbacks_idem_uq ON app.havan_callback_requests (organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX havan_callbacks_open_idx ON app.havan_callback_requests (organization_id, business_id, created_at DESC) WHERE status = 'NEW';
SELECT app_admin.attach_updated_at_trigger('app.havan_callback_requests');

-- -----------------------------------------------------------------------------
-- 6. Scheduled reminders. Each row gets an outbox event REMINDER_DUE whose
--    available_at is the due time; the worker relay delivers it (WhatsApp to
--    the yajman's own chat, or dashboard notification + WhatsApp to the Pandit).
-- -----------------------------------------------------------------------------
CREATE TABLE app.scheduled_reminders (
  id                    uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id       uuid        NOT NULL,
  business_id           uuid        NOT NULL,
  audience              text        NOT NULL,
  kind                  text        NOT NULL,
  booking_id            uuid,
  callback_request_id   uuid,
  contact_id            uuid,
  conversation_id       uuid,
  due_at                timestamptz NOT NULL,
  message               text        NOT NULL,
  status                text        NOT NULL DEFAULT 'PENDING',
  attempts              integer     NOT NULL DEFAULT 0,
  last_error            text,
  sent_at               timestamptz,
  idempotency_key       text,
  created_by            text        NOT NULL DEFAULT 'AI',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reminders_business_fk FOREIGN KEY (business_id, organization_id) REFERENCES app.businesses (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT reminders_booking_fk  FOREIGN KEY (booking_id, organization_id) REFERENCES app.bookings (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT reminders_callback_fk FOREIGN KEY (callback_request_id) REFERENCES app.havan_callback_requests (id) ON DELETE CASCADE,
  CONSTRAINT reminders_contact_fk  FOREIGN KEY (contact_id, organization_id, business_id)
    REFERENCES app.contacts (id, organization_id, business_id) ON DELETE CASCADE,
  CONSTRAINT reminders_conversation_fk FOREIGN KEY (conversation_id, organization_id, business_id)
    REFERENCES app.conversations (id, organization_id, business_id) ON DELETE SET NULL (conversation_id),
  CONSTRAINT reminders_audience_chk CHECK (audience IN ('YAJMAN','PANDIT')),
  CONSTRAINT reminders_kind_chk     CHECK (kind IN ('BOOKING','CALLBACK','FOLLOW_UP','CUSTOM')),
  CONSTRAINT reminders_status_chk   CHECK (status IN ('PENDING','SENT','FAILED','CANCELLED','SKIPPED')),
  CONSTRAINT reminders_yajman_chk   CHECK (audience <> 'YAJMAN' OR contact_id IS NOT NULL),
  CONSTRAINT reminders_message_chk  CHECK (length(message) BETWEEN 1 AND 1000 AND length(coalesce(last_error,'')) <= 300),
  CONSTRAINT reminders_by_chk       CHECK (created_by IN ('AI','USER','SYSTEM')),
  CONSTRAINT reminders_sent_chk     CHECK (status <> 'SENT' OR sent_at IS NOT NULL)
);
CREATE INDEX reminders_booking_idx ON app.scheduled_reminders (booking_id) WHERE booking_id IS NOT NULL;
CREATE INDEX reminders_due_idx ON app.scheduled_reminders (organization_id, business_id, due_at) WHERE status = 'PENDING';
CREATE UNIQUE INDEX reminders_idem_uq ON app.scheduled_reminders (organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
-- One pending booking reminder per booking and audience.
CREATE UNIQUE INDEX reminders_booking_once_uq ON app.scheduled_reminders (booking_id, audience) WHERE kind = 'BOOKING' AND status = 'PENDING';
SELECT app_admin.attach_updated_at_trigger('app.scheduled_reminders');

-- =============================================================================
-- RLS + GRANTS
-- =============================================================================
SELECT app_admin.apply_tenant_rls(t) FROM unnest(ARRAY[
  'app.havan_settings','app.havan_packages','app.havan_special_dates','app.havan_booking_details',
  'app.havan_callback_requests','app.scheduled_reminders']::regclass[]) AS t;

-- Platform festival calendar: read-only reference data for everyone, written only by seeds (hs_owner).
GRANT SELECT ON app.festival_calendar TO hs_app, hs_worker;

-- Owner dashboard (hs_app): configure packages/settings/dates, work call-backs, see booking details and reminders.
GRANT SELECT, INSERT, UPDATE ON app.havan_settings, app.havan_packages TO hs_app;
GRANT SELECT, INSERT, DELETE ON app.havan_special_dates TO hs_app;
GRANT SELECT, UPDATE ON app.havan_booking_details, app.havan_callback_requests TO hs_app;
GRANT SELECT, INSERT, UPDATE ON app.scheduled_reminders TO hs_app;

-- Assistant runtime + reminder delivery (hs_worker).
GRANT SELECT ON app.havan_settings, app.havan_packages, app.havan_special_dates TO hs_worker;
GRANT SELECT, INSERT, UPDATE ON app.havan_booking_details, app.havan_callback_requests, app.scheduled_reminders TO hs_worker;
