import type { Logger } from '../../common/logger.js';
import type { TransactionRunner } from '../../database/transaction-runner.js';
import type { KnowledgeRepository } from '../../repositories/knowledge.repository.js';
import type { EmbeddingProvider } from '../model/model-provider.js';

export const KNOWLEDGE_INGEST_REQUESTED = 'KNOWLEDGE_INGEST_REQUESTED';

/** Paragraph-aware chunking (~900 chars, small overlap). FAQ entries stay whole. */
export function chunkText(type: string, raw: string): string[] {
  const text = raw.replace(/\r\n/g, '\n').trim();
  if (!text) return [];
  if (type === 'FAQ') {
    return text.split(/\n{2,}(?=Q:)/).map((s) => s.trim()).filter(Boolean).map((s) => s.slice(0, 4000));
  }
  if (type === 'CSV') {
    const [header, ...rows] = text.split('\n').filter((l) => l.trim());
    const cols = splitCsv(header ?? '');
    const lines = rows.map((r) => splitCsv(r).map((v, i) => `${cols[i] ?? `col${i + 1}`}: ${v}`).join('; '));
    return group(lines, 900);
  }
  return group(text.split(/\n{2,}/).flatMap((p) => (p.length > 1200 ? p.match(/[^.!?\n]+[.!?]?\s*/g) ?? [p] : [p])), 900, 150);
}

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function group(parts: string[], max: number, overlap = 0): string[] {
  const chunks: string[] = [];
  let cur = '';
  for (const p of parts.map((x) => x.trim()).filter(Boolean)) {
    if (cur && cur.length + p.length + 1 > max) {
      chunks.push(cur);
      cur = overlap ? cur.slice(-overlap) : '';
    }
    cur = cur ? `${cur}\n${p}` : p;
    while (cur.length > max * 1.5) { chunks.push(cur.slice(0, max)); cur = cur.slice(max - overlap); }
  }
  if (cur) chunks.push(cur);
  return chunks.map((c) => c.slice(0, 4000));
}

/**
 * Worker-side ingestion of TEXT / FAQ / CSV sources: chunk -> (optional) embed
 * -> replace chunks -> READY. Without an embedding provider chunks are stored
 * without vectors and retrieved by keyword search (index 0019).
 */
export class KnowledgeIngestionService {
  constructor(private readonly tx: TransactionRunner, private readonly repo: KnowledgeRepository, private readonly embedder: EmbeddingProvider | undefined,
              private readonly logger: Logger) {}

  async ingest(organizationId: string, sourceId: string): Promise<'READY' | 'FAILED' | 'SKIPPED'> {
    const src = await this.tx.inTenant(async (db) => (await db.query(
      `UPDATE app.knowledge_sources SET status = 'PROCESSING', error_message = NULL
        WHERE id = $1 AND deleted_at IS NULL AND status IN ('PENDING','FAILED','PROCESSING') RETURNING id, business_id, type, raw_content`, [sourceId])).rows[0],
      { organizationId });
    if (!src) return 'SKIPPED';
    try {
      const chunks = chunkText(src.type, src.raw_content ?? '');
      if (chunks.length === 0) throw new Error('No text to learn from.');
      let vectors: number[][] | null = null;
      if (this.embedder?.configured) {
        try { vectors = await this.embedder.embed(chunks); } catch (err) {
          this.logger.warn({ event_name: 'knowledge.embedding_failed', source_id: sourceId, err: { message: String((err as Error).message).slice(0, 200) } });
        }
      }
      await this.tx.inTenant(async (db) => {
        await db.query('DELETE FROM app.knowledge_chunks WHERE knowledge_source_id = $1', [sourceId]);
        if (vectors) {
          await this.repo.insertChunks(db, organizationId, src.business_id, sourceId, this.embedder!.model,
            chunks.map((content, index) => ({ index, content, embedding: vectors![index] })));
        } else {
          await db.query(
            `INSERT INTO app.knowledge_chunks (organization_id, business_id, knowledge_source_id, chunk_index, content)
             SELECT $1, $2, $3, t.idx, t.content FROM unnest($4::int[], $5::text[]) AS t(idx, content)`,
            [organizationId, src.business_id, sourceId, chunks.map((_c, i) => i), chunks]);
        }
        await db.query(`UPDATE app.knowledge_sources SET status = 'READY', chunk_count = $2 WHERE id = $1`, [sourceId, chunks.length]);
      }, { organizationId });
      return 'READY';
    } catch (err) {
      await this.tx.inTenant((db) => db.query(`UPDATE app.knowledge_sources SET status = 'FAILED', error_message = left($2, 500) WHERE id = $1`,
        [sourceId, (err as Error).message]), { organizationId });
      return 'FAILED';
    }
  }
}
