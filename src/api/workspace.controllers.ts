import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiQuery, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { pageLimit } from '../common/cursor.js';
import { obj, optStr, str, uuidParam } from '../common/validation.js';
import type { MemberRole } from '../database/tenant-context.js';
import { currentTenant } from '../database/tenant-context.js';
import { WhatsAppError } from '../whatsapp/domain/whatsapp-errors.js';
import { WhatsAppMessageService } from '../whatsapp/services/whatsapp-message.service.js';
import { requireScope, requireUser } from './auth/permissions.js';
import { WorkspaceService, type BusinessInput } from './workspace.service.js';

const optUuid = (v: unknown, name: string) => (v === undefined || v === '' ? undefined : uuidParam(v, name));
const ROLE_VALUES = ['OWNER', 'ADMIN', 'MANAGER', 'AGENT', 'VIEWER'];

@ApiTags('Dashboard')
@ApiBearerAuth('session')
@ApiSecurity('api-key')
@Controller('v1/dashboard')
export class DashboardController {
  constructor(@Inject(WorkspaceService) private readonly ws: WorkspaceService) {}

  @Get('summary')
  @ApiQuery({ name: 'businessId', required: false })
  @ApiOperation({ summary: 'Live counters for the dashboard (scope instances:read). Messages today come from the usage ledger.' })
  summary(@Query('businessId') businessId?: string) {
    const ctx = currentTenant();
    requireScope(ctx, 'instances:read');
    return this.ws.dashboard(ctx, optUuid(businessId, 'businessId'));
  }
}

@ApiTags('Inbox')
@ApiBearerAuth('session')
@ApiSecurity('api-key')
@Controller('v1/conversations')
export class ConversationsController {
  constructor(@Inject(WorkspaceService) private readonly ws: WorkspaceService, @Inject(WhatsAppMessageService) private readonly messages: WhatsAppMessageService) {}

  @Get()
  @ApiQuery({ name: 'filter', required: false, enum: ['all', 'unread', 'open', 'resolved'] })
  @ApiQuery({ name: 'businessId', required: false }) @ApiQuery({ name: 'instanceId', required: false })
  @ApiQuery({ name: 'search', required: false }) @ApiQuery({ name: 'cursor', required: false }) @ApiQuery({ name: 'limit', required: false })
  @ApiOperation({ summary: 'Conversation list, newest activity first, cursor-paginated (scope messages:read)' })
  list(@Query() q: Record<string, string>) {
    const ctx = currentTenant();
    requireScope(ctx, 'messages:read');
    if (q.filter && !['all', 'unread', 'open', 'resolved'].includes(q.filter)) throw new WhatsAppError('VALIDATION_FAILED', 'invalid filter');
    return this.ws.listConversations(ctx, { businessId: optUuid(q.businessId, 'businessId'), instanceId: optUuid(q.instanceId, 'instanceId'),
      filter: q.filter, search: q.search ? str(q, 'search', { max: 100 }) : undefined, cursor: q.cursor, limit: pageLimit(q.limit, 30, 100) });
  }

  @Get(':id')
  get(@Param('id') id: string) {
    const ctx = currentTenant();
    requireScope(ctx, 'messages:read');
    return this.ws.getConversation(ctx, uuidParam(id));
  }

  @Get(':id/messages')
  @ApiQuery({ name: 'cursor', required: false }) @ApiQuery({ name: 'limit', required: false })
  @ApiOperation({ summary: 'Messages, newest first, keyset-paginated (scope messages:read)' })
  messagesPage(@Param('id') id: string, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    const ctx = currentTenant();
    requireScope(ctx, 'messages:read');
    return this.ws.listMessages(ctx, uuidParam(id), { cursor, limit: pageLimit(limit, 40, 100) });
  }

  @Post(':id/messages')
  @HttpCode(202)
  @ApiOperation({ summary: 'Reply in a conversation (scope messages:send). clientRequestId (UUID) makes retries/double-clicks idempotent.' })
  @ApiBody({ schema: { type: 'object', required: ['text', 'clientRequestId'], properties: { text: { type: 'string', maxLength: 4096 }, clientRequestId: { type: 'string', format: 'uuid' } } } })
  send(@Param('id') id: string, @Body() raw: unknown) {
    const ctx = currentTenant();
    requireScope(ctx, 'messages:send');
    const b = obj(raw);
    return this.messages.sendToConversation(ctx, uuidParam(id), { text: str(b, 'text', { min: 1, max: 4096 }), clientRequestId: str(b, 'clientRequestId') });
  }

