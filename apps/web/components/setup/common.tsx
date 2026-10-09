'use client';

import { useEffect, useRef, type FormEvent, type ReactNode } from 'react';
import { Button, Notice, Select, cx } from '@/components/ui';
import { useWorkspace } from '@/lib/workspace';
import { t, msg } from '@/lib/i18n';

/** The business a setup page edits: the top-bar selection, or the first business (with a picker). */
export function useSetupBusiness() {
  const { businesses, businessId, switchBusiness, orgId } = useWorkspace();
  const bid = businessId ?? businesses[0]?.id ?? null;
  const business = businesses.find((b) => b.id === bid) ?? null;
  const picker = businesses.length > 1 ? (
    <label className="flex items-center gap-2 text-sm text-slate-600">{t("Business")}
      <Select className="w-56" value={bid ?? ''} onChange={(e) => switchBusiness(e.target.value)} aria-label={t("Business")}>
        {businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
      </Select>
    </label>
  ) : null;
  const missing = !bid ? <Notice tone="warn">{t("Create a business first (Settings → Business).")}</Notice> : null;
  return { bid, business, orgId, picker, missing, currency: business?.currency ?? 'INR' };
}

export const rupees = (minor: number | null | undefined, currency = 'INR') => (minor === null || minor === undefined ? '—'
  : new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en', { style: 'currency', currency, maximumFractionDigits: minor % 100 === 0 ? 0 : 2 }).format(minor / 100));
/** "149" / "149.50" -> 14900 / 14950 paise; empty -> null. */
export function toMinor(v: FormDataEntryValue | string | null | undefined): number | null {
  const s = String(v ?? '').trim().replace(/[₹,\s]/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}
export const fromMinor = (m: number | null | undefined) => (m === null || m === undefined ? '' : String(m / 100));

/** Right-side sheet with a form (native <dialog>: focus trap + Esc). */
export function Drawer({ title, subtitle, onClose, onSubmit, children, busy, submitLabel, error, wide }: {
  title: string; subtitle?: string; onClose: () => void; onSubmit: (e: FormEvent<HTMLFormElement>) => void; children: ReactNode; busy?: boolean;
  submitLabel?: string; error?: string | null; wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby="drawer-title" className={cx('ml-auto mr-0 h-full max-h-full w-full rounded-none p-0 backdrop:bg-slate-900/40', wide ? 'max-w-2xl' : 'max-w-lg')}>
      <form onSubmit={(e) => { e.preventDefault(); onSubmit(e); }} className="flex h-full flex-col">
        <header className="border-b border-slate-200 p-4"><h2 id="drawer-title" className="font-semibold">{t(title)}</h2>{subtitle && <p className="text-xs text-slate-500">{t(subtitle)}</p>}</header>
        <div className="flex-1 space-y-4 overflow-y-auto p-4">{error && <Notice tone="error">{t(error)}</Notice>}{children}</div>
        <footer className="flex gap-2 border-t border-slate-200 p-4">
          <Button type="submit" loading={busy}>{submitLabel ? t(submitLabel) : t("Save")}</Button>
          <Button type="button" variant="secondary" onClick={() => ref.current?.close()}>{t("Cancel")}</Button>
        </footer>
      </form>
    </dialog>
  );
}

export const DAYS = [['mon', msg("Monday")], ['tue', msg("Tuesday")], ['wed', msg("Wednesday")], ['thu', msg("Thursday")], ['fri', msg("Friday")], ['sat', msg("Saturday")], ['sun', msg("Sunday")]] as const;
export type Weekly = Partial<Record<(typeof DAYS)[number][0], Array<[string, string]>>>;

/** Weekly hours editor: several time ranges per day (e.g. lunch and dinner). */
export function WeeklyEditor({ value, onChange, disabled }: { value: Weekly; onChange: (w: Weekly) => void; disabled?: boolean }) {
  const set = (d: string, ranges: Array<[string, string]>) => onChange({ ...value, [d]: ranges });
  return (
    <div className="divide-y divide-slate-100">
      {DAYS.map(([d, label]) => {
        const ranges = value[d] ?? [];
        return (
          <div key={d} className="flex flex-wrap items-center gap-3 py-2.5">
            <span className="w-28 text-sm font-medium">{t(label)}</span>
            {ranges.length === 0 && <span className="text-sm text-slate-500">{t("Closed")}</span>}
            {ranges.map(([from, to], i) => (
              <span key={i} className="flex items-center gap-1.5">
                <input type="time" aria-label={t('{day} from {n}', { day: t(label), n: i + 1 })} value={from} disabled={disabled} className="rounded-md border-0 px-2 py-1 text-sm ring-1 ring-slate-300"
                  onChange={(e) => set(d, ranges.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))} />
                <span aria-hidden>–</span>
                <input type="time" aria-label={t('{day} to {n}', { day: t(label), n: i + 1 })} value={to === '24:00' ? '23:59' : to} disabled={disabled} className="rounded-md border-0 px-2 py-1 text-sm ring-1 ring-slate-300"
                  onChange={(e) => set(d, ranges.map((r, j) => (j === i ? [r[0], e.target.value === '23:59' ? '24:00' : e.target.value] : r)))} />
                {!disabled && <button type="button" aria-label={t('Remove {day} range {n}', { day: t(label), n: i + 1 })} className="px-1 text-slate-400 hover:text-red-600" onClick={() => set(d, ranges.filter((_, j) => j !== i))}>✕</button>}
              </span>
            ))}
            {!disabled && ranges.length < 4 && (
              <button type="button" className="text-xs font-medium text-emerald-800 underline" onClick={() => set(d, [...ranges, ranges.length ? ['19:00', '23:00'] : ['10:00', '22:00']])}>
                {ranges.length ? t("+ another time") : t("+ Open")}
              </button>
            )}
          </div>
        );
      })}
      {!disabled && (
        <div className="pt-3 text-xs">
          <button type="button" className="font-medium text-emerald-800 underline" onClick={() => onChange(Object.fromEntries(DAYS.map(([d]) => [d, value.mon ?? [['10:00', '22:00']]])))}>{t("Copy Monday to all days")}</button>
        </div>
      )}
    </div>
  );
}

/** Parses "22.7196, 75.8577" or a Google Maps link into coordinates. */
export function parseCoordinates(input: string): { lat: number; lng: number } | null {
  const m = /(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/.exec(input) ?? /@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/.exec(input) ?? /[?&]q=(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/.exec(input);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}
