import { timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { assertBusinessScope, assertInstanceScope } from '../api/auth/permissions.js';
import { uuidv7 } from '../common/uuid.js';
import type { TenantContext } from '../database/tenant-context.js';
import { APP_TX, type Db, TransactionRunner } from '../database/transaction-runner.js';
import { toE164 } from '../whatsapp/domain/phone.js';
import { WhatsAppError } from '../whatsapp/domain/whatsapp-errors.js';
import { WhatsAppMessageService } from '../whatsapp/services/whatsapp-message.service.js';
import { type CodeOptions, generateCode, generateLinkCode, hashOtpCode } from './otp-crypto.js';

/** Codes per recipient per instance inside RATE_WINDOW (protects the user's phone and the sending number). */
const RATE_LIMIT = 5;
const RATE_WINDOW = '10 minutes';
const DEFAULT_TEMPLATE = '*{code}* is your {name} verification code. It expires in {minutes} minutes. Do not share it with anyone.';

export interface LinkMessages { prompt: string; success: string; expired: string }

export interface OtpView {
  id: string; kind: 'CODE' | 'LINK'; status: 'PENDING' | 'VERIFIED' | 'EXPIRED' | 'FAILED' | 'CANCELLED';
  to: string | null; expiresAt: string; verifiedAt: string | null; createdAt: string; messageId: string | null;
}

function view(r: Record<string, unknown>): OtpView {
  const expired = r.status === 'PENDING' && new Date(r.expires_at as string) <= new Date();
  return {
    id: r.id as string, kind: r.kind as OtpView['kind'], status: expired ? 'EXPIRED' : r.status as OtpView['status'], to: (r.phone_e164 as string | null) ?? null,
    expiresAt: new Date(r.expires_at as string).toISOString(), verifiedAt: r.verified_at ? new Date(r.verified_at as string).toISOString() : null,
    createdAt: new Date(r.created_at as string).toISOString(), messageId: (r.message_id as string | null) ?? null,
  };
}

const fill = (tpl: string, v: Record<string, string>) => tpl.replace(/\{(code|name|minutes)\}/g, (_m, k: string) => v[k] ?? '');

/**
 * OTP over WhatsApp for other products (login / phone verification).
 *  CODE: request-code sends a code to the user's WhatsApp; validate-code checks what the user typed
 *        (newest pending code only, max attempts, expiry, constant-time compare).
 *  LINK: generate-link returns a wa.me link; the user sends the code TO this number and the worker
 *        verifies it on arrival (see otp-inbound.ts), replies on WhatsApp and emits OTP_VERIFIED.
 */
@Injectable()
export class OtpService {
  constructor(
    @Inject(APP_TX) private readonly tx: TransactionRunner,
    @Inject(WhatsAppMessageService) private readonly messages: WhatsAppMessageService,
  ) {}

  private async instance(db: Db, ctx: TenantContext, instanceId: string) {
    const r = await db.query(
      `SELECT i.id, i.business_id, i.status, i.phone_e164, b.country_code, b.name AS business_name
         FROM app.whatsapp_instances i JOIN app.businesses b ON b.id = i.business_id
        WHERE i.id = $1 AND i.deleted_at IS NULL`, [instanceId]);
    const inst = r.rows[0];
    if (!inst) throw new WhatsAppError('WHATSAPP_INSTANCE_NOT_FOUND');
    assertBusinessScope(ctx, inst.business_id);
    assertInstanceScope(ctx, inst.id);
    return inst as { id: string; business_id: string; status: string; phone_e164: string | null; country_code: string | null; business_name: string };
  }

  async requestCode(ctx: TenantContext, instanceId: string, input: CodeOptions & { to: string; name?: string; expiresSeconds: number; template?: string }):
    Promise<OtpView & { code: string }> {
    if (input.template && !input.template.includes('{code}')) throw new WhatsAppError('VALIDATION_FAILED', 'template must contain {code}');
    const code = generateCode(input);
    const id = uuidv7();
    const prepared = await this.tx.inTenant(async (db) => {
      const inst = await this.instance(db, ctx, instanceId);
      if (inst.status !== 'CONNECTED') throw new WhatsAppError('WHATSAPP_INSTANCE_NOT_CONNECTED');
      const phone = toE164(input.to, (inst.country_code ?? undefined) as never);
      // Serialise concurrent requests for the same recipient so the rate limit and "only newest is valid" hold.
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`otp:${instanceId}:${phone}`]);
      const recent = (await db.query(
        `SELECT count(*)::int AS n FROM app.otp_requests WHERE instance_id = $1 AND phone_e164 = $2 AND created_at > now() - $3::interval`,
        [instanceId, phone, RATE_WINDOW])).rows[0].n as number;
      if (recent >= RATE_LIMIT) throw new WhatsAppError('WHATSAPP_RATE_LIMITED', `too many codes for this number - try again in ${RATE_WINDOW}`);
      await db.query(`UPDATE app.otp_requests SET status = 'CANCELLED' WHERE instance_id = $1 AND phone_e164 = $2 AND kind = 'CODE' AND status = 'PENDING'`,
        [instanceId, phone]);
      const row = (await db.query(
        `INSERT INTO app.otp_requests (id, organization_id, business_id, instance_id, api_key_id, kind, phone_e164, code_hash, app_name, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'CODE', $6, $7, $8, now() + make_interval(secs => $9::double precision)) RETURNING *`,
        [id, ctx.organizationId, inst.business_id, instanceId, ctx.apiKeyId ?? null, phone, hashOtpCode(instanceId, code, phone), input.name ?? null,
         input.expiresSeconds])).rows[0];
      return { phone, row, appName: input.name ?? inst.business_name };
    }, ctx);

    const text = fill(input.template ?? DEFAULT_TEMPLATE, { code, name: prepared.appName, minutes: String(Math.max(1, Math.round(input.expiresSeconds / 60))) });
    let messageId: string;
    try {
      ({ messageId } = await this.messages.sendText(ctx, { instanceId, to: prepared.phone, text, idempotencyKey: `otp:${id}` }));
    } catch (err) {
      await this.tx.inTenant((db) => db.query(`UPDATE app.otp_requests SET status = 'FAILED' WHERE id = $1`, [id]), ctx).catch(() => undefined);
      throw err;
    }
    await this.tx.inTenant((db) => db.query('UPDATE app.otp_requests SET message_id = $2 WHERE id = $1', [id, messageId]), ctx);
    return { ...view({ ...prepared.row, message_id: messageId }), code };
  }

  /** Always 200: { valid, reason } so callers can show a precise message without parsing errors. */
  async validateCode(ctx: TenantContext, instanceId: string, input: { to: string; code: string }):
    Promise<{ valid: boolean; reason: 'OK' | 'NOT_FOUND' | 'EXPIRED' | 'INVALID_CODE' | 'TOO_MANY_ATTEMPTS'; attemptsLeft?: number; otp?: OtpView }> {
    return this.tx.inTenant(async (db) => {
      const inst = await this.instance(db, ctx, instanceId);
      const phone = toE164(input.to, (inst.country_code ?? undefined) as never);
      const row = (await db.query(
        `SELECT * FROM app.otp_requests WHERE instance_id = $1 AND phone_e164 = $2 AND kind = 'CODE' AND status = 'PENDING'
          ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [instanceId, phone])).rows[0];
      if (!row) return { valid: false, reason: 'NOT_FOUND' as const };
      if (new Date(row.expires_at) <= new Date()) return { valid: false, reason: 'EXPIRED' as const, otp: view(row) };
      if (row.attempts >= row.max_attempts) return { valid: false, reason: 'TOO_MANY_ATTEMPTS' as const, attemptsLeft: 0, otp: view(row) };
      const ok = timingSafeEqual(hashOtpCode(instanceId, input.code.trim(), phone), row.code_hash);
      if (!ok) {
        const attempts = row.attempts + 1;
        const u = (await db.query(
          `UPDATE app.otp_requests SET attempts = $2, status = CASE WHEN $2 >= max_attempts THEN 'FAILED' ELSE status END WHERE id = $1 RETURNING *`,
          [row.id, attempts])).rows[0];
        const left = Math.max(0, row.max_attempts - attempts);
        return { valid: false, reason: left === 0 ? 'TOO_MANY_ATTEMPTS' as const : 'INVALID_CODE' as const, attemptsLeft: left, otp: view(u) };
      }
      const u = (await db.query(`UPDATE app.otp_requests SET status = 'VERIFIED', verified_at = now(), attempts = attempts + 1 WHERE id = $1 RETURNING *`, [row.id])).rows[0];
      return { valid: true, reason: 'OK' as const, otp: view(u) };
    }, ctx);
  }

  async generateLink(ctx: TenantContext, instanceId: string, input: { name?: string; expiresSeconds: number; messages: LinkMessages }):
    Promise<OtpView & { code: string; whatsappLink: string; text: string }> {
    return this.tx.inTenant(async (db) => {
      const inst = await this.instance(db, ctx, instanceId);
      if (inst.status !== 'CONNECTED' || !inst.phone_e164) throw new WhatsAppError('WHATSAPP_INSTANCE_NOT_CONNECTED');
      const code = generateLinkCode();
      const name = input.name ?? inst.business_name;
      const row = (await db.query(
        `INSERT INTO app.otp_requests (id, organization_id, business_id, instance_id, api_key_id, kind, code_hash, app_name, link_messages, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'LINK', $6, $7, $8, now() + make_interval(secs => $9::double precision)) RETURNING *`,
        [uuidv7(), ctx.organizationId, inst.business_id, instanceId, ctx.apiKeyId ?? null, hashOtpCode(instanceId, code), name,
         JSON.stringify({ success: input.messages.success, expired: input.messages.expired }), input.expiresSeconds])).rows[0];
      const text = `${fill(input.messages.prompt, { code, name, minutes: '' }).trim()}\n\nCode: ${code}`;
      return { ...view(row), code, text, whatsappLink: `https://wa.me/${inst.phone_e164.slice(1)}?text=${encodeURIComponent(text)}` };
    }, ctx);
  }

  async get(ctx: TenantContext, instanceId: string, id: string): Promise<OtpView> {
    return this.tx.inTenant(async (db) => {
      await this.instance(db, ctx, instanceId);
      const row = (await db.query('SELECT * FROM app.otp_requests WHERE id = $1 AND instance_id = $2', [id, instanceId])).rows[0];
      if (!row) throw new WhatsAppError('NOT_FOUND', 'OTP request not found');
      return view(row);
    }, ctx, { readOnly: true });
  }
}
