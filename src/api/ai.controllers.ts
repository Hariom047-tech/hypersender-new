import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AssistantAdminService } from '../ai/admin/assistant-admin.service.js';
import { validateInstructions } from '../ai/admin/instruction-validator.js';
import { SandboxService } from '../ai/admin/sandbox.service.js';
import { obj, optStr, str, uuidParam } from '../common/validation.js';
import { currentTenant } from '../database/tenant-context.js';
import { WhatsAppError } from '../whatsapp/domain/whatsapp-errors.js';
import { requireScope, requireUser } from './auth/permissions.js';

const KEY_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const keyParam = (v: string, name: string) => { if (!KEY_RE.test(v)) throw new WhatsAppError('VALIDATION_FAILED', `invalid ${name}`); return v; };

@ApiTags('AI Assistants')
@ApiBearerAuth('session')
@Controller('v1/ai/templates')
export class AiTemplatesController {
  constructor(@Inject(AssistantAdminService) private readonly admin: AssistantAdminService) {}

  @Get()
  @ApiOperation({ summary: 'Assistant template catalog (platform templates; never includes internal instructions)' })
  list() {
    requireScope(currentTenant(), 'assistants:read');
    return this.admin.catalog();
  }

  @Get(':key')
  get(@Param('key') key: string) {
    requireScope(currentTenant(), 'assistants:read');
    return this.admin.template(keyParam(key, 'template key'));
  }
}

@ApiTags('AI Assistants')
@ApiBearerAuth('session')
@Controller('v1/ai/assistants')
export class AiAssistantsController {
  constructor(@Inject(AssistantAdminService) private readonly admin: AssistantAdminService, @Inject(SandboxService) private readonly sandbox: SandboxService) {}

  private manage() {
    const ctx = currentTenant();
    requireScope(ctx, 'assistants:manage');
    requireUser(ctx, ['OWNER', 'ADMIN', 'MANAGER']);
    return ctx;
  }

  @Get()
  list() {
    const ctx = currentTenant();
    requireScope(ctx, 'assistants:read');
    return this.admin.list(ctx);
  }

  @Post()
  @ApiBody({ schema: { type: 'object', required: ['templateKey', 'businessId', 'name'], properties: {
    templateKey: { type: 'string' }, businessId: { type: 'string', format: 'uuid' }, name: { type: 'string' }, tone: { type: 'object' },
    primaryLanguage: { type: 'string' }, supportedLanguages: { type: 'array', items: { type: 'string' } }, capabilities: { type: 'object' },
    customInstructions: { type: 'string' } } } })
  @ApiOperation({ summary: 'Install a template as a new DRAFT assistant (copies template defaults; plan limit MAX_AI_AGENTS)' })
  create(@Body() raw: unknown) {
    const ctx = this.manage();
    const b = obj(raw);
    const caps = b.capabilities === undefined ? undefined : obj(b.capabilities);
    if (caps && !Object.values(caps).every((v) => typeof v === 'boolean')) throw new WhatsAppError('VALIDATION_FAILED', 'capabilities must map keys to booleans');
    if (b.supportedLanguages !== undefined && !Array.isArray(b.supportedLanguages)) throw new WhatsAppError('VALIDATION_FAILED', 'supportedLanguages must be an array');
    return this.admin.install(ctx, { templateKey: keyParam(str(b, 'templateKey'), 'templateKey'), businessId: uuidParam(b.businessId, 'businessId'),
      name: str(b, 'name', { min: 1, max: 100 }), tone: b.tone === undefined ? undefined : obj(b.tone), primaryLanguage: optStr(b, 'primaryLanguage', { max: 10 }),
      supportedLanguages: b.supportedLanguages as string[] | undefined, capabilities: caps as Record<string, boolean> | undefined,
      customInstructions: optStr(b, 'customInstructions', { max: 40000 }) });
  }

