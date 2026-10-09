'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Button, EmptyState, ErrorState, LoadingSkeleton, MessageBubble, Notice, Select, StatusBadge, cx } from '@/components/ui';
import { api, ApiError, friendlyMessage, qs } from '@/lib/api';
import { flatten, upsertMessage, type ConversationFilter } from '@/lib/cache-merge';
import { contactLabel, timeAgo } from '@/lib/format';
import { useMediaUrl } from '@/lib/hooks';
import { can } from '@/lib/permissions';
import type { Conversation, Instance, Message, Page } from '@/lib/types';
import { qk, useWorkspace } from '@/lib/workspace';
import { t, msg } from '@/lib/i18n';

export default function InboxPage() {
  return <Suspense><Inbox /></Suspense>;
}

const FILTERS: Array<{ id: ConversationFilter; label: string }> = [
  { id: 'open', label: msg("Open") }, { id: 'unread', label: msg("Unread") }, { id: 'resolved', label: msg("Resolved") }, { id: 'all', label: msg("All") }];

function Inbox() {
  const params = useSearchParams();
  const router = useRouter();
  const selected = params.get('c');
  const select = (id: string | null) => router.replace(id ? `/inbox?c=${id}` : '/inbox', { scroll: false });

  return (
    <div className="-mx-4 -my-6 flex h-[calc(100vh-57px)] sm:-mx-6 lg:-mx-8">
      <div className={cx('w-full shrink-0 border-r border-slate-200 bg-white md:w-80 lg:w-96', selected && 'hidden md:block')}>
        <ConversationList selected={selected} onSelect={select} />
      </div>
      <div className={cx('min-w-0 flex-1', !selected && 'hidden md:flex')}>
        {selected ? <Chat key={selected} id={selected} onBack={() => select(null)} /> : (
          <div className="flex flex-1 items-center justify-center p-6 text-sm text-slate-500">{t("Select a conversation")}</div>
        )}
      </div>
    </div>
  );
}

