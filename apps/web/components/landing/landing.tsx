'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { BRAND, DOCS_URL, SALES_WHATSAPP } from '@/lib/brand';
import { OTP_CODE, PATHS, SAMPLES, TECH, WEBHOOK_SAMPLE, CODE_TITLES } from './code-samples';
import { LanguageSwitch, msg, t } from '@/lib/i18n';

/* ------------------------------------------------------------------ icons */

type IconName = keyof typeof PATHS;

function Icon({ name, className = 'h-5 w-5' }: { name: IconName; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d={PATHS[name]} />
    </svg>
  );
}

function Logo() {
  return (
    <span className="flex items-center gap-2 font-bold tracking-tight text-white">
      <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-emerald-400 to-cyan-500 text-slate-950 shadow-lg shadow-emerald-500/30">
        <Icon name="bolt" className="h-4.5 w-4.5" />
      </span>
      <span className="text-lg">{BRAND}</span>
    </span>
  );
}

/* ------------------------------------------------------------------ building blocks */

function Section({ id, children, className = '' }: { id?: string; children: ReactNode; className?: string }) {
  return <section id={id} className={`scroll-mt-20 px-4 py-20 sm:px-6 sm:py-24 ${className}`}><div className="mx-auto max-w-6xl">{children}</div></section>;
}

function Heading({ eyebrow, title, body }: { eyebrow: string; title: string; body?: string }) {
  return (
    <div className="mx-auto max-w-2xl text-center">
      <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">{eyebrow}</p>
      <h2 className="mt-3 text-3xl font-bold tracking-tight text-white sm:text-4xl">{title}</h2>
      {body && <p className="mt-4 text-base leading-relaxed text-slate-400 sm:text-lg">{body}</p>}
    </div>
  );
}

const btnPrimary = 'inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-400 to-cyan-400 px-5 py-3 text-sm font-semibold text-slate-950 shadow-lg shadow-emerald-500/25 transition hover:brightness-110';
const btnGhost = 'inline-flex items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-white ring-1 ring-inset ring-white/15 transition hover:bg-white/5';

/* ------------------------------------------------------------------ nav */

const NAV = [
  { href: '#features', label: msg('Features') },
  { href: '#marketing', label: msg('Marketing') },
  { href: '#otp', label: msg('OTP') },
  { href: '#ai', label: msg('AI Assistants') },
  { href: '#pricing', label: msg('Pricing') },
  { href: '#faq', label: msg('FAQ') },
];

function Nav() {
  const [open, setOpen] = useState(false);
  return (
    <header className="sticky top-0 z-40 border-b border-white/5 bg-slate-950/75 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <a href="#top" aria-label={BRAND}><Logo /></a>
        <nav className="hidden items-center gap-1 lg:flex">
          {NAV.map((n) => <a key={n.href} href={n.href} className="rounded-lg px-3 py-2 text-sm text-slate-300 transition hover:bg-white/5 hover:text-white">{t(n.label)}</a>)}
          <a href={DOCS_URL} target="_blank" rel="noreferrer" className="rounded-lg px-3 py-2 text-sm text-slate-300 transition hover:bg-white/5 hover:text-white">{t("API Docs")}</a>
        </nav>
        <div className="flex items-center gap-2">
          <LanguageSwitch className="bg-white ring-white/20" />
          <Link href="/login" className="hidden rounded-lg px-3 py-2 text-sm font-medium text-slate-200 hover:text-white sm:inline-flex">{t("Log in")}</Link>
          <Link href="/register" className={`${btnPrimary} hidden !px-4 !py-2 sm:inline-flex`}>{t("Start free")}</Link>
          <button type="button" className="rounded-lg p-2 text-slate-200 hover:bg-white/5 lg:hidden" aria-label={t("Menu")} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            <Icon name={open ? 'close' : 'menu'} className="h-6 w-6" />
          </button>
        </div>
      </div>
      {open && (
        <nav className="border-t border-white/5 px-4 pb-4 lg:hidden">
          {NAV.map((n) => <a key={n.href} href={n.href} onClick={() => setOpen(false)} className="block rounded-lg px-3 py-3 text-slate-200 hover:bg-white/5">{t(n.label)}</a>)}
          <a href={DOCS_URL} target="_blank" rel="noreferrer" className="block rounded-lg px-3 py-3 text-slate-200 hover:bg-white/5">{t("API Docs")}</a>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Link href="/login" className={btnGhost}>{t("Log in")}</Link>
            <Link href="/register" className={btnPrimary}>{t("Start free")}</Link>
          </div>
        </nav>
      )}
    </header>
  );
}

/* ------------------------------------------------------------------ hero */

function PhoneMock() {
  return (
    <div className="relative mx-auto w-full max-w-[300px] animate-[lp-float_7s_ease-in-out_infinite]">
      <div className="absolute -inset-6 rounded-[3rem] bg-gradient-to-br from-emerald-500/30 to-cyan-500/20 blur-3xl" aria-hidden />
      <div className="relative rounded-[2.4rem] border border-white/10 bg-slate-900 p-2.5 shadow-2xl">
        <div className="overflow-hidden rounded-[1.9rem] bg-[#0b141a]">
          <div className="flex items-center gap-3 bg-[#1f2c34] px-4 py-3">
            <span className="grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-emerald-400 to-cyan-500 text-slate-950"><Icon name="bolt" className="h-4 w-4" /></span>
            <div className="leading-tight">
              <p className="text-sm font-semibold text-white">{t("Sharma Sweets")}</p>
              <p className="text-[11px] text-emerald-400">{t("online")}</p>
            </div>
          </div>
          <div className="space-y-2.5 px-3 py-4 text-[13px] leading-snug">
            <Bubble delay="0.2s">{wa(t("🔐 Your login code is *482913*. Valid for 5 minutes. Do not share it with anyone."))}</Bubble>
            <Bubble mine delay="1.1s">{t("Kaju katli 1 kg available hai?")}</Bubble>
            <Bubble delay="2s">{t("Ji haan! 🙏 Kaju katli ₹960/kg hai. Kya main aapka order book kar doon?")}<span className="mt-1 block text-[10px] text-emerald-400">✨ {t("AI assistant")}</span></Bubble>
            <Bubble mine delay="2.9s">{t("Haan, 1 kg kal shaam 6 baje")}</Bubble>
            <Bubble delay="3.8s">{t("✅ Order confirmed! Kal shaam 6 baje ready rahega.")}</Bubble>
          </div>
        </div>
      </div>
    </div>
  );
}

