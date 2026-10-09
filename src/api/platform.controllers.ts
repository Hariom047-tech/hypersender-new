import { timingSafeEqual } from 'node:crypto';
import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiExcludeController, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { obj, optStr, str, strArray, uuidParam } from '../common/validation.js';
import { currentTenant } from '../database/tenant-context.js';
import { APP_TX, TransactionRunner } from '../database/transaction-runner.js';
import { IdentityRepository } from '../repositories/identity.repository.js';
import { ApiKeyService, type ApiScope } from '../services/api-key.service.js';
import { EmailAlreadyRegisteredError, OnboardingService, SlugTakenError } from '../services/onboarding.service.js';
import { WebhookService } from '../services/webhook.service.js';
import { GoogleSignInService } from '../services/google-signin.service.js';
import { InvalidPhoneNumberError, toE164 } from '../whatsapp/domain/phone.js';
import { WhatsAppError } from '../whatsapp/domain/whatsapp-errors.js';
import { requireScope, requireUser } from './auth/permissions.js';
import { pageLimit } from '../common/cursor.js';
import { DeveloperService } from './developer.service.js';
import { assertSafeWebhookUrl, UnsafeWebhookTargetError } from '../whatsapp/services/webhook-http-sender.js';

async function checkWebhookUrl(url: string): Promise<void> {
  try {
    await assertSafeWebhookUrl(url, process.env.WEBHOOK_ALLOW_PRIVATE_NETWORKS === 'true' && process.env.NODE_ENV !== 'production');
  } catch (err) {
    if (err instanceof UnsafeWebhookTargetError) throw new WhatsAppError('VALIDATION_FAILED', `Webhook URL rejected: ${err.message}`);
    throw err;
  }
}
import { HmacSessionService } from './auth/session.service.js';

const HTTPS_RE = /^https:\/\//;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const API_SCOPES: ApiScope[] = ['instances:read', 'instances:write', 'messages:send', 'messages:read', 'webhooks:manage'];
const WEBHOOK_EVENTS = ['INSTANCE_CONNECTED', 'INSTANCE_DISCONNECTED', 'INSTANCE_STATUS_CHANGED', 'MESSAGE_RECEIVED', 'MESSAGE_SENT',
  'MESSAGE_DELIVERED', 'MESSAGE_READ', 'MESSAGE_FAILED', 'MESSAGE_REVOKED', 'MESSAGE_REACTION', 'OTP_VERIFIED'];

/** undefined = not sent, null/"" = remove. Header values cannot carry line breaks (header injection). */
function authHeaderInput(b: Record<string, unknown>): string | null | undefined {
  if (b.authorizationHeader === undefined) return undefined;
  if (b.authorizationHeader === null || b.authorizationHeader === '') return null;
  return str(b, 'authorizationHeader', { min: 1, max: 500, pattern: /^[ -~]+$/ });
}

/** Minimal dashboard auth (sign-up / login). Not tenant-scoped: excluded from the tenant middleware. */
@ApiTags('Auth (dashboard)')
@Controller('v1/auth')
export class AuthController {
  constructor(
    @Inject(OnboardingService) private readonly onboarding: OnboardingService,
    @Inject(HmacSessionService) private readonly sessions: HmacSessionService,
    @Inject(APP_TX) private readonly tx: TransactionRunner,
    @Inject(IdentityRepository) private readonly identity: IdentityRepository,
    @Inject(GoogleSignInService) private readonly google: GoogleSignInService,
  ) {}

  @Post('signup')
  @ApiOperation({ summary: 'Create user + organization (trial). Returns a session token.' })
  @ApiBody({ schema: { type: 'object', required: ['email', 'password', 'organizationName', 'organizationSlug'], properties: {
    email: { type: 'string' }, password: { type: 'string', minLength: 8 }, firstName: { type: 'string' },
    organizationName: { type: 'string' }, organizationSlug: { type: 'string' }, timezone: { type: 'string' } } } })
  async signup(@Body() raw: unknown) {
    const b = obj(raw);
    try {
      const r = await this.onboarding.signUp({ email: str(b, 'email', { max: 320 }), password: str(b, 'password', { min: 8, max: 1024 }),
        firstName: optStr(b, 'firstName', { max: 100 }), organizationName: str(b, 'organizationName', { max: 200 }),
        organizationSlug: str(b, 'organizationSlug', { max: 63 }), timezone: optStr(b, 'timezone', { max: 64 }) });
      return { ...r, token: this.sessions.issue(r.userId) };
    } catch (err) {
      if (err instanceof EmailAlreadyRegisteredError || err instanceof SlugTakenError) throw new WhatsAppError('VALIDATION_FAILED', 'email or slug already in use');
      throw err;
    }
  }

