'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Button, Card, EmptyState, ErrorState, LoadingSkeleton, MessageBubble, PageHeader, StatusBadge } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { contactLabel, dateTime, timeAgo } from '@/lib/format';
import { useMediaUrl } from '@/lib/hooks';
import type { Conversation, Message } from '@/lib/types';
import { useWorkspace } from '@/lib/workspace';
import { t } from '@/lib/i18n';

interface ContactDetail {
  id: string; name: string | null; displayName: string | null; profileName: string | null; email: string | null; phone: string | null;
  identity: { type: 'PHONE' | 'LID'; value: string; hasLid: boolean }; businessName: string; status: string; source: string;
  firstSeenAt: string; lastSeenAt: string; metadata: Record<string, string>; conversations: Conversation[]; recentMessages: Message[];
  bookings: Array<{ id: string; type: string; status: string; startAt: string; endAt: string; timezone: string }>;
}

export default function ContactPage() {
  const { id } = useParams<{ id: string }>();
  const { orgId } = useWorkspace();
  const mediaUrl = useMediaUrl();
  const q = useQuery({ queryKey: ['org', orgId, 'contact', id], queryFn: () => api<ContactDetail>(`/v1/contacts/${id}`) });
  if (q.isError) {
    return q.error instanceof ApiError && q.error.status === 404
      ? <EmptyState title={t("Contact not found")} body={t("It does not exist or you do not have access.")} action={<Link href="/contacts"><Button variant="secondary">{t("Back to contacts")}</Button></Link>} />
      : <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  }
  if (!q.data) return <LoadingSkeleton />;
  const c = q.data;
  const meta = Object.entries(c.metadata);

  return (
    <>
      <PageHeader title={c.name ?? c.phone ?? c.identity.value} description={c.businessName} />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card title={t("Contact")}>
          <dl className="space-y-3 text-sm">
            <div><dt className="text-xs text-slate-500">{t("WhatsApp name")}</dt><dd>{c.profileName ?? '—'}</dd></div>
            <div><dt className="text-xs text-slate-500">{t("Saved name")}</dt><dd>{c.displayName ?? '—'}</dd></div>
            <div><dt className="text-xs text-slate-500">{t("WhatsApp identity")}</dt>
              <dd>{c.identity.value} <StatusBadge tone="slate">{c.identity.type === 'LID' ? t("privacy ID") : t("phone number")}</StatusBadge></dd></div>
            {c.identity.type === 'LID' && <dd className="text-xs text-slate-500">{t("WhatsApp has not shared this person’s phone number. If it becomes known the contact is updated automatically.")}</dd>}
            <div><dt className="text-xs text-slate-500">{t("Email")}</dt><dd>{c.email ?? '—'}</dd></div>
            <div><dt className="text-xs text-slate-500">{t("First seen")}</dt><dd>{dateTime(c.firstSeenAt)}</dd></div>
            <div><dt className="text-xs text-slate-500">{t("Last seen")}</dt><dd>{timeAgo(c.lastSeenAt)}</dd></div>
            {meta.length > 0 && (
              <div><dt className="text-xs text-slate-500">{t("Details")}</dt>
                <dd><ul className="mt-1 space-y-0.5">{meta.map(([k, v]) => <li key={k} className="break-words"><span className="text-slate-500">{k}:</span> {v}</li>)}</ul></dd></div>
            )}
          </dl>
        </Card>
        <div className="space-y-6 lg:col-span-2">
          <Card title={t("Conversations")}>
            {!c.conversations.length ? <p className="text-sm text-slate-500">{t("No conversations.")}</p> : (
              <ul className="divide-y divide-slate-100">
                {c.conversations.map((cv) => (
                  <li key={cv.id} className="flex items-center justify-between py-2 text-sm">
                    <Link href={`/inbox?c=${cv.id}`} className="font-medium text-slate-900 hover:underline">{cv.instanceName} · {cv.lastMessage?.preview ?? contactLabel(cv.contact)}</Link>
                    <span className="text-slate-500">{timeAgo(cv.lastMessageAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title={t("Recent messages")}>
            {!c.recentMessages.length ? <p className="text-sm text-slate-500">{t("No messages.")}</p> : (
              <div className="space-y-2">{[...c.recentMessages].reverse().map((m) => <MessageBubble key={m.id} message={m} mediaUrl={mediaUrl} />)}</div>
            )}
          </Card>
          <Card title={t("Bookings")}>
            {!c.bookings.length ? <p className="text-sm text-slate-500">{t("No bookings.")}</p> : (
              <ul className="divide-y divide-slate-100 text-sm">
                {c.bookings.map((b) => <li key={b.id} className="flex justify-between py-2"><span>{b.type.toLowerCase()} · {new Date(b.startAt).toLocaleString(undefined, { timeZone: b.timezone })}</span><StatusBadge tone="slate">{b.status.toLowerCase()}</StatusBadge></li>)}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
