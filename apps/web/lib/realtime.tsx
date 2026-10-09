'use client';

import { useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { applyMessageStatus, upsertConversation, upsertMessage, type ConversationFilter } from './cache-merge';
import { openEventStream } from './sse';
import type { Conversation, Message, Page } from './types';
import { qk, useWorkspace } from './workspace';

export type RealtimeState = 'connecting' | 'live' | 'reconnecting' | 'offline';
const Ctx = createContext<RealtimeState>('connecting');
export const useRealtimeState = () => useContext(Ctx);

type Pages<T> = InfiniteData<Page<T>, string | null>;

/** Applies one normalised application event to the TanStack Query cache. Exported for tests. */
export function applyRealtimeEvent(qc: QueryClient, orgId: string, type: string, data: any): void {
  switch (type) {
    case 'message.created': {
      const m = data.message as Message;
      qc.setQueryData<Pages<Message>>(qk.messages(orgId, m.conversationId), (d) => upsertMessage(d, m));
      if (m.textTruncated) void qc.invalidateQueries({ queryKey: qk.messages(orgId, m.conversationId) });
      break;
    }
    case 'message.status_updated':
      qc.setQueryData<Pages<Message>>(qk.messages(orgId, data.conversationId), (d) => applyMessageStatus(d, data.messageId, data.status, data.errorCode));
      break;
    case 'conversation.created':
    case 'conversation.updated': {
      const c = data.conversation as Conversation;
      qc.setQueryData(qk.conversation(orgId, c.id), c);
      // Every cached conversation list: ['org', org, 'biz', biz, 'conversations', filter, search]
      for (const q of qc.getQueryCache().findAll({ queryKey: ['org', orgId, 'biz'] })) {
        const key = q.queryKey as unknown[];
        if (key[4] !== 'conversations') continue;
        if (key[6]) { void qc.invalidateQueries({ queryKey: key, exact: true }); continue; } // search results: refetch
        if (key[7] && key[7] !== c.instanceId) continue; // list filtered to another WhatsApp number
        const biz = key[3] === 'all' ? null : (key[3] as string);
        qc.setQueryData<Pages<Conversation>>(key, (d) => upsertConversation(d, c, key[5] as ConversationFilter, biz));
      }
      void qc.invalidateQueries({ queryKey: ['org', orgId, 'biz'], predicate: (q) => q.queryKey[4] === 'dashboard' });
      break;
    }
    case 'instance.status_updated':
      void qc.invalidateQueries({ queryKey: qk.instance(orgId, data.instanceId) });
      void qc.invalidateQueries({ queryKey: ['org', orgId, 'biz'], predicate: (q) => q.queryKey[4] === 'instances' || q.queryKey[4] === 'dashboard' });
      break;
    case 'notification.created':
      void qc.invalidateQueries({ queryKey: ['org', orgId, 'notifications'] });
      break;
  }
}

/** One org-wide realtime connection for the whole dashboard. */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { orgId, businessId } = useWorkspace();
  const qc = useQueryClient();
  const [state, setState] = useState<RealtimeState>('connecting');

  useEffect(() => {
    setState('connecting');
    const handle = openEventStream({
      url: `/api/v1/realtime/stream${businessId ? `?businessId=${businessId}` : ''}`,
      headers: { 'x-organization-id': orgId },
      onOpen: () => setState('live'),
      onReconnect: () => void qc.invalidateQueries({ queryKey: qk.org(orgId) }), // we may have missed events
      onFatal: () => setState('offline'),
      onEvent: (type, data) => {
        if (type === 'ready' || type === 'ping') return;
        applyRealtimeEvent(qc, orgId, type, data);
      },
    });
    const onOffline = () => setState('reconnecting');
    window.addEventListener('offline', onOffline);
    return () => { handle.close(); window.removeEventListener('offline', onOffline); };
  }, [orgId, businessId, qc]);

  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}
