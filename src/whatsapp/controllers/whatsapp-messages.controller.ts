import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { requireScope } from '../../api/auth/permissions.js';
import { obj, optStr, str, uuidParam } from '../../common/validation.js';
import { currentTenant } from '../../database/tenant-context.js';
import { ERROR_SCHEMA, MESSAGE_VIEW_SCHEMA, QUEUED_SCHEMA } from '../dto/openapi-schemas.js';
import { WhatsAppMessageService } from '../services/whatsapp-message.service.js';

const common = { instanceId: { type: 'string', format: 'uuid' }, to: { type: 'string', example: '+919812345678', description: 'E.164, or national format for the business country' },
                 idempotencyKey: { type: 'string', maxLength: 200, description: 'Retries with the same key never send twice' } };

@ApiTags('WhatsApp messages')
@ApiBearerAuth('session')
@ApiSecurity('api-key')
@ApiResponse({ status: 409, description: 'WHATSAPP_INSTANCE_NOT_CONNECTED', schema: ERROR_SCHEMA })
@ApiResponse({ status: 429, description: 'WHATSAPP_RATE_LIMITED', schema: ERROR_SCHEMA })
@Controller('v1/whatsapp/messages')
export class WhatsAppMessagesController {
  constructor(@Inject(WhatsAppMessageService) private readonly messages: WhatsAppMessageService) {}

  @Post('text')
  @HttpCode(202)
  @ApiOperation({ summary: 'Queue a text message', description: 'Scope: messages:send. Returns immediately with status QUEUED; delivery progress via GET /messages/:id and webhooks.' })
  @ApiBody({ schema: { type: 'object', required: ['instanceId', 'to', 'text'], properties: { ...common, text: { type: 'string', maxLength: 4096 } } } })
  @ApiResponse({ status: 202, schema: QUEUED_SCHEMA })
  sendText(@Body() raw: unknown) {
    const ctx = currentTenant();
    requireScope(ctx, 'messages:send');
    const b = obj(raw);
    return this.messages.sendText(ctx, { instanceId: uuidParam(b.instanceId, 'instanceId'), to: str(b, 'to', { min: 6, max: 32 }),
      text: str(b, 'text', { min: 1, max: 4096 }), idempotencyKey: optStr(b, 'idempotencyKey', { max: 200 }) });
  }

  @Post('image')
  @HttpCode(202)
  @ApiOperation({ summary: 'Queue an image (jpeg/png/webp, base64)', description: 'Scope: messages:send' })
  @ApiBody({ schema: { type: 'object', required: ['instanceId', 'to', 'dataBase64', 'mimeType'], properties: { ...common,
    dataBase64: { type: 'string' }, mimeType: { type: 'string', enum: ['image/jpeg', 'image/png', 'image/webp'] }, caption: { type: 'string', maxLength: 1024 } } } })
  @ApiResponse({ status: 202, schema: QUEUED_SCHEMA })
  sendImage(@Body() raw: unknown) { return this.media('IMAGE', raw); }

  @Post('document')
  @HttpCode(202)
  @ApiOperation({ summary: 'Queue a document (pdf/office/txt/csv/zip, base64)', description: 'Scope: messages:send' })
  @ApiBody({ schema: { type: 'object', required: ['instanceId', 'to', 'dataBase64', 'mimeType', 'fileName'], properties: { ...common,
    dataBase64: { type: 'string' }, mimeType: { type: 'string' }, fileName: { type: 'string', maxLength: 200 }, caption: { type: 'string', maxLength: 1024 } } } })
  @ApiResponse({ status: 202, schema: QUEUED_SCHEMA })
  sendDocument(@Body() raw: unknown) { return this.media('DOCUMENT', raw); }

  @Get(':id')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Get a message (normalised view)', description: 'Scope: messages:read' })
  @ApiResponse({ status: 200, schema: MESSAGE_VIEW_SCHEMA })
  @ApiResponse({ status: 404, description: 'WHATSAPP_MESSAGE_NOT_FOUND (also for other tenants\' messages)', schema: ERROR_SCHEMA })
  get(@Param('id') id: string) {
    const ctx = currentTenant();
    requireScope(ctx, 'messages:read');
    return this.messages.get(ctx, uuidParam(id));
  }

  private media(type: 'IMAGE' | 'DOCUMENT', raw: unknown) {
    const ctx = currentTenant();
    requireScope(ctx, 'messages:send');
    const b = obj(raw);
    return this.messages.sendMedia(ctx, type, {
      instanceId: uuidParam(b.instanceId, 'instanceId'), to: str(b, 'to', { min: 6, max: 32 }), dataBase64: str(b, 'dataBase64', { min: 4 }),
      mimeType: str(b, 'mimeType', { max: 255 }), fileName: type === 'DOCUMENT' ? str(b, 'fileName', { min: 1, max: 200 }) : optStr(b, 'fileName', { max: 200 }),
      caption: optStr(b, 'caption', { max: 1024 }), idempotencyKey: optStr(b, 'idempotencyKey', { max: 200 }),
    });
  }
}
