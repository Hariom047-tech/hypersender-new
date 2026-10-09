import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { obj, optStr, str, uuidParam } from '../common/validation.js';
import { APP_TX, TransactionRunner } from '../database/transaction-runner.js';
import { IdentityRepository } from '../repositories/identity.repository.js';
import { InvalidOrganizationError, OnboardingService, SlugTakenError } from '../services/onboarding.service.js';
import { WhatsAppError } from '../whatsapp/domain/whatsapp-errors.js';
import { HmacSessionService } from './auth/session.service.js';

/**
 * Account-level endpoints: need a dashboard session but NO organization
 * context (the user may not have one yet, or is choosing one). Excluded from
 * the tenant middleware; each call verifies the session itself.
 */
@ApiTags('Account (dashboard)')
@ApiBearerAuth('session')
@Controller('v1/account')
export class AccountController {
  constructor(
    @Inject(HmacSessionService) private readonly sessions: HmacSessionService,
    @Inject(OnboardingService) private readonly onboarding: OnboardingService,
    @Inject(APP_TX) private readonly tx: TransactionRunner,
    @Inject(IdentityRepository) private readonly identity: IdentityRepository,
  ) {}

  private async userId(auth?: string): Promise<string> {
    const s = auth?.startsWith('Bearer ') ? await this.sessions.verify(auth.slice(7)) : null;
    if (!s) throw new WhatsAppError('UNAUTHENTICATED', 'valid session required');
    return s.userId;
  }

  @Get('me')
  @ApiOperation({ summary: 'Current user, organizations (with role) and pending invitations' })
  async me(@Headers('authorization') auth?: string) {
    const userId = await this.userId(auth);
    return this.tx.run({ userId }, async (db) => {
      const u = (await db.query(`SELECT id, email, first_name AS "firstName", last_name AS "lastName", status FROM app.users WHERE id = $1`, [userId])).rows[0];
      if (!u || u.status !== 'ACTIVE') throw new WhatsAppError('UNAUTHENTICATED', 'account not active');
      const organizations = (await db.query(
        `SELECT o.id, o.name, o.slug, m.role, o.timezone, o.country_code AS "countryCode", o.default_currency AS "currency",
                (SELECT count(*)::int FROM app.businesses b WHERE b.organization_id = o.id AND b.deleted_at IS NULL) AS "businessCount"
           FROM app.organization_members m JOIN app.organizations o ON o.id = m.organization_id
          WHERE m.user_id = app.current_user_id() AND m.status = 'ACTIVE' AND o.deleted_at IS NULL ORDER BY m.created_at`)).rows;
      const invitations = (await db.query(
        `SELECT organization_id AS "organizationId", organization_name AS "organizationName", role, invited_by AS "invitedBy", invited_at AS "invitedAt"
           FROM app_auth.my_pending_invitations()`)).rows;
      return { user: { id: u.id, email: u.email, firstName: u.firstName, lastName: u.lastName }, organizations, invitations };
    });
  }

  @Post('organizations')
  @ApiOperation({ summary: 'Create an organization (you become OWNER; trial plan). Idempotent per slug for the same user.' })
  @ApiBody({ schema: { type: 'object', required: ['name', 'slug'], properties: { name: { type: 'string' }, slug: { type: 'string', pattern: '^[a-z0-9]+(-[a-z0-9]+)*$' },
    timezone: { type: 'string', example: 'Asia/Kolkata' }, countryCode: { type: 'string', example: 'IN' }, currency: { type: 'string', example: 'INR' } } } })
  async createOrganization(@Headers('authorization') auth: string | undefined, @Body() raw: unknown) {
    const userId = await this.userId(auth);
    const b = obj(raw);
    try {
      return await this.onboarding.createOrganization(userId, {
        name: str(b, 'name', { min: 1, max: 200 }), slug: str(b, 'slug', { min: 2, max: 63, pattern: /^[a-z0-9]+(-[a-z0-9]+)*$/ }),
        timezone: optStr(b, 'timezone', { max: 64 }), countryCode: optStr(b, 'countryCode', { pattern: /^[A-Z]{2}$/ }),
        currency: optStr(b, 'currency', { pattern: /^[A-Z]{3}$/ }),
      });
    } catch (err) {
      if (err instanceof SlugTakenError) throw new WhatsAppError('CONFLICT', 'That workspace address is taken. Choose another.');
      if (err instanceof InvalidOrganizationError) throw new WhatsAppError('VALIDATION_FAILED', 'Invalid timezone, country or currency.');
      throw err;
    }
  }

  @Post('invitations/:organizationId/accept')
  @HttpCode(200)
  async accept(@Headers('authorization') auth: string | undefined, @Param('organizationId') org: string) {
    const userId = await this.userId(auth);
    const r = await this.tx.run({ userId }, (db) => db.query('SELECT app_auth.accept_invitation($1) AS ok', [uuidParam(org)]));
    if (!r.rows[0].ok) throw new WhatsAppError('NOT_FOUND');
    return { accepted: true };
  }

  @Post('invitations/:organizationId/decline')
  @HttpCode(200)
  async decline(@Headers('authorization') auth: string | undefined, @Param('organizationId') org: string) {
    const userId = await this.userId(auth);
    const r = await this.tx.run({ userId }, (db) => db.query('SELECT app_auth.decline_invitation($1) AS ok', [uuidParam(org)]));
    if (!r.rows[0].ok) throw new WhatsAppError('NOT_FOUND');
    return { declined: true };
  }
}
