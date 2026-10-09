'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { Button, Card, EmptyState, ErrorState, LoadingSkeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import type { Page } from '@/lib/types';
import { qk, useWorkspace } from '@/lib/workspace';
import { t, msg } from '@/lib/i18n';

const EVENT_TEXT: Record<string, string> = {
  QR_GENERATED: msg("QR code generated"), PAIRING_STARTED: msg("Pairing started"), CONNECTED: msg("Connected"), DISCONNECTED: msg("Disconnected"),
  RECONNECTING: msg("Reconnect attempted"), RESTARTED: msg("Connection restarted"), LOGGED_OUT: msg("Logged out"), CREDENTIALS_DESTROYED: msg("Stored credentials destroyed"), ERROR: msg("Error"),
};
const REASON_TEXT: Record<string, string> = {
  USER_DISCONNECT: msg("by a team member"), USER_LOGOUT: msg("by a team member"), USER_RESTART: msg("by a team member"), LOGGED_OUT_FROM_PHONE: msg("from the phone"),
  QR_EXPIRED: msg("QR code expired"), CONNECTION_LOST: msg("connection lost"), WORKER_SHUTDOWN: msg("server maintenance"), PROVIDER_RESTART_REQUIRED: msg("after linking"),
  RECONNECT_ATTEMPTS_EXHAUSTED: msg("could not reconnect"), CONNECTION_REPLACED: msg("session opened elsewhere"), ACCOUNT_RESTRICTED: msg("account restricted by WhatsApp"),
  AUTH_INVALID: msg("credentials no longer valid"), INSTANCE_DELETED: msg("instance deleted"), DUPLICATE_PHONE_NUMBER: msg("number already linked to another instance"),
};

/** Connection history of an instance ("Status History"). `bare` drops the card (for dialogs). */
export function Activity({ id, bare }: { id: string; bare?: boolean }) {
  const { orgId } = useWorkspace();
  interface Ev { id: string; type: string; status: string | null; reason: string | null; details: Record<string, unknown>; at: string }
  const q = useInfiniteQuery({
    queryKey: [...qk.instance(orgId, id), 'activity'],
    queryFn: ({ pageParam }) => api<Page<Ev>>(`/v1/whatsapp/instances/${id}/activity${pageParam ? `?cursor=${pageParam}` : ''}`),
    initialPageParam: null as string | null,
    getNextPageParam: (p) => p.nextCursor,
  });
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (q.isLoading) return <LoadingSkeleton />;
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  if (!items.length) return <EmptyState title={t("No activity yet")} body={t("Connection events will appear here once you connect WhatsApp.")} />;
  const list = (
    <>
      <ol className="space-y-3">
        {items.map((e) => (
          <li key={e.id} className="flex gap-3 text-sm">
            <time className="w-40 shrink-0 text-slate-500" dateTime={e.at}>{dateTime(e.at)}</time>
            <span className="text-slate-900">{t(EVENT_TEXT[e.type] ?? e.type)}{e.reason ? ` — ${t(REASON_TEXT[e.reason] ?? e.reason.toLowerCase().replace(/_/g, ' '))}` : ''}
              {typeof e.details.attempt === 'number' ? t(" (attempt {attempt})", { attempt: e.details.attempt }) : ''}</span>
          </li>
        ))}
      </ol>
      {q.hasNextPage && <Button variant="secondary" size="sm" className="mt-4" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>{t("Load more")}</Button>}
    </>
  );
  return bare ? list : <Card title={t("Activity")}>{list}</Card>;
}
