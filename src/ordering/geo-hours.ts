/** Delivery serviceability and opening-hours logic (pure, timezone-aware). */

export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export type Serviceability = { serviceable: true; by: 'PINCODE' | 'RADIUS'; distanceKm?: number } | { serviceable: false; reason: 'AREA_NOT_CONFIGURED' | 'OUTSIDE_AREA' | 'NEED_PINCODE_OR_LOCATION' };

export function checkServiceability(area: { pincodes: string[]; radiusKm: number | null; origin: { lat: number; lng: number } | null },
                                    target: { pincode?: string | null; lat?: number | null; lng?: number | null }): Serviceability {
  const hasPins = area.pincodes.length > 0;
  const hasRadius = area.radiusKm !== null && area.origin !== null;
  if (!hasPins && !hasRadius) return { serviceable: false, reason: 'AREA_NOT_CONFIGURED' };
  if (target.lat !== null && target.lat !== undefined && target.lng !== null && target.lng !== undefined && hasRadius) {
    const km = haversineKm(area.origin!, { lat: target.lat, lng: target.lng });
    if (km <= area.radiusKm!) return { serviceable: true, by: 'RADIUS', distanceKm: Math.round(km * 10) / 10 };
    if (!hasPins || !target.pincode) return { serviceable: false, reason: 'OUTSIDE_AREA' };
  }
  if (target.pincode && hasPins) {
    return area.pincodes.includes(target.pincode) ? { serviceable: true, by: 'PINCODE' } : { serviceable: false, reason: 'OUTSIDE_AREA' };
  }
  return { serviceable: false, reason: 'NEED_PINCODE_OR_LOCATION' };
}

// ------------------------------------------------------------------------ time
const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type WeeklyHours = Partial<Record<(typeof DAY_KEYS)[number], Array<[string, string]>>>;

export function localParts(d: Date, tz: string): { date: string; minutes: number; dow: number } {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    minute: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(d).map((x) => [x.type, x.value]));
  const dow = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday);
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute), dow };
}

/** UTC instant of a local wall-clock time in `tz` (handles DST by re-checking the offset). */
export function zonedInstant(date: string, hhmm: string, tz: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  let guess = Date.UTC(y, m - 1, d, hh, mm);
  for (let i = 0; i < 2; i++) {
    const lp = localParts(new Date(guess), tz);
    const [ly, lm, ld] = lp.date.split('-').map(Number);
    const localAsUtc = Date.UTC(ly, lm - 1, ld, Math.floor(lp.minutes / 60), lp.minutes % 60);
    guess += Date.UTC(y, m - 1, d, hh, mm) - localAsUtc;
  }
  return new Date(guess);
}

const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const addDays = (date: string, n: number) => { const x = new Date(`${date}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

export function hoursConfigured(h: WeeklyHours | null | undefined): boolean {
  return Boolean(h && DAY_KEYS.some((k) => (h[k] ?? []).length > 0));
}

/** Is the business open at `at`? Unconfigured hours count as open (the owner has not restricted them). */
export function isOpenAt(h: WeeklyHours | null | undefined, tz: string, at: Date): boolean {
  if (!hoursConfigured(h)) return true;
  const lp = localParts(at, tz);
  const ranges = h![DAY_KEYS[lp.dow]] ?? [];
  return ranges.some(([from, to]) => lp.minutes >= toMin(from) && lp.minutes < (to === '00:00' ? 1440 : toMin(to)));
}

/** Next opening instant within 7 days, or null. */
export function nextOpening(h: WeeklyHours | null | undefined, tz: string, from: Date): Date | null {
  if (!hoursConfigured(h)) return null;
  const start = localParts(from, tz);
  for (let i = 0; i < 8; i++) {
    const date = addDays(start.date, i);
    const dow = (start.dow + i) % 7;
    for (const [open] of [...(h![DAY_KEYS[dow]] ?? [])].sort()) {
      const at = zonedInstant(date, open, tz);
      if (at > from) return at;
    }
  }
  return null;
}
