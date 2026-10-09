import { Injectable } from '@nestjs/common';
import type { Db } from '../database/transaction-runner.js';

export interface RetrievedChunk { id: string; knowledgeSourceId: string; content: string; distance: number; title?: string }

@Injectable()
export class KnowledgeRepository {
  /**
   * Tenant-safe semantic retrieval.
   *  - organization_id / business_id filters are explicit AND enforced by RLS;
   *  - agent-private sources of OTHER agents are excluded;
   *  - only READY, non-deleted sources embedded with the same model are used.
   * Exact (non-ANN) distance: see 0007_knowledge.sql for the HNSW upgrade path.
   */
  async search(db: Db, q: { organizationId: string; businessId: string; aiAgentId: string; embedding: number[]; embeddingModel: string; limit?: number }): Promise<RetrievedChunk[]> {
    const r = await db.query(
      `SELECT c.id, c.knowledge_source_id, c.content, c.embedding <=> $4::extensions.vector AS distance
         FROM app.knowledge_chunks c
         JOIN app.knowledge_sources s ON s.id = c.knowledge_source_id
        WHERE c.organization_id = $1 AND c.business_id = $2
          AND s.organization_id = $1 AND s.business_id = $2
          AND s.status = 'READY' AND s.deleted_at IS NULL
          AND (s.ai_agent_id IS NULL OR s.ai_agent_id = $3)
          AND c.embedding_model = $5
          AND c.embedding_dimensions = $6
        ORDER BY distance
        LIMIT $7`,
      [q.organizationId, q.businessId, q.aiAgentId, `[${q.embedding.join(',')}]`, q.embeddingModel, q.embedding.length,
       Math.min(q.limit ?? 8, 50)]);
    return r.rows.map((row) => ({ id: row.id, knowledgeSourceId: row.knowledge_source_id, content: row.content, distance: Number(row.distance) }));
  }

  async insertChunks(db: Db, organizationId: string, businessId: string, sourceId: string, model: string,
                     chunks: Array<{ index: number; content: string; embedding: number[] }>): Promise<void> {
    if (chunks.length === 0) return;
    await db.query(
      `INSERT INTO app.knowledge_chunks (organization_id, business_id, knowledge_source_id, chunk_index, content, embedding, embedding_model, embedding_dimensions)
       SELECT $1, $2, $3, t.idx, t.content, t.emb::extensions.vector, $4, extensions.vector_dims(t.emb::extensions.vector)
         FROM unnest($5::int[], $6::text[], $7::text[]) AS t(idx, content, emb)`,
      [organizationId, businessId, sourceId, model, chunks.map((c) => c.index), chunks.map((c) => c.content),
       chunks.map((c) => `[${c.embedding.join(',')}]`)]);
  }

  /**
   * Keyword retrieval (no embeddings needed): OR-query over the words of the
   * question, ranked by ts_rank. Same tenant/business/agent scoping as search().
   * Expression matches index knowledge_chunks_fts_idx (0019).
   */
  async searchLexical(db: Db, q: { organizationId: string; businessId: string; aiAgentId: string; words: string[]; limit?: number }): Promise<RetrievedChunk[]> {
    if (q.words.length === 0) return [];
    const r = await db.query(
      `WITH query AS (SELECT to_tsquery('simple', array_to_string(ARRAY(SELECT quote_literal(w) FROM unnest($4::text[]) w), ' | ')) AS tq)
       SELECT c.id, c.knowledge_source_id, s.title, c.content, ts_rank(to_tsvector('simple', c.content), query.tq) AS rank
         FROM query, app.knowledge_chunks c
         JOIN app.knowledge_sources s ON s.id = c.knowledge_source_id
        WHERE c.organization_id = $1 AND c.business_id = $2
          AND s.organization_id = $1 AND s.business_id = $2
          AND s.status = 'READY' AND s.deleted_at IS NULL
          AND (s.ai_agent_id IS NULL OR s.ai_agent_id = $3)
          AND to_tsvector('simple', c.content) @@ query.tq
        ORDER BY rank DESC, c.id
        LIMIT $5`,
      [q.organizationId, q.businessId, q.aiAgentId, q.words, Math.min(q.limit ?? 5, 20)]);
    return r.rows.map((row) => ({ id: row.id, knowledgeSourceId: row.knowledge_source_id, content: row.content, distance: 1 - Number(row.rank), title: row.title }));
  }

  async sourceTitles(db: Db, ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const r = await db.query('SELECT id, title FROM app.knowledge_sources WHERE id = ANY($1::uuid[])', [ids]);
    return new Map(r.rows.map((x) => [x.id, x.title]));
  }
}