  @Post('register')
  @ApiOperation({ summary: 'Create an account (no organization yet). Returns a session token (consumed by the web BFF, stored in an HttpOnly cookie).' })
  @ApiBody({ schema: { type: 'object', required: ['email', 'password'], properties: { email: { type: 'string' }, password: { type: 'string', minLength: 8 },
    firstName: { type: 'string' }, lastName: { type: 'string' }, phone: { type: 'string', description: 'Mobile number; Indian numbers may omit +91' } } } })
  async register(@Body() raw: unknown) {
    const b = obj(raw);
    const phone = optStr(b, 'phone', { max: 32 });
    let phoneE164: string | null = null;
    if (phone) {
      try { phoneE164 = toE164(phone, 'IN'); } catch (err) {
        if (err instanceof InvalidPhoneNumberError) throw new WhatsAppError('VALIDATION_FAILED', 'Enter a valid mobile number.');
        throw err;
      }
    }
    try {
      const r = await this.onboarding.register({ email: str(b, 'email', { max: 320, pattern: EMAIL_RE }),
        password: str(b, 'password', { min: 8, max: 1024 }), firstName: optStr(b, 'firstName', { max: 100 }), lastName: optStr(b, 'lastName', { max: 100 }), phoneE164 });
      return { ...r, token: this.sessions.issue(r.userId) };
    } catch (err) {
      if (err instanceof EmailAlreadyRegisteredError) throw new WhatsAppError('CONFLICT', 'An account with this email already exists. Sign in instead.');
      throw err;
    }
  }

  @Post('google/authorize-url')
  @HttpCode(200)
  @ApiOperation({ summary: 'Google sign-in step 1 (web BFF): consent URL for the given state and S256 PKCE challenge.' })
  googleAuthorizeUrl(@Body() raw: unknown) {
    const b = obj(raw);
    return { url: this.google.authorizeUrl(str(b, 'state', { max: 128 }), str(b, 'codeChallenge', { max: 128 }), optStr(b, 'loginHint', { max: 320 })) };
  }

  @Post('google')
  @HttpCode(200)
  @ApiOperation({ summary: 'Google sign-in step 2 (web BFF): exchanges the code; signs in or creates the account for the verified Google email.' })
  async googleSignIn(@Body() raw: unknown) {
    const b = obj(raw);
    const profile = await this.google.profile(str(b, 'code', { max: 2048 }), str(b, 'codeVerifier', { max: 128 }));
    const r = await this.onboarding.googleSignIn(profile);
    if (!r) throw new WhatsAppError('UNAUTHENTICATED', 'This account cannot sign in. Contact your workspace owner.');
    const organizations = await this.tx.run({ userId: r.userId }, (db) => this.identity.listMyOrganizations(db));
    return { token: this.sessions.issue(r.userId), userId: r.userId, created: r.created, organizations };
  }

  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Login. Returns a session token and the organizations you belong to.' })
  @ApiBody({ schema: { type: 'object', required: ['email', 'password'], properties: { email: { type: 'string' }, password: { type: 'string' } } } })
  async login(@Body() raw: unknown) {
    const b = obj(raw);
    const userId = await this.onboarding.login(str(b, 'email', { max: 320 }), str(b, 'password', { max: 1024 }));
    if (!userId) throw new WhatsAppError('UNAUTHENTICATED', 'invalid credentials');
    const organizations = await this.tx.run({ userId }, (db) => this.identity.listMyOrganizations(db));
    return { token: this.sessions.issue(userId), userId, organizations };
  }
}

@ApiTags('API keys')
@ApiBearerAuth('session')
@Controller('v1/api-keys')
export class ApiKeysController {
  constructor(@Inject(ApiKeyService) private readonly keys: ApiKeyService) {}

  @Post()
  @ApiOperation({ summary: 'Create an API key (OWNER/ADMIN). The plaintext key is returned ONCE.' })
  @ApiBody({ schema: { type: 'object', required: ['name', 'scopes'], properties: { name: { type: 'string' },
    scopes: { type: 'array', items: { type: 'string', enum: API_SCOPES } }, businessId: { type: 'string', format: 'uuid' },
    expiresAt: { type: 'string', format: 'date-time' } } } })
  create(@Body() raw: unknown) {
    const ctx = currentTenant();
    requireUser(ctx, ['OWNER', 'ADMIN']);
    const b = obj(raw);
    const expires = optStr(b, 'expiresAt');
    return this.keys.create(ctx, { name: str(b, 'name', { max: 100 }), scopes: strArray(b, 'scopes', API_SCOPES) as ApiScope[],
      businessId: b.businessId ? uuidParam(b.businessId, 'businessId') : undefined, expiresAt: expires ? new Date(expires) : undefined });
  }

