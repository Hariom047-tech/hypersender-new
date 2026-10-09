import { QueryClient, type InfiniteData } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { applyMessageStatus, forwardStatus, upsertConversation, upsertMessage } from '@/lib/cache-merge';
import { applyRealtimeEvent } from '@/lib/realtime';
import type { Conversation, Message, Page } from '@/lib/types';
import { qk } from '@/lib/workspace';

const msg = (id: string, status: Message['status'] = 'QUEUED', over: Partial<Message> = {}): Message => ({
  id, conversationId: 'c1', instanceId: 'i1', businessId: 'b1', direction: 'OUTBOUND', origin: 'DASHBOARD', fromMe: true, type: 'TEXT',
  text: `text ${id}`, status, timestamp: new Date().toISOString(), errorCode: null, isAiGenerated: false, replyTo: null, attachments: [], ...over,
});
const conv = (id: string, over: Partial<Conversation> = {}): Conversation => ({
  id, status: 'OPEN', unreadCount: 1, lastMessageAt: new Date().toISOString(), businessId: 'b1', businessName: 'B', instanceId: 'i1', instanceName: 'I',
  contact: { id: 'ct', name: 'Rahul', phone: '+919811100011', identity: '+919811100011', identityType: 'PHONE' }, lastMessage: null, ...over,
});
const pages = <T,>(...items: T[][]): InfiniteData<Page<T>, string | null> => ({ pages: items.map((i) => ({ items: i, nextCursor: null })), pageParams: items.map(() => null) });

describe('cache merge rules', () => {
  it('status only moves forward (late/duplicate receipts never downgrade)', () => {
    expect(forwardStatus('QUEUED', 'SENT')).toBe('SENT');
    expect(forwardStatus('READ', 'DELIVERED')).toBe('READ');
    expect(forwardStatus('READ', 'READ')).toBe('READ');
    expect(forwardStatus('SENT', 'WHATEVER')).toBe('SENT');
  });

  it('upsertMessage: new id prepended once; same id (API response + realtime) never duplicated', () => {
    let d = pages([msg('m1', 'SENT')]);
    d = upsertMessage(d, msg('m2'))!;
    d = upsertMessage(d, msg('m2'))!;
    d = upsertMessage(d, msg('m2', 'QUEUED'))!;
    expect(d.pages[0].items.map((m) => m.id)).toEqual(['m2', 'm1']);
    d = applyMessageStatus(d, 'm2', 'DELIVERED')!;
    d = upsertMessage(d, msg('m2', 'SENT'))!; // stale copy arrives later
    expect(d.pages[0].items[0].status).toBe('DELIVERED');
  });

  it('upsertConversation respects the list filter and moves updated threads to the top', () => {
    let d = pages([conv('a'), conv('b')]);
    d = upsertConversation(d, conv('b', { unreadCount: 3 }), 'open', null)!;
    expect(d.pages[0].items.map((c) => c.id)).toEqual(['b', 'a']);
    d = upsertConversation(d, conv('a', { status: 'RESOLVED' }), 'open', null)!;
    expect(d.pages[0].items.map((c) => c.id)).toEqual(['b']);
    const unread = upsertConversation(pages([conv('x')]), conv('x', { unreadCount: 0 }), 'unread', null)!;
    expect(unread.pages[0].items).toEqual([]);
    const otherBiz = upsertConversation(pages([]), conv('y', { businessId: 'b2' }), 'all', 'b1')!;
    expect(otherBiz.pages[0].items).toEqual([]);
  });
});

describe('applyRealtimeEvent', () => {
  it('merges message.created / status updates into the right conversation cache without duplicates', () => {
    const qc = new QueryClient();
    qc.setQueryData(qk.messages('org1', 'c1'), pages([msg('m1', 'SENT')]));
    applyRealtimeEvent(qc, 'org1', 'message.created', { message: msg('m2', 'QUEUED') });
    applyRealtimeEvent(qc, 'org1', 'message.created', { message: msg('m2', 'QUEUED') });
    applyRealtimeEvent(qc, 'org1', 'message.status_updated', { messageId: 'm2', conversationId: 'c1', status: 'READ' });
    applyRealtimeEvent(qc, 'org1', 'message.status_updated', { messageId: 'm2', conversationId: 'c1', status: 'DELIVERED' });
    const d = qc.getQueryData<InfiniteData<Page<Message>>>(qk.messages('org1', 'c1'))!;
    expect(d.pages[0].items.map((m) => [m.id, m.status])).toEqual([['m2', 'READ'], ['m1', 'SENT']]);
  });

  it('conversation.updated reaches every cached list of the organization only', () => {
    const qc = new QueryClient();
    const openKey = [...qk.scoped('org1', null, 'conversations', 'open', null), null];
    const otherOrg = [...qk.scoped('org2', null, 'conversations', 'open', null), null];
    qc.setQueryData(openKey, pages([conv('a')]));
    qc.setQueryData(otherOrg, pages([conv('z')]));
    applyRealtimeEvent(qc, 'org1', 'conversation.created', { conversation: conv('new') });
    expect(qc.getQueryData<InfiniteData<Page<Conversation>>>(openKey)!.pages[0].items.map((c) => c.id)).toEqual(['new', 'a']);
    expect(qc.getQueryData<InfiniteData<Page<Conversation>>>(otherOrg)!.pages[0].items.map((c) => c.id)).toEqual(['z']);
  });
});
