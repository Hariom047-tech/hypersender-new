-- =============================================================================
-- 0025 WHATSAPP MARKETING CAMPAIGNS (consent-first)
--
-- A campaign sends ONE owner-approved message (with {name} personalisation) to
-- customers who already know the business:
--   * the contact has messaged the business before, OR
--   * an opt-in is recorded (START keyword, or the owner recorded consent).
-- Anyone who replies STOP (or asks to be removed) is opted out for good and is
-- never messaged by a campaign again. Uploading unknown / bought lists is not
-- supported by design.
--
-- Sending is paced by the worker (one message per tick, fixed interval, only
-- inside the business's sending hours, daily cap per number with a warm-up for
-- new numbers) and pauses itself when opt-outs or failures climb.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- marketing_contact_prefs: one row per contact that opted in or out.
-- -----------------------------------------------------------------------------
CREATE TABLE app.marketing_contact_prefs (
  id                  uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id     uuid        NOT NULL,
  business_id         uuid        NOT NULL,
  contact_id          uuid        NOT NULL,
  status              text        NOT NULL,
  source              text        NOT NULL,
  note                text,
  changed_by_user_id  uuid        REFERENCES app.users(id) ON DELETE SET NULL,
  changed_at          timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mprefs_contact_fk FOREIGN KEY (contact_id, organization_id, business_id)
    REFERENCES app.contacts (id, organization_id, business_id) ON DELETE CASCADE,
  CONSTRAINT mprefs_contact_uq UNIQUE (contact_id),
  CONSTRAINT mprefs_status_chk CHECK (status IN ('OPTED_IN','OPTED_OUT')),
  CONSTRAINT mprefs_source_chk CHECK (source IN ('KEYWORD','MANUAL','API')),
  -- A manual opt-in must say how the customer agreed (shop counter, website form, ...).
  CONSTRAINT mprefs_manual_note_chk CHECK (NOT (status = 'OPTED_IN' AND source = 'MANUAL') OR length(trim(coalesce(note, ''))) >= 3),
  CONSTRAINT mprefs_note_len_chk CHECK (note IS NULL OR length(note) <= 300)
);
CREATE INDEX mprefs_business_idx ON app.marketing_contact_prefs (business_id, status);
SELECT app_admin.attach_updated_at_trigger('app.marketing_contact_prefs');

-- -----------------------------------------------------------------------------
-- marketing_campaigns
-- -----------------------------------------------------------------------------
CREATE TABLE app.marketing_campaigns (
  id                    uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id       uuid        NOT NULL,
  business_id           uuid        NOT NULL,
  whatsapp_instance_id  uuid        NOT NULL,
  name                  text        NOT NULL,
  message               text        NOT NULL,
  audience              jsonb       NOT NULL DEFAULT '{"type":"ALL"}'::jsonb,
  status                text        NOT NULL DEFAULT 'DRAFT',
  scheduled_at          timestamptz,
  window_start_minute   integer     NOT NULL DEFAULT 540,   -- 09:00 business time
  window_end_minute     integer     NOT NULL DEFAULT 1200,  -- 20:00 business time
  interval_seconds      integer     NOT NULL DEFAULT 30,
  tick_seq              integer     NOT NULL DEFAULT 0,
  waiting_reason        text,
  pause_reason          text,
  recipient_count       integer     NOT NULL DEFAULT 0,
  created_by_user_id    uuid        REFERENCES app.users(id) ON DELETE SET NULL,
  started_at            timestamptz,
  completed_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mcamp_instance_fk FOREIGN KEY (whatsapp_instance_id, organization_id, business_id)
    REFERENCES app.whatsapp_instances (id, organization_id, business_id) ON DELETE CASCADE,
  CONSTRAINT mcamp_id_org_uq UNIQUE (id, organization_id),
  CONSTRAINT mcamp_status_chk CHECK (status IN ('DRAFT','SCHEDULED','SENDING','PAUSED','COMPLETED','CANCELLED')),
  CONSTRAINT mcamp_name_chk CHECK (length(trim(name)) BETWEEN 1 AND 120),
  CONSTRAINT mcamp_message_chk CHECK (length(trim(message)) BETWEEN 5 AND 1500),
  CONSTRAINT mcamp_window_chk CHECK (window_start_minute BETWEEN 0 AND 1439 AND window_end_minute BETWEEN 1 AND 1440
                                     AND window_end_minute - window_start_minute >= 60),
  -- Never faster than one message every 15 seconds.
  CONSTRAINT mcamp_interval_chk CHECK (interval_seconds BETWEEN 15 AND 3600),
  CONSTRAINT mcamp_audience_chk CHECK (jsonb_typeof(audience) = 'object'),
  CONSTRAINT mcamp_reason_len_chk CHECK (length(coalesce(pause_reason, '')) <= 300 AND length(coalesce(waiting_reason, '')) <= 60)
);
CREATE INDEX mcamp_business_idx ON app.marketing_campaigns (business_id, created_at DESC);
SELECT app_admin.attach_updated_at_trigger('app.marketing_campaigns');

