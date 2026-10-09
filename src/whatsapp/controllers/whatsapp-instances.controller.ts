import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query, Sse, type MessageEvent } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiProduces, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Observable } from 'rxjs';
import { requireScope } from '../../api/auth/permissions.js';
import { obj, optStr, str, uuidParam } from '../../common/validation.js';
import { currentTenant } from '../../database/tenant-context.js';
import { INSTANCE_SCHEMA, ERROR_SCHEMA, COMMAND_ACCEPTED_SCHEMA, STATUS_SCHEMA } from '../dto/openapi-schemas.js';
import { REALTIME_BUS, type RealtimeBus } from '../realtime/realtime-bus.js';
import { WhatsAppInstanceService } from '../services/whatsapp-instance.service.js';
import { WorkspaceService } from '../../api/workspace.service.js';
import { ApiKeyService } from '../../services/api-key.service.js';
import { WhatsAppError } from '../domain/whatsapp-errors.js';
import { pageLimit } from '../../common/cursor.js';

@ApiTags('WhatsApp instances')
@ApiBearerAuth('session')
@ApiSecurity('api-key')
@ApiResponse({ status: 401, description: 'Missing/invalid credentials' })
@ApiResponse({ status: 404, description: 'Instance not found (also for other tenants\' instances)', schema: ERROR_SCHEMA })
@Controller('v1/whatsapp/instances')
export class WhatsAppInstancesController {
  constructor(
    @Inject(WhatsAppInstanceService) private readonly instances: WhatsAppInstanceService,
    @Inject(REALTIME_BUS) private readonly bus: RealtimeBus,
    @Inject(WorkspaceService) private readonly ws: WorkspaceService,
    @Inject(ApiKeyService) private readonly apiKeys: ApiKeyService,
  ) {}

  @Get(':id/activity')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Connection history (whatsapp_instance_events; allow-listed details only). Scope instances:read' })
  activity(@Param('id') id: string, @Query('cursor') cursor?: string) {
    const ctx = currentTenant();
    requireScope(ctx, 'instances:read');
    return this.ws.instanceActivity(ctx, uuidParam(id), { cursor, limit: pageLimit(undefined, 30, 100) });
  }

  @Post()
  @ApiOperation({ summary: 'Create an instance (status CREATED; nothing is connected yet)', description: 'Scope: instances:write' })
  @ApiBody({ schema: { type: 'object', required: ['businessId', 'name'], properties: {
    businessId: { type: 'string', format: 'uuid' }, name: { type: 'string', maxLength: 100 }, description: { type: 'string', maxLength: 500 } } } })
  @ApiResponse({ status: 201, schema: INSTANCE_SCHEMA })
  @ApiResponse({ status: 402, description: 'Plan limit reached / subscription inactive', schema: ERROR_SCHEMA })
  async create(@Body() raw: unknown) {
    const ctx = currentTenant();
    requireScope(ctx, 'instances:write');
    const b = obj(raw);
    const inst = await this.instances.create(ctx, { businessId: uuidParam(b.businessId, 'businessId'), name: str(b, 'name', { min: 1, max: 100 }),
      description: optStr(b, 'description', { max: 500 }) });
    // Every instance gets its API key (Bearer token) right away; plans without API access simply get none.
    await this.apiKeys.ensureInstanceKey(ctx, inst.id).catch(() => undefined);
    return inst;
  }

  @Patch(':id')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Rename an instance / change its description (connection is untouched)', description: 'Scope: instances:write' })
  @ApiBody({ schema: { type: 'object', properties: { name: { type: 'string', maxLength: 100 }, description: { type: 'string', maxLength: 500, nullable: true } } } })
  @ApiResponse({ status: 200, schema: INSTANCE_SCHEMA })
  update(@Param('id') id: string, @Body() raw: unknown) {
    const ctx = currentTenant();
    requireScope(ctx, 'instances:write');
    const b = obj(raw);
    if (b.name !== undefined && (typeof b.name !== 'string' || !b.name.trim())) throw new WhatsAppError('VALIDATION_FAILED', 'name cannot be empty');
    const description = b.description === null ? null : optStr(b, 'description', { max: 500 });
    return this.instances.update(ctx, uuidParam(id), { name: optStr(b, 'name', { min: 1, max: 100 }),
      ...(b.description !== undefined ? { description: description || null } : {}) });
  }

  @Get()
  @ApiOperation({ summary: 'List instances', description: 'Scope: instances:read' })
  @ApiResponse({ status: 200, schema: { type: 'array', items: INSTANCE_SCHEMA } })
  list() {
    const ctx = currentTenant();
    requireScope(ctx, 'instances:read');
    return this.instances.list(ctx);
  }

  @Get(':id')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Get an instance', description: 'Scope: instances:read' })
  @ApiResponse({ status: 200, schema: INSTANCE_SCHEMA })
  get(@Param('id') id: string) {
    const ctx = currentTenant();
    requireScope(ctx, 'instances:read');
    return this.instances.get(ctx, uuidParam(id));
  }

  @Get(':id/status')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Normalised connection status', description: 'Scope: instances:read' })
  @ApiResponse({ status: 200, schema: STATUS_SCHEMA })
  status(@Param('id') id: string) {
    const ctx = currentTenant();
    requireScope(ctx, 'instances:read');
    return this.instances.status(ctx, uuidParam(id));
  }

