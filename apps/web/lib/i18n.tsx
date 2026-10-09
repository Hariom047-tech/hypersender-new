'use client';

import { createContext, Fragment, useCallback, useContext, useState, type ReactNode } from 'react';
import { HI } from './i18n-hi';

/**
 * Dashboard language (English / हिंदी).
 *
 * The English text in the code IS the key: t('Save') -> 'सेव करें' in Hindi, and
 * English (or any missing entry) falls back to the source text. Values may carry
 * {placeholders}: t('{n} unread', { n: 3 }).
 *
 * The choice lives in the `hs.lang` cookie so the server renders the first paint
 * in the right language. Switching re-mounts the page tree (the query cache is
 * kept), so every component - including plain helper functions that call t()
 * outside React - re-renders in the new language.
 *
 * msg('...') marks a string that is translated later where it is shown (option
 * lists, status maps). It returns the text unchanged; the coverage test reads it.
 */
export type Lang = 'en' | 'hi';
export const LANG_COOKIE = 'hs.lang';

let current: Lang = 'en';

export function t(text: string | null | undefined, vars?: Record<string, string | number | null | undefined>): string {
  if (text === null || text === undefined) return '';
  const base = current === 'hi' ? HI[text] ?? text : text;
  return vars ? base.replace(/\{(\w+)\}/g, (m: string, k: string) => (vars[k] === undefined || vars[k] === null ? '' : String(vars[k]))) : base;
}

/** Marks a string for translation where it is displayed (see header). */
export const msg = (text: string): string => text;

/** Locale for dates and numbers in the current language. */
export const locale = (): string => (current === 'hi' ? 'hi-IN' : 'en-IN');
export const currentLang = (): Lang => current;

const Ctx = createContext<{ lang: Lang; setLang: (l: Lang) => void }>({ lang: 'en', setLang: () => undefined });

export function LanguageProvider({ initial, children }: { initial: Lang; children: ReactNode }) {
  const [lang, setState] = useState<Lang>(initial);
  current = lang; // set before any child renders in this pass
  const setLang = useCallback((l: Lang) => {
    current = l;
    document.cookie = `${LANG_COOKIE}=${l}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
    document.documentElement.lang = l;
    setState(l);
  }, []);
  return <Ctx.Provider value={{ lang, setLang }}><Fragment key={lang}>{children}</Fragment></Ctx.Provider>;
}

export const useLanguage = () => useContext(Ctx);

/** EN | हिं switch for the top navigation. */
export function LanguageSwitch({ className }: { className?: string }) {
  const { lang, setLang } = useLanguage();
  const opt = (l: Lang, label: string, title: string) => (
    <button type="button" onClick={() => setLang(l)} aria-pressed={lang === l} title={title} lang={l}
      className={`rounded px-2 py-1 text-xs font-semibold transition ${lang === l ? 'bg-emerald-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>
      {label}
    </button>
  );
  return (
    <div role="group" aria-label="Language / भाषा" className={`inline-flex items-center gap-0.5 rounded-md p-0.5 ring-1 ring-slate-300 ${className ?? ''}`}>
      {opt('en', 'EN', 'English')}
      {opt('hi', 'हिं', 'हिंदी')}
    </div>
  );
}