-- -----------------------------------------------------------------------------
-- marketing_campaign_recipients: the audience snapshot taken when sending starts.
-- -----------------------------------------------------------------------------
CREATE TABLE app.marketing_campaign_recipients (
  id                uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id   uuid        NOT NULL,
  campaign_id       uuid        NOT NULL,
  business_id       uuid        NOT NULL,
  contact_id        uuid        NOT NULL,
  status            text        NOT NULL DEFAULT 'PENDING',
  conversation_id   uuid,
  message_id        uuid,
  skip_reason       text,
  queued_at         timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mrec_campaign_fk FOREIGN KEY (campaign_id, organization_id)
    REFERENCES app.marketing_campaigns (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT mrec_contact_fk FOREIGN KEY (contact_id, organization_id, business_id)
    REFERENCES app.contacts (id, organization_id, business_id) ON DELETE CASCADE,
  CONSTRAINT mrec_once_uq UNIQUE (campaign_id, contact_id),
  CONSTRAINT mrec_status_chk CHECK (status IN ('PENDING','QUEUED','SKIPPED')),
  CONSTRAINT mrec_queued_chk CHECK (status <> 'QUEUED' OR (message_id IS NOT NULL AND queued_at IS NOT NULL)),
  CONSTRAINT mrec_reason_len_chk CHECK (length(coalesce(skip_reason, '')) <= 60)
);
CREATE INDEX mrec_pending_idx ON app.marketing_campaign_recipients (campaign_id, id) WHERE status = 'PENDING';
CREATE INDEX mrec_campaign_idx ON app.marketing_campaign_recipients (campaign_id, status);
-- Daily cap per number: campaign messages queued today.
CREATE INDEX mrec_queued_idx ON app.marketing_campaign_recipients (business_id, queued_at) WHERE status = 'QUEUED';
SELECT app_admin.attach_updated_at_trigger('app.marketing_campaign_recipients');

-- =============================================================================
-- RLS + GRANTS
-- =============================================================================
SELECT app_admin.apply_tenant_rls(t) FROM unnest(ARRAY[
  'app.marketing_contact_prefs','app.marketing_campaigns','app.marketing_campaign_recipients']::regclass[]) AS t;

-- Dashboard: create/run campaigns, record consent.
GRANT SELECT, INSERT, UPDATE ON app.marketing_contact_prefs, app.marketing_campaigns TO hs_app;
GRANT SELECT, INSERT, UPDATE ON app.marketing_campaign_recipients TO hs_app;
-- Worker: paced delivery + STOP keyword opt-outs from inbound messages.
GRANT SELECT, INSERT, UPDATE ON app.marketing_contact_prefs TO hs_worker;
GRANT SELECT, UPDATE ON app.marketing_campaigns TO hs_worker;
GRANT SELECT, UPDATE ON app.marketing_campaign_recipients TO hs_worker;
