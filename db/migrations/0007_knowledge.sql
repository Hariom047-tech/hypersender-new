-- =============================================================================
-- 0007 KNOWLEDGE BASE (pgvector)
-- =============================================================================

CREATE TABLE app.knowledge_sources (
  id                  uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id     uuid        NOT NULL,
  business_id         uuid        NOT NULL,
  -- NULL = shared by every agent of the business; set = private to one agent.
  ai_agent_id         uuid,
  type                text        NOT NULL,
  title               text        NOT NULL,
  source_url          text,
  storage_key         text,       -- private object storage key for uploaded files
  status              text        NOT NULL DEFAULT 'PENDING',
  checksum            bytea,      -- sha256 of source content: skip re-embedding unchanged sources
  error_message       text,
  created_by_user_id  uuid        REFERENCES app.users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  CONSTRAINT knowledge_sources_business_fk FOREIGN KEY (business_id, organization_id)
    REFERENCES app.businesses (id, organization_id) ON DELETE RESTRICT,
  -- Agents are soft-deleted; do not silently turn private knowledge into shared.
  CONSTRAINT knowledge_sources_agent_fk FOREIGN KEY (ai_agent_id, organization_id, business_id)
    REFERENCES app.ai_agents (id, organization_id, business_id) ON DELETE RESTRICT,
  CONSTRAINT knowledge_sources_id_org_biz_uq UNIQUE (id, organization_id, business_id),
  CONSTRAINT knowledge_sources_type_chk    CHECK (type IN ('TEXT','PDF','DOCX','CSV','WEBSITE','FAQ','MANUAL')),
  CONSTRAINT knowledge_sources_status_chk  CHECK (status IN ('PENDING','PROCESSING','READY','FAILED','ARCHIVED')),
  CONSTRAINT knowledge_sources_title_chk   CHECK (length(btrim(title)) BETWEEN 1 AND 300),
  CONSTRAINT knowledge_sources_url_chk     CHECK (source_url IS NULL OR source_url ~ '^https?://'),
  CONSTRAINT knowledge_sources_web_chk     CHECK (type <> 'WEBSITE' OR source_url IS NOT NULL),
  CONSTRAINT knowledge_sources_file_chk    CHECK (type NOT IN ('PDF','DOCX','CSV') OR storage_key IS NOT NULL),
  CONSTRAINT knowledge_sources_key_chk     CHECK (storage_key IS NULL OR storage_key !~* '^[a-z]+://'),
  CONSTRAINT knowledge_sources_checksum_chk CHECK (checksum IS NULL OR octet_length(checksum) = 32)
);
CREATE INDEX knowledge_sources_org_biz_idx ON app.knowledge_sources (organization_id, business_id) WHERE deleted_at IS NULL;
CREATE INDEX knowledge_sources_agent_idx ON app.knowledge_sources (ai_agent_id) WHERE ai_agent_id IS NOT NULL;
SELECT app_admin.attach_updated_at_trigger('app.knowledge_sources');

-- -----------------------------------------------------------------------------
-- knowledge_chunks
-- The embedding column is an UNCONSTRAINED `vector` plus explicit
-- (embedding_model, embedding_dimensions), so the model/dimension is not baked
-- into the schema and several models can coexist during a migration. Once a
-- model is chosen and volume justifies ANN, add a partial expression HNSW index
-- per model, e.g. (new migration, CONCURRENTLY):
--
--   CREATE INDEX CONCURRENTLY knowledge_chunks_hnsw_te3s ON app.knowledge_chunks
--     USING hnsw ((embedding::extensions.vector(1536)) extensions.vector_cosine_ops)
--     WHERE embedding_model = 'text-embedding-3-small';
--
-- and query with the same cast + predicate. Until then retrieval is an EXACT
-- scan restricted by (organization_id, business_id) - per-business corpora are
-- small, exact search has perfect recall, and the tenant filter is applied
-- before any distance is computed.
-- -----------------------------------------------------------------------------
CREATE TABLE app.knowledge_chunks (
  id                    uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  organization_id       uuid        NOT NULL,
  business_id           uuid        NOT NULL,
  knowledge_source_id   uuid        NOT NULL,
  chunk_index           integer     NOT NULL,
  content               text        NOT NULL,
  content_tokens        integer,
  embedding             extensions.vector,
  embedding_model       text,
  embedding_dimensions  integer,
  metadata              jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  -- Chunks have no value without their source (re-ingestion replaces them).
  CONSTRAINT knowledge_chunks_source_fk FOREIGN KEY (knowledge_source_id, organization_id, business_id)
    REFERENCES app.knowledge_sources (id, organization_id, business_id) ON DELETE CASCADE,
  CONSTRAINT knowledge_chunks_position_uq UNIQUE (knowledge_source_id, chunk_index),
  CONSTRAINT knowledge_chunks_index_chk   CHECK (chunk_index >= 0),
  CONSTRAINT knowledge_chunks_content_chk CHECK (length(content) BETWEEN 1 AND 32000),
  CONSTRAINT knowledge_chunks_model_chk   CHECK ((embedding IS NULL) = (embedding_model IS NULL)
                                                 AND (embedding IS NULL) = (embedding_dimensions IS NULL)),
  CONSTRAINT knowledge_chunks_dims_chk    CHECK (embedding IS NULL OR extensions.vector_dims(embedding) = embedding_dimensions),
  CONSTRAINT knowledge_chunks_meta_chk    CHECK (jsonb_typeof(metadata) = 'object')
);
-- Retrieval prefilter (tenant + business), then exact distance ordering.
CREATE INDEX knowledge_chunks_org_biz_source_idx ON app.knowledge_chunks (organization_id, business_id, knowledge_source_id);

SELECT app_admin.apply_tenant_rls('app.knowledge_sources');
SELECT app_admin.apply_tenant_rls('app.knowledge_chunks');

GRANT SELECT, INSERT, UPDATE ON app.knowledge_sources TO hs_app;
GRANT SELECT, UPDATE ON app.knowledge_sources TO hs_worker;
GRANT SELECT, DELETE ON app.knowledge_chunks TO hs_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.knowledge_chunks TO hs_worker;