  @Post(':id/connect')
  @HttpCode(202)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Start linking via QR code', description: 'Scope: instances:write. Asynchronous: subscribe to GET /events (SSE) for `whatsapp.instance.qr`, or poll GET /qr. The QR is never stored.' })
  @ApiResponse({ status: 202, schema: COMMAND_ACCEPTED_SCHEMA })
  @ApiResponse({ status: 409, description: 'WHATSAPP_INSTANCE_ALREADY_CONNECTED', schema: ERROR_SCHEMA })
  connect(@Param('id') id: string) { return this.run(id, 'CONNECT'); }

  @Post(':id/pairing-code')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Link using an 8-character pairing code instead of a QR', description: 'Scope: instances:write. Waits (bounded) for the code; enter it on the phone under Linked devices > Link with phone number.' })
  @ApiBody({ schema: { type: 'object', required: ['phoneNumber'], properties: { phoneNumber: { type: 'string', example: '+919812345678' } } } })
  @ApiResponse({ status: 201, schema: { type: 'object', properties: { pairingCode: { type: 'string' }, expiresInSeconds: { type: 'integer' } } } })
  @ApiResponse({ status: 504, description: 'WHATSAPP_PAIRING_CODE_UNAVAILABLE', schema: ERROR_SCHEMA })
  pairingCode(@Param('id') id: string, @Body() raw: unknown) {
    const ctx = currentTenant();
    requireScope(ctx, 'instances:write');
    return this.instances.requestPairingCode(ctx, uuidParam(id), str(obj(raw), 'phoneNumber', { min: 6, max: 32 }));
  }

  @Get(':id/qr')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Current QR code (ephemeral, in-memory only)', description: 'Scope: instances:write. 404 WHATSAPP_QR_NOT_AVAILABLE when none is pending.' })
  @ApiResponse({ status: 200, schema: { type: 'object', properties: { qr: { type: 'string' }, expiresAt: { type: 'string', format: 'date-time' } } } })
  qr(@Param('id') id: string) {
    const ctx = currentTenant();
    requireScope(ctx, 'instances:write'); // QR = authentication material: write scope required
    return this.instances.getQr(ctx, uuidParam(id));
  }

  @Sse(':id/events')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiProduces('text/event-stream')
  @ApiOperation({ summary: 'Realtime instance events (Server-Sent Events)',
    description: 'Scope: instances:write. Events: `whatsapp.instance.qr` {qr, expiresAt}, `whatsapp.instance.pairing_code` {pairingCode}, `whatsapp.instance.status` {status, reason}, `ping`. Only this tenant\'s events for this instance are ever emitted.' })
  async events(@Param('id') id: string): Promise<Observable<MessageEvent>> {
    const ctx = currentTenant();
    requireScope(ctx, 'instances:write');
    const instanceId = uuidParam(id);
    const initial = await this.instances.status(ctx, instanceId); // RLS ownership check BEFORE subscribing
    const cachedQr = initial.qrAvailable ? await this.instances.getQr(ctx, instanceId).catch(() => null) : null;
    const org = ctx.organizationId;
    return new Observable<MessageEvent>((sub) => {
      sub.next({ type: 'whatsapp.instance.status', data: { status: initial.status, reason: null } });
      if (cachedQr) sub.next({ type: 'whatsapp.instance.qr', data: cachedQr });
      const off = this.bus.subscribe((e) => {
        if (!e.type.startsWith('whatsapp.instance.')) return;                // connection events only
        if (e.organizationId !== org || e.instanceId !== instanceId) return; // tenant + instance filter
        sub.next({ type: e.type, data: e.data });
      });
      const ping = setInterval(() => sub.next({ type: 'ping', data: {} }), 25_000);
      return () => { off(); clearInterval(ping); };
    });
  }

  @Post(':id/restart')
  @HttpCode(202)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Restart the socket (auth kept, no QR)', description: 'Scope: instances:write' })
  @ApiResponse({ status: 202, schema: COMMAND_ACCEPTED_SCHEMA })
  restart(@Param('id') id: string) { return this.run(id, 'RESTART'); }

  @Post(':id/disconnect')
  @HttpCode(202)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Disconnect: close the socket, KEEP the linked device (reconnect later without QR)', description: 'Scope: instances:write' })
  @ApiResponse({ status: 202, schema: COMMAND_ACCEPTED_SCHEMA })
  disconnect(@Param('id') id: string) { return this.run(id, 'DISCONNECT'); }

  @Post(':id/logout')
  @HttpCode(202)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Logout: unlink the device on WhatsApp and destroy stored credentials (new QR required)', description: 'Scope: instances:write' })
  @ApiResponse({ status: 202, schema: COMMAND_ACCEPTED_SCHEMA })
  logout(@Param('id') id: string) { return this.run(id, 'LOGOUT'); }

  @Delete(':id')
  @HttpCode(202)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Delete: soft-delete the instance, log out and destroy credentials. Messages follow retention policies.', description: 'Scope: instances:write' })
  @ApiResponse({ status: 202, schema: COMMAND_ACCEPTED_SCHEMA })
  remove(@Param('id') id: string) { return this.run(id, 'DELETE'); }

  private run(id: string, command: 'CONNECT' | 'RESTART' | 'DISCONNECT' | 'LOGOUT' | 'DELETE') {
    const ctx = currentTenant();
    requireScope(ctx, 'instances:write');
    return this.instances.command(ctx, uuidParam(id), command);
  }
}
