'use client';

import { forwardRef, useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { t as tr } from '@/lib/i18n';

export function cx(...c: Array<string | false | null | undefined>): string {
  return c.filter(Boolean).join(' ');
}

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-gradient-to-r from-emerald-400 to-cyan-400 font-semibold text-[#04110c] shadow-md shadow-emerald-500/20 hover:brightness-110 disabled:opacity-50',
  secondary: 'bg-slate-50 text-slate-800 ring-1 ring-inset ring-slate-300 hover:bg-slate-100 hover:text-slate-900 disabled:text-slate-400',
  danger: 'bg-red-600 text-white hover:brightness-110 disabled:opacity-50',
  ghost: 'text-slate-700 hover:bg-slate-100 disabled:text-slate-400',
};

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; loading?: boolean }>(
  function Button({ variant = 'primary', size = 'md', loading, className, children, disabled, ...rest }, ref) {
    return (
      <button ref={ref} disabled={disabled || loading} aria-busy={loading || undefined}
        className={cx('inline-flex items-center justify-center gap-2 rounded-lg font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 disabled:cursor-not-allowed',
          size === 'sm' ? 'px-2.5 py-1.5 text-xs' : 'px-3.5 py-2 text-sm', VARIANTS[variant], className)} {...rest}>
        {loading && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />}
        {children}
      </button>
    );
  });

const fieldCls = 'block w-full rounded-lg border-0 bg-slate-50 px-3 py-2 text-sm text-slate-900 ring-1 ring-inset ring-slate-300 placeholder:text-slate-400 transition focus:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-emerald-500 disabled:opacity-60';

export function Field({ label, hint, error, children, id }: { label: string; hint?: string; error?: string | null; children: (id: string, describedBy?: string) => ReactNode; id?: string }) {
  const auto = useId();
  const fid = id ?? auto;
  const desc = error ? `${fid}-err` : hint ? `${fid}-hint` : undefined;
  return (
    <div>
      <label htmlFor={fid} className="block text-sm font-medium text-slate-800">{tr(label)}</label>
      <div className="mt-1">{children(fid, desc)}</div>
      {hint && !error && <p id={`${fid}-hint`} className="mt-1 text-xs text-slate-500">{tr(hint)}</p>}
      {error && <p id={`${fid}-err`} className="mt-1 text-xs text-red-700" role="alert">{tr(error)}</p>}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cx(fieldCls, className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cx(fieldCls, className)} {...rest} />;
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cx(fieldCls, 'pr-8', className)} {...rest}>{children}</select>;
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('overflow-hidden rounded-xl bg-white shadow-[0_10px_30px_-12px_rgba(0,0,0,0.6)] ring-1 ring-slate-200', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-slate-200 bg-gradient-to-r from-emerald-50 via-transparent to-transparent px-4 py-3">
          {title && <h2 className="text-sm font-semibold text-slate-900">{typeof title === 'string' ? tr(title) : title}</h2>}
          {actions}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: Array<{ id: T; label: string }>; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div role="tablist" aria-label={tr(label)} className="flex w-fit max-w-full gap-1 overflow-x-auto rounded-xl bg-slate-50 p-1 ring-1 ring-inset ring-slate-200">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} onClick={() => onChange(t.id)}
          className={cx('whitespace-nowrap rounded-lg px-3.5 py-1.5 text-sm font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600',
            value === t.id ? 'bg-emerald-100 text-emerald-800 ring-1 ring-inset ring-emerald-200' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900')}>
          {tr(t.label)}
        </button>
      ))}
    </div>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'error' | 'success'; children: ReactNode }) {
  const tones = { info: 'bg-sky-50 text-sky-900 ring-sky-200', warn: 'bg-amber-50 text-amber-900 ring-amber-200',
                  error: 'bg-red-50 text-red-900 ring-red-200', success: 'bg-emerald-50 text-emerald-900 ring-emerald-200' };
  return <div role={tone === 'error' ? 'alert' : 'status'} className={cx('rounded-xl p-3.5 text-sm ring-1 ring-inset', tones[tone])}>{children}</div>;
}
