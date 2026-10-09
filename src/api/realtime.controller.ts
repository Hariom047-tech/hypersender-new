import { Controller, Inject, Query, Sse, type MessageEvent } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProduces, ApiQuery, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Observable } from 'rxjs';
import { uuidParam } from '../common/validation.js';
import { currentTenant } from '../database/tenant-context.js';
import { APP_TX, TransactionRunner } from '../database/transaction-runner.js';
import { WhatsAppError } from '../whatsapp/domain/whatsapp-errors.js';
import { APP_EVENT_TYPES, REALTIME_BUS, type RealtimeBus } from '../whatsapp/realtime/realtime-bus.js';
import { requireScope } from './auth/permissions.js';

/**
 * ONE org-wide realtime stream for the dashboard (Server-Sent Events).
 * Authorisation: tenant middleware (membership / live API key) + scope
 * messages:read. Every event is filtered server-side by organization, by the
 * caller's business restriction (business-scoped API keys, or ?businessId=)
 * and, for notifications, by recipient user. QR/pairing codes are NOT on this
 * stream (they stay on the per-instance stream that requires instances:write).
 * Clients must refetch after reconnecting: SSE is best-effort, the DB is truth.
 */
@ApiTags('Realtime')
@ApiBearerAuth('session')
@ApiSecurity('api-key')
@Controller('v1/realtime')
export class RealtimeController {
  constructor(@Inject(REALTIME_BUS) private readonly bus: RealtimeBus, @Inject(APP_TX) private readonly tx: TransactionRunner) {}

  @Sse('stream')
  @ApiProduces('text/event-stream')
  @ApiQuery({ name: 'businessId', required: false })
  @ApiOperation({ summary: 'Application events: conversation.created|updated, message.created, message.status_updated, instance.status_updated, notification.created (+ ready, ping)' })
  async stream(@Query('businessId') businessId?: string): Promise<Observable<MessageEvent>> {
    const ctx = currentTenant();
    requireScope(ctx, 'messages:read');
    let business: string | null = ctx.businessId ?? null;
    if (businessId) {
      const requested = uuidParam(businessId, 'businessId');
      if (business && business !== requested) throw new WhatsAppError('NOT_FOUND');
      const ok = await this.tx.inTenant((db) => db.query('SELECT 1 FROM app.businesses WHERE id = $1 AND deleted_at IS NULL', [requested]), ctx, { readOnly: true });
      if (!ok.rowCount) throw new WhatsAppError('NOT_FOUND');
      business = requested;
    }
    const org = ctx.organizationId;
    const user = ctx.userId ?? null;
    return new Observable<MessageEvent>((sub) => {
      sub.next({ type: 'ready', data: { organizationId: org, businessId: business } });
      const off = this.bus.subscribe((e) => {
        if (!APP_EVENT_TYPES.has(e.type)) return;
        if (e.organizationId !== org) return;
        if (e.userId && e.userId !== user) return;
        if (business && e.businessId && e.businessId !== business) return;
        sub.next({ type: e.type, data: e.data });
      });
      const ping = setInterval(() => sub.next({ type: 'ping', data: {} }), 25_000);
      return () => { off(); clearInterval(ping); };
    });
  }
}
