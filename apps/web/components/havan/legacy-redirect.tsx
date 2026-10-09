'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { EmptyState, ErrorState, LoadingSkeleton } from '@/components/ui';
import { api } from '@/lib/api';
import type { AssistantSummary } from '@/lib/types';
import { useWorkspace } from '@/lib/workspace';
import { t } from '@/lib/i18n';
import { HAVAN_TEMPLATE_KEY, type HavanSection } from './havan-panel';

/**
 * Havan pages now live inside the havan assistant ("Havan" tab). The old /havan/* URLs stay for bookmarks and
 * the Google Calendar OAuth return (which only knows /havan/settings), and forward to the right assistant.
 */
export function HavanLegacyRedirect({ section }: { section: HavanSection }) {
  const router = useRouter();
  const { orgId, businessId } = useWorkspace();
  const q = useQuery({ queryKey: ['org', orgId, 'biz', 'all', 'ai-assistants', 'havan'], queryFn: () => api<AssistantSummary[]>('/v1/ai/assistants') });
  const havan = (q.data ?? []).filter((a) => a.templateKey === HAVAN_TEMPLATE_KEY && a.status !== 'ARCHIVED');
  const target = havan.find((a) => a.businessId === businessId) ?? havan[0];
  useEffect(() => {
    if (!target) return;
    const p = new URLSearchParams({ tab: 'havan', section });
    const calendar = new URLSearchParams(window.location.search).get('calendar');
    if (calendar) p.set('calendar', calendar);
    router.replace(`/ai-assistants/${target.id}?${p.toString()}`);
  }, [target, section, router]);
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (q.isLoading || target) return <LoadingSkeleton />;
  return (
    <EmptyState title={t("No havan assistant yet")}
      body={t("Havan bookings, call-backs and settings are part of the Havan Booking Assistant. Create one from the templates to get started.")}
      action={<Link className="rounded-md bg-emerald-700 px-3.5 py-2 text-sm font-medium text-white hover:bg-emerald-800" href="/ai-assistants/templates">{t("Browse templates")}</Link>} />
  );
}
