-- =============================================================================
-- 0005 CONTACTS, CONVERSATIONS, MESSAGES
-- =============================================================================

-- -----------------------------------------------------------------------------
-- contacts: a customer AS SEEN BY ONE BUSINESS. The same human in two
-- organizations is two unrelated rows; there is no global identity/merge.
-- -----------------------------------------------------------------------------
CREATE TABLE app.contacts (
  id               uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id  uuid        NOT NULL,
  business_id      uuid        NOT NULL,
  phone_e164       text,
  whatsapp_jid     text        NOT NULL,
  whatsapp_lid     text,       -- WhatsApp "LID" privacy identifier, when the provider exposes it
  display_name     text,
  profile_name     text,
  email            text,
  source           text        NOT NULL DEFAULT 'WHATSAPP_INBOUND',
  status           text        NOT NULL DEFAULT 'ACTIVE',
  metadata         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  CONSTRAINT contacts_business_fk FOREIGN KEY (business_id, organization_id)
    REFERENCES app.businesses (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT contacts_id_org_uq     UNIQUE (id, organization_id),
  CONSTRAINT contacts_id_org_biz_uq UNIQUE (id, organization_id, business_id),
  CONSTRAINT contacts_phone_chk     CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  CONSTRAINT contacts_jid_chk       CHECK (whatsapp_jid ~ '^[^@\s]+@[a-z.]+$' AND length(whatsapp_jid) <= 128),
  CONSTRAINT contacts_email_chk     CHECK (email IS NULL OR email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  CONSTRAINT contacts_source_chk    CHECK (source IN ('WHATSAPP_INBOUND','WHATSAPP_OUTBOUND','MANUAL','IMPORT','API','BOOKING')),
  CONSTRAINT contacts_status_chk    CHECK (status IN ('ACTIVE','BLOCKED','ARCHIVED','ANONYMIZED')),
  CONSTRAINT contacts_meta_chk      CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT contacts_seen_chk      CHECK (last_seen_at >= first_seen_at)
);
-- Identity + ingestion upsert target: one live contact per business per JID.
CREATE UNIQUE INDEX contacts_business_jid_uq ON app.contacts (business_id, whatsapp_jid) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX contacts_business_lid_uq ON app.contacts (business_id, whatsapp_lid)
  WHERE whatsapp_lid IS NOT NULL AND deleted_at IS NULL;
-- CRM lookup by phone.
CREATE INDEX contacts_org_biz_phone_idx ON app.contacts (organization_id, business_id, phone_e164) WHERE deleted_at IS NULL;
SELECT app_admin.attach_updated_at_trigger('app.contacts');

-- -----------------------------------------------------------------------------
-- conversations: the inbox thread between one contact and one WA instance.
-- -----------------------------------------------------------------------------
CREATE TABLE app.conversations (
  id                    uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id       uuid        NOT NULL,
  business_id           uuid        NOT NULL,
  whatsapp_instance_id  uuid        NOT NULL,
  contact_id            uuid        NOT NULL,
  status                text        NOT NULL DEFAULT 'OPEN',
  handling_mode         text        NOT NULL DEFAULT 'AI',
  assigned_user_id      uuid,
  assigned_ai_agent_id  uuid,       -- FK added in 0006
  last_message_at       timestamptz NOT NULL DEFAULT now(),
  last_inbound_at       timestamptz,
  last_outbound_at      timestamptz,
  unread_count          integer     NOT NULL DEFAULT 0,
  ai_paused_until       timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  closed_at             timestamptz,
  -- Instance and contact must belong to the SAME business of the SAME tenant.
  CONSTRAINT conversations_instance_fk FOREIGN KEY (whatsapp_instance_id, organization_id, business_id)
    REFERENCES app.whatsapp_instances (id, organization_id, business_id) ON DELETE RESTRICT,
  CONSTRAINT conversations_contact_fk FOREIGN KEY (contact_id, organization_id, business_id)
    REFERENCES app.contacts (id, organization_id, business_id) ON DELETE RESTRICT,
  -- Only a member of this organization can be assigned (not merely any user).
  CONSTRAINT conversations_assignee_fk FOREIGN KEY (organization_id, assigned_user_id)
    REFERENCES app.organization_members (organization_id, user_id) ON DELETE SET NULL (assigned_user_id),
  CONSTRAINT conversations_id_org_uq          UNIQUE (id, organization_id),
  CONSTRAINT conversations_id_org_biz_uq      UNIQUE (id, organization_id, business_id),
  CONSTRAINT conversations_id_org_biz_inst_uq UNIQUE (id, organization_id, business_id, whatsapp_instance_id),
  CONSTRAINT conversations_status_chk  CHECK (status IN ('OPEN','WAITING','RESOLVED','CLOSED')),
  CONSTRAINT conversations_mode_chk    CHECK (handling_mode IN ('AI','HUMAN','HYBRID','PAUSED')),
  CONSTRAINT conversations_unread_chk  CHECK (unread_count >= 0),
  CONSTRAINT conversations_closed_chk  CHECK (status <> 'CLOSED' OR closed_at IS NOT NULL)
);
-- One non-closed thread per (instance, contact): ingestion upsert target, and
-- serves "instance_id + contact_id" lookups.
CREATE UNIQUE INDEX conversations_active_thread_uq ON app.conversations (whatsapp_instance_id, contact_id)
  WHERE status <> 'CLOSED';
-- Inbox: newest activity first, filtered by status.
CREATE INDEX conversations_inbox_idx ON app.conversations (organization_id, status, last_message_at DESC);
CREATE INDEX conversations_business_inbox_idx ON app.conversations (business_id, status, last_message_at DESC);
-- "My conversations".
CREATE INDEX conversations_assignee_idx ON app.conversations (assigned_user_id, status, last_message_at DESC)
  WHERE assigned_user_id IS NOT NULL;
-- Contact history + FK support for contact deletion.
CREATE INDEX conversations_contact_idx ON app.conversations (contact_id);
SELECT app_admin.attach_updated_at_trigger('app.conversations');

-- -----------------------------------------------------------------------------
-- messages: largest table. Append-heavy; UUIDv7 ids enforced so the table can
-- later be RANGE-partitioned on id (time-ordered) without changing any FK or
-- application semantics - see docs/architecture.md "Scaling".
-- -----------------------------------------------------------------------------
CREATE TABLE app.messages (
  id                    uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id       uuid        NOT NULL,
  business_id           uuid        NOT NULL,
  whatsapp_instance_id  uuid        NOT NULL,
  conversation_id       uuid        NOT NULL,
  contact_id            uuid,
  -- Provider id (Baileys key.id). NULL only while an outbound message is QUEUED
  -- and the provider has not assigned one.
  provider_message_id   text,
  -- Caller-supplied idempotency key for outbound sends (API / AI / dashboard).
  idempotency_key       text,
  direction             text        NOT NULL,
  sender_jid            text        NOT NULL,
  recipient_jid         text        NOT NULL,
  message_type          text        NOT NULL,
  text_body             text,
  reply_to_message_id   uuid,
  provider_timestamp    timestamptz,
  -- Sort key for threads: provider time when known, else creation time.
  message_timestamp     timestamptz GENERATED ALWAYS AS (coalesce(provider_timestamp, created_at)) STORED,
  status                text        NOT NULL,
  status_updated_at     timestamptz NOT NULL DEFAULT now(),
  from_me               boolean     NOT NULL,
  is_ai_generated       boolean     NOT NULL DEFAULT false,
  ai_agent_id           uuid,       -- FK added in 0006
  sent_by_user_id       uuid        REFERENCES app.users(id) ON DELETE SET NULL,
  error_code            text,
  error_message         text,
  raw_metadata          jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  -- One constraint pins org + business + instance consistency with the thread.
  CONSTRAINT messages_conversation_fk FOREIGN KEY (conversation_id, organization_id, business_id, whatsapp_instance_id)
    REFERENCES app.conversations (id, organization_id, business_id, whatsapp_instance_id) ON DELETE RESTRICT,
  CONSTRAINT messages_contact_fk FOREIGN KEY (contact_id, organization_id, business_id)
    REFERENCES app.contacts (id, organization_id, business_id) ON DELETE RESTRICT,
  CONSTRAINT messages_reply_fk FOREIGN KEY (reply_to_message_id, organization_id)
    REFERENCES app.messages (id, organization_id) ON DELETE SET NULL (reply_to_message_id),
  CONSTRAINT messages_id_org_uq      UNIQUE (id, organization_id),
  CONSTRAINT messages_v7_chk         CHECK (uuid_extract_version(id) = 7),
  CONSTRAINT messages_direction_chk  CHECK (direction IN ('INBOUND','OUTBOUND')),
  CONSTRAINT messages_type_chk       CHECK (message_type IN ('TEXT','IMAGE','VIDEO','AUDIO','VOICE','DOCUMENT','LOCATION',
                                                            'CONTACT','REACTION','POLL','STICKER','UNKNOWN')),
  CONSTRAINT messages_status_chk     CHECK (
       (direction = 'INBOUND'  AND status IN ('RECEIVED','READ','REVOKED'))
    OR (direction = 'OUTBOUND' AND status IN ('QUEUED','SENT','DELIVERED','READ','FAILED','REVOKED'))),
  CONSTRAINT messages_from_me_chk    CHECK ((direction = 'OUTBOUND') = from_me),
  CONSTRAINT messages_inbound_ids_chk CHECK (direction = 'OUTBOUND' OR (provider_message_id IS NOT NULL AND provider_timestamp IS NOT NULL)),
  CONSTRAINT messages_sent_ids_chk   CHECK (status IN ('QUEUED','FAILED') OR provider_message_id IS NOT NULL),
  CONSTRAINT messages_ai_chk         CHECK (NOT is_ai_generated OR (ai_agent_id IS NOT NULL AND direction = 'OUTBOUND')),
  CONSTRAINT messages_body_len_chk   CHECK (text_body IS NULL OR length(text_body) <= 65536),
  CONSTRAINT messages_pmid_len_chk   CHECK (provider_message_id IS NULL OR length(provider_message_id) BETWEEN 1 AND 256),
  CONSTRAINT messages_idem_len_chk   CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 200)
);
-- IDEMPOTENCY: the same provider message on the same instance is stored once.
-- (Scoped to the instance; provider ids are NOT assumed globally unique.)
CREATE UNIQUE INDEX messages_instance_provider_id_uq ON app.messages (whatsapp_instance_id, provider_message_id);
-- Outbound send idempotency (API retries, AI worker retries).
CREATE UNIQUE INDEX messages_org_idempotency_uq ON app.messages (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
-- Thread rendering / pagination (keyset on (message_timestamp, id)).
CREATE INDEX messages_conversation_ts_idx ON app.messages (conversation_id, message_timestamp DESC, id DESC);
-- FK support (parent deletes would otherwise seq-scan this huge table).
CREATE INDEX messages_contact_idx ON app.messages (contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX messages_reply_idx ON app.messages (reply_to_message_id) WHERE reply_to_message_id IS NOT NULL;
-- Retention purges / exports scan by time: BRIN is ~1000x smaller than B-tree
-- and effective because UUIDv7 + created_at are insert-ordered.
CREATE INDEX messages_created_brin ON app.messages USING brin (created_at);
SELECT app_admin.attach_updated_at_trigger('app.messages');

-- Status only moves forward (receipts arrive out of order / duplicated).
CREATE FUNCTION app.message_status_rank(p_status text) RETURNS integer
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE p_status
    WHEN 'QUEUED' THEN 10 WHEN 'RECEIVED' THEN 10
    WHEN 'SENT' THEN 20 WHEN 'DELIVERED' THEN 30 WHEN 'READ' THEN 40
    WHEN 'FAILED' THEN 50 WHEN 'REVOKED' THEN 60 ELSE 0 END
$$;
GRANT EXECUTE ON FUNCTION app.message_status_rank(text) TO hs_app, hs_worker;

-- -----------------------------------------------------------------------------
-- message_status_events: delivery/read timeline (append-only, deduplicated).
-- -----------------------------------------------------------------------------
CREATE TABLE app.message_status_events (
  id                  uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id     uuid        NOT NULL,
  message_id          uuid        NOT NULL,
  status              text        NOT NULL,
  provider_timestamp  timestamptz,
  metadata            jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- Timeline has no value without the message.
  CONSTRAINT message_status_events_message_fk FOREIGN KEY (message_id, organization_id)
    REFERENCES app.messages (id, organization_id) ON DELETE CASCADE,
  -- Duplicate receipts collapse (ON CONFLICT DO NOTHING); also the lookup index.
  CONSTRAINT message_status_events_uq         UNIQUE (message_id, status),
  CONSTRAINT message_status_events_v7_chk     CHECK (uuid_extract_version(id) = 7),
  CONSTRAINT message_status_events_status_chk CHECK (status IN ('RECEIVED','QUEUED','SENT','DELIVERED','READ','FAILED','REVOKED'))
);

-- -----------------------------------------------------------------------------
-- message_attachments: metadata only. Bytes live in private object storage.
-- -----------------------------------------------------------------------------
CREATE TABLE app.message_attachments (
  id                uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id   uuid        NOT NULL,
  message_id        uuid        NOT NULL,
  media_type        text        NOT NULL,
  mime_type         text        NOT NULL,
  file_name         text,
  file_size         bigint,
  storage_provider  text        NOT NULL,
  -- Object key inside a PRIVATE bucket (never a public URL). Convention:
  -- org/<organization_id>/msg/<message_id>/<attachment_id>
  storage_key       text        NOT NULL,
  sha256            bytea,
  status            text        NOT NULL DEFAULT 'PENDING',
  expires_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT message_attachments_message_fk FOREIGN KEY (message_id, organization_id)
    REFERENCES app.messages (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT message_attachments_storage_uq  UNIQUE (storage_provider, storage_key),
  CONSTRAINT message_attachments_media_chk   CHECK (media_type IN ('IMAGE','VIDEO','AUDIO','VOICE','DOCUMENT','STICKER')),
  CONSTRAINT message_attachments_mime_chk    CHECK (mime_type ~ '^[a-z]+/[a-zA-Z0-9.+\-]+' AND length(mime_type) <= 255),
  CONSTRAINT message_attachments_size_chk    CHECK (file_size IS NULL OR file_size >= 0),
  CONSTRAINT message_attachments_provider_chk CHECK (storage_provider IN ('S3','GCS','R2','AZURE_BLOB','LOCAL_DEV')),
  CONSTRAINT message_attachments_key_chk     CHECK (storage_key !~* '^[a-z]+://' AND length(storage_key) BETWEEN 1 AND 1024),
  CONSTRAINT message_attachments_sha_chk     CHECK (sha256 IS NULL OR octet_length(sha256) = 32),
  CONSTRAINT message_attachments_status_chk  CHECK (status IN ('PENDING','STORED','FAILED','EXPIRED','DELETED'))
);
CREATE INDEX message_attachments_message_idx ON app.message_attachments (message_id);
SELECT app_admin.attach_updated_at_trigger('app.message_attachments');

-- =============================================================================
-- RLS + GRANTS
-- =============================================================================
SELECT app_admin.apply_tenant_rls('app.contacts');
SELECT app_admin.apply_tenant_rls('app.conversations');
SELECT app_admin.apply_tenant_rls('app.messages');
SELECT app_admin.apply_tenant_rls('app.message_status_events');
SELECT app_admin.apply_tenant_rls('app.message_attachments');

GRANT SELECT, INSERT, UPDATE ON app.contacts TO hs_app, hs_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.conversations TO hs_app;
GRANT SELECT, INSERT, UPDATE ON app.conversations TO hs_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.messages TO hs_app;
GRANT SELECT, INSERT, UPDATE ON app.messages TO hs_worker;
GRANT SELECT, INSERT ON app.message_status_events TO hs_app, hs_worker;
GRANT SELECT, INSERT, UPDATE ON app.message_attachments TO hs_app, hs_worker;