/** WhatsApp-style *bold* inside a chat bubble. */
const wa = (text: string) => text.split(/(\*[^*]+\*)/).map((part, i) => (/^\*[^*]+\*$/.test(part) ? <b key={i}>{part.slice(1, -1)}</b> : part));

function Bubble({ children, mine, delay }: { children: ReactNode; mine?: boolean; delay: string }) {
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <p style={{ animationDelay: delay }}
        className={`max-w-[85%] animate-[lp-pop_0.5s_ease-out_both] rounded-xl px-3 py-2 text-slate-100 shadow ${mine ? 'rounded-tr-sm bg-[#005c4b]' : 'rounded-tl-sm bg-[#1f2c34]'}`}>
        {children}
      </p>
    </div>
  );
}

function Hero() {
  return (
    <section id="top" className="relative overflow-hidden px-4 pb-16 pt-14 sm:px-6 sm:pt-20">
      <div className="lp-grid pointer-events-none absolute inset-0" aria-hidden />
      <div className="pointer-events-none absolute left-1/2 top-0 h-[520px] w-[900px] -translate-x-1/2 rounded-full bg-emerald-500/15 blur-[120px]" aria-hidden />
      <div className="relative mx-auto grid max-w-6xl items-center gap-14 lg:grid-cols-[1.15fr_0.85fr]">
        <div className="text-center lg:text-left">
          <a href="#pricing" className="inline-flex items-center gap-2 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-xs font-medium text-emerald-300">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
            {t("Plans from just ₹499/month · Unlimited messages")}
          </a>
          <h1 className="mt-6 text-4xl font-extrabold leading-[1.1] tracking-tight text-white sm:text-5xl lg:text-6xl">
            {t("WhatsApp marketing, API & AI assistants")}{' '}
            <span className="bg-gradient-to-r from-emerald-300 via-teal-300 to-cyan-300 bg-clip-text text-transparent">{t("for developers who ship fast")}</span>
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-base leading-relaxed text-slate-400 sm:text-lg lg:mx-0">
            {t("Send offers to all your customers at once, send OTPs and messages from your app, and let an AI assistant reply 24×7. Connect your number with a QR scan: no Meta approval, no per-message charges, one flat monthly price.")}
          </p>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row lg:justify-start">
            <Link href="/register" className={btnPrimary}>{t("Start 14-day free trial")}<Icon name="arrow" className="h-4 w-4" /></Link>
            <a href="#api" className={btnGhost}><Icon name="code" className="h-4 w-4" />{t("See the API")}</a>
          </div>
          <ul className="mt-8 flex flex-wrap justify-center gap-x-6 gap-y-2 text-sm text-slate-400 lg:justify-start">
            {[msg('No credit card needed'), msg('Setup in 2 minutes'), msg('Cancel anytime')].map((x) => (
              <li key={x} className="flex items-center gap-1.5"><Icon name="check" className="h-4 w-4 text-emerald-400" />{t(x)}</li>
            ))}
          </ul>
        </div>
        <PhoneMock />
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ code window */


function CodeWindow({ samples, title }: { samples: Record<string, string>; title: string }) {
  const langs = Object.keys(samples);
  const [lang, setLang] = useState(langs[0]!);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(samples[lang]!).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };
  return (
    <div className="overflow-hidden rounded-2xl border border-white/10 bg-[#0a0f1c] shadow-2xl shadow-black/40">
      <div className="flex items-center justify-between gap-3 border-b border-white/10 bg-white/[0.03] px-4 py-2.5">
        <div className="flex items-center gap-1.5" aria-hidden>
          <span className="h-3 w-3 rounded-full bg-rose-400/80" /><span className="h-3 w-3 rounded-full bg-amber-400/80" /><span className="h-3 w-3 rounded-full bg-emerald-400/80" />
        </div>
        <p className="truncate font-mono text-xs text-slate-500">{title}</p>
        <button type="button" onClick={copy} className="rounded-md px-2 py-1 text-xs font-medium text-slate-400 ring-1 ring-white/10 hover:text-white">{copied ? t("Copied ✓") : t("Copy")}</button>
      </div>
      {langs.length > 1 && (
        <div className="flex gap-1 overflow-x-auto border-b border-white/10 px-3 pt-2" role="tablist">
          {langs.map((l) => (
            <button key={l} type="button" role="tab" aria-selected={l === lang} onClick={() => setLang(l)}
              className={`whitespace-nowrap rounded-t-lg px-3 py-2 text-xs font-semibold transition ${l === lang ? 'bg-white/10 text-emerald-300' : 'text-slate-500 hover:text-slate-200'}`}>
              {t(l)}
            </button>
          ))}
        </div>
      )}
      <pre className="max-h-[360px] overflow-auto p-5 font-mono text-[13px] leading-relaxed text-slate-200"><code>{samples[lang]}</code></pre>
    </div>
  );
}

/* ------------------------------------------------------------------ marketing campaigns */

const TEMPLATES = [msg('🪔 Diwali offer'), msg('🆕 New arrivals'), msg('💳 Payment reminder'), msg('🎉 Event invite')];

function CampaignMock() {
  const stats: Array<[string, string, string]> = [
    [msg('Sent'), '1,250', 'w-full'],
    [msg('Delivered'), '1,236', 'w-[98%]'],
    [msg('Read'), '1,048', 'w-[84%]'],
    [msg('Replied'), '212', 'w-[17%]'],
  ];
  return (
    <div className="relative">
      <div className="absolute -inset-4 rounded-[2rem] bg-gradient-to-br from-fuchsia-500/20 via-emerald-500/15 to-cyan-500/20 blur-3xl" aria-hidden />
      <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-[#0a0f1c] shadow-2xl shadow-black/40">
        <div className="flex items-center justify-between gap-3 border-b border-white/10 bg-white/[0.03] px-5 py-3">
          <p className="flex items-center gap-2 text-sm font-semibold text-white"><Icon name="megaphone" className="h-4 w-4 text-emerald-300" />{t("New campaign")}</p>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-400/15 px-2.5 py-1 text-xs font-medium text-emerald-300"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />{t("Sending…")}</span>
        </div>
        <div className="space-y-4 p-5">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-slate-500">{t("Template")}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {TEMPLATES.map((x, i) => (
                <span key={x} className={`rounded-lg px-3 py-1.5 text-xs font-medium ${i === 0 ? 'bg-emerald-400 text-slate-950' : 'bg-white/5 text-slate-300 ring-1 ring-white/10'}`}>{t(x)}</span>
              ))}
            </div>
          </div>
          <div className="rounded-xl bg-[#0b141a] p-3">
            <p className="max-w-[92%] whitespace-pre-line rounded-xl rounded-tl-sm bg-[#1f2c34] px-3 py-2 text-[13px] leading-snug text-slate-100">
              {wa(t("Namaste {name} ji 🙏\nIs Diwali *20% off* on all sweets at Sharma Sweets! 🪔\nReply YES to order. Reply STOP to unsubscribe.", { name: '{name}' }))}
            </p>
            <p className="mt-2 flex items-center gap-1.5 text-[11px] text-fuchsia-300"><Icon name="sparkles" className="h-3.5 w-3.5" />{t("Written by AI · {name} is filled in for every customer")}</p>
          </div>
          <p className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white/5 px-3 py-2 text-sm text-slate-300">
            <span>👥 {t("1,250 customers · Group: Regular customers")}</span>
            <span className="text-xs text-slate-500">🕖 {t("Today, 7:00 PM")}</span>
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {stats.map(([label, n, w]) => (
              <div key={label} className="rounded-lg border border-white/10 p-3">
                <p className="text-lg font-bold text-white">{n}</p>
                <p className="text-xs text-slate-400">{t(label)}</p>
                <div className="mt-2 h-1 rounded-full bg-white/10"><div className={`h-1 rounded-full bg-gradient-to-r from-emerald-400 to-cyan-400 ${w}`} /></div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <p className="relative mt-3 text-center text-xs text-slate-500">{t("Example campaign")}</p>
    </div>
  );
}

function Marketing() {
  const points: Array<{ icon: IconName; title: string; body: string }> = [
    { icon: 'megaphone', title: msg('Send to thousands at once'), body: msg('Reach every customer who has chatted with you or agreed to receive offers, or only recent ones, with one click.') },
    { icon: 'sparkles', title: msg('AI writes your message'), body: msg('Tell the AI assistant your offer in Hindi or English. It writes a catchy message with emojis and a clear call to action.') },
    { icon: 'photo', title: msg('Many ready templates'), body: msg('Festival offers, new arrivals, payment reminders, event invites and more. Add images, videos or PDFs.') },
    { icon: 'clock', title: msg('Schedule & safe sending'), body: msg('Pick the best time. Messages go out with smart gaps and an easy opt-out to keep your number safe.') },
    { icon: 'chart', title: msg('Track every result'), body: msg('See sent, delivered, read and replied for every campaign. Replies go straight to your AI assistant and team inbox.') },
  ];
  const costs: Array<[string, string, boolean]> = [
    [msg('Bulk SMS'), msg('≈ ₹1,500 – ₹2,500'), false],
    [msg('Official WhatsApp API'), msg('≈ ₹8,000 + GST'), false],
    [BRAND, msg('Included in ₹499/month'), true],
  ];
  return (
    <Section id="marketing" className="relative overflow-hidden bg-gradient-to-b from-transparent via-fuchsia-950/15 to-transparent">
      <div className="pointer-events-none absolute -left-20 top-20 h-80 w-80 rounded-full bg-fuchsia-500/10 blur-[110px]" aria-hidden />
      <div className="relative mb-5 text-center">
        <span className="inline-flex items-center gap-2 rounded-full border border-fuchsia-400/30 bg-fuchsia-400/10 px-3 py-1 text-xs font-semibold text-fuchsia-200">
          <Icon name="megaphone" className="h-3.5 w-3.5" />{t("Most loved service")}
        </span>
      </div>
      <Heading eyebrow={t("WhatsApp marketing campaigns")} title={t("Send your offers to every customer in one click")}
        body={t("Pick a template or let the AI assistant write one, personalise it with each customer's name, and send it to your whole list at once. No per-message fee, so a campaign costs a fraction of SMS or the official API.")} />
      <div className="mt-14 grid items-start gap-12 lg:grid-cols-[1fr_1.05fr]">
        <ul className="space-y-5">
          {points.map((p) => (
            <li key={p.title} className="flex gap-4">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-fuchsia-400/20 to-emerald-400/10 text-fuchsia-200 ring-1 ring-fuchsia-400/20"><Icon name={p.icon} /></span>
              <div><p className="font-semibold text-white">{t(p.title)}</p><p className="mt-1 text-sm leading-relaxed text-slate-400">{t(p.body)}</p></div>
            </li>
          ))}
        </ul>
        <CampaignMock />
      </div>
      <div className="mt-12 rounded-2xl border border-white/10 bg-white/[0.03] p-6">
        <p className="text-center text-sm font-medium text-slate-300">{t("Cost of sending 10,000 marketing messages (approx.)")}</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {costs.map(([who, cost, us]) => (
            <div key={who} className={`rounded-xl p-4 text-center ${us ? 'bg-gradient-to-br from-emerald-400/20 to-cyan-400/10 ring-2 ring-emerald-400/60' : 'bg-white/[0.03] ring-1 ring-white/10'}`}>
              <p className={`text-sm ${us ? 'font-semibold text-emerald-200' : 'text-slate-400'}`}>{us ? who : t(who)}</p>
              <p className={`mt-1 text-xl font-bold ${us ? 'text-white' : 'text-slate-300 line-through decoration-rose-400/60'}`}>{t(cost)}</p>
            </div>
          ))}
        </div>
        <div className="mt-6 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link href="/register" className={btnPrimary}>{t("Start your first campaign free")}<Icon name="arrow" className="h-4 w-4" /></Link>
          <a href={`https://wa.me/${SALES_WHATSAPP}`} target="_blank" rel="noreferrer" className={btnGhost}>{t("We'll run it for you")}</a>
        </div>
      </div>
    </Section>
  );
}

function ApiSection() {
  return (
    <Section id="api">
      <div className="grid items-center gap-12 lg:grid-cols-2">
        <div>
          <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">{t("Developer first")}</p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight text-white sm:text-4xl">{t("One API call. Message delivered.")}</h2>
          <p className="mt-4 text-lg leading-relaxed text-slate-400">{t("A clean REST API with API keys, clear error codes and idempotent requests. Works with any language that can send an HTTP request.")}</p>
          <ul className="mt-8 space-y-4">
            {[
              [msg('Simple JSON over HTTPS'), msg('Send text, images, videos, documents and voice notes with one endpoint.')],
              [msg('Scoped API keys'), msg('Create separate keys for each app, limit what they can do and revoke them anytime.')],
              [msg('Interactive API reference'), msg('Try every endpoint from your browser with the built-in OpenAPI docs.')],
            ].map(([h, b]) => (
              <li key={h} className="flex gap-3">
                <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-emerald-400/15 text-emerald-300"><Icon name="check" className="h-3.5 w-3.5" /></span>
                <p className="text-slate-300"><span className="font-semibold text-white">{t(h)}</span> — {t(b)}</p>
              </li>
            ))}
          </ul>
          <div className="mt-8 flex flex-wrap gap-2">
            {TECH.map((l) => <span key={l} className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs font-medium text-slate-300">{l}</span>)}
          </div>
        </div>
        <CodeWindow samples={SAMPLES} title={CODE_TITLES.send} />
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ features */

const FEATURES: Array<{ icon: IconName; title: string; body: string }> = [
  { icon: 'chat', title: msg('WhatsApp API'), body: msg('Send and receive text, images, videos, documents and voice notes from your own WhatsApp number.') },
  { icon: 'key', title: msg('OTP & login links'), body: msg('Send one-time passwords on WhatsApp, verify them with one call and stop brute force with built-in rate limits.') },
  { icon: 'link', title: msg('Real-time webhooks'), body: msg('Get every incoming message, delivery and read receipt on your server the moment it happens, signed and retried.') },
  { icon: 'sparkles', title: msg('AI assistants'), body: msg('Let a trained AI assistant answer customers, take bookings and orders 24×7, and hand over to your team when needed.') },
  { icon: 'users', title: msg('Shared team inbox'), body: msg('Your whole team replies from one WhatsApp number, with assignment, notes and chat history in one place.') },
  { icon: 'qr', title: msg('QR or pairing code'), body: msg('Connect any WhatsApp or WhatsApp Business number in seconds. No Facebook Business verification needed.') },
  { icon: 'bell', title: msg('Uptime alerts'), body: msg('Get notified the moment a number disconnects, so your messages never silently stop.') },
  { icon: 'megaphone', title: msg('Bulk marketing campaigns'), body: msg('Send offers and updates to thousands of customers at once, with AI-written templates and full tracking.') },
  { icon: 'shield', title: msg('Secure by design'), body: msg('Encrypted secrets, per-business data isolation and full audit logs for every change.') },
];

function Features() {
  return (
    <Section id="features">
      <Heading eyebrow={t("Everything in one place")} title={t("Everything you need to talk to customers on WhatsApp")}
        body={t("From a single OTP to a full AI-powered support desk, start small and grow without changing platforms.")} />
      <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((f) => (
          <div key={f.title} className="group relative overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] p-6 transition hover:-translate-y-0.5 hover:border-emerald-400/40 hover:bg-white/[0.05]">
            <div className="absolute -right-10 -top-10 h-32 w-32 rounded-full bg-emerald-500/0 blur-2xl transition group-hover:bg-emerald-500/20" aria-hidden />
            <span className="grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-br from-emerald-400/20 to-cyan-400/10 text-emerald-300 ring-1 ring-emerald-400/20"><Icon name={f.icon} /></span>
            <h3 className="mt-5 text-lg font-semibold text-white">{t(f.title)}</h3>
            <p className="mt-2 text-sm leading-relaxed text-slate-400">{t(f.body)}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ OTP */


function Otp() {
  const steps: Array<[string, string]> = [
    [msg('Send the code'), msg('We generate the code, deliver it on WhatsApp and track its status.')],
    [msg('Verify in one call'), msg('Check the code the user typed. Wrong attempts and expiry are handled for you.')],
    [msg('Or skip the code'), msg('Send a one-tap login link instead for passwordless sign-in.')],
  ];
  return (
    <Section id="otp" className="bg-gradient-to-b from-transparent via-emerald-950/20 to-transparent">
      <div className="grid items-center gap-12 lg:grid-cols-2">
        <CodeWindow samples={{ [msg('1 · Send')]: OTP_CODE.OTP_SEND, [msg('2 · Verify')]: OTP_CODE.OTP_VERIFY, [msg('3 · Magic link')]: OTP_CODE.OTP_LINK }} title={CODE_TITLES.otp} />
        <div>
          <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">{t("WhatsApp OTP")}</p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight text-white sm:text-4xl">{t("OTPs people actually open")}</h2>
          <p className="mt-4 text-lg leading-relaxed text-slate-400">{t("Almost everyone in India checks WhatsApp more than SMS. Send login and verification codes where your users already are, without DLT registration or per-SMS costs.")}</p>
          <ol className="mt-8 space-y-5">
            {steps.map(([h, b], i) => (
              <li key={h} className="flex gap-4">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-emerald-400 text-sm font-bold text-slate-950">{i + 1}</span>
                <div><p className="font-semibold text-white">{t(h)}</p><p className="mt-1 text-sm text-slate-400">{t(b)}</p></div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ webhooks */


function Webhooks() {
  const points = [
    [msg('Signed payloads'), msg('Every request carries a signature so you know it came from us.')],
    [msg('Automatic retries'), msg('Failed deliveries are retried with back-off, and you can replay any of them.')],
    [msg('Delivery log'), msg('See each attempt, the response code and the body your server returned.')],
  ];
  return (
    <Section id="webhooks">
      <div className="grid items-center gap-12 lg:grid-cols-2">
        <div>
          <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">{t("Webhooks")}</p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight text-white sm:text-4xl">{t("Know the moment anything happens")}</h2>
          <p className="mt-4 text-lg leading-relaxed text-slate-400">{t("New messages, delivery and read receipts, and connection changes are pushed to your URL in real time. No polling.")}</p>
          <div className="mt-8 grid gap-3 sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
            {points.map(([h, b]) => (
              <div key={h} className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
                <p className="font-semibold text-white">{t(h)}</p>
                <p className="mt-1 text-sm text-slate-400">{t(b)}</p>
              </div>
            ))}
          </div>
        </div>
        <CodeWindow samples={WEBHOOK_SAMPLE} title={CODE_TITLES.webhook} />
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ AI assistants */

const USE_CASES: Array<{ emoji: string; title: string; body: string }> = [
  { emoji: '🛕', title: msg('Temples & pandits'), body: msg('Havan and puja bookings, festival dates, reminders and call-back requests.') },
  { emoji: '🍽️', title: msg('Restaurants & sweet shops'), body: msg('Menu questions, orders, delivery slots and order updates.') },
  { emoji: '🩺', title: msg('Clinics & salons'), body: msg('Appointments, reschedules and reminders without phone calls.') },
  { emoji: '🏠', title: msg('Real estate & coaching'), body: msg('Qualify leads, share brochures and book site visits or demo classes.') },
];

function AiAssistants() {
  return (
    <Section id="ai" className="relative overflow-hidden">
      <div className="pointer-events-none absolute right-0 top-10 h-80 w-80 rounded-full bg-cyan-500/10 blur-[100px]" aria-hidden />
      <Heading eyebrow={t("Custom AI assistants")} title={t("An AI assistant that knows your business")}
        body={t("We build and train a WhatsApp assistant on your services, prices and FAQs. It replies in Hindi, English or Hinglish, books appointments, and calls your team in when a human is needed.")} />
      <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {USE_CASES.map((u) => (
          <div key={u.title} className="rounded-2xl border border-white/10 bg-gradient-to-b from-white/[0.06] to-white/[0.02] p-6">
            <span className="text-3xl" aria-hidden>{u.emoji}</span>
            <h3 className="mt-4 font-semibold text-white">{t(u.title)}</h3>
            <p className="mt-2 text-sm leading-relaxed text-slate-400">{t(u.body)}</p>
          </div>
        ))}
      </div>
      <div className="mt-10 grid gap-4 rounded-2xl border border-emerald-400/20 bg-emerald-400/[0.04] p-6 sm:grid-cols-3 sm:p-8">
        {[
          [msg('Trained on your data'), msg('Upload FAQs, documents and links. Answers stay grounded in what you provide.')],
          [msg('Takes real actions'), msg('Checks availability, creates bookings, reminds customers and notifies your staff.')],
          [msg('You stay in control'), msg('Test it before going live, review every chat and take over any conversation.')],
        ].map(([h, b]) => (
          <div key={h} className="flex gap-3">
            <Icon name="sparkles" className="mt-0.5 h-5 w-5 shrink-0 text-emerald-300" />
            <div><p className="font-semibold text-white">{t(h)}</p><p className="mt-1 text-sm text-slate-400">{t(b)}</p></div>
          </div>
        ))}
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ how it works + services */

function HowItWorks() {
  const steps: Array<{ icon: IconName; title: string; body: string }> = [
    { icon: 'users', title: msg('Create your account'), body: msg('Sign up free. No credit card, no paperwork.') },
    { icon: 'qr', title: msg('Scan the QR code'), body: msg('Link your WhatsApp number just like WhatsApp Web.') },
    { icon: 'bolt', title: msg('Send your first message'), body: msg('Copy your API key and send from any language in minutes.') },
  ];
  return (
    <Section>
      <Heading eyebrow={t("How it works")} title={t("Live in three steps")} />
      <div className="relative mt-14 grid gap-6 md:grid-cols-3">
        <div className="absolute left-[16%] right-[16%] top-7 hidden h-px bg-gradient-to-r from-emerald-400/0 via-emerald-400/50 to-emerald-400/0 md:block" aria-hidden />
        {steps.map((s, i) => (
          <div key={s.title} className="relative text-center">
            <span className="relative mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-slate-900 text-emerald-300 ring-1 ring-emerald-400/40">
              <Icon name={s.icon} className="h-6 w-6" />
              <span className="absolute -right-2 -top-2 grid h-6 w-6 place-items-center rounded-full bg-emerald-400 text-xs font-bold text-slate-950">{i + 1}</span>
            </span>
            <h3 className="mt-5 text-lg font-semibold text-white">{t(s.title)}</h3>
            <p className="mx-auto mt-2 max-w-xs text-sm text-slate-400">{t(s.body)}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}

function Services() {
  const items: Array<{ icon: IconName; title: string; body: string }> = [
    { icon: 'code', title: msg('API integration help'), body: msg('We help your developers connect WhatsApp to your website, app or CRM.') },
    { icon: 'sparkles', title: msg('AI assistant setup'), body: msg('We write the prompts, add your knowledge and test the assistant for you.') },
    { icon: 'wrench', title: msg('Custom automations'), body: msg('Order updates, payment reminders, follow-ups and reports built to your needs.') },
    { icon: 'chart', title: msg('Ongoing support'), body: msg('Real people on WhatsApp to help when you need changes or get stuck.') },
  ];
  return (
    <Section id="services" className="bg-gradient-to-b from-transparent via-cyan-950/20 to-transparent">
      <div className="grid gap-12 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
        <div>
          <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">{t("Done-for-you services")}</p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight text-white sm:text-4xl">{t("Not technical? We set it up for you.")}</h2>
          <p className="mt-4 text-lg leading-relaxed text-slate-400">{t("Everything is easy to use from the dashboard, and our team is one WhatsApp message away if you want us to build it for you.")}</p>
          <a href={`https://wa.me/${SALES_WHATSAPP}`} target="_blank" rel="noreferrer" className={`${btnGhost} mt-8`}><Icon name="chat" className="h-4 w-4" />{t("Talk to us on WhatsApp")}</a>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {items.map((s) => (
            <div key={s.title} className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
              <Icon name={s.icon} className="h-6 w-6 text-cyan-300" />
              <h3 className="mt-4 font-semibold text-white">{t(s.title)}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-400">{t(s.body)}</p>
            </div>
          ))}
        </div>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ comparison */

function Compare() {
  const rows: Array<[string, string, string]> = [
    [msg('Monthly cost'), msg('From ₹499, flat'), msg('Per-conversation charges + BSP fees')],
    [msg('Per-message charges'), msg('None'), msg('Yes, for every template message')],
    [msg('Setup time'), msg('2 minutes with a QR scan'), msg('Days to weeks')],
    [msg('Facebook Business verification'), msg('Not needed'), msg('Required')],
    [msg('Message templates approval'), msg('Not needed'), msg('Required for outbound messages')],
    [msg('Bulk marketing messages'), msg('Included, no per-message fee'), msg('About ₹0.80 + GST per message')],
    [msg('AI assistant'), msg('Included on Pro and above'), msg('Build it yourself')],
  ];
  return (
    <Section>
      <Heading eyebrow={t("Why us")} title={t("Why {brand}?", { brand: BRAND })} body={t("A simpler, cheaper way to use WhatsApp for your business.")} />
      <div className="mt-12 overflow-x-auto rounded-2xl border border-white/10">
        <table className="w-full min-w-[560px] text-left text-sm">
          <thead className="bg-white/[0.04] text-slate-300">
            <tr>
              <th className="px-5 py-4 font-medium" />
              <th className="px-5 py-4 font-semibold text-emerald-300">{BRAND}</th>
              <th className="px-5 py-4 font-medium">{t("Official Business API")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {rows.map(([k, us, them]) => (
              <tr key={k}>
                <td className="px-5 py-4 font-medium text-white">{t(k)}</td>
                <td className="px-5 py-4 text-emerald-200"><span className="inline-flex items-center gap-2"><Icon name="check" className="h-4 w-4 shrink-0 text-emerald-400" />{t(us)}</span></td>
                <td className="px-5 py-4 text-slate-400">{t(them)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ pricing */

type Plan = { name: string; monthly: number | null; tagline: string; numbers: string; features: string[]; popular?: boolean; cta: string };

const PLANS: Plan[] = [
  { name: msg('Free trial'), monthly: 0, tagline: msg('Try everything for 14 days'), numbers: msg('1 WhatsApp number'), cta: msg('Start free'),
    features: [msg('100 messages per day'), msg('Try marketing campaigns'), msg('WhatsApp API & OTP'), msg('1 webhook URL'), msg('100 MB media storage'), msg('Community support')] },
  { name: msg('Starter'), monthly: 499, tagline: msg('For small businesses and side projects'), numbers: msg('1 WhatsApp number'), popular: true, cta: msg('Choose Starter'),
    features: [msg('Unlimited messages'), msg('Marketing campaigns: 1,000 contacts / day'), msg('60 API requests / minute'), msg('WhatsApp OTP & login links'), msg('3 webhook URLs'), msg('1 GB media storage'), msg('Shared team inbox'), msg('Email support')] },
  { name: msg('Pro'), monthly: 1199, tagline: msg('For growing teams'), numbers: msg('3 WhatsApp numbers'), cta: msg('Choose Pro'),
    features: [msg('Everything in Starter'), msg('Marketing campaigns: 5,000 contacts / day'), msg('AI-written campaign messages'), msg('100 API requests / minute'), msg('10 webhook URLs'), msg('5 GB media storage'), msg('1 AI assistant'), msg('Priority WhatsApp support')] },
  { name: msg('Business'), monthly: 1699, tagline: msg('For busy businesses and agencies'), numbers: msg('5 WhatsApp numbers'), cta: msg('Choose Business'),
    features: [msg('Everything in Pro'), msg('Marketing campaigns: 15,000 contacts / day'), msg('500 API requests / minute'), msg('25 webhook URLs'), msg('20 GB media storage'), msg('3 AI assistants'), msg('Uptime alerts on WhatsApp')] },
];

const inr = (n: number) => `₹${n.toLocaleString('en-IN')}`;

function Pricing() {
  const [yearly, setYearly] = useState(false);
  return (
    <Section id="pricing">
      <Heading eyebrow={t("Pricing")} title={t("Simple pricing. Unlimited messages.")} body={t("Half the price of most WhatsApp API tools, with no per-message fees. Prices exclude GST.")} />
      <div className="mt-8 flex justify-center">
        <div className="inline-flex items-center rounded-xl border border-white/10 bg-white/[0.03] p-1 text-sm">
          <button type="button" onClick={() => setYearly(false)} aria-pressed={!yearly} className={`rounded-lg px-4 py-2 font-medium transition ${!yearly ? 'bg-white text-slate-950' : 'text-slate-300'}`}>{t("Monthly")}</button>
          <button type="button" onClick={() => setYearly(true)} aria-pressed={yearly} className={`rounded-lg px-4 py-2 font-medium transition ${yearly ? 'bg-white text-slate-950' : 'text-slate-300'}`}>
            {t("Yearly")} <span className="ml-1 rounded-full bg-emerald-400/20 px-2 py-0.5 text-xs text-emerald-300">{t("2 months free")}</span>
          </button>
        </div>
      </div>
      <div className="mt-10 grid gap-5 md:grid-cols-2 xl:grid-cols-4">
        {PLANS.map((p) => {
          const price = p.monthly === null ? null : yearly ? p.monthly * 10 : p.monthly;
          return (
            <div key={p.name} className={`relative flex flex-col rounded-2xl p-6 ${p.popular ? 'bg-gradient-to-b from-emerald-400/15 to-cyan-400/5 ring-2 ring-emerald-400/70' : 'border border-white/10 bg-white/[0.03]'}`}>
              {p.popular && <span className="absolute -top-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-gradient-to-r from-emerald-400 to-cyan-400 px-3 py-1 text-xs font-bold text-slate-950">{t("Most popular")}</span>}
              <h3 className="text-lg font-semibold text-white">{t(p.name)}</h3>
              <p className="mt-1 min-h-10 text-sm text-slate-400">{t(p.tagline)}</p>
              <p className="mt-5 flex items-end gap-1">
                <span className="text-4xl font-extrabold tracking-tight text-white">{price === 0 ? t("Free") : inr(price ?? 0)}</span>
                {!!price && <span className="pb-1 text-sm text-slate-400">{yearly ? t("/year") : t("/month")}</span>}
              </p>
              {yearly && !!p.monthly && <p className="mt-1 text-xs text-emerald-300">{t("{amount}/month billed yearly", { amount: inr(Math.round((p.monthly * 10) / 12)) })}</p>}
              <p className="mt-4 rounded-lg bg-white/5 px-3 py-2 text-sm font-medium text-white">📱 {t(p.numbers)}</p>
              <ul className="mt-5 flex-1 space-y-2.5">
                {p.features.map((f) => <li key={f} className="flex gap-2 text-sm text-slate-300"><Icon name="check" className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />{t(f)}</li>)}
              </ul>
              <Link href="/register" className={`mt-6 ${p.popular ? btnPrimary : btnGhost}`}>{t(p.cta)}</Link>
            </div>
          );
        })}
      </div>
      <div className="mt-6 flex flex-col items-center justify-between gap-4 rounded-2xl border border-white/10 bg-white/[0.03] p-6 sm:flex-row">
        <div>
          <p className="text-lg font-semibold text-white">{t("Enterprise")}</p>
          <p className="mt-1 text-sm text-slate-400">{t("10+ numbers, 1000+ requests per minute, custom AI assistants built for you and a dedicated account manager.")}</p>
        </div>
        <a href={`https://wa.me/${SALES_WHATSAPP}`} target="_blank" rel="noreferrer" className={`${btnGhost} shrink-0`}>{t("Contact sales")}</a>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ FAQ + CTA + footer */

const FAQ: Array<[string, string]> = [
  [msg('What is {brand}?'), msg('{brand} lets you send and receive WhatsApp messages from your own number through a simple API and dashboard. You can also add OTP login, webhooks and a custom AI assistant.')],
  [msg('Is this the official WhatsApp Business API?'), msg('No. {brand} links your existing WhatsApp or WhatsApp Business number the same way WhatsApp Web does, so there is no Meta approval or per-message fee. Please follow WhatsApp’s terms: message people who expect to hear from you and never send spam, or WhatsApp may restrict the number.')],
  [msg('Are messages really unlimited?'), msg('Yes, on all paid plans there is no message cap. Only the API request rate per minute changes by plan, to keep your number safe.')],
  [msg('Do I need to be a developer?'), msg('No. The dashboard, team inbox and AI assistant work without code. Developers get the API, webhooks and OTP on top.')],
  [msg('Can you build a custom AI assistant for my business?'), msg('Yes. Tell us about your business and we will set up, train and test an assistant for you. Talk to us on WhatsApp to get started.')],
  [msg('Can I send marketing messages to many customers at once?'), msg('Yes. Create a campaign, choose a template or let the AI write it, pick your contacts and send now or schedule it. Only message customers who know your business and agreed to hear from you: every campaign includes an opt-out, and we send with safe gaps to protect your number.')],
  [msg('Is there a free trial?'), msg('Yes, 14 days free with 100 messages a day. No credit card needed.')],
  [msg('How do I pay and can I cancel?'), msg('Pay monthly or yearly by UPI, card or net banking. You can upgrade, downgrade or cancel at any time from your dashboard.')],
  [msg('What happens if my phone goes offline?'), msg('Your number stays linked for a long time even when the phone is off. If it ever disconnects we alert you right away so you can reconnect with one scan.')],
];

function Faq() {
  return (
    <Section id="faq">
      <Heading eyebrow={t("FAQ")} title={t("Questions, answered")} />
      <div className="mx-auto mt-12 max-w-3xl space-y-3">
        {FAQ.map(([q, a]) => (
          <details key={q} className="group rounded-2xl border border-white/10 bg-white/[0.03] px-5 open:bg-white/[0.05]">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-5 font-medium text-white">
              {t(q, { brand: BRAND })}
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-white/5 text-emerald-300 transition group-open:rotate-45" aria-hidden>+</span>
            </summary>
            <p className="pb-5 text-sm leading-relaxed text-slate-400">{t(a, { brand: BRAND })}</p>
          </details>
        ))}
      </div>
    </Section>
  );
}

function FinalCta() {
  return (
    <section className="px-4 pb-20 sm:px-6">
      <div className="relative mx-auto max-w-6xl overflow-hidden rounded-3xl bg-gradient-to-br from-emerald-500 via-teal-500 to-cyan-600 px-6 py-14 text-center sm:px-12">
        <div className="lp-grid pointer-events-none absolute inset-0 opacity-30" aria-hidden />
        <h2 className="relative text-3xl font-extrabold tracking-tight text-slate-950 sm:text-4xl">{t("Send your first WhatsApp message today")}</h2>
        <p className="relative mx-auto mt-4 max-w-xl text-slate-900/80">{t("Start free for 14 days. Plans from ₹499/month when you are ready.")}</p>
        <div className="relative mt-8 flex flex-col justify-center gap-3 sm:flex-row">
          <Link href="/register" className="inline-flex items-center justify-center gap-2 rounded-xl bg-slate-950 px-6 py-3 text-sm font-semibold text-white hover:bg-slate-800">{t("Create free account")}<Icon name="arrow" className="h-4 w-4" /></Link>
          <a href={`https://wa.me/${SALES_WHATSAPP}`} target="_blank" rel="noreferrer" className="inline-flex items-center justify-center gap-2 rounded-xl bg-white/20 px-6 py-3 text-sm font-semibold text-slate-950 ring-1 ring-inset ring-slate-950/20 hover:bg-white/30">{t("Talk to us on WhatsApp")}</a>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  const cols: Array<[string, Array<[string, string]>]> = [
    [msg('Product'), [[msg('Features'), '#features'], [msg('Marketing campaigns'), '#marketing'], [msg('WhatsApp OTP'), '#otp'], [msg('Webhooks'), '#webhooks'], [msg('AI Assistants'), '#ai'], [msg('Pricing'), '#pricing']]],
    [msg('Developers'), [[msg('API Docs'), DOCS_URL], [msg('API examples'), '#api'], [msg('Log in'), '/login']]],
    [msg('Company'), [[msg('Services'), '#services'], [msg('FAQ'), '#faq'], [msg('Contact us'), `https://wa.me/${SALES_WHATSAPP}`]]],
  ];
  return (
    <footer className="border-t border-white/5 px-4 py-14 sm:px-6">
      <div className="mx-auto grid max-w-6xl gap-10 sm:grid-cols-2 lg:grid-cols-[1.5fr_1fr_1fr_1fr]">
        <div>
          <Logo />
          <p className="mt-4 max-w-xs text-sm text-slate-400">{t("WhatsApp API, OTP, webhooks and AI assistants for Indian businesses and developers.")}</p>
        </div>
        {cols.map(([h, links]) => (
          <div key={h}>
            <p className="text-sm font-semibold text-white">{t(h)}</p>
            <ul className="mt-4 space-y-2.5">
              {links.map(([label, href]) => (
                <li key={label}><a href={href} className="text-sm text-slate-400 hover:text-white" {...(href.startsWith('http') ? { target: '_blank', rel: 'noreferrer' } : {})}>{t(label)}</a></li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="mx-auto mt-12 flex max-w-6xl flex-col gap-2 border-t border-white/5 pt-6 text-xs text-slate-500 sm:flex-row sm:justify-between">
        <p>© {new Date().getFullYear()} {BRAND}. {t("All rights reserved.")}</p>
        <p>{t("WhatsApp is a trademark of Meta Platforms, Inc. {brand} is not affiliated with Meta.", { brand: BRAND })}</p>
      </div>
    </footer>
  );
}

/* ------------------------------------------------------------------ page */

export function Landing() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 selection:bg-emerald-400/30">
      <Nav />
      <main>
        <Hero />
        <Marketing />
        <ApiSection />
        <Features />
        <Otp />
        <Webhooks />
        <AiAssistants />
        <HowItWorks />
        <Compare />
        <Pricing />
        <Services />
        <Faq />
        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}
