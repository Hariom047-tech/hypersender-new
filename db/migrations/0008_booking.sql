-- =============================================================================
-- 0008 GENERIC BOOKING ENGINE
-- services / business_resources / resource_services / availability_rules /
-- availability_exceptions / bookings / booking_events
-- One model serves clinics, salons, restaurants, hotels, consultants.
-- =============================================================================

CREATE TABLE app.services (
  id                 uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id    uuid        NOT NULL,
  business_id        uuid        NOT NULL,
  location_id        uuid,
  name               text        NOT NULL,
  description        text,
  duration_minutes   integer,
  price_minor_units  bigint,     -- paise / cents; never floating point
  currency           text        NOT NULL,
  active             boolean     NOT NULL DEFAULT true,
  metadata           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  CONSTRAINT services_business_fk FOREIGN KEY (business_id, organization_id)
    REFERENCES app.businesses (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT services_location_fk FOREIGN KEY (location_id, organization_id, business_id)
    REFERENCES app.business_locations (id, organization_id, business_id) ON DELETE SET NULL (location_id),
  CONSTRAINT services_id_org_biz_uq UNIQUE (id, organization_id, business_id),
  CONSTRAINT services_name_chk      CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT services_duration_chk  CHECK (duration_minutes IS NULL OR duration_minutes BETWEEN 1 AND 1440),
  CONSTRAINT services_price_chk     CHECK (price_minor_units IS NULL OR price_minor_units >= 0),
  CONSTRAINT services_currency_chk  CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT services_meta_chk      CHECK (jsonb_typeof(metadata) = 'object')
);
CREATE INDEX services_org_biz_idx ON app.services (organization_id, business_id) WHERE deleted_at IS NULL;
SELECT app_admin.attach_updated_at_trigger('app.services');

CREATE TABLE app.business_resources (
  id               uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id  uuid        NOT NULL,
  business_id      uuid        NOT NULL,
  location_id      uuid,
  resource_type    text        NOT NULL,   -- DOCTOR, DENTIST, STYLIST, TABLE, ROOM, EQUIPMENT, ...
  name             text        NOT NULL,
  description      text,
  capacity         integer     NOT NULL DEFAULT 1,  -- e.g. seats at a table
  active           boolean     NOT NULL DEFAULT true,
  metadata         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  CONSTRAINT business_resources_business_fk FOREIGN KEY (business_id, organization_id)
    REFERENCES app.businesses (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT business_resources_location_fk FOREIGN KEY (location_id, organization_id, business_id)
    REFERENCES app.business_locations (id, organization_id, business_id) ON DELETE SET NULL (location_id),
  CONSTRAINT business_resources_id_org_biz_uq UNIQUE (id, organization_id, business_id),
  CONSTRAINT business_resources_type_chk     CHECK (resource_type ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  CONSTRAINT business_resources_name_chk     CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT business_resources_capacity_chk CHECK (capacity >= 1),
  CONSTRAINT business_resources_meta_chk     CHECK (jsonb_typeof(metadata) = 'object')
);
CREATE INDEX business_resources_org_biz_idx ON app.business_resources (organization_id, business_id, resource_type)
  WHERE deleted_at IS NULL;
SELECT app_admin.attach_updated_at_trigger('app.business_resources');

-- Which resource (doctor / stylist / room) can deliver which service.
CREATE TABLE app.resource_services (
  organization_id  uuid        NOT NULL,
  business_id      uuid        NOT NULL,
  resource_id      uuid        NOT NULL,
  service_id       uuid        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (resource_id, service_id),
  CONSTRAINT resource_services_resource_fk FOREIGN KEY (resource_id, organization_id, business_id)
    REFERENCES app.business_resources (id, organization_id, business_id) ON DELETE CASCADE,
  CONSTRAINT resource_services_service_fk FOREIGN KEY (service_id, organization_id, business_id)
    REFERENCES app.services (id, organization_id, business_id) ON DELETE CASCADE
);
CREATE INDEX resource_services_service_idx ON app.resource_services (service_id);

-- Weekly recurring opening hours. ISO day_of_week: 1 = Monday .. 7 = Sunday.
-- Wall-clock times interpreted in `timezone`; an overnight shift is two rules.
-- resource_id NULL = business/location-wide hours.
CREATE TABLE app.availability_rules (
  id               uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id  uuid        NOT NULL,
  business_id      uuid        NOT NULL,
  resource_id      uuid,
  location_id      uuid,
  day_of_week      smallint    NOT NULL,
  start_time       time        NOT NULL,
  end_time         time        NOT NULL,
  timezone         text        NOT NULL,
  effective_from   date,
  effective_until  date,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT availability_rules_business_fk FOREIGN KEY (business_id, organization_id)
    REFERENCES app.businesses (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT availability_rules_resource_fk FOREIGN KEY (resource_id, organization_id, business_id)
    REFERENCES app.business_resources (id, organization_id, business_id) ON DELETE CASCADE,
  CONSTRAINT availability_rules_location_fk FOREIGN KEY (location_id, organization_id, business_id)
    REFERENCES app.business_locations (id, organization_id, business_id) ON DELETE CASCADE,
  CONSTRAINT availability_rules_dow_chk    CHECK (day_of_week BETWEEN 1 AND 7),
  CONSTRAINT availability_rules_time_chk   CHECK (start_time < end_time),
  CONSTRAINT availability_rules_tz_chk     CHECK (app.is_valid_timezone(timezone)),
  CONSTRAINT availability_rules_range_chk  CHECK (effective_from IS NULL OR effective_until IS NULL OR effective_from <= effective_until)
);
CREATE INDEX availability_rules_lookup_idx ON app.availability_rules (organization_id, business_id, resource_id, day_of_week);
SELECT app_admin.attach_updated_at_trigger('app.availability_rules');

-- One-off overrides: holidays, leave, special openings, blocked slots.
CREATE TABLE app.availability_exceptions (
  id               uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id  uuid        NOT NULL,
  business_id      uuid        NOT NULL,
  resource_id      uuid,
  location_id      uuid,
  start_at         timestamptz NOT NULL,
  end_at           timestamptz NOT NULL,
  type             text        NOT NULL,
  reason           text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT availability_exceptions_business_fk FOREIGN KEY (business_id, organization_id)
    REFERENCES app.businesses (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT availability_exceptions_resource_fk FOREIGN KEY (resource_id, organization_id, business_id)
    REFERENCES app.business_resources (id, organization_id, business_id) ON DELETE CASCADE,
  CONSTRAINT availability_exceptions_location_fk FOREIGN KEY (location_id, organization_id, business_id)
    REFERENCES app.business_locations (id, organization_id, business_id) ON DELETE CASCADE,
  CONSTRAINT availability_exceptions_range_chk CHECK (start_at < end_at),
  CONSTRAINT availability_exceptions_type_chk  CHECK (type IN ('HOLIDAY','LEAVE','SPECIAL_OPENING','BLOCKED'))
);
CREATE INDEX availability_exceptions_lookup_idx ON app.availability_exceptions (organization_id, business_id, start_at);
CREATE INDEX availability_exceptions_resource_idx ON app.availability_exceptions (resource_id, start_at) WHERE resource_id IS NOT NULL;
SELECT app_admin.attach_updated_at_trigger('app.availability_exceptions');

-- -----------------------------------------------------------------------------
-- bookings: generic appointment / reservation.
-- Double booking is prevented IN THE DATABASE by an exclusion constraint:
-- two live (PENDING/CONFIRMED) bookings of one resource can never overlap,
-- no matter how many API/AI workers race. The loser gets SQLSTATE 23P01.
-- -----------------------------------------------------------------------------
CREATE TABLE app.bookings (
  id                           uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id              uuid        NOT NULL,
  business_id                  uuid        NOT NULL,
  location_id                  uuid,
  contact_id                   uuid        NOT NULL,
  service_id                   uuid,
  resource_id                  uuid,
  conversation_id              uuid,
  ai_agent_id                  uuid,
  rescheduled_from_booking_id  uuid,
  booking_type                 text        NOT NULL DEFAULT 'APPOINTMENT',
  status                       text        NOT NULL DEFAULT 'PENDING',
  start_at                     timestamptz NOT NULL,
  end_at                       timestamptz NOT NULL,
  timezone                     text        NOT NULL,
  customer_name                text        NOT NULL,
  customer_phone               text        NOT NULL,
  customer_email               text,
  party_size                   integer,
  notes                        text,
  metadata                     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  source                       text        NOT NULL,
  created_by_type              text        NOT NULL,
  created_by_user_id           uuid        REFERENCES app.users(id) ON DELETE SET NULL,
  -- AI tools pass "<ai_run_id>:<tool_call_id>"; API clients pass their own key.
  idempotency_key              text,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  cancelled_at                 timestamptz,
  CONSTRAINT bookings_contact_fk FOREIGN KEY (contact_id, organization_id, business_id)
    REFERENCES app.contacts (id, organization_id, business_id) ON DELETE RESTRICT,
  CONSTRAINT bookings_service_fk FOREIGN KEY (service_id, organization_id, business_id)
    REFERENCES app.services (id, organization_id, business_id) ON DELETE SET NULL (service_id),
  -- A booking's resource is essential for scheduling; resources are soft-deleted.
  CONSTRAINT bookings_resource_fk FOREIGN KEY (resource_id, organization_id, business_id)
    REFERENCES app.business_resources (id, organization_id, business_id) ON DELETE RESTRICT,
  CONSTRAINT bookings_location_fk FOREIGN KEY (location_id, organization_id, business_id)
    REFERENCES app.business_locations (id, organization_id, business_id) ON DELETE SET NULL (location_id),
  CONSTRAINT bookings_conversation_fk FOREIGN KEY (conversation_id, organization_id, business_id)
    REFERENCES app.conversations (id, organization_id, business_id) ON DELETE SET NULL (conversation_id),
  CONSTRAINT bookings_ai_agent_fk FOREIGN KEY (ai_agent_id, organization_id, business_id)
    REFERENCES app.ai_agents (id, organization_id, business_id) ON DELETE SET NULL (ai_agent_id),
  CONSTRAINT bookings_rescheduled_fk FOREIGN KEY (rescheduled_from_booking_id, organization_id)
    REFERENCES app.bookings (id, organization_id) ON DELETE SET NULL (rescheduled_from_booking_id),
  CONSTRAINT bookings_id_org_uq       UNIQUE (id, organization_id),
  CONSTRAINT bookings_type_chk        CHECK (booking_type ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  CONSTRAINT bookings_status_chk      CHECK (status IN ('PENDING','CONFIRMED','COMPLETED','CANCELLED','NO_SHOW','RESCHEDULED')),
  CONSTRAINT bookings_source_chk      CHECK (source IN ('AI_WHATSAPP','HUMAN','DASHBOARD','API')),
  CONSTRAINT bookings_creator_chk     CHECK (created_by_type IN ('AI','USER','CUSTOMER','API','SYSTEM')),
  CONSTRAINT bookings_creator_user_chk CHECK (created_by_type <> 'USER' OR created_by_user_id IS NOT NULL),
  CONSTRAINT bookings_creator_ai_chk  CHECK (created_by_type <> 'AI' OR ai_agent_id IS NOT NULL),
  CONSTRAINT bookings_range_chk       CHECK (start_at < end_at AND end_at - start_at <= interval '31 days'),
  CONSTRAINT bookings_tz_chk          CHECK (app.is_valid_timezone(timezone)),
  CONSTRAINT bookings_phone_chk       CHECK (customer_phone ~ '^\+[1-9][0-9]{6,14}$'),
  CONSTRAINT bookings_email_chk       CHECK (customer_email IS NULL OR customer_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  CONSTRAINT bookings_party_chk       CHECK (party_size IS NULL OR party_size BETWEEN 1 AND 10000),
  CONSTRAINT bookings_cancelled_chk   CHECK (status <> 'CANCELLED' OR cancelled_at IS NOT NULL),
  CONSTRAINT bookings_meta_chk        CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT bookings_no_overlap EXCLUDE USING gist (
    resource_id WITH =,
    tstzrange(start_at, end_at, '[)') WITH &&
  ) WHERE (resource_id IS NOT NULL AND status IN ('PENDING','CONFIRMED'))
);
CREATE INDEX bookings_calendar_idx ON app.bookings (organization_id, business_id, start_at);
CREATE INDEX bookings_resource_idx ON app.bookings (resource_id, start_at, status) WHERE resource_id IS NOT NULL;
CREATE INDEX bookings_contact_idx ON app.bookings (contact_id, start_at DESC);
CREATE INDEX bookings_conversation_idx ON app.bookings (conversation_id) WHERE conversation_id IS NOT NULL;
CREATE UNIQUE INDEX bookings_idempotency_uq ON app.bookings (organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
SELECT app_admin.attach_updated_at_trigger('app.bookings');

CREATE TABLE app.booking_events (
  id                    uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id       uuid        NOT NULL,
  booking_id            uuid        NOT NULL,
  event_type            text        NOT NULL,
  old_start_at          timestamptz,
  new_start_at          timestamptz,
  performed_by_type     text        NOT NULL,
  performed_by_user_id  uuid        REFERENCES app.users(id) ON DELETE SET NULL,
  metadata              jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT booking_events_booking_fk FOREIGN KEY (booking_id, organization_id)
    REFERENCES app.bookings (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT booking_events_type_chk   CHECK (event_type IN ('CREATED','CONFIRMED','RESCHEDULED','CANCELLED','COMPLETED',
                                                             'NO_SHOW','UPDATED','REMINDER_SENT')),
  CONSTRAINT booking_events_actor_chk  CHECK (performed_by_type IN ('AI','USER','CUSTOMER','API','SYSTEM')),
  CONSTRAINT booking_events_meta_chk   CHECK (jsonb_typeof(metadata) = 'object')
);
CREATE INDEX booking_events_booking_idx ON app.booking_events (booking_id, created_at);

-- =============================================================================
-- RLS + GRANTS
-- =============================================================================
SELECT app_admin.apply_tenant_rls('app.services');
SELECT app_admin.apply_tenant_rls('app.business_resources');
SELECT app_admin.apply_tenant_rls('app.resource_services');
SELECT app_admin.apply_tenant_rls('app.availability_rules');
SELECT app_admin.apply_tenant_rls('app.availability_exceptions');
SELECT app_admin.apply_tenant_rls('app.bookings');
SELECT app_admin.apply_tenant_rls('app.booking_events');

GRANT SELECT, INSERT, UPDATE ON app.services, app.business_resources TO hs_app;
GRANT SELECT ON app.services, app.business_resources TO hs_worker;
GRANT SELECT, INSERT, DELETE ON app.resource_services TO hs_app;
GRANT SELECT ON app.resource_services TO hs_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.availability_rules, app.availability_exceptions TO hs_app;
GRANT SELECT ON app.availability_rules, app.availability_exceptions TO hs_worker;
-- AI tool execution happens in the worker; bookings are never deleted (cancel instead).
GRANT SELECT, INSERT, UPDATE ON app.bookings TO hs_app, hs_worker;
GRANT SELECT, INSERT ON app.booking_events TO hs_app, hs_worker;
