import { Injectable } from '@nestjs/common';
import type { Db } from '../database/transaction-runner.js';
import type { MemberRole } from '../database/tenant-context.js';

export interface MembershipRow { organizationId: string; role: MemberRole; status: string }

@Injectable()
export class IdentityRepository {
  /** Requires app.current_user_id = id (users_self policy). */
  /** passwordHash null = an account that signs in with Google only. */
  async insertUser(db: Db, u: { id: string; email: string; passwordHash: string | null; firstName?: string | null; lastName?: string | null; phoneE164?: string | null; emailVerified?: boolean }): Promise<void> {
    await db.query(
      `INSERT INTO app.users (id, email, password_hash, first_name, last_name, phone_e164, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE')`,
      [u.id, u.email, u.passwordHash, u.firstName ?? null, u.lastName ?? null, u.phoneE164 ?? null]);
    if (u.emailVerified) await db.query(`UPDATE app.users SET email_verified_at = now() WHERE id = $1`, [u.id]);
  }

  /** Pre-tenant login lookup through the SECURITY DEFINER function. */
  async getLoginCandidate(db: Db, email: string): Promise<{ userId: string; passwordHash: string | null; status: string } | null> {
    const r = await db.query('SELECT user_id, password_hash, status FROM app_auth.get_login_candidate($1)', [email]);
    return r.rows[0] ? { userId: r.rows[0].user_id, passwordHash: r.rows[0].password_hash, status: r.rows[0].status } : null;
  }

  /** Requires app.current_organization_id = o.id and app.current_user_id = creator. */
  async insertOrganization(db: Db, o: { id: string; name: string; slug: string; timezone: string; countryCode?: string; currency: string; createdByUserId: string }): Promise<void> {
    await db.query(
      `INSERT INTO app.organizations (id, name, slug, timezone, country_code, default_currency, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [o.id, o.name, o.slug, o.timezone, o.countryCode ?? null, o.currency, o.createdByUserId]);
  }

  async insertMember(db: Db, m: { organizationId: string; userId: string; role: MemberRole; status: 'ACTIVE' | 'INVITED'; invitedByUserId?: string }): Promise<void> {
    await db.query(
      `INSERT INTO app.organization_members (organization_id, user_id, role, status, invited_by_user_id, joined_at)
       VALUES ($1, $2, $3, $4, $5, CASE WHEN $4 = 'ACTIVE' THEN now() END)`,
      [m.organizationId, m.userId, m.role, m.status, m.invitedByUserId ?? null]);
  }

  /** Membership of the acting user in one org (visible via members_select: user_id = current user). */
  async findActiveMembership(db: Db, organizationId: string, userId: string): Promise<MembershipRow | null> {
    const r = await db.query(
      `SELECT organization_id, role, status FROM app.organization_members
        WHERE organization_id = $1 AND user_id = $2 AND status = 'ACTIVE'`,
      [organizationId, userId]);
    return r.rows[0] ? { organizationId: r.rows[0].organization_id, role: r.rows[0].role, status: r.rows[0].status } : null;
  }

  async listMyOrganizations(db: Db): Promise<Array<{ id: string; name: string; slug: string; role: MemberRole }>> {
    const r = await db.query(
      `SELECT o.id, o.name, o.slug, m.role
         FROM app.organization_members m
         JOIN app.organizations o ON o.id = m.organization_id
        WHERE m.user_id = app.current_user_id() AND m.status = 'ACTIVE' AND o.deleted_at IS NULL
        ORDER BY o.name`);
    return r.rows;
  }

  async insertBusiness(db: Db, b: { id?: string; organizationId: string; name: string; timezone: string; currency: string; industry?: string }): Promise<string> {
    const r = await db.query(
      `INSERT INTO app.businesses (id, organization_id, name, timezone, currency, industry)
       VALUES (coalesce($1::uuid, app.uuid_generate_v7()), $2, $3, $4, $5, $6) RETURNING id`,
      [b.id ?? null, b.organizationId, b.name, b.timezone, b.currency, b.industry ?? null]);
    return r.rows[0].id;
  }
}
