import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { assertInstanceScope, requireScope, requireUser } from './auth/permissions.js';
import { obj, optStr, str, uuidParam } from '../common/validation.js';
import { currentTenant } from '../database/tenant-context.js';
import { OtpService } from '../otp/otp.service.js';
import { ApiKeyService } from '../services/api-key.service.js';
import { WhatsAppError } from '../whatsapp/domain/whatsapp-errors.js';
import { ERROR_SCHEMA } from '../whatsapp/dto/openapi-schemas.js';
import { WhatsAppInstanceService } from '../whatsapp/services/whatsapp-instance.service.js';
import { WhatsAppMessageService } from '../whatsapp/services/whatsapp-message.service.js';

/** Public host other products call (shown on the instance page). */
export const publicApiUrl = () => (process.env.PUBLIC_API_URL ?? 'http://localhost:3100').replace(/\/$/, '');

type Body = Record<string, unknown>;

/** `to` (+919812345678 / 9812345678) or gateway-style `chatId` (919812345678@c.us). Groups are not supported. */
function recipient(b: Body): string {
  if (typeof b.chatId === 'string' && b.chatId) {
    const m = /^(\d{6,15})@(c\.us|s\.whatsapp\.net)$/.exec(b.chatId.trim());
    if (!m) throw new WhatsAppError('WHATSAPP_INVALID_RECIPIENT', 'chatId must look like 919812345678@c.us (groups are not supported)');
    return `+${m[1]}`;
  }
  return str(b, 'to', { min: 6, max: 32 });
}
function optInt(b: Body, key: string, min: number, max: number, def: number): number {
  const v = b[key];
  if (v === undefined || v === null) return def;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new WhatsAppError('VALIDATION_FAILED', `${key} must be an integer between ${min} and ${max}`);
  return v;
}
function optBool(b: Body, key: string, def: boolean): boolean {
  const v = b[key];
  if (v === undefined || v === null) return def;
  if (typeof v !== 'boolean') throw new WhatsAppError('VALIDATION_FAILED', `${key} must be true or false`);
  return v;
}
/** The instance in the path; instance keys may only use their own. */
function instanceParam(raw: string): string {
  const id = uuidParam(raw, 'instance');
  assertInstanceScope(currentTenant(), id);
  return id;
}

const TO = { to: { type: 'string', example: '+919812345678', description: 'E.164, or national format for the business country' },
             chatId: { type: 'string', example: '919812345678@c.us', description: 'Alternative to `to` (gateway style)' },
             idempotencyKey: { type: 'string', maxLength: 200, description: 'Retries with the same key never send twice' } };
const QUEUED = { type: 'object', properties: { queued: { type: 'boolean' }, messageId: { type: 'string', format: 'uuid' }, status: { type: 'string', example: 'QUEUED' },
                                                 duplicate: { type: 'boolean' }, statusUrl: { type: 'string' } } };

/** Instance API key (dashboard): created with the instance, copyable again by owners/admins (reveal), rotatable. */
@ApiTags('Instance API key (dashboard)')
@ApiBearerAuth('session')
@Controller('v1/whatsapp/instances/:id/api-key')
export class InstanceApiKeyController {
  constructor(@Inject(ApiKeyService) private readonly keys: ApiKeyService, @Inject(WhatsAppInstanceService) private readonly instances: WhatsAppInstanceService) {}

  @Get()
  @ApiOperation({ summary: 'Instance credentials: id, base URL and the live key metadata. Creates the key if the instance has none yet.' })
  async get(@Param('id') raw: string) {
    const ctx = currentTenant();
    requireUser(ctx, ['OWNER', 'ADMIN']);
    const id = uuidParam(raw);
    await this.instances.get(ctx, id);
    return { instanceId: id, baseUrl: publicApiUrl(), key: await this.keys.ensureInstanceKey(ctx, id) };
  }