  @Get()
  @ApiOperation({ summary: 'List API keys (OWNER/ADMIN). Never returns key material or hashes.' })
  list() {
    const ctx = currentTenant();
    requireUser(ctx, ['OWNER', 'ADMIN']);
    return this.keys.list(ctx);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Revoke an API key (takes effect immediately, including in-flight requests)' })
  async revoke(@Param('id') id: string) {
    const ctx = currentTenant();
    requireUser(ctx, ['OWNER', 'ADMIN']);
    return { revoked: await this.keys.revoke(ctx, uuidParam(id)) };
  }
}

@ApiTags('Webhooks')
@ApiBearerAuth('session')
@ApiSecurity('api-key')
@Controller('v1/webhooks')
export class WebhooksController {
  constructor(@Inject(WebhookService) private readonly webhooks: WebhookService, @Inject(DeveloperService) private readonly dev: DeveloperService) {}

  @Get()
  @ApiOperation({ summary: 'List webhook endpoints with last success/failure (scope webhooks:manage)' })
  list() {
    const ctx = currentTenant();
    requireScope(ctx, 'webhooks:manage');
    return this.dev.listWebhooks(ctx);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    const ctx = currentTenant();
    requireScope(ctx, 'webhooks:manage');
    return this.dev.getWebhook(ctx, uuidParam(id));
  }

  @Patch(':id')
  @ApiBody({ schema: { type: 'object', properties: { name: { type: 'string' }, url: { type: 'string' }, enabled: { type: 'boolean' },
    eventTypes: { type: 'array', items: { type: 'string', enum: WEBHOOK_EVENTS } },
    authorizationHeader: { type: 'string', nullable: true, maxLength: 500, description: 'Sent as the Authorization header on every delivery; null removes it' } } } })
  async update(@Param('id') id: string, @Body() raw: unknown) {
    const ctx = currentTenant();
    requireScope(ctx, 'webhooks:manage');
    const b = obj(raw);
    const url = optStr(b, 'url', { max: 2048, pattern: HTTPS_RE });
    if (url) await checkWebhookUrl(url);
    if (b.enabled !== undefined && typeof b.enabled !== 'boolean') throw new WhatsAppError('VALIDATION_FAILED', 'enabled must be boolean');
    const authHeader = authHeaderInput(b);
    if (authHeader !== undefined) await this.webhooks.setAuthHeader(ctx, uuidParam(id), authHeader);
    return this.dev.updateWebhook(ctx, uuidParam(id), { name: optStr(b, 'name', { min: 1, max: 100 }), url, enabled: b.enabled as boolean | undefined,
      eventTypes: b.eventTypes === undefined ? undefined : strArray(b, 'eventTypes', WEBHOOK_EVENTS) });
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    const ctx = currentTenant();
    requireScope(ctx, 'webhooks:manage');
    return this.dev.deleteWebhook(ctx, uuidParam(id));
  }

  @Post(':id/test')
  @HttpCode(202)
  @ApiOperation({ summary: 'Send a WEBHOOK_TEST event to this endpoint only' })
  test(@Param('id') id: string) {
    const ctx = currentTenant();
    requireScope(ctx, 'webhooks:manage');
    return this.dev.sendTest(ctx, uuidParam(id));
  }

  @Get(':id/deliveries')
  deliveries(@Param('id') id: string, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    const ctx = currentTenant();
    requireScope(ctx, 'webhooks:manage');
    return this.dev.deliveries(ctx, uuidParam(id), { cursor, limit: pageLimit(limit, 25, 100) });
  }

  @Post(':id/deliveries/:deliveryId/retry')
  @HttpCode(202)
  retry(@Param('id') id: string, @Param('deliveryId') deliveryId: string) {
    const ctx = currentTenant();
    requireScope(ctx, 'webhooks:manage');
    return this.dev.retryDelivery(ctx, uuidParam(id), uuidParam(deliveryId, 'deliveryId'));
  }