  @Post(':id/read')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mark conversation read (scope messages:send)' })
  read(@Param('id') id: string) {
    const ctx = currentTenant();
    requireScope(ctx, 'messages:send');
    return this.ws.markRead(ctx, uuidParam(id));
  }

  @Patch(':id')
  @ApiBody({ schema: { type: 'object', required: ['status'], properties: { status: { type: 'string', enum: ['OPEN', 'RESOLVED'] } } } })
  @ApiOperation({ summary: 'Resolve / reopen (scope messages:send)' })
  update(@Param('id') id: string, @Body() raw: unknown) {
    const ctx = currentTenant();
    requireScope(ctx, 'messages:send');
    const status = str(obj(raw), 'status');
    if (status !== 'OPEN' && status !== 'RESOLVED') throw new WhatsAppError('VALIDATION_FAILED', 'status must be OPEN or RESOLVED');
    return this.ws.setConversationStatus(ctx, uuidParam(id), status);
  }

  @Post(':id/handling')
  @HttpCode(200)
  @ApiBody({ schema: { type: 'object', required: ['mode'], properties: { mode: { type: 'string', enum: ['AI', 'HUMAN'] } } } })
  @ApiOperation({ summary: 'Take over from the AI assistant (HUMAN) or hand back (AI). Scope messages:send.' })
  handling(@Param('id') id: string, @Body() raw: unknown) {
    const ctx = currentTenant();
    requireScope(ctx, 'messages:send');
    const mode = str(obj(raw), 'mode');
    if (mode !== 'AI' && mode !== 'HUMAN') throw new WhatsAppError('VALIDATION_FAILED', 'mode must be AI or HUMAN');
    return this.ws.setHandlingMode(ctx, uuidParam(id), mode);
  }
}

@ApiTags('Contacts')
@ApiBearerAuth('session')
@ApiSecurity('api-key')
@Controller('v1/contacts')
export class ContactsController {
  constructor(@Inject(WorkspaceService) private readonly ws: WorkspaceService) {}

  @Get()
  @ApiQuery({ name: 'businessId', required: false }) @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'cursor', required: false }) @ApiQuery({ name: 'limit', required: false })
  list(@Query() q: Record<string, string>) {
    const ctx = currentTenant();
    requireScope(ctx, 'messages:read');
    return this.ws.listContacts(ctx, { businessId: optUuid(q.businessId, 'businessId'), search: q.search ? str(q, 'search', { max: 100 }) : undefined,
      cursor: q.cursor, limit: pageLimit(q.limit, 30, 100) });
  }

  @Get(':id')
  get(@Param('id') id: string) {
    const ctx = currentTenant();
    requireScope(ctx, 'messages:read');
    return this.ws.getContact(ctx, uuidParam(id));
  }
}

@ApiTags('Organization')
@ApiBearerAuth('session')
@Controller('v1/organization')
export class OrganizationController {
  constructor(@Inject(WorkspaceService) private readonly ws: WorkspaceService) {}

  @Get()
  get() {
    const ctx = currentTenant();
    requireUser(ctx, ['OWNER', 'ADMIN', 'MANAGER', 'AGENT', 'VIEWER']);
    return this.ws.getOrganization(ctx);
  }

  @Patch()
  @ApiOperation({ summary: 'Update organization settings (OWNER/ADMIN)' })
  @ApiBody({ schema: { type: 'object', properties: { name: { type: 'string' }, timezone: { type: 'string' }, countryCode: { type: 'string' }, currency: { type: 'string' } } } })
  async update(@Body() raw: unknown) {
    const ctx = currentTenant();
    requireUser(ctx, ['OWNER', 'ADMIN']);
    const b = obj(raw);
    try {
      return await this.ws.updateOrganization(ctx, { name: optStr(b, 'name', { min: 1, max: 200 }), timezone: optStr(b, 'timezone', { max: 64 }),
        countryCode: optStr(b, 'countryCode', { pattern: /^[A-Z]{2}$/ }), currency: optStr(b, 'currency', { pattern: /^[A-Z]{3}$/ }) });
    } catch (err) {
      if ((err as { code?: string }).code === '23514') throw new WhatsAppError('VALIDATION_FAILED', 'invalid timezone, country or currency');
      throw err;
    }
  }
}