  @Post('reveal')
  @HttpCode(200)
  @ApiOperation({ summary: 'The full instance API key, for the copy / show button (audited). apiKey is null for an old hash-only key: generate a new one.' })
  async reveal(@Param('id') raw: string) {
    const ctx = currentTenant();
    requireUser(ctx, ['OWNER', 'ADMIN']);
    const id = uuidParam(raw);
    await this.instances.get(ctx, id);
    return { apiKey: await this.keys.revealInstanceKey(ctx, id) };
  }

  @Post()
  @ApiOperation({ summary: 'Generate a new instance API key (the previous key stops working immediately)' })
  async rotate(@Param('id') raw: string) {
    const ctx = currentTenant();
    requireUser(ctx, ['OWNER', 'ADMIN']);
    const id = uuidParam(raw);
    await this.instances.get(ctx, id);
    const k = (await this.keys.createInstanceKey(ctx, id))!;
    const { plaintext, ...key } = k;
    return { instanceId: id, baseUrl: publicApiUrl(), apiKey: plaintext, key };
  }
}

/**
 * WhatsApp API addressed by instance (gateway style):
 *   POST {base}/api/whatsapp/v1/{instance}/send-text   Authorization: Bearer <instance API key>
 * Sends are queued (202) and delivered by the instance's worker; follow up with GET messages/{id} or webhooks.
 */
@ApiTags('Instance API - WhatsApp')
@ApiBearerAuth('instance-key')
@ApiParam({ name: 'instance', format: 'uuid', description: 'Instance ID' })
@ApiResponse({ status: 401, description: 'Missing/invalid API key' })
@ApiResponse({ status: 404, description: 'WHATSAPP_INSTANCE_NOT_FOUND (also another instance than the key\'s)', schema: ERROR_SCHEMA })
@ApiResponse({ status: 409, description: 'WHATSAPP_INSTANCE_NOT_CONNECTED', schema: ERROR_SCHEMA })
@ApiResponse({ status: 429, description: 'WHATSAPP_RATE_LIMITED', schema: ERROR_SCHEMA })
@Controller('api/whatsapp/v1/:instance')
export class InstanceWhatsAppApiController {
  constructor(@Inject(WhatsAppMessageService) private readonly messages: WhatsAppMessageService,
              @Inject(WhatsAppInstanceService) private readonly instances: WhatsAppInstanceService) {}

  private queued(instanceId: string, r: { messageId: string; status: string; duplicate: boolean }) {
    return { queued: true, ...r, statusUrl: `${publicApiUrl()}/api/whatsapp/v1/${instanceId}/messages/${r.messageId}` };
  }

  @Get('status')
  @ApiOperation({ summary: 'Instance connection status and phone number' })
  async status(@Param('instance') raw: string) {
    const ctx = currentTenant();
    requireScope(ctx, 'instances:read');
    const id = instanceParam(raw);
    const s = await this.instances.status(ctx, id);
    return { instanceId: id, status: s.status, phoneNumber: s.phoneNumber, displayName: s.displayName, connectedAt: s.connectedAt };
  }

  @Post('send-text')
  @HttpCode(202)
  @ApiOperation({ summary: 'Send a text message' })
  @ApiBody({ schema: { type: 'object', required: ['text'], properties: { ...TO, text: { type: 'string', maxLength: 4096 } } } })
  @ApiResponse({ status: 202, schema: QUEUED })
  async sendText(@Param('instance') raw: string, @Body() body: unknown) {
    const ctx = currentTenant();
    requireScope(ctx, 'messages:send');
    const instanceId = instanceParam(raw);
    const b = obj(body);
    return this.queued(instanceId, await this.messages.sendText(ctx, { instanceId, to: recipient(b), text: str(b, 'text', { min: 1, max: 4096 }),
      idempotencyKey: optStr(b, 'idempotencyKey', { max: 200 }) }));
  }

  @Post('send-image')
  @HttpCode(202)
  @ApiOperation({ summary: 'Send an image (jpeg/png/webp as base64)' })
  @ApiBody({ schema: { type: 'object', required: ['dataBase64', 'mimeType'], properties: { ...TO, dataBase64: { type: 'string' },
    mimeType: { type: 'string', enum: ['image/jpeg', 'image/png', 'image/webp'] }, caption: { type: 'string', maxLength: 1024 } } } })
  @ApiResponse({ status: 202, schema: QUEUED })
  sendImage(@Param('instance') raw: string, @Body() body: unknown) { return this.media('IMAGE', raw, body); }

