import { msg } from '@/lib/i18n';
/** Static option lists for forms (values must satisfy backend CHECK constraints). */
export const COUNTRIES = [
  ['IN', msg("India")], ['AE', msg("United Arab Emirates")], ['US', msg("United States")], ['GB', msg("United Kingdom")], ['SG', msg("Singapore")],
  ['SA', msg("Saudi Arabia")], ['ID', msg("Indonesia")], ['BR', msg("Brazil")], ['MX', msg("Mexico")], ['NG', msg("Nigeria")], ['ZA', msg("South Africa")],
  ['DE', msg("Germany")], ['FR', msg("France")], ['ES', msg("Spain")], ['IT', msg("Italy")], ['AU', msg("Australia")], ['CA', msg("Canada")], ['PK', msg("Pakistan")],
  ['BD', msg("Bangladesh")], ['NP', msg("Nepal")], ['LK', msg("Sri Lanka")], ['MY', msg("Malaysia")], ['PH', msg("Philippines")], ['KE', msg("Kenya")], ['EG', msg("Egypt")],
] as const;

export const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'SAR', 'IDR', 'BRL', 'MXN', 'NGN', 'ZAR', 'AUD', 'CAD', 'PKR', 'BDT', 'NPR', 'LKR', 'MYR', 'PHP', 'KES', 'EGP'];

export const INDUSTRIES = [
  ['DENTAL_CLINIC', msg("Dental clinic")], ['MEDICAL_CLINIC', msg("Medical clinic / doctor")], ['SALON_SPA', msg("Salon & spa")], ['RESTAURANT', msg("Restaurant")],
  ['HOTEL', msg("Hotel")], ['REAL_ESTATE', msg("Real estate")], ['ECOMMERCE', msg("E-commerce")], ['EDUCATION', msg("Education")], ['FITNESS', msg("Fitness")],
  ['PROFESSIONAL_SERVICES', msg("Professional services")], ['RETAIL', msg("Retail shop")], ['OTHER', msg("Other")],
] as const;

export function timezones(): string[] {
  try { return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone'); } catch { return ['UTC', 'Asia/Kolkata']; }
}

export function browserTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}
