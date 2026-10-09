'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { Button, DataTable, EmptyState, ErrorState, Notice, PageHeader } from '@/components/ui';
import { api, qs } from '@/lib/api';
import { flatten } from '@/lib/cache-merge';
import { dateTime } from '@/lib/format';
import { can } from '@/lib/permissions';
import type { Page } from '@/lib/types';
import { useWorkspace } from '@/lib/workspace';
import { t } from '@/lib/i18n';

interface Entry { id: string; at: string; actorType: string; actor: string | null; action: string; resourceType: string; resourceId: string | null }

const human = (s: string) => s.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export default function AuditLogPage() {
  const { orgId, role } = useWorkspace();
  const allowed = can(role, 'audit:view');
  const q = useInfiniteQuery({
    queryKey: ['org', orgId, 'audit'],
    queryFn: ({ pageParam }) => api<Page<Entry>>(`/v1/audit-logs${qs({ cursor: pageParam })}`),
    initialPageParam: null as string | null, getNextPageParam: (p) => p.nextCursor, enabled: allowed,
  });
  if (!allowed) return <><PageHeader title={t("Audit log")} /><Notice>{t("Only owners and admins can view the audit log.")}</Notice></>;
  return (
    <>
      <PageHeader title={t("Audit log")} description={t("Who changed what. Secrets are never recorded here.")} />
      {q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
        <DataTable caption={t("Audit log")} loading={q.isLoading} rows={flatten(q.data)} rowKey={(r) => r.id}
          empty={<EmptyState title={t("Nothing recorded yet")} />}
          columns={[
            { key: 'at', header: t("When"), cell: (r) => dateTime(r.at) },
            { key: 'who', header: t("Who"), cell: (r) => r.actor ?? (r.actorType === 'SYSTEM' ? t("System") : r.actorType.toLowerCase()) },
            { key: 'what', header: t("Action"), cell: (r) => human(r.action) },
            { key: 'res', header: t("Resource"), cell: (r) => human(r.resourceType) },
          ]} />
      )}
      {q.hasNextPage && <Button variant="secondary" className="mt-4" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>{t("Load more")}</Button>}
    </>
  );
}