  @Post('send-file')
  @HttpCode(202)
  @ApiOperation({ summary: 'Send a document (pdf/office/txt/csv/zip as base64)' })
  @ApiBody({ schema: { type: 'object', required: ['dataBase64', 'mimeType', 'fileName'], properties: { ...TO, dataBase64: { type: 'string' },
    mimeType: { type: 'string', example: 'application/pdf' }, fileName: { type: 'string', maxLength: 200 }, caption: { type: 'string', maxLength: 1024 } } } })
  @ApiResponse({ status: 202, schema: QUEUED })
  sendFile(@Param('instance') raw: string, @Body() body: unknown) { return this.media('DOCUMENT', raw, body); }

  @Get('messages/:messageId')
  @ApiParam({ name: 'messageId', format: 'uuid' })
  @ApiOperation({ summary: 'Message status (QUEUED → SENT → DELIVERED → READ, or FAILED)' })
  async message(@Param('instance') raw: string, @Param('messageId') messageId: string) {
    const ctx = currentTenant();
    requireScope(ctx, 'messages:read');
    const instanceId = instanceParam(raw);
    const m = await this.messages.get(ctx, uuidParam(messageId, 'messageId'));
    if ((m.instance as { id?: string } | undefined)?.id !== instanceId) throw new WhatsAppError('WHATSAPP_MESSAGE_NOT_FOUND');
    return m;
  }

  private async media(type: 'IMAGE' | 'DOCUMENT', raw: string, body: unknown) {
    const ctx = currentTenant();
    requireScope(ctx, 'messages:send');
    const instanceId = instanceParam(raw);
    const b = obj(body);
    return this.queued(instanceId, await this.messages.sendMedia(ctx, type, {
      instanceId, to: recipient(b), dataBase64: str(b, 'dataBase64', { min: 4 }), mimeType: str(b, 'mimeType', { max: 255 }),
      fileName: type === 'DOCUMENT' ? str(b, 'fileName', { min: 1, max: 200 }) : optStr(b, 'fileName', { max: 200 }),
      caption: optStr(b, 'caption', { max: 1024 }), idempotencyKey: optStr(b, 'idempotencyKey', { max: 200 }),
    }));
  }
}

/**
 * OTP over WhatsApp:
 *   request-code  -> we send a code to the user's WhatsApp; validate-code checks what they typed.
 *   generate-link -> "login by WhatsApp": the user taps a wa.me link and sends the code to this number;
 *                    you learn the result from the OTP_VERIFIED webhook (or GET requests/{id}).
 */
@ApiTags('Instance API - OTP')
@ApiBearerAuth('instance-key')
@ApiParam({ name: 'instance', format: 'uuid', description: 'Instance ID' })
@ApiResponse({ status: 404, description: 'WHATSAPP_INSTANCE_NOT_FOUND', schema: ERROR_SCHEMA })
@ApiResponse({ status: 409, description: 'WHATSAPP_INSTANCE_NOT_CONNECTED', schema: ERROR_SCHEMA })
@ApiResponse({ status: 429, description: 'WHATSAPP_RATE_LIMITED (max 5 codes per number per 10 minutes)', schema: ERROR_SCHEMA })
@Controller('api/otp/v1/:instance')
export class OtpApiController {
  constructor(@Inject(OtpService) private readonly otp: OtpService) {}

