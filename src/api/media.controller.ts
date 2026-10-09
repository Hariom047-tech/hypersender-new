import { createHmac, timingSafeEqual } from 'node:crypto';
import { Controller, Get, Inject, Param, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { isUuid } from '../common/uuid.js';
import { uuidParam } from '../common/validation.js';
import { currentTenant, type DbContext } from '../database/tenant-context.js';
import { APP_TX, TransactionRunner } from '../database/transaction-runner.js';
import { WhatsAppError } from '../whatsapp/domain/whatsapp-errors.js';
import { contentDisposition, MEDIA_STORAGE, type MediaStorageService } from '../whatsapp/media/media-storage.service.js';
import { assertBusinessScope, requireScope } from './auth/permissions.js';

/** Image types safe to render inline. Everything else (incl. SVG, HTML) is forced to download. */
const INLINE_SAFE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const TTL_SECONDS = 300;

interface Claims { a: string; o: string; u?: string; k?: string; exp: number }

function secret(): Buffer {
  const s = process.env.MEDIA_URL_SECRET ?? process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error('MEDIA_URL_SECRET (or SESSION_SECRET) must be at least 32 characters');
  return Buffer.from(`media:${s}`, 'utf8');
}

export function issueMediaToken(c: Claims): string {
  const body = Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
  return `${body}.${createHmac('sha256', secret()).update(body).digest('base64url')}`;
}

export function verifyMediaToken(token: string): Claims | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', secret()).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const c = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Claims;
    if (!isUuid(c.a) || !isUuid(c.o) || typeof c.exp !== 'number' || c.exp * 1000 < Date.now()) return null;
    if (!(isUuid(c.u) || isUuid(c.k))) return null;
    return c;
  } catch {
    return null;
  }
}

interface Res { setHeader(k: string, v: string): void; status(c: number): Res; send(b: Buffer): void }

/**
 * Media access. Attachments are never public:
 *  - S3: a presigned GET URL valid <= 5 min, with a safe Content-Disposition.
 *  - local dev: a 5-min HMAC capability URL bound to (attachment, org, user|key),
 *    served below; the download re-validates the principal through RLS
 *    (a removed member / revoked key can no longer use a leaked URL).
 * Clients can never pass storage keys - only attachment ids.
 */
@ApiTags('Media')
@Controller('v1/media')
export class MediaController {
  constructor(@Inject(APP_TX) private readonly tx: TransactionRunner, @Inject(MEDIA_STORAGE) private readonly media: MediaStorageService) {}

  @Get('attachments/:id/url')
  @ApiBearerAuth('session')
  @ApiSecurity('api-key')
  @ApiOperation({ summary: 'Short-lived URL for an attachment (scope messages:read)' })
  async url(@Param('id') id: string) {
    const ctx = currentTenant();
    requireScope(ctx, 'messages:read');
    const att = await this.load(ctx, uuidParam(id));
    const inline = INLINE_SAFE.has(att.mime_type);
    const direct = await this.media.signedUrl(att.storage_key, { expiresInSeconds: TTL_SECONDS, contentType: att.mime_type,
                                                                 downloadName: att.file_name, inline });
    const expiresAt = new Date(Date.now() + TTL_SECONDS * 1000);
    if (direct) return { url: direct, expiresAt, inline };
    const token = issueMediaToken({ a: att.id, o: ctx.organizationId, u: ctx.userId, k: ctx.apiKeyId, exp: Math.floor(expiresAt.getTime() / 1000) });
    return { url: `/v1/media/download/${token}`, expiresAt, inline };
  }

  /** Excluded from the tenant middleware: the token IS the credential, re-checked against RLS. */
  @Get('download/:token')
  @ApiOperation({ summary: 'Download via a short-lived capability URL (local storage only)' })
  async download(@Param('token') token: string, @Res() res: Res): Promise<void> {
    const c = verifyMediaToken(token);
    if (!c) throw new WhatsAppError('NOT_FOUND');
    const ctx: DbContext = { organizationId: c.o, userId: c.u, apiKeyId: c.k };
    const att = await this.load(ctx, c.a);
    const data = await this.media.get(att.storage_key);
    const inline = INLINE_SAFE.has(att.mime_type);
    res.setHeader('Content-Type', inline ? att.mime_type : 'application/octet-stream');
    res.setHeader('Content-Disposition', contentDisposition(inline, att.file_name ?? (inline ? null : 'attachment')));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.status(200).send(data);
  }

  private async load(ctx: DbContext & { businessId?: string }, attachmentId: string) {
    const r = await this.tx.inTenant((db) => db.query(
      `SELECT a.id, a.storage_key, a.mime_type, a.file_name, a.status, m.business_id
         FROM app.message_attachments a JOIN app.messages m ON m.id = a.message_id WHERE a.id = $1`, [attachmentId]), ctx, { readOnly: true });
    const att = r.rows[0];
    if (!att || att.status !== 'STORED') throw new WhatsAppError('NOT_FOUND');
    if ('businessId' in ctx && ctx.businessId) assertBusinessScope(ctx as never, att.business_id);
    return att as { id: string; storage_key: string; mime_type: string; file_name: string | null; business_id: string };
  }
}
