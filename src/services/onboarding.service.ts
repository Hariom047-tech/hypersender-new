import { Inject, Injectable } from '@nestjs/common';
import { uuidv7 } from '../common/uuid.js';
import { isPgError, PgCode } from '../database/errors.js';
import { APP_TX, TransactionRunner } from '../database/transaction-runner.js';
import { IdentityRepository } from '../repositories/identity.repository.js';
import { OpsRepository } from '../repositories/ops.repository.js';
import { hashPassword, verifyPassword } from '../security/passwords.js';

export class EmailAlreadyRegisteredError extends Error {}
export class SlugTakenError extends Error {}
export class InvalidOrganizationError extends Error {}

export interface SignUpInput {
  email: string;
  password: string;
  firstName?: string;
  lastName?: string;
  organizationName: string;
  organizationSlug: string;
  timezone?: string;
  countryCode?: string;
  currency?: string;
}

@Injectable()
export class OnboardingService {
  constructor(
    @Inject(APP_TX) private readonly tx: TransactionRunner,
    @Inject(IdentityRepository) private readonly identity: IdentityRepository,
    @Inject(OpsRepository) private readonly ops: OpsRepository,
  ) {}

  /** scrypt cost (log2 N). Production: 17 (OWASP). Tests may lower it via env. */
  private get passwordLogN(): number {
    return Number(process.env.PASSWORD_SCRYPT_LOG_N ?? 17);
  }

  /**
   * Sign-up: user + organization + OWNER membership + trial subscription in ONE
   * transaction. Ids are generated here so the tenant context can be set before
   * the first INSERT; RLS then admits exactly this bootstrap sequence
   * (organizations_create -> members_insert bootstrap branch -> tenant policies).
   */
  async signUp(input: SignUpInput): Promise<{ userId: string; organizationId: string }> {
    const userId = uuidv7();
    const organizationId = uuidv7();
    const passwordHash = await hashPassword(input.password, this.passwordLogN); // outside the transaction (CPU-heavy)

    try {
      await this.tx.run({ userId, organizationId }, async (db) => {
        await this.identity.insertUser(db, { id: userId, email: input.email, passwordHash, firstName: input.firstName, lastName: input.lastName });
        await this.identity.insertOrganization(db, {
          id: organizationId, name: input.organizationName, slug: input.organizationSlug,
          timezone: input.timezone ?? 'UTC', countryCode: input.countryCode, currency: input.currency ?? 'INR', createdByUserId: userId,
        });
        await this.identity.insertMember(db, { organizationId, userId, role: 'OWNER', status: 'ACTIVE' });
        await db.query(
          `INSERT INTO app.subscriptions (organization_id, plan_id, provider, status, current_period_start, current_period_end, trial_end)
           SELECT $1, p.id, 'NONE', 'TRIALING', now(), now() + make_interval(days => p.trial_days), now() + make_interval(days => p.trial_days)
             FROM app.subscription_plans p WHERE p.code = 'TRIAL' AND p.active`, [organizationId]);
        await this.ops.audit(db, { organizationId, actorType: 'USER', actorUserId: userId, action: 'ORGANIZATION_CREATED',
          resourceType: 'ORGANIZATION', resourceId: organizationId });
      });
    } catch (err) {
      if (isPgError(err, PgCode.UNIQUE_VIOLATION) && err.constraint === 'users_email_normalized_uq') throw new EmailAlreadyRegisteredError();
      if (isPgError(err, PgCode.UNIQUE_VIOLATION) && err.constraint === 'organizations_slug_uq') throw new SlugTakenError();
      throw err;
    }
    return { userId, organizationId };
  }

  /** Step 1 of onboarding: account only (no organization yet). */
  async register(input: { email: string; password: string; firstName?: string; lastName?: string; phoneE164?: string | null }): Promise<{ userId: string }> {
    const userId = uuidv7();
    const passwordHash = await hashPassword(input.password, this.passwordLogN);
    try {
      await this.tx.run({ userId }, (db) => this.identity.insertUser(db, { id: userId, email: input.email, passwordHash,
        firstName: input.firstName, lastName: input.lastName, phoneE164: input.phoneE164 }));
    } catch (err) {
      if (isPgError(err, PgCode.UNIQUE_VIOLATION)) throw new EmailAlreadyRegisteredError();
      throw err;
    }
    return { userId };
  }

