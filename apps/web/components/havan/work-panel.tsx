'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { Button, EmptyState, ErrorState, LoadingSkeleton, Notice, StatusBadge } from '@/components/ui';
import { api, friendlyMessage } from '@/lib/api';
import { currentLang, t, msg } from '@/lib/i18n';

interface Callback {
  id: string; status: 'NEW' | 'CALLED' | 'CLOSED'; phone: string; preferredCallTime: string | null; reason: string; tier: string | null; participationMode: string | null;
  summary: string | null; conversationId: string | null; createdAt: string; customerName: string | null;
}
interface HavanBooking {
  id: string; status: string; startAt: string; customerName: string; customerPhone: string; tier: string | null; participationMode: string; yajmanName: string; city: string | null;
  gotra: string | null; sankalp: string | null; prasadAddress: string | null; dakshinaStatus: string; reminders: Array<{ audience: string; dueAt: string; status: string }> | null;
}
const TIER: Record<string, string> = { SAMANYA: msg("Samanya Havan"), VISHESH: msg("Vishesh Havan"), MAHA_VISHESH: msg("Maha Vishesh Havan"), NOT_DECIDED: msg("Havan not decided") };
const MODE: Record<string, string> = { NALKHEDA_IN_PERSON: msg("📍 Nalkheda"), ONLINE_SANKALP: msg("💻 Online"), NOT_DECIDED: msg("Place not decided") };
const REASON: Record<string, string> = { DAKSHINA: msg("Wants to know the dakshina"), HAVAN_TYPE: msg("Needs help choosing the havan"), BOOKING: msg("Booking / date"), GUIDANCE: msg("Guidance"), OTHER: msg("Other") };
const when = (s: string) => new Date(s).toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const phoneLabel = (p: string) => (p.startsWith('+91') && p.length === 13 ? `+91 ${p.slice(3, 8)} ${p.slice(8)}` : p);

/**
 * Notes the assistant writes (call-back summary, sankalp) are free text, so the static dictionary cannot
 * cover them. In Hindi mode they are translated by the API; the original shows until then or if it fails.
 */
function useFreeText(bid: string, texts: Array<string | null | undefined>) {
  const lang = currentLang();
  const list = [...new Set(texts.filter((x): x is string => !!x && !!x.trim()))];
  const q = useQuery({
    queryKey: ['translate', bid, lang, list], enabled: lang === 'hi' && list.length > 0, staleTime: Infinity, retry: false,
    queryFn: () => api<{ texts: string[] }>(`/v1/businesses/${bid}/havan/translate`, { method: 'POST', body: { lang, texts: list } }),
  });
  return (text: string) => (q.data ? q.data.texts[list.indexOf(text)] ?? text : text);
}

function Chip({ children }: { children: ReactNode }) {
  return <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-700">{children}</span>;
}

