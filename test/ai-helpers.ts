import { uuidv7 } from '../src/common/uuid.js';
import type { Harness, Tenant } from './helpers.js';

export const TZ = 'Asia/Kolkata';

/** Local calendar dates in the business timezone: tomorrow and the next Sunday after today. */
export function localDates(now = new Date()): { today: string; tomorrow: string; sunday: string } {
  const fmt = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const today = fmt(now);
  const add = (s: string, n: number) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
  return { today, tomorrow: add(today, 1), sunday: add(today, dow === 0 ? 7 : 7 - dow) };
}

/** UTC instant for a local date + HH:MM in the business timezone (IST = UTC+5:30, no DST). */
export const istInstant = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+05:30`);

export interface Clinic { serviceCleaning: string; serviceConsult: string; drSharma: string; drMehta: string; hairSpa: string }

/**
 * Realistic business data for a tenant's business (owner role, fixtures only):
 * profile, hours, address, services with prices, two doctors, weekly availability 09:00-18:00.
 */
export async function seedBusinessData(h: Harness, t: Tenant, businessId = t.businessId): Promise<Clinic> {
  const ids = { serviceCleaning: uuidv7(), serviceConsult: uuidv7(), drSharma: uuidv7(), drMehta: uuidv7(), hairSpa: uuidv7() };
  const hours = JSON.stringify(Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [[d === 'sun' ? '10:00' : '09:00', d === 'sun' ? '16:00' : '18:00']]])));
  const q = (sql: string, p: unknown[]) => h.owner.query(sql, p);
  await q(`UPDATE app.businesses SET description = 'Family dental and medical clinic', phone_e164 = '+919811122233', industry = 'HEALTHCARE',
            address = '{"line1":"12 MG Road","city":"Indore","state":"MP","postalCode":"452001"}', business_hours = $2, timezone = 'Asia/Kolkata' WHERE id = $1`,
    [businessId, hours]);
  await q(`INSERT INTO app.business_locations (organization_id, business_id, name, address, timezone, is_primary, latitude, longitude)
           VALUES ($1, $2, 'Main clinic', '{"line1":"12 MG Road","city":"Indore"}', 'Asia/Kolkata', true, 22.7196, 75.8577)`, [t.orgId, businessId]);
  await q(`INSERT INTO app.services (id, organization_id, business_id, name, description, duration_minutes, price_minor_units, currency) VALUES
             ($1, $3, $4, 'Dental Cleaning', 'Scaling and polishing', 30, 80000, 'INR'),
             ($2, $3, $4, 'General Consultation', 'Doctor consultation', 30, 50000, 'INR'),
             ($5, $3, $4, 'Hair Spa', 'Deep conditioning hair spa', 60, 149900, 'INR')`,
    [ids.serviceCleaning, ids.serviceConsult, t.orgId, businessId, ids.hairSpa]);
  await q(`INSERT INTO app.business_resources (id, organization_id, business_id, resource_type, name) VALUES
             ($1, $3, $4, 'DOCTOR', 'Dr Sharma'), ($2, $3, $4, 'DOCTOR', 'Dr Mehta')`, [ids.drSharma, ids.drMehta, t.orgId, businessId]);
  await q(`INSERT INTO app.resource_services (organization_id, business_id, resource_id, service_id)
           SELECT $1, $2, r, s FROM unnest($3::uuid[]) r CROSS JOIN unnest($4::uuid[]) s`,
    [t.orgId, businessId, [ids.drSharma, ids.drMehta], [ids.serviceCleaning, ids.serviceConsult, ids.hairSpa]]);
  await q(`INSERT INTO app.availability_rules (organization_id, business_id, resource_id, day_of_week, start_time, end_time, timezone)
           SELECT $1, $2, r, d, '09:00', '18:00', 'Asia/Kolkata' FROM unnest($3::uuid[]) r CROSS JOIN generate_series(1, 7) d`,
    [t.orgId, businessId, [ids.drSharma, ids.drMehta]]);
  return ids;
}

export async function newBusiness(h: Harness, t: Tenant, name: string): Promise<string> {
  const id = uuidv7();
  await h.owner.query(`INSERT INTO app.businesses (id, organization_id, name, timezone) VALUES ($1, $2, $3, 'Asia/Kolkata')`, [id, t.orgId, name]);
  return id;
}