function ConversationList({ selected, onSelect }: { selected: string | null; onSelect: (id: string) => void }) {
  const { orgId, businessId } = useWorkspace();
  const [filter, setFilter] = useState<ConversationFilter>('open');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [instanceId, setInstanceId] = useState('');
  useEffect(() => { const t = setTimeout(() => setSearch(searchInput.trim()), 300); return () => clearTimeout(t); }, [searchInput]);
  const instances = useQuery({ queryKey: qk.scoped(orgId, businessId, 'instances'), queryFn: () => api<Instance[]>('/v1/whatsapp/instances') });

  const q = useInfiniteQuery({
    // Key layout is relied upon by the realtime merger: [org, id, 'biz', biz, 'conversations', filter, search, instance]
    queryKey: [...qk.scoped(orgId, businessId, 'conversations', filter, search || null), instanceId || null],
    queryFn: ({ pageParam, signal }) => api<Page<Conversation>>(`/v1/conversations${qs({ filter, search, businessId, instanceId, cursor: pageParam, limit: 30 })}`, { signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (p) => p.nextCursor,
  });
  const items = flatten(q.data);

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b border-slate-200 p-3">
        <label className="sr-only" htmlFor="inbox-search">{t("Search conversations")}</label>
        <input id="inbox-search" type="search" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder={t("Search name or phone")}
          className="block w-full rounded-md px-3 py-2 text-sm ring-1 ring-slate-300 focus:ring-2 focus:ring-emerald-600" maxLength={100} />
        <div className="flex gap-1" role="tablist" aria-label={t("Conversation filter")}>
          {FILTERS.map((f) => (
            <button key={f.id} role="tab" aria-selected={filter === f.id} onClick={() => setFilter(f.id)}
              className={cx('rounded-md px-2.5 py-1 text-xs font-medium', filter === f.id ? 'bg-emerald-700 text-white' : 'text-slate-600 hover:bg-slate-100')}>{f.label}</button>
          ))}
        </div>
        {(instances.data?.length ?? 0) > 1 && (
          <Select aria-label={t("Filter by WhatsApp number")} value={instanceId} onChange={(e) => setInstanceId(e.target.value)} className="py-1.5 text-xs">
            <option value="">{t("All WhatsApp numbers")}</option>
            {instances.data!.map((i) => <option key={i.id} value={i.id}>{i.name}{i.phoneNumber ? ` (${i.phoneNumber})` : ''}</option>)}
          </Select>
        )}
      </div>
      <div className="flex-1 overflow-y-auto" aria-live="polite">
        {q.isError ? <div className="p-3"><ErrorState error={q.error} onRetry={() => q.refetch()} /></div>
          : q.isLoading ? <div className="p-3"><LoadingSkeleton rows={6} label={t("Loading conversations")} /></div>
          : items.length === 0 ? (
            <div className="p-4"><EmptyState title={search ? t("No matching conversations") : t("No conversations yet.")}
              body={search ? undefined : t("Messages received on your connected WhatsApp will appear here.")} /></div>
          ) : (
            <ul>
              {items.map((c) => (
                <li key={c.id}>
                  <button onClick={() => onSelect(c.id)} aria-current={selected === c.id ? 'true' : undefined}
                    className={cx('flex w-full gap-3 border-b border-slate-100 px-3 py-3 text-left hover:bg-slate-50', selected === c.id && 'bg-emerald-50')}>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <p className={cx('truncate text-sm', c.unreadCount ? 'font-semibold text-slate-900' : 'font-medium text-slate-800')}>{contactLabel(c.contact)}</p>
                        <time className="shrink-0 text-[11px] text-slate-500" dateTime={c.lastMessageAt}>{timeAgo(c.lastMessageAt)}</time>
                      </div>
                      <p className="truncate text-xs text-slate-500">
                        {c.lastMessage?.direction === 'OUTBOUND' && <span aria-label={t("You:")}>↩ </span>}
                        {c.lastMessage ? (c.lastMessage.preview ?? `[${c.lastMessage.type.toLowerCase()}]`) : t("No messages")}
                      </p>
                      <p className="mt-0.5 truncate text-[11px] text-slate-400">{c.contact.phone ?? c.contact.identity} · {c.instanceName}{businessIdLabel(c, businessId)}</p>
                    </div>
                    {c.unreadCount > 0 && <span className="self-center rounded-full bg-emerald-700 px-2 py-0.5 text-[11px] font-semibold text-white" aria-label={t("{unreadCount} unread", { unreadCount: c.unreadCount })}>{c.unreadCount}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        {q.hasNextPage && <div className="p-3"><Button variant="secondary" size="sm" className="w-full" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>{t("Load more")}</Button></div>}
      </div>
    </div>
  );
}

const businessIdLabel = (c: Conversation, selectedBusiness: string | null) => (selectedBusiness ? '' : ` · ${c.businessName}`);

interface Pending { clientRequestId: string; text: string; createdAt: string; error?: string }

function Chat({ id, onBack }: { id: string; onBack: () => void }) {
  const { orgId, role } = useWorkspace();
  const qc = useQueryClient();
  const mediaUrl = useMediaUrl();
  const conv = useQuery({ queryKey: qk.conversation(orgId, id), queryFn: () => api<Conversation>(`/v1/conversations/${id}`) });
  const msgs = useInfiniteQuery({
    queryKey: qk.messages(orgId, id),
    queryFn: ({ pageParam }) => api<Page<Message>>(`/v1/conversations/${id}/messages${qs({ cursor: pageParam, limit: 40 })}`),
    initialPageParam: null as string | null,
    getNextPageParam: (p) => p.nextCursor,
  });
  const [pending, setPending] = useState<Pending[]>([]);
  const [draft, setDraft] = useState('');
  const draftId = useRef<string>(crypto.randomUUID());
  const bottom = useRef<HTMLDivElement>(null);
  const canSend = can(role, 'messages:send');

  // Mark read on open.
  const unread = conv.data?.unreadCount ?? 0;
  useEffect(() => {
    if (unread > 0 && canSend) void api<Conversation>(`/v1/conversations/${id}/read`, { method: 'POST' }).then((c) => qc.setQueryData(qk.conversation(orgId, id), c)).catch(() => undefined);
  }, [unread, canSend, id, orgId, qc]);

  const ordered = useMemo(() => [...flatten(msgs.data)].reverse(), [msgs.data]);
  useLayoutEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [ordered.length, pending.length]);

  const send = useMutation({
    mutationFn: (p: Pending) => api<{ message: Message }>(`/v1/conversations/${id}/messages`, { method: 'POST', body: { text: p.text, clientRequestId: p.clientRequestId } }),
    onSuccess: (r, p) => {
      qc.setQueryData<InfiniteData<Page<Message>, string | null>>(qk.messages(orgId, id), (d) => upsertMessage(d, r.message));
      setPending((ps) => ps.filter((x) => x.clientRequestId !== p.clientRequestId));
    },
    onError: (err, p) => setPending((ps) => ps.map((x) => (x.clientRequestId === p.clientRequestId ? { ...x, error: friendlyMessage(err) } : x))),
  });

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const text = draft.trim();
    if (!text || send.isPending) return;
    // One compose action = one clientRequestId: double clicks / retries are idempotent server-side.
    const p: Pending = { clientRequestId: draftId.current, text, createdAt: new Date().toISOString() };
    draftId.current = crypto.randomUUID();
    setDraft('');
    setPending((ps) => [...ps, p]);
    send.mutate(p);
  };
  const retry = (p: Pending) => { setPending((ps) => ps.map((x) => (x.clientRequestId === p.clientRequestId ? { ...x, error: undefined } : x))); send.mutate(p); };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } };

  const status = useMutation({
    mutationFn: (s: 'OPEN' | 'RESOLVED') => api<Conversation>(`/v1/conversations/${id}`, { method: 'PATCH', body: { status: s } }),
    onSuccess: (c) => qc.setQueryData(qk.conversation(orgId, id), c),
  });

  const handling = useMutation({
    mutationFn: (mode: 'AI' | 'HUMAN') => api<Conversation>(`/v1/conversations/${id}/handling`, { method: 'POST', body: { mode } }),
    onSuccess: (c) => qc.setQueryData(qk.conversation(orgId, id), c),
  });

  if (conv.isError) {
    return <div className="p-6">{conv.error instanceof ApiError && conv.error.status === 404
      ? <EmptyState title={t("Conversation not found")} body={t("It does not exist or you do not have access.")} action={<Button variant="secondary" onClick={onBack}>{t("Back")}</Button>} />
      : <ErrorState error={conv.error} onRetry={() => conv.refetch()} />}</div>;
  }
  const c = conv.data;
  return (
    <div className="flex h-full min-w-0 flex-1">
      <section className="flex min-w-0 flex-1 flex-col bg-slate-50" aria-label={t("Conversation")}>
        <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-2.5">
          <button onClick={onBack} className="rounded p-1 text-slate-600 hover:bg-slate-100 md:hidden" aria-label={t("Back to conversations")}>←</button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-slate-900">{c ? contactLabel(c.contact) : '…'}</p>
            <p className="truncate text-xs text-slate-500">{c ? t("{phone} · via {instanceName}", { phone: c.contact.phone ?? c.contact.identity, instanceName: c.instanceName }) : ''}</p>
          </div>
          {c?.assistant && (c.handlingMode === 'AI' || c.handlingMode === 'HYBRID'
            ? <span className="rounded-full bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-800 ring-1 ring-inset ring-violet-200">{t("AI replying ·")}{' '}{c.assistant.name}</span>
            : <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-900 ring-1 ring-inset ring-amber-200">{t("Team handling · AI paused")}</span>)}
          {c?.assistant && canSend && (c.handlingMode === 'AI' || c.handlingMode === 'HYBRID'
            ? <Button size="sm" variant="secondary" loading={handling.isPending} onClick={() => handling.mutate('HUMAN')}>{t("Take over")}</Button>
            : <Button size="sm" variant="secondary" loading={handling.isPending} onClick={() => handling.mutate('AI')}>{t("Resume AI")}</Button>)}
          {c && canSend && (c.status === 'RESOLVED' || c.status === 'CLOSED'
            ? <Button size="sm" variant="secondary" loading={status.isPending} onClick={() => status.mutate('OPEN')}>{t("Reopen")}</Button>
            : <Button size="sm" variant="secondary" loading={status.isPending} onClick={() => status.mutate('RESOLVED')}>{t("Resolve")}</Button>)}
        </header>
        <div className="flex-1 space-y-2 overflow-y-auto p-4">
          {msgs.hasNextPage && <div className="text-center"><Button size="sm" variant="ghost" loading={msgs.isFetchingNextPage} onClick={() => msgs.fetchNextPage()}>{t("Load earlier messages")}</Button></div>}
          {msgs.isLoading && <LoadingSkeleton rows={5} label={t("Loading messages")} />}
          {msgs.isError && <ErrorState error={msgs.error} onRetry={() => msgs.refetch()} />}
          {ordered.map((m) => <MessageBubble key={m.id} message={m} mediaUrl={mediaUrl} />)}
          {pending.map((p) => (
            <div key={p.clientRequestId}>
              <MessageBubble pending message={{ id: p.clientRequestId, conversationId: id, instanceId: '', businessId: '', direction: 'OUTBOUND', origin: 'DASHBOARD', fromMe: true,
                type: 'TEXT', text: p.text, status: 'QUEUED', timestamp: p.createdAt, errorCode: null, isAiGenerated: false, replyTo: null, attachments: [] }} />
              {p.error && <p className="mt-1 text-right text-xs text-red-700">{p.error} <button className="underline" onClick={() => retry(p)}>{t("Retry")}</button></p>}
            </div>
          ))}
          <div ref={bottom} />
        </div>
        {canSend ? (
          <form onSubmit={submit} className="flex items-end gap-2 border-t border-slate-200 bg-white p-3">
            <label htmlFor="composer" className="sr-only">{t("Message")}</label>
            <textarea id="composer" rows={1} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} maxLength={4096}
              placeholder={t("Type a message")} className="max-h-40 min-h-[40px] flex-1 resize-y rounded-md px-3 py-2 text-sm ring-1 ring-slate-300 focus:ring-2 focus:ring-emerald-600" />
            <Button type="submit" disabled={!draft.trim()}>{t("Send")}</Button>
          </form>
        ) : <div className="border-t border-slate-200 bg-white p-3"><Notice>{t("You have read-only access.")}</Notice></div>}
      </section>
      {c && <ContactPane c={c} />}
    </div>
  );
}

function ContactPane({ c }: { c: Conversation }) {
  return (
    <aside className="hidden w-72 shrink-0 border-l border-slate-200 bg-white p-4 xl:block" aria-label={t("Contact details")}>
      <p className="text-sm font-semibold text-slate-900">{contactLabel(c.contact)}</p>
      <dl className="mt-3 space-y-2 text-sm">
        <div><dt className="text-xs text-slate-500">{t("WhatsApp")}</dt><dd>{c.contact.phone ?? c.contact.identity}</dd></div>
        {c.contact.identityType === 'LID' && <div><dt className="text-xs text-slate-500">{t("Identity")}</dt><dd>{t("WhatsApp privacy ID (phone not shared)")}</dd></div>}
        <div><dt className="text-xs text-slate-500">{t("Business")}</dt><dd>{c.businessName}</dd></div>
        <div><dt className="text-xs text-slate-500">{t("Number")}</dt><dd>{c.instanceName}</dd></div>
        <div><dt className="text-xs text-slate-500">{t("Status")}</dt><dd><StatusBadge tone={c.status === 'RESOLVED' || c.status === 'CLOSED' ? 'slate' : 'green'}>{c.status.toLowerCase()}</StatusBadge></dd></div>
      </dl>
      <Link href={`/contacts/${c.contact.id}`} className="mt-4 inline-block text-sm text-emerald-800 underline">{t("Open contact")}</Link>
    </aside>
  );
}
