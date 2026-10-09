import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { requireUser } from './auth/permissions.js';
import { pageLimit } from '../common/cursor.js';
import { uuidParam } from '../common/validation.js';
import { currentTenant } from '../database/tenant-context.js';
import { WhatsAppError } from '../whatsapp/domain/whatsapp-errors.js';
import { BillingService, TX_STATUSES, type SubscriptionGroup } from './billing.service.js';

const GROUPS: SubscriptionGroup[] = ['ACTIVE', 'PENDING', 'INACTIVE'];
const search = (v?: string) => (v && v.trim() ? v.trim().slice(0, 100) : undefined);

@ApiTags('Usage & billing')
@ApiBearerAuth('session')
@Controller('v1/billing')
export class BillingController {
  constructor(@Inject(BillingService) private readonly billing: BillingService) {}

  @Get('subscriptions')
  @ApiOperation({ summary: 'Subscriptions grouped as ACTIVE (incl. trial) / PENDING (past due) / INACTIVE, with counts per group' })
  @ApiQuery({ name: 'group', required: false, enum: GROUPS }) @ApiQuery({ name: 'q', required: false })
  subscriptions(@Query('group') group?: string, @Query('q') q?: string) {
    const ctx = currentTenant();
    requireUser(ctx, ['OWNER', 'ADMIN']);
    const g = (group ?? 'ACTIVE').toUpperCase() as SubscriptionGroup;
    if (!GROUPS.includes(g)) throw new WhatsAppError('VALIDATION_FAILED', `group must be one of ${GROUPS.join(', ')}`);
    return this.billing.subscriptions(ctx, { group: g, search: search(q) });
  }

  @Get('transactions')
  @ApiOperation({ summary: 'Transactions (one per issued invoice) with summary counts; keyset paginated' })
  @ApiQuery({ name: 'status', required: false, enum: TX_STATUSES }) @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'subscription', required: false }) @ApiQuery({ name: 'cursor', required: false }) @ApiQuery({ name: 'limit', required: false })
  transactions(@Query('status') status?: string, @Query('q') q?: string, @Query('subscription') subscription?: string,
               @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    const ctx = currentTenant();
    requireUser(ctx, ['OWNER', 'ADMIN']);
    if (status && !(TX_STATUSES as readonly string[]).includes(status)) throw new WhatsAppError('VALIDATION_FAILED', `status must be one of ${TX_STATUSES.join(', ')}`);
    return this.billing.transactions(ctx, { status: status || undefined, search: search(q), subscription: search(subscription), cursor, limit: pageLimit(limit, 10, 100) });
  }

  @Get('transactions/export')
  @ApiOperation({ summary: 'All transactions (max 5000) for a CSV export' })
  export() {
    const ctx = currentTenant();
    requireUser(ctx, ['OWNER', 'ADMIN']);
    return this.billing.exportTransactions(ctx);
  }

  @Get('invoices/:id')
  @ApiOperation({ summary: 'Invoice with amounts and payments (printable)' })
  invoice(@Param('id') id: string) {
    const ctx = currentTenant();
    requireUser(ctx, ['OWNER', 'ADMIN']);
    return this.billing.invoice(ctx, uuidParam(id));
  }
}
