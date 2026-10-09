'use client';

import { forwardRef, useId, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { t } from '@/lib/i18n';

/* Shared pieces of the sign-in / sign-up screens (dark theme, same look as the landing page). */

const ICONS = {
  mail: 'M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75',
  lock: 'M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z',
  user: 'M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z', // i18n-ignore: SVG path
  phone: 'M10.5 1.5H8.25A2.25 2.25 0 006 3.75v16.5a2.25 2.25 0 002.25 2.25h7.5A2.25 2.25 0 0018 20.25V3.75a2.25 2.25 0 00-2.25-2.25H13.5m-3 0V3h3V1.5m-3 0h3m-3 18.75h3',
  eye: 'M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z M15 12a3 3 0 11-6 0 3 3 0 016 0z',
  eyeOff: 'M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88',
  alert: 'M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z', // i18n-ignore: SVG path
} as const;
export type AuthIcon = keyof typeof ICONS;

export function Icon({ name, className = 'h-5 w-5' }: { name: AuthIcon; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d={ICONS[name]} />
    </svg>
  );
}

export function AuthHeading({ title, subtitle }: { title: string; subtitle?: ReactNode }) {
  return (
    <div className="text-center">
      <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">{title}</h1>
      {subtitle && <p className="mt-2 text-sm text-slate-400">{subtitle}</p>}
    </div>
  );
}

type FieldProps = InputHTMLAttributes<HTMLInputElement> & { label: string; icon?: AuthIcon; hint?: string; addon?: ReactNode; right?: ReactNode };

export const AuthField = forwardRef<HTMLInputElement, FieldProps>(function AuthField({ label, icon, hint, addon, right, className, ...rest }, ref) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-slate-200">{label}</label>
      <div className="group flex items-center rounded-xl border border-white/10 bg-white/[0.04] transition focus-within:border-emerald-400/70 focus-within:bg-white/[0.06] focus-within:ring-4 focus-within:ring-emerald-400/10">
        {icon && <Icon name={icon} className="ml-3.5 h-5 w-5 shrink-0 text-slate-500 group-focus-within:text-emerald-300" />}
        {addon}
        <input ref={ref} id={id} data-auth-input aria-describedby={hint ? `${id}-hint` : undefined}
          className={`h-12 w-full min-w-0 flex-1 bg-transparent px-3 text-[15px] text-white placeholder:text-slate-500 focus:outline-none ${className ?? ''}`} {...rest} />
        {right}
      </div>
      {hint && <p id={`${id}-hint`} className="mt-1.5 text-xs text-slate-500">{hint}</p>}
    </div>
  );
});

export const PasswordField = forwardRef<HTMLInputElement, Omit<FieldProps, 'type' | 'right' | 'icon'>>(function PasswordField(props, ref) {
  const [show, setShow] = useState(false);
  return (
    <AuthField ref={ref} {...props} icon="lock" type={show ? 'text' : 'password'}
      right={(
        <button type="button" onClick={() => setShow((v) => !v)} className="mr-2 rounded-lg p-2 text-slate-500 hover:bg-white/5 hover:text-slate-200"
          aria-label={show ? t("Hide password") : t("Show password")} aria-pressed={show}>
          <Icon name={show ? 'eyeOff' : 'eye'} className="h-5 w-5" />
        </button>
      )} />
  );
});

/** 0-4 strength score shown as a bar under the new password. */
export function passwordScore(p: string): number {
  if (!p) return 0;
  let s = p.length >= 8 ? 1 : 0;
  if (p.length >= 12) s++;
  if (/[a-z]/.test(p) && /[A-Z]/.test(p)) s++;
  if (/\d/.test(p) && /[^A-Za-z0-9]/.test(p)) s++;
  return Math.min(4, s);
}
const BARS = ['bg-white/10', 'bg-rose-400', 'bg-amber-400', 'bg-emerald-400', 'bg-emerald-300'];
export function StrengthMeter({ password }: { password: string }) {
  const s = passwordScore(password);
  if (!password) return null;
  return (
    <div className="mt-2 flex items-center gap-3" aria-live="polite">
      <div className="flex flex-1 gap-1">{[1, 2, 3, 4].map((i) => <span key={i} className={`h-1.5 flex-1 rounded-full ${i <= s ? BARS[s] : 'bg-white/10'}`} />)}</div>
      <span className="w-14 text-right text-xs text-slate-400">{s === 0 ? t("Too short") : s === 1 ? t("Weak") : s === 2 ? t("Fair") : s === 3 ? t("Good") : t("Strong")}</span>
    </div>
  );
}

export function GoogleButton({ label }: { label: string }) {
  // A plain link: the BFF route redirects to Google (works without JavaScript too).
  return (
    <a href="/api/auth/google"
      className="flex h-12 w-full items-center justify-center gap-3 rounded-xl bg-white px-4 text-[15px] font-semibold text-slate-900 shadow-lg shadow-black/20 transition hover:bg-slate-100 focus-visible:ring-4 focus-visible:ring-white/30">
      <svg viewBox="0 0 48 48" className="h-5 w-5" aria-hidden>
        <path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z" />
        <path fill="#FF3D00" d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z" />
        <path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z" />
        <path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 01-4.087 5.571l.003-.002 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z" />
      </svg>
      {label}
    </a>
  );
}

export function Divider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 text-xs uppercase tracking-wider text-slate-500">
      <span className="h-px flex-1 bg-white/10" />{label}<span className="h-px flex-1 bg-white/10" />
    </div>
  );
}

export function AuthError({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="flex gap-2.5 rounded-xl border border-rose-400/30 bg-rose-500/10 px-3.5 py-3 text-sm text-rose-200">
      <Icon name="alert" className="mt-0.5 h-5 w-5 shrink-0 text-rose-300" />
      <div>{children}</div>
    </div>
  );
}

export function SubmitButton({ busy, children, disabled }: { busy?: boolean; children: ReactNode; disabled?: boolean }) {
  return (
    <button type="submit" disabled={busy || disabled}
      className="relative flex h-12 w-full items-center justify-center gap-2 overflow-hidden rounded-xl bg-gradient-to-r from-emerald-400 to-cyan-400 text-[15px] font-semibold text-slate-950 shadow-lg shadow-emerald-500/25 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60">
      {busy && <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-950/30 border-t-slate-950" aria-hidden />}
      {children}
    </button>
  );
}

/** Friendly text for ?error= after a Google redirect. */
export function googleError(code: string | null): string | null {
  switch (code) {
    case 'google_unavailable': return t("Google sign-in is not set up yet. Please use email and password.");
    case 'google_cancelled': return t("Google sign-in was cancelled.");
    case 'google_denied': return t("This Google account cannot sign in here. Contact your workspace owner.");
    case 'google_failed': return t("Google sign-in did not complete. Please try again.");
    default: return null;
  }
}
