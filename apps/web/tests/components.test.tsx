import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MessageBubble, StatusBadge, InstanceStatus } from '@/components/ui';
import { ApiError, friendlyMessage } from '@/lib/api';
import { can } from '@/lib/permissions';
import type { Message } from '@/lib/types';

const base: Message = {
  id: 'm', conversationId: 'c', instanceId: 'i', businessId: 'b', direction: 'INBOUND', origin: 'CONTACT', fromMe: false, type: 'TEXT', text: 'hi',
  status: 'RECEIVED', timestamp: new Date().toISOString(), errorCode: null, isAiGenerated: false, replyTo: null, attachments: [],
};

describe('MessageBubble (untrusted customer content)', () => {
  it('renders HTML/script in customer messages as inert text', () => {
    const evil = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const { container } = render(<MessageBubble message={{ ...base, text: evil }} />);
    expect(screen.getByText(evil)).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
  });

  it('shows unsupported types safely and document names as text', () => {
    render(<MessageBubble message={{ ...base, type: 'UNKNOWN', text: null }} />);
    expect(screen.getByText('Unsupported WhatsApp message')).toBeTruthy();
    const name = '"><svg onload=alert(1)>.pdf';
    const { container } = render(<MessageBubble message={{ ...base, type: 'DOCUMENT', text: null,
      attachments: [{ id: 'a', mediaType: 'DOCUMENT', mimeType: 'application/pdf', fileName: name, fileSize: 2048, status: 'STORED' }] }} />);
    expect(screen.getByText(name)).toBeTruthy();
    expect(container.querySelector('svg')).toBeNull();
  });

  it('outbound status is shown as text; phone-sent messages are labelled; pending never claims SENT', () => {
    render(<MessageBubble message={{ ...base, direction: 'OUTBOUND', fromMe: true, origin: 'LINKED_DEVICE', status: 'READ' }} />);
    expect(screen.getByText('Sent from phone')).toBeTruthy();
    expect(screen.getByText(/Read/)).toBeTruthy();
    render(<MessageBubble pending message={{ ...base, id: 'p', direction: 'OUTBOUND', fromMe: true, origin: 'DASHBOARD', status: 'SENT' }} />);
    expect(screen.getByText(/Sending…/)).toBeTruthy();
  });
});

describe('status badges carry text, not colour alone', () => {
  it('StatusBadge / InstanceStatus', () => {
    render(<><StatusBadge tone="green">Enabled</StatusBadge><InstanceStatus status="LOGGED_OUT" /><InstanceStatus status="RECONNECTING" /></>);
    expect(screen.getByText('Enabled')).toBeTruthy();
    expect(screen.getByText('Logged out — scan QR to reconnect')).toBeTruthy();
    expect(screen.getByText('Reconnecting…')).toBeTruthy();
  });
});

describe('error UX', () => {
  it('maps backend codes to owner-friendly text and never leaks internals', () => {
    expect(friendlyMessage(new ApiError(409, 'WHATSAPP_INSTANCE_NOT_CONNECTED', 'x'))).toBe('WhatsApp is disconnected. Reconnect it before sending.');
    expect(friendlyMessage(new ApiError(500, 'INTERNAL_ERROR', 'relation "app.x" does not exist'))).not.toMatch(/relation|app\./);
    expect(friendlyMessage(new TypeError('Failed to fetch'))).toMatch(/Network error/);
  });
});

describe('UI permission mirror matches the backend', async () => {
  // Import the backend's authoritative mapping and compare every role x scope.
  const backend = await import('../../../src/api/auth/permissions');
  const roles = ['OWNER', 'ADMIN', 'MANAGER', 'AGENT', 'VIEWER'] as const;
  const scopes = ['instances:read', 'instances:write', 'messages:send', 'messages:read', 'webhooks:manage', 'assistants:read', 'assistants:manage'] as const;
  it.each(roles)('role %s', (role) => {
    for (const s of scopes) {
      let backendAllows = true;
      try { backend.requireScope({ organizationId: 'o', userId: 'u', role }, s); } catch { backendAllows = false; }
      expect(can(role, s), `${role} ${s}`).toBe(backendAllows);
    }
  });
});