  @Post('request-code')
  @ApiOperation({ summary: 'Generate a code and send it on WhatsApp', description: 'Only the newest code per number is valid. The code is also returned so you can log/test.' })
  @ApiBody({ schema: { type: 'object', properties: { ...TO,
    length: { type: 'integer', minimum: 4, maximum: 10, default: 6 }, useNumber: { type: 'boolean', default: true }, useLetter: { type: 'boolean', default: false },
    allCapital: { type: 'boolean', default: false }, name: { type: 'string', maxLength: 60, description: 'Your app name used in the message' },
    expires: { type: 'integer', minimum: 60, maximum: 86400, default: 1800, description: 'Seconds' },
    template: { type: 'string', maxLength: 1000, description: 'Custom message; must contain {code}. Also {name} and {minutes}.' } } } })
  requestCode(@Param('instance') raw: string, @Body() body: unknown) {
    const ctx = currentTenant();
    requireScope(ctx, 'messages:send');
    const instanceId = instanceParam(raw);
    const b = obj(body);
    const useNumber = optBool(b, 'useNumber', true);
    const useLetter = optBool(b, 'useLetter', false);
    if (!useNumber && !useLetter) throw new WhatsAppError('VALIDATION_FAILED', 'useNumber and useLetter cannot both be false');
    return this.otp.requestCode(ctx, instanceId, { to: recipient(b), length: optInt(b, 'length', 4, 10, 6), useNumber, useLetter,
      allCapital: optBool(b, 'allCapital', false), name: optStr(b, 'name', { min: 1, max: 60 }), expiresSeconds: optInt(b, 'expires', 60, 86400, 1800),
      template: optStr(b, 'template', { min: 6, max: 1000 }) });
  }

  @Post('validate-code')
  @HttpCode(200)
  @ApiOperation({ summary: 'Check the code the user typed', description: 'Always 200 with { valid, reason }. reason: OK | NOT_FOUND | EXPIRED | INVALID_CODE | TOO_MANY_ATTEMPTS (5 tries).' })
  @ApiBody({ schema: { type: 'object', required: ['code'], properties: { ...TO, code: { type: 'string', maxLength: 10 } } } })
  validateCode(@Param('instance') raw: string, @Body() body: unknown) {
    const ctx = currentTenant();
    requireScope(ctx, 'messages:send');
    const instanceId = instanceParam(raw);
    const b = obj(body);
    return this.otp.validateCode(ctx, instanceId, { to: recipient(b), code: str(b, 'code', { min: 1, max: 10 }) });
  }

  @Post('generate-link')
  @ApiOperation({ summary: '"Login by WhatsApp" link', description: 'Show `whatsappLink` to the user (button / QR). When they send the prefilled message, the request becomes VERIFIED with their phone, they get the success reply and an OTP_VERIFIED webhook is sent.' })
  @ApiBody({ schema: { type: 'object', properties: { name: { type: 'string', maxLength: 60 }, expires: { type: 'integer', minimum: 60, maximum: 86400, default: 1800 },
    message: { type: 'object', properties: { prompt: { type: 'string', example: 'Log me in to {name}' }, success: { type: 'string', example: 'You are logged in to {name} ✅' },
      expired: { type: 'string', example: 'This login link has expired. Please request a new one.' } } } } } })
  generateLink(@Param('instance') raw: string, @Body() body: unknown) {
    const ctx = currentTenant();
    requireScope(ctx, 'messages:send');
    const instanceId = instanceParam(raw);
    const b = obj(body);
    const m = b.message === undefined ? {} : obj(b.message);
    return this.otp.generateLink(ctx, instanceId, { name: optStr(b, 'name', { min: 1, max: 60 }), expiresSeconds: optInt(b, 'expires', 60, 86400, 1800), messages: {
      prompt: optStr(m, 'prompt', { min: 1, max: 300 }) ?? 'Log me in to {name}',
      success: optStr(m, 'success', { min: 1, max: 1000 }) ?? 'You are verified for {name} ✅ You can go back to the app now.',
      expired: optStr(m, 'expired', { min: 1, max: 1000 }) ?? 'This login link has expired. Please request a new one.' } });
  }

  @Get('requests/:id')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'OTP request status: PENDING | VERIFIED | EXPIRED | FAILED | CANCELLED (+ the verified phone for links)' })
  get(@Param('instance') raw: string, @Param('id') id: string) {
    const ctx = currentTenant();
    requireScope(ctx, 'messages:read');
    return this.otp.get(ctx, instanceParam(raw), uuidParam(id));
  }
}