  @Get(':id')
  get(@Param('id') id: string) {
    const ctx = currentTenant();
    requireScope(ctx, 'assistants:read');
    return this.admin.get(ctx, uuidParam(id));
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update identity, tone, languages, instructions, welcome, handoff and response wait' })
  update(@Param('id') id: string, @Body() raw: unknown) {
    const b = obj(raw);
    return this.admin.update(this.manage(), uuidParam(id), { name: b.name, description: b.description, tone: b.tone === undefined ? undefined : obj(b.tone),
      primaryLanguage: b.primaryLanguage, supportedLanguages: b.supportedLanguages, customInstructions: b.customInstructions, instructionsMode: b.instructionsMode,
      welcome: b.welcome === undefined ? undefined : obj(b.welcome), handoff: b.handoff === undefined ? undefined : obj(b.handoff), responseWaitMs: b.responseWaitMs });
  }

  @Put(':id/capabilities/:key')
  @ApiBody({ schema: { type: 'object', properties: { enabled: { type: 'boolean' }, configuration: { type: 'object' } } } })
  @ApiOperation({ summary: 'Enable/disable a capability or change its settings (validated against the capability settings schema)' })
  capability(@Param('id') id: string, @Param('key') key: string, @Body() raw: unknown) {
    const b = obj(raw);
    return this.admin.setCapability(this.manage(), uuidParam(id), keyParam(key, 'capability'), { enabled: b.enabled, configuration: b.configuration });
  }

  @Put(':id/whatsapp')
  @ApiBody({ schema: { type: 'object', properties: { whatsappInstanceId: { type: 'string', format: 'uuid', nullable: true } } } })
  @ApiOperation({ summary: 'Choose the WhatsApp number this assistant answers (one active assistant per number)' })
  channel(@Param('id') id: string, @Body() raw: unknown) {
    const b = obj(raw);
    return this.admin.setChannel(this.manage(), uuidParam(id), b.whatsappInstanceId === null ? null : uuidParam(b.whatsappInstanceId, 'whatsappInstanceId'));
  }

  @Get(':id/readiness')
  readiness(@Param('id') id: string) {
    const ctx = currentTenant();
    requireScope(ctx, 'assistants:read');
    return this.admin.readiness(ctx, uuidParam(id));
  }

  @Post(':id/instructions/validate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Review custom instructions (never rewrites them)' })
  validate(@Param('id') id: string, @Body() raw: unknown) {
    this.manage();
    uuidParam(id);
    return { issues: validateInstructions(optStr(obj(raw), 'text', { max: 40000 }) ?? '', { handoffEnabled: true }) };
  }

  @Post(':id/publish')
  @HttpCode(200)
  @ApiOperation({ summary: 'Validate and publish: snapshot a new immutable version and go ACTIVE' })
  publish(@Param('id') id: string) { return this.admin.publish(this.manage(), uuidParam(id)); }

  @Post(':id/pause')
  @HttpCode(200)
  pause(@Param('id') id: string) { return this.admin.setStatus(this.manage(), uuidParam(id), 'PAUSED'); }

  @Post(':id/resume')
  @HttpCode(200)
  resume(@Param('id') id: string) { return this.admin.setStatus(this.manage(), uuidParam(id), 'ACTIVE'); }

  @Post(':id/archive')
  @HttpCode(200)
  archive(@Param('id') id: string) { return this.admin.setStatus(this.manage(), uuidParam(id), 'ARCHIVED'); }

  @Get(':id/knowledge')
  knowledge(@Param('id') id: string) {
    const ctx = currentTenant();
    requireScope(ctx, 'assistants:read');
    return this.admin.listKnowledge(ctx, uuidParam(id));
  }

  @Post(':id/knowledge')
  @ApiBody({ schema: { type: 'object', required: ['type', 'title'], properties: { type: { type: 'string', enum: ['TEXT', 'FAQ', 'CSV'] }, title: { type: 'string' },
    content: { type: 'string' }, faqs: { type: 'array', items: { type: 'object', properties: { q: { type: 'string' }, a: { type: 'string' } } } },
    scope: { type: 'string', enum: ['ASSISTANT', 'BUSINESS'] } } } })
  addKnowledge(@Param('id') id: string, @Body() raw: unknown) {
    return this.admin.addKnowledge(this.manage(), uuidParam(id), obj(raw));
  }

  @Post(':id/knowledge/starter')
  @HttpCode(200)
  @ApiOperation({ summary: 'Add the template\'s researched starter knowledge (skips sources already present)' })
  addStarterKnowledge(@Param('id') id: string) {
    return this.admin.addStarterKnowledge(this.manage(), uuidParam(id));
  }

  @Delete(':id/knowledge/:sourceId')
  deleteKnowledge(@Param('id') id: string, @Param('sourceId') sourceId: string) {
    return this.admin.deleteKnowledge(this.manage(), uuidParam(id), uuidParam(sourceId, 'sourceId'));
  }

  @Get(':id/activity')
  activity(@Param('id') id: string) {
    const ctx = currentTenant();
    requireScope(ctx, 'assistants:read');
    return this.admin.activity(ctx, uuidParam(id));
  }

  @Post(':id/test-sessions')
  @ApiOperation({ summary: 'Start a Test Assistant chat (DRY_RUN: nothing is sent or written)' })
  createSession(@Param('id') id: string, @Body() raw: unknown) {
    return this.sandbox.create(this.manage(), uuidParam(id), optStr(obj(raw ?? {}), 'customerName', { max: 60 }));
  }

  @Get(':id/test-sessions/:sid')
  getSession(@Param('id') id: string, @Param('sid') sid: string) {
    return this.sandbox.get(this.manage(), uuidParam(id), uuidParam(sid, 'sessionId'));
  }

  @Post(':id/test-sessions/:sid/messages')
  @HttpCode(200)
  @ApiBody({ schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } } })
  @ApiOperation({ summary: 'Send a test customer message; returns the assistant reply and an operational trace (no reasoning)' })
  send(@Param('id') id: string, @Param('sid') sid: string, @Body() raw: unknown) {
    return this.sandbox.send(this.manage(), uuidParam(id), uuidParam(sid, 'sessionId'), str(obj(raw), 'text', { min: 1, max: 2000 }));
  }
}

