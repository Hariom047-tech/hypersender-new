'use client';

import { msg, t } from '@/lib/i18n';

const POINTS = [
  { emoji: '⚡', title: msg('WhatsApp API & OTP in minutes'), body: msg('Scan a QR code, copy your API key and send.') },
  { emoji: '📣', title: msg('Marketing campaigns, safely'), body: msg('Offers to customers who know you, sent slow and steady.') },
  { emoji: '✨', title: msg('AI assistant that replies 24×7'), body: msg('Answers questions, takes bookings and orders for you.') },
];

/** Left side of the sign-in / sign-up screens (large screens only). */
export function AuthShowcase() {
  return (
    <section className="hidden lg:block" aria-label={t("Why businesses choose us")}>
      <span className="inline-flex items-center gap-2 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-xs font-medium text-emerald-300">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />{t("Plans from just ₹499/month · Unlimited messages")}
      </span>
      <h2 className="mt-6 text-4xl font-extrabold leading-tight tracking-tight text-white xl:text-5xl">
        {t("Grow your business")}{' '}
        <span className="bg-gradient-to-r from-emerald-300 via-teal-300 to-cyan-300 bg-clip-text text-transparent">{t("on WhatsApp")}</span>
      </h2>
      <p className="mt-4 max-w-lg text-lg leading-relaxed text-slate-400">{t("One place for your WhatsApp API, OTPs, marketing campaigns and a custom AI assistant.")}</p>

      <ul className="mt-8 space-y-4">
        {POINTS.map((p) => (
          <li key={p.title} className="flex gap-4">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-white/[0.05] text-xl ring-1 ring-white/10" aria-hidden>{p.emoji}</span>
            <div><p className="font-semibold text-white">{t(p.title)}</p><p className="text-sm text-slate-400">{t(p.body)}</p></div>
          </li>
        ))}
      </ul>

      {/* Floating preview cards */}
      <div className="relative mt-10 h-44 max-w-lg" aria-hidden>
        <div className="absolute left-0 top-0 w-72 animate-[lp-float_7s_ease-in-out_infinite] rounded-2xl border border-white/10 bg-slate-900/80 p-4 shadow-2xl backdrop-blur">
          <p className="flex items-center justify-between text-xs text-slate-400"><span>📣 {t("Diwali offer")}</span><span className="text-emerald-300">● {t("Sending")}</span></p>
          <div className="mt-3 grid grid-cols-3 gap-2 text-center">
            {[['1,236', msg('Delivered')], ['1,048', msg('Read')], ['212', msg('Replied')]].map(([n, l]) => (
              <div key={l} className="rounded-lg bg-white/5 py-2"><p className="text-sm font-bold text-white">{n}</p><p className="text-[10px] text-slate-400">{t(l)}</p></div>
            ))}
          </div>
          <div className="mt-3 h-1.5 rounded-full bg-white/10"><div className="h-1.5 w-4/5 rounded-full bg-gradient-to-r from-emerald-400 to-cyan-400" /></div>
        </div>
        <div className="absolute right-0 top-16 w-64 animate-[lp-float_8s_ease-in-out_infinite_1s] rounded-2xl border border-white/10 bg-[#0b141a] p-3 shadow-2xl">
          <p className="w-fit max-w-[90%] rounded-xl rounded-tl-sm bg-[#1f2c34] px-3 py-2 text-[13px] text-slate-100">🔐 {t("Your login code is 482913")}</p>
          <p className="ml-auto mt-2 w-fit max-w-[90%] rounded-xl rounded-tr-sm bg-[#005c4b] px-3 py-2 text-[13px] text-slate-100">✅ {t("Order confirmed!")}</p>
        </div>
      </div>
    </section>
  );
}