function businessBody(raw: unknown, requireName: boolean): BusinessInput {
  const b = obj(raw);
  const isObj = (v: unknown) => v === undefined || (typeof v === 'object' && v !== null && !Array.isArray(v));
  if (!isObj(b.address) || !isObj(b.businessHours)) throw new WhatsAppError('VALIDATION_FAILED', 'address and businessHours must be objects');
  if (b.address && Object.values(b.address as object).some((v) => typeof v !== 'string' || v.length > 200)) throw new WhatsAppError('VALIDATION_FAILED', 'address values must be short strings');
  if (b.businessHours && JSON.stringify(b.businessHours).length > 4000) throw new WhatsAppError('VALIDATION_FAILED', 'businessHours too large');
  return {
    name: requireName ? str(b, 'name', { min: 1, max: 200 }) : optStr(b, 'name', { min: 1, max: 200 }),
    industry: b.industry === '' ? '' : optStr(b, 'industry', { pattern: /^[A-Z][A-Z0-9_]{1,63}$/ }),
    description: optStr(b, 'description', { max: 2000 }),
    phone: b.phone === '' ? '' : optStr(b, 'phone', { max: 32 }),
    email: b.email === '' ? '' : optStr(b, 'email', { max: 320, pattern: /^[^@\s]+@[^@\s]+\.[^@\s]+$/ }),
    website: b.website === '' ? '' : optStr(b, 'website', { max: 300, pattern: /^https?:\/\// }),
    timezone: optStr(b, 'timezone', { max: 64 }), currency: optStr(b, 'currency', { pattern: /^[A-Z]{3}$/ }),
    countryCode: optStr(b, 'countryCode', { pattern: /^[A-Z]{2}$/ }),
    address: b.address as Record<string, string> | undefined, businessHours: b.businessHours as Record<string, unknown> | undefined,
  };
}

const BUSINESS_BODY = { type: 'object', properties: { name: { type: 'string' }, industry: { type: 'string', example: 'DENTAL_CLINIC' }, description: { type: 'string' },
  phone: { type: 'string' }, email: { type: 'string' }, website: { type: 'string' }, timezone: { type: 'string' }, currency: { type: 'string' },
  countryCode: { type: 'string' }, address: { type: 'object' }, businessHours: { type: 'object' } } };

@ApiTags('Businesses')
@ApiBearerAuth('session')
@ApiSecurity('api-key')
@Controller('v1/businesses')
export class BusinessesController {
  constructor(@Inject(WorkspaceService) private readonly ws: WorkspaceService) {}

  @Get()
  list() {
    const ctx = currentTenant();
    requireScope(ctx, 'instances:read');
    return this.ws.listBusinesses(ctx);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    const ctx = currentTenant();
    requireScope(ctx, 'instances:read');
    return this.ws.getBusiness(ctx, uuidParam(id));
  }

  @Post()
  @ApiOperation({ summary: 'Create a business (OWNER/ADMIN)' })
  @ApiBody({ schema: BUSINESS_BODY })
  create(@Body() raw: unknown) {
    const ctx = currentTenant();
    requireUser(ctx, ['OWNER', 'ADMIN']);
    return this.ws.upsertBusiness(ctx, null, businessBody(raw, true));
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update business settings (OWNER/ADMIN)' })
  @ApiBody({ schema: BUSINESS_BODY })
  update(@Param('id') id: string, @Body() raw: unknown) {
    const ctx = currentTenant();
    requireUser(ctx, ['OWNER', 'ADMIN']);
    return this.ws.upsertBusiness(ctx, uuidParam(id), businessBody(raw, false));
  }
}

@ApiTags('Team')
@ApiBearerAuth('session')
@Controller('v1/team')
export class TeamController {
  constructor(@Inject(WorkspaceService) private readonly ws: WorkspaceService) {}

  @Get('members')
  members() {
    const ctx = currentTenant();
    requireUser(ctx, ['OWNER', 'ADMIN', 'MANAGER', 'AGENT', 'VIEWER']);
    return this.ws.listMembers(ctx);
  }

  @Post('invitations')
  @ApiOperation({ summary: 'Invite an EXISTING account by email (OWNER/ADMIN). Counts toward TEAM_MEMBERS. The invitee accepts in-app.' })
  @ApiBody({ schema: { type: 'object', required: ['email', 'role'], properties: { email: { type: 'string' }, role: { type: 'string', enum: ROLE_VALUES } } } })
  invite(@Body() raw: unknown) {
    const ctx = currentTenant();
    requireUser(ctx, ['OWNER', 'ADMIN']);
    const b = obj(raw);
    return this.ws.invite(ctx, str(b, 'email', { max: 320 }), str(b, 'role') as MemberRole);
  }

  @Patch('members/:userId')
  @ApiBody({ schema: { type: 'object', required: ['role'], properties: { role: { type: 'string', enum: ROLE_VALUES } } } })
  changeRole(@Param('userId') userId: string, @Body() raw: unknown) {
    const ctx = currentTenant();
    requireUser(ctx, ['OWNER', 'ADMIN']);
    return this.ws.changeRole(ctx, uuidParam(userId), str(obj(raw), 'role') as MemberRole);
  }

  @Delete('members/:userId')
  remove(@Param('userId') userId: string) {
    const ctx = currentTenant();
    requireUser(ctx, ['OWNER', 'ADMIN']);
    return this.ws.removeMember(ctx, uuidParam(userId));
  }
}

@ApiTags('Usage & billing')
@ApiBearerAuth('session')
@Controller('v1')
export class UsageBillingController {
  constructor(@Inject(WorkspaceService) private readonly ws: WorkspaceService) {}

  @Get('usage')
  @ApiQuery({ name: 'period', required: false, enum: ['current', 'previous'] })
  usage(@Query('period') period?: string) {
    const ctx = currentTenant();
    requireUser(ctx, ['OWNER', 'ADMIN', 'MANAGER']);
    return this.ws.usage(ctx, period === 'previous' ? 'previous' : 'current');
  }

  @Get('billing')
  @ApiOperation({ summary: 'Plan, entitlements with usage, invoices. Payments are not enabled yet.' })
  billing() {
    const ctx = currentTenant();
    requireUser(ctx, ['OWNER', 'ADMIN']);
    return this.ws.billing(ctx);
  }

  @Get('audit-logs')
  @ApiQuery({ name: 'cursor', required: false })
  auditLogs(@Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    const ctx = currentTenant();
    requireUser(ctx, ['OWNER', 'ADMIN']);
    return this.ws.auditLog(ctx, { cursor, limit: pageLimit(limit, 50, 100) });
  }

  @Get('notifications')
  @ApiQuery({ name: 'cursor', required: false }) @ApiQuery({ name: 'unreadOnly', required: false })
  notifications(@Query('cursor') cursor?: string, @Query('unreadOnly') unreadOnly?: string) {
    const ctx = currentTenant();
    requireUser(ctx, ['OWNER', 'ADMIN', 'MANAGER', 'AGENT', 'VIEWER']);
    return this.ws.notifications(ctx, { cursor, limit: 20, unreadOnly: unreadOnly === 'true' });
  }

  @Post('notifications/read-all')
  @HttpCode(200)
  readAll() {
    const ctx = currentTenant();
    requireUser(ctx, ['OWNER', 'ADMIN', 'MANAGER', 'AGENT', 'VIEWER']);
    return this.ws.markNotificationsRead(ctx);
  }

  @Post('notifications/:id/read')
  @HttpCode(200)
  readOne(@Param('id') id: string) {
    const ctx = currentTenant();
    requireUser(ctx, ['OWNER', 'ADMIN', 'MANAGER', 'AGENT', 'VIEWER']);
    return this.ws.markNotificationsRead(ctx, uuidParam(id));
  }
}
