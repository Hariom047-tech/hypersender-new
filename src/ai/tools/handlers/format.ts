/** Presentation helpers shared by tool handlers (results carry machine values AND display strings). */
export function money(minor: number | string | null | undefined, currency: string): { amountMinor: number; currency: string; display: string } | null {
  if (minor === null || minor === undefined) return null;
  const n = Number(minor);
  const major = n / 100;
  let display: string;
  try {
    display = new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en', { style: 'currency', currency, maximumFractionDigits: n % 100 === 0 ? 0 : 2 }).format(major);
  } catch {
    display = `${currency} ${major.toFixed(2)}`;
  }
  return { amountMinor: n, currency, display };
}

export function localLabel(d: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-IN', { timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
}

export function localDate(d: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

export function clip(s: string | null | undefined, n: number): string | null {
  if (!s) return null;
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Words for keyword search (letters/digits in any script). */
export function searchWords(text: string, max = 12): string[] {
  return Array.from(new Set((text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []))).slice(0, max);
}
