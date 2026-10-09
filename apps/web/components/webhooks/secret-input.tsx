'use client';

import { useState, type InputHTMLAttributes } from 'react';
import { t } from '@/lib/i18n';

/** Password-style input with an eye button to show / hide what was typed (e.g. the webhook Authorization secret). */
export function SecretInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const [shown, setShown] = useState(false);
  return (
    <div className="flex rounded-md shadow-sm ring-1 ring-inset ring-slate-300 focus-within:ring-2 focus-within:ring-emerald-600">
      <input {...props} type={shown ? 'text' : 'password'} autoComplete="off" spellCheck={false}
        className="block w-full min-w-0 flex-1 rounded-l-md border-0 bg-transparent px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:ring-0" />
      <button type="button" onClick={() => setShown((v) => !v)} aria-pressed={shown} aria-label={shown ? t("Hide secret") : t("Show secret")}
        className="flex items-center border-l border-slate-300 px-3 text-slate-500 hover:text-emerald-700">
        <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" />{shown && <path d="M3 3l18 18" />}
        </svg>
      </button>
    </div>
  );
}