  @Post()
  @ApiOperation({ summary: 'Create a webhook endpoint (scope webhooks:manage). The signing secret is returned ONCE.' })
  @ApiBody({ schema: { type: 'object', required: ['name', 'url', 'eventTypes'], properties: { name: { type: 'string' },
    url: { type: 'string', example: 'https://example.com/hooks/whatsapp' }, eventTypes: { type: 'array', items: { type: 'string', enum: WEBHOOK_EVENTS } },
    businessId: { type: 'string', format: 'uuid' }, instanceId: { type: 'string', format: 'uuid' },
    authorizationHeader: { type: 'string', maxLength: 500, description: 'Optional static Authorization header value (in addition to the HMAC signature)' } } } })
  async create(@Body() raw: unknown) {
    const ctx = currentTenant();
    requireScope(ctx, 'webhooks:manage');
    const b = obj(raw);
    const url = str(b, 'url', { max: 2048, pattern: HTTPS_RE });
    await checkWebhookUrl(url);
    const authHeader = authHeaderInput(b);
    const created = await this.webhooks.createEndpoint(ctx, { name: str(b, 'name', { max: 100 }), url,
      eventTypes: strArray(b, 'eventTypes', WEBHOOK_EVENTS), businessId: b.businessId ? uuidParam(b.businessId, 'businessId') : undefined,
      instanceId: b.instanceId ? uuidParam(b.instanceId, 'instanceId') : undefined });
    if (authHeader) await this.webhooks.setAuthHeader(ctx, created.id, authHeader);
    return created;
  }
}

/** Webhook Logs: every delivery of the organization (all endpoints) with filters, detail and manual retry. */
@ApiTags('Webhooks')
@ApiBearerAuth('session')
@ApiSecurity('api-key')
@Controller('v1/webhook-logs')
export class WebhookLogsController {
  constructor(@Inject(DeveloperService) private readonly dev: DeveloperService) {}

  @Get()
  @ApiOperation({ summary: 'Deliveries of all endpoints, newest first (scope webhooks:manage)' })
  list(@Query('status') status?: string, @Query('event') event?: string, @Query('endpoint') endpoint?: string, @Query('instance') instance?: string,
       @Query('httpStatus') httpStatus?: string, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    const ctx = currentTenant();
    requireScope(ctx, 'webhooks:manage');
    if (status && !['SUCCESS', 'FAILED', 'PENDING'].includes(status)) throw new WhatsAppError('VALIDATION_FAILED', 'status must be SUCCESS, FAILED or PENDING');
    if (event && !WEBHOOK_EVENTS.includes(event) && event !== 'WEBHOOK_TEST') throw new WhatsAppError('VALIDATION_FAILED', 'unknown event');
    const code = httpStatus ? Number(httpStatus) : undefined;
    if (code !== undefined && (!Number.isInteger(code) || code < 100 || code > 599)) throw new WhatsAppError('VALIDATION_FAILED', 'httpStatus must be 100-599');
    return this.dev.webhookLogs(ctx, { status: (status || undefined) as 'SUCCESS' | 'FAILED' | 'PENDING' | undefined, eventType: event || undefined,
      endpointId: endpoint ? uuidParam(endpoint, 'endpoint') : undefined, instanceId: instance ? uuidParam(instance, 'instance') : undefined,
      httpStatus: code, cursor, limit: pageLimit(limit, 25, 100) });
  }

  @Get(':id')
  @ApiOperation({ summary: 'One delivery with the payload sent and the response received' })
  get(@Param('id') id: string) {
    const ctx = currentTenant();
    requireScope(ctx, 'webhooks:manage');
    return this.dev.webhookLog(ctx, uuidParam(id));
  }

  @Post(':id/retry')
  @HttpCode(202)
  retry(@Param('id') id: string) {
    const ctx = currentTenant();
    requireScope(ctx, 'webhooks:manage');
    return this.dev.retryLog(ctx, uuidParam(id));
  }
}

/** Ops-only aggregate health. Guarded by INTERNAL_OPS_TOKEN; returns counts, never tenant data. */
@ApiExcludeController()
@Controller('internal/health')
export class InternalHealthController {
  constructor(@Inject(APP_TX) private readonly tx: TransactionRunner) {}

  @Get('whatsapp')
  async whatsapp(@Headers('x-ops-token') token?: string) {
    const expected = process.env.INTERNAL_OPS_TOKEN;
    const ok = !!expected && !!token && token.length === expected.length && timingSafeEqual(Buffer.from(token), Buffer.from(expected));
    if (!ok) throw new WhatsAppError('FORBIDDEN', 'ops token required');
    const stale = Math.ceil(Number(process.env.WHATSAPP_WORKER_STALE_AFTER_MS ?? 45_000) / 1000);
    const r = await this.tx.run({}, (db) => db.query('SELECT app_ops.whatsapp_health_summary($1) AS s', [stale]));
    return r.rows[0].s;
  }
}