  /**
   * Google sign-in with a VERIFIED Google email: signs in the account with that
   * email, or creates one (no password; Google only). Returns null for accounts
   * that are suspended or not yet activated.
   */
  async googleSignIn(p: { email: string; firstName: string | null; lastName: string | null }): Promise<{ userId: string; created: boolean } | null> {
    const candidate = await this.tx.run({}, (db) => this.identity.getLoginCandidate(db, p.email));
    if (candidate) {
      if (candidate.status !== 'ACTIVE') return null;
      await this.tx.run({ userId: candidate.userId }, (db) =>
        db.query('UPDATE app.users SET last_login_at = now(), email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1', [candidate.userId]));
      return { userId: candidate.userId, created: false };
    }
    const userId = uuidv7();
    try {
      await this.tx.run({ userId }, (db) => this.identity.insertUser(db, { id: userId, email: p.email, passwordHash: null,
        firstName: p.firstName, lastName: p.lastName, emailVerified: true }));
    } catch (err) {
      // Created by a parallel request a moment ago: sign that account in.
      if (isPgError(err, PgCode.UNIQUE_VIOLATION)) return this.googleSignIn(p);
      throw err;
    }
    return { userId, created: true };
  }

  /**
   * Step 2: create an organization for an existing user (OWNER + trial).
   * Idempotent per slug: the client keeps one slug per onboarding attempt, so a
   * refresh/retry that hits the unique slug returns the organization THIS user
   * already created instead of creating a duplicate.
   */
  async createOrganization(userId: string, input: { name: string; slug: string; timezone?: string; countryCode?: string; currency?: string }): Promise<{ organizationId: string; created: boolean }> {
    const organizationId = uuidv7();
    try {
      await this.tx.run({ userId, organizationId }, async (db) => {
        await this.identity.insertOrganization(db, { id: organizationId, name: input.name, slug: input.slug, timezone: input.timezone ?? 'UTC',
          countryCode: input.countryCode, currency: input.currency ?? 'INR', createdByUserId: userId });
        await this.identity.insertMember(db, { organizationId, userId, role: 'OWNER', status: 'ACTIVE' });
        await db.query(
          `INSERT INTO app.subscriptions (organization_id, plan_id, provider, status, current_period_start, current_period_end, trial_end)
           SELECT $1, p.id, 'NONE', 'TRIALING', now(), now() + make_interval(days => p.trial_days), now() + make_interval(days => p.trial_days)
             FROM app.subscription_plans p WHERE p.code = 'TRIAL' AND p.active`, [organizationId]);
        await this.ops.audit(db, { organizationId, actorType: 'USER', actorUserId: userId, action: 'ORGANIZATION_CREATED',
          resourceType: 'ORGANIZATION', resourceId: organizationId });
      });
      return { organizationId, created: true };
    } catch (err) {
      if (isPgError(err, PgCode.UNIQUE_VIOLATION) && err.constraint === 'organizations_slug_uq') {
        const mine = await this.tx.run({ userId }, (db) => this.identity.listMyOrganizations(db));
        const existing = mine.find((o) => o.slug === input.slug && o.role === 'OWNER');
        if (existing) return { organizationId: existing.id, created: false };
        throw new SlugTakenError();
      }
      if (isPgError(err, PgCode.CHECK_VIOLATION)) throw new InvalidOrganizationError((err as { constraint?: string }).constraint ?? 'check');
      throw err;
    }
  }

  /** Returns the user id on success. Same generic failure for unknown email / wrong password / inactive. */
  async login(email: string, password: string): Promise<string | null> {
    const candidate = await this.tx.run({}, (db) => this.identity.getLoginCandidate(db, email));
    // Verify against a dummy hash when the user does not exist to keep timing uniform.
    const hash = candidate?.passwordHash
      ?? `$scrypt$ln=${this.passwordLogN},r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=`;
    const ok = await verifyPassword(password, hash);
    if (!candidate || !ok || candidate.status !== 'ACTIVE') return null;
    await this.tx.run({ userId: candidate.userId }, (db) =>
      db.query('UPDATE app.users SET last_login_at = now() WHERE id = $1', [candidate.userId]));
    return candidate.userId;
  }
}
