-- =============================================================================
-- 0010 AUDIT, NOTIFICATIONS, OUTBOX, RETENTION, PRIVACY PROCEDURES
-- =============================================================================

-- -----------------------------------------------------------------------------
-- audit_logs: append-only. organization_id NULL = platform-level event (only
-- writable by hs_owner tooling). No FK to users: audit must survive user
-- anonymisation and keep the original actor id.
-- -----------------------------------------------------------------------------
CREATE TABLE app.audit_logs (
  id                  uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id     uuid        REFERENCES app.organizations(id) ON DELETE RESTRICT,
  actor_type          text        NOT NULL,
  actor_user_id       uuid,
  actor_api_key_id    uuid,
  action              text        NOT NULL,
  resource_type       text        NOT NULL,
  resource_id         uuid,
  ip_address          inet,
  user_agent          text,
  request_id          text,
  metadata            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_logs_v7_chk        CHECK (uuid_extract_version(id) = 7),
  CONSTRAINT audit_logs_actor_chk     CHECK (actor_type IN ('USER','API_KEY','SYSTEM','AI_AGENT','WORKER','PLATFORM_ADMIN')),
  CONSTRAINT audit_logs_action_chk    CHECK (action ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  CONSTRAINT audit_logs_resource_chk  CHECK (resource_type ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  CONSTRAINT audit_logs_ua_chk        CHECK (user_agent IS NULL OR length(user_agent) <= 512),
  CONSTRAINT audit_logs_meta_chk      CHECK (jsonb_typeof(metadata) = 'object'),
  -- Backstop for the application-side redactor: obvious secret-bearing keys
  -- are rejected at the top level of metadata.
  CONSTRAINT audit_logs_no_secrets_chk CHECK (NOT (metadata ?| ARRAY['password','password_hash','secret','api_key',
                                                   'key_hash','token','access_token','refresh_token','credentials',
                                                   'private_key','encrypted_credentials']))
);
CREATE INDEX audit_logs_org_created_idx ON app.audit_logs (organization_id, created_at DESC);
CREATE INDEX audit_logs_resource_idx ON app.audit_logs (organization_id, resource_type, resource_id);

-- -----------------------------------------------------------------------------
-- notifications: per user, per organization. FK to the membership: removing
-- a member removes their notifications of that org, and a notification can
-- never target a user who is not a member.
-- -----------------------------------------------------------------------------
CREATE TABLE app.notifications (
  id               uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id  uuid        NOT NULL,
  user_id          uuid        NOT NULL,
  type             text        NOT NULL,
  title            text        NOT NULL,
  body             text,
  data             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  read_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notifications_member_fk FOREIGN KEY (organization_id, user_id)
    REFERENCES app.organization_members (organization_id, user_id) ON DELETE CASCADE,
  CONSTRAINT notifications_type_chk  CHECK (type ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  CONSTRAINT notifications_title_chk CHECK (length(title) BETWEEN 1 AND 200),
  CONSTRAINT notifications_data_chk  CHECK (jsonb_typeof(data) = 'object')
);
CREATE INDEX notifications_user_idx ON app.notifications (organization_id, user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON app.notifications (user_id, organization_id) WHERE read_at IS NULL;

-- -----------------------------------------------------------------------------
-- outbox_events: transactional outbox. Written in the SAME transaction as the
-- business change; relayed asynchronously (webhooks, AI, usage, search, ...).
-- Claimed with a visibility timeout (available_at pushed forward while
-- PROCESSING), so a crashed relay's events become visible again.
-- -----------------------------------------------------------------------------
CREATE TABLE app.outbox_events (
  id               uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id  uuid        REFERENCES app.organizations(id) ON DELETE RESTRICT,
  event_type       text        NOT NULL,
  aggregate_type   text        NOT NULL,
  aggregate_id     uuid        NOT NULL,
  payload          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status           text        NOT NULL DEFAULT 'PENDING',
  attempts         integer     NOT NULL DEFAULT 0,
  available_at     timestamptz NOT NULL DEFAULT now(),
  locked_by        text,
  last_error       text,
  dedupe_key       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  processed_at     timestamptz,
  CONSTRAINT outbox_events_v7_chk        CHECK (uuid_extract_version(id) = 7),
  CONSTRAINT outbox_events_type_chk      CHECK (event_type ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  CONSTRAINT outbox_events_aggregate_chk CHECK (aggregate_type ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  CONSTRAINT outbox_events_status_chk    CHECK (status IN ('PENDING','PROCESSING','PROCESSED','FAILED','DEAD')),
  CONSTRAINT outbox_events_attempts_chk  CHECK (attempts >= 0),
  CONSTRAINT outbox_events_processed_chk CHECK (status <> 'PROCESSED' OR processed_at IS NOT NULL),
  CONSTRAINT outbox_events_payload_chk   CHECK (jsonb_typeof(payload) = 'object')
);
CREATE INDEX outbox_events_due_idx ON app.outbox_events (available_at) WHERE status IN ('PENDING','PROCESSING','FAILED');
CREATE UNIQUE INDEX outbox_events_dedupe_uq ON app.outbox_events (organization_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

-- -----------------------------------------------------------------------------
-- data_retention_policies: tenant-configurable retention per data category.
-- retention_days NULL = keep until explicitly deleted. Executed by the
-- retention worker; financial records are NOT governed by tenant policies.
-- -----------------------------------------------------------------------------
CREATE TABLE app.data_retention_policies (
  id                  uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id     uuid        NOT NULL REFERENCES app.organizations(id) ON DELETE RESTRICT,
  business_id         uuid,
  data_category       text        NOT NULL,
  retention_days      integer,
  action              text        NOT NULL DEFAULT 'DELETE',
  created_by_user_id  uuid        REFERENCES app.users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT data_retention_policies_business_fk FOREIGN KEY (business_id, organization_id)
    REFERENCES app.businesses (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT data_retention_policies_uq UNIQUE NULLS NOT DISTINCT (organization_id, business_id, data_category),
  CONSTRAINT data_retention_policies_category_chk CHECK (data_category IN (
      'MESSAGES','MESSAGE_MEDIA','AI_RUNS','WEBHOOK_EVENTS','WEBHOOK_DELIVERIES',
      'AUDIT_LOGS','USAGE_EVENTS','INACTIVE_CONTACTS','KNOWLEDGE')),
  CONSTRAINT data_retention_policies_days_chk   CHECK (retention_days IS NULL OR retention_days >= 1),
  CONSTRAINT data_retention_policies_action_chk CHECK (action IN ('DELETE','ANONYMIZE')),
  -- Platform floors: audit >= 1 year, usage (billing evidence) >= 2 years.
  CONSTRAINT data_retention_policies_floor_chk  CHECK (
       (data_category <> 'AUDIT_LOGS'   OR retention_days IS NULL OR retention_days >= 365)
   AND (data_category <> 'USAGE_EVENTS' OR retention_days IS NULL OR retention_days >= 730))
);
SELECT app_admin.attach_updated_at_trigger('app.data_retention_policies');

-- =============================================================================
-- RLS
-- =============================================================================
SELECT app_admin.apply_tenant_rls('app.audit_logs');
SELECT app_admin.apply_tenant_rls('app.notifications');
SELECT app_admin.apply_tenant_rls('app.outbox_events');
SELECT app_admin.apply_tenant_rls('app.data_retention_policies');

-- A user only reads/updates their own notifications (other members' inboxes
-- are private even inside the same organization). Insert stays tenant-wide.
CREATE POLICY notifications_owner_select ON app.notifications AS RESTRICTIVE FOR SELECT TO hs_app
  USING (user_id = (SELECT app.current_user_id()));
CREATE POLICY notifications_owner_update ON app.notifications AS RESTRICTIVE FOR UPDATE TO hs_app
  USING (user_id = (SELECT app.current_user_id()));
CREATE POLICY notifications_owner_delete ON app.notifications AS RESTRICTIVE FOR DELETE TO hs_app
  USING (user_id = (SELECT app.current_user_id()));

-- Outbox relay: claims across tenants, then handles each event under the
-- event's organization context.
CREATE POLICY outbox_events_relay_read ON app.outbox_events FOR SELECT TO hs_worker USING (true);
CREATE POLICY outbox_events_relay_update ON app.outbox_events FOR UPDATE TO hs_worker USING (true) WITH CHECK (true);
CREATE POLICY outbox_events_relay_delete ON app.outbox_events FOR DELETE TO hs_worker USING (status = 'PROCESSED');

-- =============================================================================
-- GRANTS
-- =============================================================================
GRANT SELECT, INSERT ON app.audit_logs TO hs_app, hs_worker;
GRANT SELECT, INSERT, DELETE ON app.notifications TO hs_app;
GRANT UPDATE (read_at) ON app.notifications TO hs_app;
GRANT SELECT, INSERT ON app.notifications TO hs_worker;
GRANT INSERT ON app.outbox_events TO hs_app;
GRANT SELECT, INSERT, DELETE ON app.outbox_events TO hs_worker;
GRANT UPDATE (status, attempts, available_at, locked_by, last_error, processed_at) ON app.outbox_events TO hs_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.data_retention_policies TO hs_app;
GRANT SELECT ON app.data_retention_policies TO hs_worker;

-- =============================================================================
-- PRIVACY PROCEDURES (SECURITY INVOKER: they run under the caller's RLS, so a
-- tenant can only ever affect its own rows)
-- =============================================================================

-- Right-to-erasure for one customer: strips PII from the contact and the text of
-- their messages; keeps row skeletons so bookings/usage/analytics stay
-- consistent. Media objects are queued for deletion via the outbox.
CREATE FUNCTION app.anonymize_contact(p_contact_id uuid) RETURNS void
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  v_org uuid;
BEGIN
  SELECT organization_id INTO v_org FROM app.contacts WHERE id = p_contact_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'contact % not found', p_contact_id USING ERRCODE = 'no_data_found';
  END IF;

  INSERT INTO app.outbox_events (organization_id, event_type, aggregate_type, aggregate_id, payload)
  SELECT v_org, 'MEDIA_PURGE_REQUESTED', 'CONTACT', p_contact_id,
         jsonb_build_object('attachments', coalesce(jsonb_agg(jsonb_build_object(
             'storage_provider', a.storage_provider, 'storage_key', a.storage_key)), '[]'::jsonb))
    FROM app.message_attachments a
    JOIN app.messages m ON m.id = a.message_id
   WHERE m.contact_id = p_contact_id;

  UPDATE app.message_attachments a SET status = 'DELETED', file_name = NULL
    FROM app.messages m
   WHERE m.id = a.message_id AND m.contact_id = p_contact_id;

  UPDATE app.messages
     SET text_body = NULL, raw_metadata = NULL,
         sender_jid = CASE WHEN direction = 'INBOUND' THEN 'anonymized@anonymized.invalid' ELSE sender_jid END,
         recipient_jid = CASE WHEN direction = 'OUTBOUND' THEN 'anonymized@anonymized.invalid' ELSE recipient_jid END
   WHERE contact_id = p_contact_id;

  UPDATE app.bookings
     SET customer_name = 'Anonymized', customer_phone = '+10000000000', customer_email = NULL, notes = NULL
   WHERE contact_id = p_contact_id;

  UPDATE app.contacts
     SET phone_e164 = NULL,
         whatsapp_jid = replace(id::text, '-', '') || '@anonymized.invalid',
         whatsapp_lid = NULL, display_name = NULL, profile_name = NULL, email = NULL,
         metadata = '{}'::jsonb, status = 'ANONYMIZED', deleted_at = now()
   WHERE id = p_contact_id;
END $$;
GRANT EXECUTE ON FUNCTION app.anonymize_contact(uuid) TO hs_app;

-- Hard-delete one conversation and everything that only exists for it.
-- Bookings survive (conversation_id -> NULL); usage/audit survive.
CREATE FUNCTION app.purge_conversation(p_conversation_id uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  v_org uuid;
  v_count integer;
BEGIN
  SELECT organization_id INTO v_org FROM app.conversations WHERE id = p_conversation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation % not found', p_conversation_id USING ERRCODE = 'no_data_found';
  END IF;

  INSERT INTO app.outbox_events (organization_id, event_type, aggregate_type, aggregate_id, payload)
  SELECT v_org, 'MEDIA_PURGE_REQUESTED', 'CONVERSATION', p_conversation_id,
         jsonb_build_object('attachments', coalesce(jsonb_agg(jsonb_build_object(
             'storage_provider', a.storage_provider, 'storage_key', a.storage_key)), '[]'::jsonb))
    FROM app.message_attachments a
    JOIN app.messages m ON m.id = a.message_id
   WHERE m.conversation_id = p_conversation_id;

  DELETE FROM app.ai_runs WHERE conversation_id = p_conversation_id;          -- cascades ai_tool_calls
  UPDATE app.bookings SET conversation_id = NULL WHERE conversation_id = p_conversation_id;
  DELETE FROM app.messages WHERE conversation_id = p_conversation_id;         -- cascades attachments, status events
  GET DIAGNOSTICS v_count = ROW_COUNT;
  DELETE FROM app.conversations WHERE id = p_conversation_id;
  RETURN v_count;
END $$;
GRANT EXECUTE ON FUNCTION app.purge_conversation(uuid) TO hs_app;

-- -----------------------------------------------------------------------------
-- app_admin.purge_organization_data(org): permanent organization deletion.
-- Run by hs_owner from an audited admin job AFTER the grace period.
-- Order matters (RESTRICT FKs make a wrong order fail loudly, never silently).
-- RETAINED: organizations row (tombstone), subscriptions, invoices, payments,
-- usage_events, audit_logs  - statutory / billing evidence.
-- DESTROYED: everything operational, incl. WhatsApp credentials & signal keys.
-- -----------------------------------------------------------------------------
CREATE FUNCTION app_admin.purge_organization_data(p_org uuid) RETURNS void
LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.organizations WHERE id = p_org AND deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'organization % must be soft-deleted before purge', p_org;
  END IF;

  -- 1. Secrets first: auth material, API keys, webhook secrets.
  DELETE FROM app.whatsapp_auth_credentials WHERE organization_id = p_org;   -- cascades signal keys
  DELETE FROM app.api_keys WHERE organization_id = p_org;
  -- 2. Delivery pipeline.
  DELETE FROM app.outbox_events WHERE organization_id = p_org;
  DELETE FROM app.webhook_events WHERE organization_id = p_org;              -- cascades deliveries
  DELETE FROM app.webhook_endpoints WHERE organization_id = p_org;           -- cascades subscriptions, deliveries
  -- 3. AI traces, bookings, knowledge.
  DELETE FROM app.ai_runs WHERE organization_id = p_org;                     -- cascades tool calls
  DELETE FROM app.bookings WHERE organization_id = p_org;                    -- cascades booking events
  DELETE FROM app.knowledge_sources WHERE organization_id = p_org;           -- cascades chunks
  -- 4. Messaging.
  DELETE FROM app.messages WHERE organization_id = p_org;                    -- cascades attachments, status events
  DELETE FROM app.conversations WHERE organization_id = p_org;
  DELETE FROM app.contacts WHERE organization_id = p_org;
  -- 5. Configuration.
  DELETE FROM app.ai_agents WHERE organization_id = p_org;                   -- cascades versions, channels, tools
  DELETE FROM app.availability_exceptions WHERE organization_id = p_org;
  DELETE FROM app.availability_rules WHERE organization_id = p_org;
  DELETE FROM app.resource_services WHERE organization_id = p_org;
  DELETE FROM app.business_resources WHERE organization_id = p_org;
  DELETE FROM app.services WHERE organization_id = p_org;
  DELETE FROM app.whatsapp_instances WHERE organization_id = p_org;          -- cascades instance events
  DELETE FROM app.data_retention_policies WHERE organization_id = p_org;
  DELETE FROM app.notifications WHERE organization_id = p_org;
  DELETE FROM app.business_locations WHERE organization_id = p_org;
  DELETE FROM app.businesses WHERE organization_id = p_org;
  DELETE FROM app.organization_members WHERE organization_id = p_org;

  UPDATE app.organizations SET status = 'CANCELLED', name = 'Deleted organization',
         slug = 'deleted-' || replace(id::text, '-', '')
   WHERE id = p_org;

  INSERT INTO app.audit_logs (organization_id, actor_type, action, resource_type, resource_id, metadata)
  VALUES (p_org, 'SYSTEM', 'ORGANIZATION_PURGED', 'ORGANIZATION', p_org, '{}'::jsonb);
END $$;
