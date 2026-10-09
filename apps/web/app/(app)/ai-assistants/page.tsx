'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { AssistantStatusBadge, TemplateIcon } from '@/components/ai/visuals';
import { EmptyState, ErrorState, InstanceStatus, LoadingSkeleton, PageHeader } from '@/components/ui';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import type { AssistantSummary } from '@/lib/types';
import { useWorkspace } from '@/lib/workspace';
import { AiNav } from './ai-nav';
import { t } from '@/lib/i18n';

export default function AssistantsPage() {
  const { orgId, businessId } = useWorkspace();
  const q = useQuery({ queryKey: ['org', orgId, 'biz', businessId ?? 'all', 'ai-assistants'], queryFn: () => api<AssistantSummary[]>('/v1/ai/assistants') });
  const rows = (q.data ?? []).filter((a) => !businessId || a.businessId === businessId);
  return (
    <>
      <PageHeader title={t("AI Assistants")} description={t("Your assistants answer WhatsApp customers using your business data.")}
        actions={<Link href="/ai-assistants/templates" className="rounded-md bg-emerald-700 px-3.5 py-2 text-sm font-medium text-white hover:bg-emerald-800">{t("+ New assistant")}</Link>} />
      <AiNav />
      {q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : q.isLoading ? <LoadingSkeleton /> : rows.length === 0 ? (
        <EmptyState title={t("No assistants yet")} body={t("Start from a template - it comes with the right capabilities for your kind of business.")}
          action={<Link href="/ai-assistants/templates" className="text-sm font-medium text-emerald-800 underline">{t("Browse templates")}</Link>} />
      ) : (
        <ul className="grid gap-4 md:grid-cols-2" aria-label={t("Your assistants")}>
          {rows.map((a) => (
            <li key={a.id}>
              <Link href={`/ai-assistants/${a.id}`} className="flex gap-4 rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200 hover:shadow-md">
                <TemplateIcon iconKey={a.iconKey} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2"><p className="truncate font-semibold text-slate-900">{a.name}</p><AssistantStatusBadge status={a.status} /></div>
                  <p className="text-sm text-slate-600">{a.templateName ?? t("Custom")} · {a.businessName}</p>
                  <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    {a.whatsappName ? <>{t("WhatsApp:")}{' '}{a.whatsappName} {a.whatsappStatus && <InstanceStatus status={a.whatsappStatus} />}</> : t("No WhatsApp number yet")}
                    <span>· {a.capabilityCount} {t("capabilities")}</span><span>{t("· updated")}{' '}{timeAgo(a.updatedAt)}</span>
                  </p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
