'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button, DataTable, EmptyState, ErrorState, Input, PageHeader, StatusBadge } from '@/components/ui';
import { api, qs } from '@/lib/api';
import { flatten } from '@/lib/cache-merge';
import { timeAgo } from '@/lib/format';
import type { ContactRow, Page } from '@/lib/types';
import { qk, useWorkspace } from '@/lib/workspace';
import { t } from '@/lib/i18n';

export default function ContactsPage() {
  const { orgId, businessId } = useWorkspace();
  const router = useRouter();
  const [input, setInput] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => { const t = setTimeout(() => setSearch(input.trim()), 300); return () => clearTimeout(t); }, [input]);
  const q = useInfiniteQuery({
    queryKey: qk.scoped(orgId, businessId, 'contacts', search || null),
    queryFn: ({ pageParam, signal }) => api<Page<ContactRow>>(`/v1/contacts${qs({ businessId, search, cursor: pageParam, limit: 30 })}`, { signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (p) => p.nextCursor,
  });
  const rows = flatten(q.data);

  return (
    <>
      <PageHeader title={t("Contacts")} description={t("Everyone who has chatted with your WhatsApp numbers.")} />
      <div className="mb-4 max-w-sm">
        <label htmlFor="contact-search" className="sr-only">{t("Search contacts")}</label>
        <Input id="contact-search" type="search" placeholder={t("Search name or phone")} value={input} onChange={(e) => setInput(e.target.value)} maxLength={100} />
      </div>
      {q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
        <DataTable caption={t("Contacts")} loading={q.isLoading} rows={rows} rowKey={(r) => r.id} onRowClick={(r) => router.push(`/contacts/${r.id}`)}
          empty={<EmptyState title={search ? t("No matching contacts") : t("No contacts yet.")} body={search ? undefined : t("Contacts are created automatically when customers message you.")} />}
          columns={[
            { key: 'name', header: t("Name"), cell: (r) => <span className="font-medium text-slate-900">{r.name ?? '—'}</span> },
            { key: 'wa', header: t("WhatsApp"), cell: (r) => (
              <span>{r.phone ?? r.identity}{r.identityType === 'LID' && <span className="ml-2"><StatusBadge tone="slate">{t("privacy ID")}</StatusBadge></span>}</span>) },
            { key: 'biz', header: t("Business"), cell: (r) => r.businessName },
            { key: 'last', header: t("Last message"), cell: (r) => timeAgo(r.lastMessageAt) },
            { key: 'first', header: t("First seen"), cell: (r) => timeAgo(r.firstSeenAt) },
            { key: 'seen', header: t("Last seen"), cell: (r) => timeAgo(r.lastSeenAt) },
          ]} />
      )}
      {q.hasNextPage && <Button variant="secondary" className="mt-4" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>{t("Load more")}</Button>}
    </>
  );
}
