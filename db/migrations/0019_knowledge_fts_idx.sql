-- migrate:no-transaction
-- 0019 Lexical knowledge search (used when a chunk has no embedding, e.g. no
-- embedding provider configured, and as a keyword complement to vector search).
-- Expression must match KnowledgeRepository.searchLexical exactly.
CREATE INDEX CONCURRENTLY IF NOT EXISTS knowledge_chunks_fts_idx
  ON app.knowledge_chunks USING gin (to_tsvector('simple', content));
