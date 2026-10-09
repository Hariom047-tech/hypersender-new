'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { AuthError, AuthField, AuthHeading, Divider, GoogleButton, PasswordField, StrengthMeter, SubmitButton } from '@/components/auth/auth-ui';
import { ApiError, friendlyMessage } from '@/lib/api';
import { msg, t } from '@/lib/i18n';

const COUNTRIES = [
  { code: '+91', flag: '🇮🇳', name: msg('India') }, { code: '+971', flag: '🇦🇪', name: msg('UAE') }, { code: '+1', flag: '🇺🇸', name: msg('USA / Canada') },
  { code: '+44', flag: '🇬🇧', name: msg('UK') }, { code: '+61', flag: '🇦🇺', name: msg('Australia') }, { code: '+977', flag: '🇳🇵', name: msg('Nepal') },
  { code: '+880', flag: '🇧🇩', name: msg('Bangladesh') }, { code: '+65', flag: '🇸🇬', name: msg('Singapore') },
];

/** Onboarding step 1: the account. Organization and business come next (/onboarding). */
// i18n-ignore: an email address reads the same in every language
const EMAIL_EXAMPLE = 'you@business.com';

export default function RegisterPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState('');
  const [country, setCountry] = useState('+91');

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const name = String(f.get('name') ?? '').trim().replace(/\s+/g, ' ');
    const email = String(f.get('email') ?? '').trim();
    const phone = String(f.get('phone') ?? '').replace(/[\s-]/g, '');
    if (name.length < 2) { setError(t("Enter your name.")); return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { setError(t("Enter a valid email address.")); return; }
    if (phone && !/^\d{6,14}$/.test(phone)) { setError(t("Enter a valid mobile number.")); return; }
    if (password.length < 8) { setError(t("Use a password of at least 8 characters.")); return; }
    if (password !== String(f.get('confirm'))) { setError(t("The two passwords do not match.")); return; }
    if (!f.get('terms')) { setError(t("Please accept the terms to continue.")); return; }
    const [firstName, ...rest] = name.split(' ');
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hs-csrf': '1' },
        body: JSON.stringify({ email, password, firstName, lastName: rest.join(' ') || undefined, phone: phone ? `${country}${phone.replace(/^0+/, '')}` : undefined }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? 'HTTP_ERROR', data?.error?.message);
      router.replace('/onboarding');
    } catch (err) {
      setError(friendlyMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <AuthHeading title={t("Create your free account")} subtitle={t("14-day free trial · No credit card needed")} />
      <GoogleButton label={t("Sign up with Google")} />
      <Divider label={t("or with email")} />
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error && <AuthError>{error}</AuthError>}
        <AuthField label={t("Full name")} icon="user" name="name" autoComplete="name" placeholder={t("e.g. Rahul Sharma")} maxLength={120} required />
        <AuthField label={t("Email address")} icon="mail" name="email" type="email" autoComplete="email" inputMode="email" placeholder={EMAIL_EXAMPLE} required />
        <AuthField label={t("Mobile number (optional)")} name="phone" type="tel" autoComplete="tel-national" inputMode="tel" placeholder="98765 43210" maxLength={16}
          hint={t("We may call to help you set up. Never shared.")}
          addon={(
            <select aria-label={t("Country code")} value={country} onChange={(e) => setCountry(e.target.value)}
              className="ml-2 h-9 rounded-lg border-0 bg-white/5 pl-2 pr-1 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-400/40">
              {COUNTRIES.map((c) => <option key={c.code} value={c.code} className="bg-slate-900" title={t(c.name)}>{c.flag} {c.code}</option>)}
            </select>
          )} />
        <div>
          <PasswordField label={t("Password")} name="password" autoComplete="new-password" placeholder={t("At least 8 characters")} value={password}
            onChange={(e) => setPassword(e.target.value)} required minLength={8} />
          <StrengthMeter password={password} />
        </div>
        <PasswordField label={t("Confirm password")} name="confirm" autoComplete="new-password" placeholder={t("Type it again")} required />
        <label className="flex items-start gap-3 text-sm text-slate-400">
          <input type="checkbox" name="terms" className="mt-0.5 h-4 w-4 shrink-0 rounded border-white/20 bg-white/5 accent-emerald-400" />
          <span>{t("I agree to the Terms of Service and Privacy Policy, and to use WhatsApp only with customers who expect my messages.")}</span>
        </label>
        <SubmitButton busy={busy}>{t("Create account")}</SubmitButton>
      </form>
      <p className="text-center text-sm text-slate-400">
        {t("Already have an account?")}{' '}<Link href="/login" className="font-semibold text-emerald-300 hover:text-emerald-200">{t("Sign in")}</Link>
      </p>
    </div>
  );
}
