'use client';

import type { ReactNode } from 'react';
import { StatusBadge, cx } from '@/components/ui';
import type { AssistantStatus, DemoMessage } from '@/lib/types';
import { t, msg } from '@/lib/i18n';

const ICONS: Record<string, { glyph: string; bg: string }> = {
  stethoscope: { glyph: '🩺', bg: 'bg-sky-100' }, tooth: { glyph: '🦷', bg: 'bg-cyan-100' }, utensils: { glyph: '🍽️', bg: 'bg-orange-100' },
  scissors: { glyph: '✂️', bg: 'bg-pink-100' }, building: { glyph: '🏢', bg: 'bg-indigo-100' }, store: { glyph: '🏪', bg: 'bg-emerald-100' },
  bed: { glyph: '🛏️', bg: 'bg-amber-100' }, headset: { glyph: '🎧', bg: 'bg-violet-100' }, chart: { glyph: '📈', bg: 'bg-lime-100' },
  bag: { glyph: '🛍️', bg: 'bg-rose-100' }, food: { glyph: '🍕', bg: 'bg-orange-100' }, assistant: { glyph: '🤖', bg: 'bg-slate-100' },
};

export function TemplateIcon({ iconKey, size = 'md' }: { iconKey: string | null | undefined; size?: 'sm' | 'md' | 'lg' }) {
  const i = ICONS[iconKey ?? ''] ?? ICONS.assistant;
  return (
    <span aria-hidden className={cx('inline-flex shrink-0 items-center justify-center rounded-xl', i.bg,
      size === 'sm' ? 'h-8 w-8 text-base' : size === 'lg' ? 'h-14 w-14 text-3xl' : 'h-11 w-11 text-2xl')}>{i.glyph}</span>
  );
}

const STATUS: Record<AssistantStatus, { tone: 'green' | 'amber' | 'slate' | 'blue' | 'red'; text: string }> = {
  DRAFT: { tone: 'slate', text: msg("Draft") }, TESTING: { tone: 'blue', text: msg("Testing") }, ACTIVE: { tone: 'green', text: msg("Live") },
  PAUSED: { tone: 'amber', text: msg("Paused") }, ARCHIVED: { tone: 'slate', text: msg("Archived") },
};
export function AssistantStatusBadge({ status }: { status: AssistantStatus }) {
  const s = STATUS[status] ?? STATUS.DRAFT;
  return <StatusBadge tone={s.tone}>{s.text}</StatusBadge>;
}

/** WhatsApp-style chat. `label` makes clear whether this is a static demo or a live test. */
export function WhatsAppChat({ title, subtitle, messages, label, footer, className, children }: {
  title: string; subtitle?: string; messages?: DemoMessage[]; label: string; footer?: ReactNode; className?: string; children?: ReactNode;
}) {
  return (
    <div className={cx('flex flex-col overflow-hidden rounded-2xl bg-[#0b141a] shadow-sm ring-1 ring-slate-300', className)}>
      <div className="flex items-center gap-3 bg-[#1f2c34] px-4 py-3 text-white">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white/20 text-sm font-semibold" aria-hidden>{title.slice(0, 1)}</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{title}</p>
          {subtitle && <p className="truncate text-xs text-white/80">{subtitle}</p>}
        </div>
        <span className="rounded-full bg-white/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide">{label}</span>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto p-3" aria-live="polite">
        {messages?.map((m, i) => <ChatLine key={i} m={m} />)}
        {children}
      </div>
      {footer}
    </div>
  );
}

export function ChatLine({ m }: { m: DemoMessage }) {
  if (m.from === 'tool') {
    return (
      <div className="flex justify-center">
        <span className="rounded-full bg-white/80 px-2.5 py-0.5 text-[11px] text-slate-600 ring-1 ring-slate-200">✓ {m.label ?? t("Checked")}</span>
      </div>
    );
  }
  const out = m.from === 'assistant';
  return (
    <div className={cx('flex', out ? 'justify-end' : 'justify-start')}>
      <p className={cx('max-w-[85%] whitespace-pre-wrap break-words rounded-lg px-3 py-1.5 text-sm shadow-sm', out ? 'bg-[#005c4b] text-slate-900' : 'bg-[#1f2c34] text-slate-900')}>{m.text}</p>
    </div>
  );
}

export const MARKETPLACE_FILTERS = [
  { id: 'ALL', label: msg("All") }, { id: 'APPOINTMENTS', label: msg("Appointments") }, { id: 'SALES', label: msg("Sales") }, { id: 'SUPPORT', label: msg("Support") },
  { id: 'HOSPITALITY', label: msg("Hospitality") }, { id: 'REAL_ESTATE', label: msg("Real Estate") }, { id: 'GENERAL', label: msg("General") },
] as const;

export const LANGUAGES: Array<[string, string]> = [['en', msg("English")], ['hi', msg("Hindi")], ['mr', msg("Marathi")], ['gu', msg("Gujarati")], ['ta', msg("Tamil")], ['te', msg("Telugu")], ['bn', msg("Bengali")], ['kn', msg("Kannada")]];
