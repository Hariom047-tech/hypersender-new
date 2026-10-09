'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { AuthError, AuthField, AuthHeading, Divider, GoogleButton, googleError, PasswordField, SubmitButton } from '@/components/auth/auth-ui';
import { ApiError, friendlyMessage } from '@/lib/api';
import { t } from '@/lib/i18n';

// i18n-ignore: an email address reads the same in every language
const EMAIL_EXAMPLE = 'you@business.com';

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Errors coming back from the Google redirect (?error=google_...).
  useEffect(() => { setError(googleError(new URLSearchParams(window.location.search).get('error'))); }, []);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (!String(f.get('email')).trim() || !String(f.get('password'))) { setError(t("Enter your email and password.")); return; }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hs-csrf': '1' },
        body: JSON.stringify({ email: f.get('email'), password: f.get('password') }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? 'HTTP_ERROR', res.status === 401 ? 'Email or password is incorrect.' : data?.error?.message);
      router.replace(data.organizations?.length ? '/dashboard' : '/onboarding');
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? t("Email or password is incorrect.") : friendlyMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <AuthHeading title={t("Welcome back 👋")} subtitle={t("Sign in to manage your WhatsApp, campaigns and AI assistant.")} />
      <GoogleButton label={t("Continue with Google")} />
      <Divider label={t("or with email")} />
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error && <AuthError>{error}</AuthError>}
        <AuthField label={t("Email address")} icon="mail" name="email" type="email" autoComplete="email" inputMode="email" placeholder={EMAIL_EXAMPLE} required />
        <PasswordField label={t("Password")} name="password" autoComplete="current-password" placeholder="••••••••" required />
        <SubmitButton busy={busy}>{t("Sign in")}</SubmitButton>
      </form>
      <p className="text-center text-sm text-slate-400">
        {t("New here?")}{' '}<Link href="/register" className="font-semibold text-emerald-300 hover:text-emerald-200">{t("Create a free account")}</Link>
      </p>
      <p className="text-center text-xs text-slate-500">{t("Forgot your password? Sign in with Google using the same email, or contact support.")}</p>
    </div>
  );
}
