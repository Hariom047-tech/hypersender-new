'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { ChatLine, MARKETPLACE_FILTERS, TemplateIcon } from '@/components/ai/visuals';
import { ErrorState, LoadingSkeleton, PageHeader, cx } from '@/components/ui';
import { api } from '@/lib/api';
import type { AssistantTemplate } from '@/lib/types';
import { useWorkspace } from '@/lib/workspace';
import { AiNav } from '../ai-nav';
import { t as tr } from '@/lib/i18n';

/** Screen 1 - template marketplace. Previews are DEMO data defined by the platform template. */
export default function TemplateMarketplacePage() {
  const { orgId } = useWorkspace();
  const [filter, setFilter] = useState<(typeof MARKETPLACE_FILTERS)[number]['id']>('ALL');
  const q = useQuery({ queryKey: ['org', orgId, 'ai-templates'], queryFn: () => api<AssistantTemplate[]>('/v1/ai/templates') });
  const rows = (q.data ?? []).filter((t) => filter === 'ALL' || t.marketplaceCategory === filter);
  return (
    <>
      <PageHeader title={tr("AI Assistants")} description={tr("Choose a ready-made AI assistant for your business.")} />
      <AiNav />
      <div role="group" aria-label={tr("Filter templates")} className="mb-5 flex flex-wrap gap-2">
        {MARKETPLACE_FILTERS.map((f) => (
          <button key={f.id} type="button" onClick={() => setFilter(f.id)} aria-pressed={filter === f.id}
            className={cx('rounded-full px-3 py-1.5 text-sm ring-1 ring-inset', filter === f.id ? 'bg-emerald-700 text-white ring-emerald-700' : 'bg-white text-slate-700 ring-slate-300 hover:bg-slate-50')}>
            {f.label}
          </button>
        ))}
      </div>
      {q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : q.isLoading ? <LoadingSkeleton rows={6} label={tr("Loading templates")} /> : (
        <ul className="grid gap-5 md:grid-cols-2 xl:grid-cols-3" aria-label={tr("Assistant templates")}>
          {rows.map((t) => <TemplateCard key={t.key} t={t} />)}
        </ul>
      )}
    </>
  );
}

function TemplateCard({ t }: { t: AssistantTemplate }) {
  const demo = t.demoConversations[0]?.messages.filter((m) => m.from !== 'tool').slice(0, 2) ?? [];
  const badges = t.capabilities.filter((c) => c.defaultEnabled && c.available && c.name).slice(0, 4);
  return (
    <li className="flex flex-col rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200 transition hover:shadow-md">
      <div className="flex items-start gap-3">
        <TemplateIcon iconKey={t.iconKey} />
        <div className="min-w-0">
          <h2 className="font-semibold text-slate-900">{tr(t.name)}</h2>
          <p className="mt-0.5 text-sm text-slate-600">{t.shortDescription}</p>
        </div>
      </div>
      <ul className="mt-3 flex flex-wrap gap-1.5" aria-label={tr("Capabilities")}>
        {badges.map((c) => <li key={c.key} className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800 ring-1 ring-inset ring-emerald-200">{tr(c.name ?? '')}</li>)}
      </ul>
      {demo.length > 0 && (
        <figure className="mt-4 space-y-1.5 rounded-lg bg-[#0b141a] p-3">
          <figcaption className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">{tr("Demo preview")}</figcaption>
          {demo.map((m, i) => <ChatLine key={i} m={m} />)}
        </figure>
      )}
      <div className="mt-auto flex gap-2 pt-4">
        <Link href={`/ai-assistants/templates/${t.key}`} className="rounded-md px-3 py-2 text-sm font-medium text-slate-800 ring-1 ring-inset ring-slate-300 hover:bg-slate-50">{tr("Preview")}</Link>
        <Link href={`/ai-assistants/templates/${t.key}?use=1`} className="rounded-md bg-emerald-700 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-800">{tr("Use Template")}</Link>
      </div>
    </li>
  );
}
