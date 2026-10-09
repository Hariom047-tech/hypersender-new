import type { InfiniteData } from '@tanstack/react-query';
import type { Conversation, Message, MessageStatus, Page } from './types';

/**
 * Pure merge functions used to apply realtime events to cached server data.
 * Rules: stable ids, no duplicates, status only moves forward (receipts can
 * arrive late / twice / out of order), the server stays the source of truth.
 */
const RANK: Record<string, number> = { QUEUED: 10, RECEIVED: 10, SENT: 20, DELIVERED: 30, READ: 40, FAILED: 50, REVOKED: 60 };

export function forwardStatus(current: string, next: string): string {
  return (RANK[next] ?? 0) > (RANK[current] ?? 0) ? next : current;
}

type Pages<T> = InfiniteData<Page<T>, string | null>;

/** Messages are cached newest-first. New ids go to the front of page 0; known ids are updated in place. */
export function upsertMessage(data: Pages<Message> | undefined, msg: Message): Pages<Message> | undefined {
  if (!data) return data;
  let found = false;
  const pages = data.pages.map((p) => ({
    ...p,
    items: p.items.map((m) => {
      if (m.id !== msg.id) return m;
      found = true;
      return { ...m, ...msg, status: forwardStatus(m.status, msg.status) as MessageStatus };
    }),
  }));
  if (!found && pages.length) pages[0] = { ...pages[0], items: [msg, ...pages[0].items] };
  return { ...data, pages };
}

export function applyMessageStatus(data: Pages<Message> | undefined, messageId: string, status: string, errorCode?: string | null): Pages<Message> | undefined {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((p) => ({
      ...p,
      items: p.items.map((m) => (m.id === messageId
        ? { ...m, status: forwardStatus(m.status, status) as MessageStatus, errorCode: errorCode ?? m.errorCode } : m)),
    })),
  };
}

export type ConversationFilter = 'all' | 'unread' | 'open' | 'resolved';

export function matchesFilter(c: Conversation, filter: ConversationFilter): boolean {
  if (filter === 'unread') return c.unreadCount > 0 && (c.status === 'OPEN' || c.status === 'WAITING');
  if (filter === 'open') return c.status === 'OPEN' || c.status === 'WAITING';
  if (filter === 'resolved') return c.status === 'RESOLVED' || c.status === 'CLOSED';
  return true;
}

/** Moves/inserts a conversation to the top of the list if it (still) matches the list's filter; removes it otherwise. */
export function upsertConversation(data: Pages<Conversation> | undefined, conv: Conversation, filter: ConversationFilter, businessId: string | null): Pages<Conversation> | undefined {
  if (!data) return data;
  const pages = data.pages.map((p) => ({ ...p, items: p.items.filter((c) => c.id !== conv.id) }));
  const belongs = matchesFilter(conv, filter) && (!businessId || conv.businessId === businessId);
  if (belongs && pages.length) pages[0] = { ...pages[0], items: [conv, ...pages[0].items] };
  return { ...data, pages };
}

export function flatten<T>(data: { pages: Array<Page<T>> } | undefined): T[] {
  return data ? data.pages.flatMap((p) => p.items) : [];
}