/** Pandit Ji's work list: yajmans waiting for a call. Cards read well on a phone too. */
export function HavanCallbacks({ bid, orgId }: { bid: string; orgId: string | null }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<'NEW' | 'ALL'>('NEW');
  const q = useQuery({ queryKey: ['org', orgId, 'havan', bid, 'callbacks', status], queryFn: () => api<Callback[]>(`/v1/businesses/${bid}/havan/callbacks?status=${status}`) });
  const mark = useMutation({ mutationFn: ({ id, s }: { id: string; s: 'CALLED' | 'CLOSED' }) => api(`/v1/businesses/${bid}/havan/callbacks/${id}/status`, { method: 'POST', body: { status: s } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['org', orgId, 'havan', bid, 'callbacks'] }) });
  const note = useFreeText(bid, (q.data ?? []).map((r) => r.summary));
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={status === 'ALL'} onChange={(e) => setStatus(e.target.checked ? 'ALL' : 'NEW')} /> {t("Also show older ones (called / closed)")}</label>
      {mark.isError && <Notice tone="error">{friendlyMessage(mark.error)}</Notice>}
      {q.isLoading ? <LoadingSkeleton rows={4} /> : !q.data?.length ? (
        <EmptyState title={t("No call-backs pending 🙏")} body={t("When a yajman asks for a call about dakshina or a havan, it appears here and Pandit Ji also gets a WhatsApp.")} />
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {q.data.map((r) => (
            <li key={r.id} className="rounded-lg bg-white p-4 shadow-sm ring-1 ring-slate-200">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-base font-semibold text-slate-900">{r.customerName ?? t("WhatsApp yajman")}</p>
                  <a className="text-sm font-medium text-emerald-700 hover:underline" href={`tel:${r.phone}`}>📞 {phoneLabel(r.phone)}</a>
                </div>
                <StatusBadge tone={r.status === 'NEW' ? 'amber' : r.status === 'CALLED' ? 'green' : 'slate'}>
                  {r.status === 'NEW' ? t("To call") : r.status === 'CALLED' ? t("Called") : t("Closed")}
                </StatusBadge>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                <Chip>{t(REASON[r.reason] ?? r.reason)}</Chip>
                {r.tier && r.tier !== 'NOT_DECIDED' && <Chip>🔥 {t(TIER[r.tier])}</Chip>}
                {r.participationMode && r.participationMode !== 'NOT_DECIDED' && <Chip>{t(MODE[r.participationMode])}</Chip>}
                {r.preferredCallTime && <Chip>🕘 {r.preferredCallTime}</Chip>}
              </div>
              {r.summary && <p className="mt-3 whitespace-pre-line break-words rounded-md bg-slate-50 p-3 text-sm text-slate-700">{note(r.summary)}</p>}
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-slate-500">{when(r.createdAt)}</span>
                <span className="flex flex-wrap gap-2">
                  {r.conversationId && <Link className="rounded-md px-2.5 py-1.5 text-xs font-medium text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50" href={`/inbox?c=${r.conversationId}`}>{t("💬 View chat")}</Link>}
                  {r.status === 'NEW' && <Button size="sm" onClick={() => mark.mutate({ id: r.id, s: 'CALLED' })}>{t("✅ Mark as called")}</Button>}
                  {r.status !== 'CLOSED' && <Button size="sm" variant="ghost" onClick={() => mark.mutate({ id: r.id, s: 'CLOSED' })}>{t("Close")}</Button>}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Havan bookings the assistant made, with gotra, sankalp and reminders. */
export function HavanBookings({ bid, orgId }: { bid: string; orgId: string | null }) {
  const qc = useQueryClient();
  const key = ['org', orgId, 'havan', bid, 'bookings'];
  const q = useQuery({ queryKey: key, queryFn: () => api<HavanBooking[]>(`/v1/businesses/${bid}/havan/bookings`) });
  const agree = useMutation({ mutationFn: (id: string) => api(`/v1/businesses/${bid}/havan/bookings/${id}/dakshina`, { method: 'POST', body: { status: 'AGREED_ON_CALL' } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }) });
  const note = useFreeText(bid, (q.data ?? []).map((r) => r.sankalp));
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  return (
    <div className="space-y-3">
      {agree.isError && <Notice tone="error">{friendlyMessage(agree.error)}</Notice>}
      {q.isLoading ? <LoadingSkeleton rows={4} /> : !q.data?.length ? (
        <EmptyState title={t("No havan bookings yet")} body={t("Bookings made through the assistant appear here with gotra, sankalp and reminders.")} />
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {q.data.map((r) => {
            const active = ['PENDING', 'CONFIRMED'].includes(r.status);
            const rem = (r.reminders ?? []).filter((x) => x.status !== 'CANCELLED');
            return (
              <li key={r.id} className={`rounded-lg bg-white p-4 shadow-sm ring-1 ${active ? 'ring-slate-200' : 'opacity-70 ring-slate-100'}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-base font-semibold text-slate-900">🔥 {r.tier ? t(TIER[r.tier]) : t("Havan")}</p>
                    <p className="text-sm font-medium text-slate-700">📅 {when(r.startAt)}</p>
                  </div>
                  <StatusBadge tone={active ? 'green' : 'slate'}>{active ? t("Confirmed") : r.status === 'CANCELLED' ? t("Cancel") : r.status === 'RESCHEDULED' ? t("Rescheduled") : r.status}</StatusBadge>
                </div>
                <div className="mt-3 space-y-1 text-sm text-slate-700">
                  <p>🙏 <span className="font-medium">{r.yajmanName}</span>{r.city && <span className="text-slate-500">, {r.city}</span>}</p>
                  <p><a className="font-medium text-emerald-700 hover:underline" href={`tel:${r.customerPhone}`}>📞 {phoneLabel(r.customerPhone)}</a></p>
                  <p>{t(MODE[r.participationMode] ?? r.participationMode)}</p>
                  {r.gotra && <p>{t("Gotra:")}{' '}{r.gotra}</p>}
                  {r.sankalp && <p className="break-words">{t("Sankalp:")}{' '}{note(r.sankalp)}</p>}
                  {r.prasadAddress && <p className="break-words">{t("Prasad address:")}{' '}{r.prasadAddress}</p>}
                </div>
                {rem.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {rem.map((x, i) => <Chip key={i}>🔔 {x.audience === 'PANDIT' ? t("Pandit Ji") : t("Yajman")}: {x.status === 'SENT' ? t("sent") : when(x.dueAt)}</Chip>)}
                  </div>
                )}
                <div className="mt-3 flex items-center justify-between gap-2 border-t border-slate-100 pt-3">
                  <span className="text-sm">{t("Dakshina:")}</span>
                  {r.dakshinaStatus === 'AGREED_ON_CALL' ? <StatusBadge tone="green">{t("Agreed")}</StatusBadge>
                    : <Button size="sm" variant="secondary" loading={agree.isPending && agree.variables === r.id} onClick={() => agree.mutate(r.id)}>{t("Agreed on the call")}</Button>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
