import Link from 'next/link';
import type { ReactNode } from 'react';
import { AuthShowcase } from '@/components/auth/auth-showcase';
import { BRAND } from '@/lib/brand';
import { LanguageSwitch } from '@/lib/i18n';

/** Sign-in / sign-up: brand story on the left (large screens), the form on a glass card on the right. */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="relative min-h-screen overflow-hidden bg-slate-950 text-slate-200 selection:bg-emerald-400/30">
      <div className="lp-grid pointer-events-none absolute inset-0" aria-hidden />
      <div className="pointer-events-none absolute -top-40 left-1/4 h-[520px] w-[720px] rounded-full bg-emerald-500/15 blur-[120px]" aria-hidden />
      <div className="pointer-events-none absolute -bottom-40 right-0 h-[420px] w-[520px] rounded-full bg-cyan-500/10 blur-[120px]" aria-hidden />

      <header className="relative z-10 mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2 font-bold tracking-tight text-white" aria-label={BRAND}>
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-emerald-400 to-cyan-500 text-slate-950 shadow-lg shadow-emerald-500/30">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="h-4 w-4" aria-hidden><path d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" /></svg>
          </span>
          <span className="text-lg">{BRAND}</span>
        </Link>
        <LanguageSwitch className="bg-white ring-white/20" />
      </header>

      <main className="relative z-10 mx-auto grid max-w-7xl items-center gap-10 px-4 pb-12 pt-4 sm:px-6 lg:min-h-[calc(100vh-4rem)] lg:grid-cols-[1.1fr_0.9fr] lg:gap-16 lg:pb-16">
        <AuthShowcase />
        <div className="mx-auto w-full max-w-md">
          <div className="relative rounded-3xl p-px [background:linear-gradient(140deg,rgba(52,211,153,0.55),rgba(255,255,255,0.06)_35%,rgba(255,255,255,0.04)_65%,rgba(34,211,238,0.45))]">
            <div className="rounded-[calc(1.5rem-1px)] bg-slate-900/85 px-5 py-8 shadow-2xl shadow-black/50 backdrop-blur-xl sm:px-8 sm:py-10">
              {children}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
