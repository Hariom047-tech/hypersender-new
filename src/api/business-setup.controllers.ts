import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CatalogService } from '../catalog/catalog.service.js';
import { obj, uuidParam } from '../common/validation.js';
import { currentTenant } from '../database/tenant-context.js';
import { HavanAdminService } from '../havan/havan-admin.service.js';
import { TranslationService } from '../ai/translation.service.js';
import { CampaignAdminService } from '../marketing/campaign-admin.service.js';
import { OrderingAdminService } from '../ordering/ordering-admin.service.js';
import { WhatsAppError } from '../whatsapp/domain/whatsapp-errors.js';
import { requireScope, requireUser } from './auth/permissions.js';

/** Owners, admins and managers configure the business; everyone can read. */
function manager() {
  const ctx = currentTenant();
  requireUser(ctx, ['OWNER', 'ADMIN', 'MANAGER']);
  return ctx;
}
function reader() {
  const ctx = currentTenant();
  requireScope(ctx, 'messages:read');
  return ctx;
}
/** Staff who work orders (agents included). */
function operator() {
  const ctx = currentTenant();
  requireScope(ctx, 'messages:send');
  requireUser(ctx, ['OWNER', 'ADMIN', 'MANAGER', 'AGENT']);
  return ctx;
}
const optUuid = (v: unknown, n: string) => (v === undefined || v === '' || v === null ? undefined : uuidParam(v, n));

@ApiTags('Business setup')
@ApiBearerAuth('session')
@Controller('v1/businesses/:bid')
export class BusinessSetupController {
  constructor(@Inject(CatalogService) private readonly c: CatalogService) {}

  @Get('services') @ApiOperation({ summary: 'Services & prices (what customers can book)' })
  services(@Param('bid') bid: string) { return this.c.listServices(reader(), uuidParam(bid)); }
  @Post('services') createService(@Param('bid') bid: string, @Body() b: unknown) { return this.c.saveService(manager(), uuidParam(bid), null, obj(b)); }
  @Patch('services/:id') updateService(@Param('bid') bid: string, @Param('id') id: string, @Body() b: unknown) { return this.c.saveService(manager(), uuidParam(bid), uuidParam(id), obj(b)); }
  @Delete('services/:id') deleteService(@Param('bid') bid: string, @Param('id') id: string) { return this.c.deleteService(manager(), uuidParam(bid), uuidParam(id)); }

  @Get('resources') @ApiOperation({ summary: 'Staff & tables (bookable resources with capacity)' })
  resources(@Param('bid') bid: string) { return this.c.listResources(reader(), uuidParam(bid)); }
  @Post('resources') createResource(@Param('bid') bid: string, @Body() b: unknown) { return this.c.saveResource(manager(), uuidParam(bid), null, obj(b)); }
  @Patch('resources/:id') updateResource(@Param('bid') bid: string, @Param('id') id: string, @Body() b: unknown) { return this.c.saveResource(manager(), uuidParam(bid), uuidParam(id), obj(b)); }
  @Delete('resources/:id') deleteResource(@Param('bid') bid: string, @Param('id') id: string) { return this.c.deleteResource(manager(), uuidParam(bid), uuidParam(id)); }

  @Get('availability') @ApiOperation({ summary: 'Weekly bookable hours (business-wide, or ?resourceId= for one resource)' })
  availability(@Param('bid') bid: string, @Query('resourceId') rid?: string) { return this.c.getAvailability(reader(), uuidParam(bid), optUuid(rid, 'resourceId') ?? null); }
  @Put('availability') setAvailability(@Param('bid') bid: string, @Body() raw: unknown) {
    const b = obj(raw);
    return this.c.setAvailability(manager(), uuidParam(bid), optUuid(b.resourceId, 'resourceId') ?? null, b.weekly);
  }
  @Get('availability-exceptions') exceptions(@Param('bid') bid: string) { return this.c.listExceptions(reader(), uuidParam(bid)); }
  @Post('availability-exceptions') addException(@Param('bid') bid: string, @Body() b: unknown) { return this.c.addException(manager(), uuidParam(bid), obj(b)); }
  @Delete('availability-exceptions/:id') deleteException(@Param('bid') bid: string, @Param('id') id: string) { return this.c.deleteException(manager(), uuidParam(bid), uuidParam(id)); }

  @Get('locations') @ApiOperation({ summary: 'Branches / addresses with map location' })
  locations(@Param('bid') bid: string) { return this.c.listLocations(reader(), uuidParam(bid)); }
  @Post('locations') createLocation(@Param('bid') bid: string, @Body() b: unknown) { return this.c.saveLocation(manager(), uuidParam(bid), null, obj(b)); }
  @Patch('locations/:id') updateLocation(@Param('bid') bid: string, @Param('id') id: string, @Body() b: unknown) { return this.c.saveLocation(manager(), uuidParam(bid), uuidParam(id), obj(b)); }
  @Delete('locations/:id') deleteLocation(@Param('bid') bid: string, @Param('id') id: string) { return this.c.deleteLocation(manager(), uuidParam(bid), uuidParam(id)); }
}

@ApiTags('Business setup')
@ApiBearerAuth('session')
@Controller('v1/bookings')
export class BookingsController {
  constructor(@Inject(CatalogService) private readonly c: CatalogService) {}

  @Get() @ApiOperation({ summary: 'Appointments / reservations in a date range' })
  list(@Query() q: Record<string, string>) {
    const from = q.from ? new Date(q.from) : new Date(Date.now() - 86_400_000);
    const to = q.to ? new Date(q.to) : new Date(Date.now() + 14 * 86_400_000);
    if (Number.isNaN(+from) || Number.isNaN(+to) || from >= to || +to - +from > 92 * 86_400_000) throw new WhatsAppError('VALIDATION_FAILED', 'from/to must be a range of up to 92 days');
    if (q.status && !['PENDING', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'RESCHEDULED'].includes(q.status)) throw new WhatsAppError('VALIDATION_FAILED', 'invalid status');
    return this.c.listBookings(reader(), { businessId: optUuid(q.businessId, 'businessId'), from, to, status: q.status || undefined });
  }

  @Post(':id/status') @HttpCode(200)
  status(@Param('id') id: string, @Body() raw: unknown) {
    const b = obj(raw);
    const s = String(b.status);
    if (!['CONFIRMED', 'COMPLETED', 'NO_SHOW', 'CANCELLED'].includes(s)) throw new WhatsAppError('VALIDATION_FAILED', 'status must be CONFIRMED, COMPLETED, NO_SHOW or CANCELLED');
    return this.c.setBookingStatus(operator(), uuidParam(id), s as 'CONFIRMED', typeof b.reason === 'string' ? b.reason : undefined);
  }
}

@ApiTags('Restaurant')
@ApiBearerAuth('session')
@Controller('v1/businesses/:bid')
export class RestaurantSetupController {
  constructor(@Inject(OrderingAdminService) private readonly o: OrderingAdminService) {}

  @Get('menu') @ApiOperation({ summary: 'Menu: categories, dishes (sizes, add-on groups), add-on groups' })
  menu(@Param('bid') bid: string) { return this.o.getMenu(reader(), uuidParam(bid)); }
  @Post('menu/categories') createCategory(@Param('bid') bid: string, @Body() b: unknown) { return this.o.saveCategory(manager(), uuidParam(bid), null, obj(b)); }
  @Patch('menu/categories/:id') updateCategory(@Param('bid') bid: string, @Param('id') id: string, @Body() b: unknown) { return this.o.saveCategory(manager(), uuidParam(bid), uuidParam(id), obj(b)); }
  @Delete('menu/categories/:id') deleteCategory(@Param('bid') bid: string, @Param('id') id: string) { return this.o.deleteCategory(manager(), uuidParam(bid), uuidParam(id)); }
  @Post('menu/items') createItem(@Param('bid') bid: string, @Body() b: unknown) { return this.o.saveItem(manager(), uuidParam(bid), null, obj(b)); }
  @Patch('menu/items/:id') updateItem(@Param('bid') bid: string, @Param('id') id: string, @Body() b: unknown) { return this.o.saveItem(manager(), uuidParam(bid), uuidParam(id), obj(b)); }
  @Delete('menu/items/:id') deleteItem(@Param('bid') bid: string, @Param('id') id: string) { return this.o.deleteItem(manager(), uuidParam(bid), uuidParam(id)); }
  @Post('menu/items/:id/availability') @HttpCode(200) @ApiOperation({ summary: 'Quick "sold out" / "available again" toggle (staff)' })
  availability(@Param('bid') bid: string, @Param('id') id: string, @Body() raw: unknown) {
    const b = obj(raw);
    if (typeof b.available !== 'boolean') throw new WhatsAppError('VALIDATION_FAILED', 'available must be true or false');
    return this.o.setItemAvailability(operator(), uuidParam(bid), uuidParam(id), b.available);
  }
  @Post('menu/modifier-groups') createGroup(@Param('bid') bid: string, @Body() b: unknown) { return this.o.saveModifierGroup(manager(), uuidParam(bid), null, obj(b)); }
  @Patch('menu/modifier-groups/:id') updateGroup(@Param('bid') bid: string, @Param('id') id: string, @Body() b: unknown) { return this.o.saveModifierGroup(manager(), uuidParam(bid), uuidParam(id), obj(b)); }
  @Delete('menu/modifier-groups/:id') deleteGroup(@Param('bid') bid: string, @Param('id') id: string) { return this.o.deleteModifierGroup(manager(), uuidParam(bid), uuidParam(id)); }

  @Get('ordering-settings') settings(@Param('bid') bid: string) { return this.o.getSettings(reader(), uuidParam(bid)); }
  @Put('ordering-settings') saveSettings(@Param('bid') bid: string, @Body() b: unknown) { return this.o.saveSettings(manager(), uuidParam(bid), obj(b)); }

  @Get('coupons') coupons(@Param('bid') bid: string) { return this.o.listCoupons(reader(), uuidParam(bid)); }
  @Post('coupons') createCoupon(@Param('bid') bid: string, @Body() b: unknown) { return this.o.saveCoupon(manager(), uuidParam(bid), null, obj(b)); }
  @Patch('coupons/:id') updateCoupon(@Param('bid') bid: string, @Param('id') id: string, @Body() b: unknown) { return this.o.saveCoupon(manager(), uuidParam(bid), uuidParam(id), obj(b)); }
}

@ApiTags('Restaurant')
@ApiBearerAuth('session')
@Controller('v1')
export class OrdersController {
  constructor(@Inject(OrderingAdminService) private readonly o: OrderingAdminService) {}

  @Get('orders') @ApiOperation({ summary: 'Order board: view=ACTIVE|DONE|CANCELLED|ALL' })
  list(@Query('businessId') businessId?: string, @Query('view') view = 'ACTIVE') {
    if (!['ACTIVE', 'DONE', 'CANCELLED', 'ALL'].includes(view)) throw new WhatsAppError('VALIDATION_FAILED', 'invalid view');
    return this.o.listOrders(reader(), { businessId: optUuid(businessId, 'businessId'), view: view as 'ACTIVE' });
  }
  @Get('orders/:id') get(@Param('id') id: string) { return this.o.getOrder(reader(), uuidParam(id)); }
  @Post('orders/:id/status') @HttpCode(200) @ApiOperation({ summary: 'Accept / reject / preparing / ready / out for delivery / delivered / completed / cancel (customer is notified on WhatsApp)' })
  status(@Param('id') id: string, @Body() raw: unknown) {
    const b = obj(raw);
    const s = String(b.status);
    if (!['ACCEPTED', 'REJECTED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY', 'DELIVERED', 'COMPLETED', 'CANCELLED'].includes(s)) throw new WhatsAppError('VALIDATION_FAILED', 'invalid status');
    return this.o.updateStatus(operator(), uuidParam(id), s, typeof b.note === 'string' ? b.note : null);
  }
  @Post('orders/:id/paid') @HttpCode(200) paid(@Param('id') id: string) { return this.o.markPaid(operator(), uuidParam(id)); }
  @Post('order-requests/:id/resolve') @HttpCode(200)
  resolve(@Param('id') id: string, @Body() raw: unknown) {
    const b = obj(raw);
    if (typeof b.approve !== 'boolean') throw new WhatsAppError('VALIDATION_FAILED', 'approve must be true or false');
    return this.o.resolveRequest(operator(), uuidParam(id), b.approve, typeof b.note === 'string' ? b.note : null);
  }
  @Get('support-tickets') tickets(@Query('businessId') businessId?: string, @Query('open') open?: string) {
    return this.o.listTickets(reader(), { businessId: optUuid(businessId, 'businessId'), open: open !== 'false' });
  }
  @Post('support-tickets/:id/status') @HttpCode(200) ticketStatus(@Param('id') id: string, @Body() raw: unknown) {
    const s = String(obj(raw).status);
    if (!['OPEN', 'IN_PROGRESS', 'RESOLVED'].includes(s)) throw new WhatsAppError('VALIDATION_FAILED', 'invalid status');
    return this.o.setTicketStatus(operator(), uuidParam(id), s as 'OPEN');
  }
}

@ApiTags('Havan')
@ApiBearerAuth('session')
@Controller('v1/businesses/:bid/havan')
export class HavanSetupController {
  constructor(@Inject(HavanAdminService) private readonly h: HavanAdminService,
              @Inject(TranslationService) private readonly tr: TranslationService) {}

  @Post('translate') @HttpCode(200)
  @ApiOperation({ summary: 'Translate free-text notes (call-back summaries, sankalp) into the dashboard language' })
  async translate(@Param('bid') bid: string, @Body() b: unknown) {
    reader(); uuidParam(bid);
    const body = obj(b);
    const lang = String(body.lang ?? '');
    const texts = body.texts;
    if (lang !== 'hi') throw new WhatsAppError('VALIDATION_FAILED', 'unsupported lang');
    if (!Array.isArray(texts) || texts.length > 50 || texts.some((x) => typeof x !== 'string' || x.length > 2000)) {
      throw new WhatsAppError('VALIDATION_FAILED', 'texts must be up to 50 strings of at most 2000 characters');
    }
    return { lang, texts: await this.tr.translate(texts as string[], lang) };
  }

  @Get('settings') @ApiOperation({ summary: 'Pandit Ji contact, temple information, online havan, reminder lead time' })
  settings(@Param('bid') bid: string) { return this.h.getSettings(reader(), uuidParam(bid)); }
  @Put('settings') saveSettings(@Param('bid') bid: string, @Body() b: unknown) { return this.h.saveSettings(manager(), uuidParam(bid), obj(b)); }

  @Get('packages') @ApiOperation({ summary: 'Samanya / Vishesh / Maha Vishesh havan packages (no prices: dakshina is told on call)' })
  packages(@Param('bid') bid: string) { return this.h.listPackages(reader(), uuidParam(bid)); }
  @Put('packages/:tier') savePackage(@Param('bid') bid: string, @Param('tier') tier: string, @Body() b: unknown) {
    return this.h.savePackage(manager(), uuidParam(bid), String(tier).toUpperCase(), obj(b));
  }
  @Delete('packages/:tier') deletePackage(@Param('bid') bid: string, @Param('tier') tier: string) {
    return this.h.deletePackage(manager(), uuidParam(bid), String(tier).toUpperCase());
  }

  @Get('special-dates') specialDates(@Param('bid') bid: string) { return this.h.listSpecialDates(reader(), uuidParam(bid)); }
  @Post('special-dates') addSpecialDate(@Param('bid') bid: string, @Body() b: unknown) { return this.h.addSpecialDate(manager(), uuidParam(bid), obj(b)); }
  @Delete('special-dates/:id') deleteSpecialDate(@Param('bid') bid: string, @Param('id') id: string) {
    return this.h.deleteSpecialDate(manager(), uuidParam(bid), uuidParam(id));
  }

  @Get('callbacks') @ApiOperation({ summary: 'Call-back requests from yajmans: status=NEW|CALLED|CLOSED|ALL' })
  callbacks(@Param('bid') bid: string, @Query('status') status = 'NEW') {
    if (!['NEW', 'CALLED', 'CLOSED', 'ALL'].includes(status)) throw new WhatsAppError('VALIDATION_FAILED', 'invalid status');
    return this.h.listCallbacks(reader(), uuidParam(bid), status as 'NEW');
  }
  @Post('callbacks/:id/status') @HttpCode(200) callbackStatus(@Param('bid') bid: string, @Param('id') id: string, @Body() raw: unknown) {
    const s = String(obj(raw).status);
    if (!['CALLED', 'CLOSED'].includes(s)) throw new WhatsAppError('VALIDATION_FAILED', 'status must be CALLED or CLOSED');
    return this.h.setCallbackStatus(operator(), uuidParam(bid), uuidParam(id), s as 'CALLED');
  }

  @Get('google-calendar') @ApiOperation({ summary: "Pandit Ji's Google Calendar connection status" })
  calendar(@Param('bid') bid: string) { return this.h.calendarStatus(reader(), uuidParam(bid)); }
  @Post('google-calendar/connect') @HttpCode(200) @ApiOperation({ summary: 'Start connecting Google Calendar: returns the Google consent URL to open' })
  connectCalendar(@Param('bid') bid: string) { return this.h.connectCalendar(manager(), uuidParam(bid)); }
  @Delete('google-calendar') disconnectCalendar(@Param('bid') bid: string) { return this.h.disconnectCalendar(manager(), uuidParam(bid)); }

  @Get('bookings') @ApiOperation({ summary: 'Upcoming havan bookings with gotra, sankalp, mode, dakshina status and reminders' })
  bookings(@Param('bid') bid: string) { return this.h.listBookings(reader(), uuidParam(bid)); }
  @Post('bookings/:id/dakshina') @HttpCode(200) dakshina(@Param('bid') bid: string, @Param('id') id: string, @Body() raw: unknown) {
    const s = String(obj(raw).status);
    if (!['TO_BE_DISCUSSED_ON_CALL', 'AGREED_ON_CALL'].includes(s)) throw new WhatsAppError('VALIDATION_FAILED', 'status must be TO_BE_DISCUSSED_ON_CALL or AGREED_ON_CALL');
    return this.h.setDakshinaStatus(operator(), uuidParam(bid), uuidParam(id), s as 'AGREED_ON_CALL');
  }
}

/** Google redirects the browser here after consent (public route: the signed state carries org, business and user). */
@ApiTags('Havan')
@Controller('v1/oauth/google')
export class GoogleOAuthController {
  constructor(@Inject(HavanAdminService) private readonly h: HavanAdminService) {}

  @Get('callback')
  async callback(@Query('code') code: string | undefined, @Query('state') state: string | undefined, @Query('error') error: string | undefined, @Res() res: Response) {
    res.redirect(302, await this.h.completeCalendar(code, state, error));
  }
}

@ApiTags('Marketing campaigns')
@ApiBearerAuth('session')
@Controller('v1/businesses/:bid/campaigns')
export class CampaignsController {
  constructor(@Inject(CampaignAdminService) private readonly c: CampaignAdminService) {}

  @Post('audience') @HttpCode(200)
  @ApiOperation({ summary: 'How many customers a campaign would reach (only people who messaged you or opted in, never opted-out ones)' })
  audience(@Param('bid') bid: string, @Body() b: unknown) { return this.c.audience(reader(), uuidParam(bid), obj(b).audience); }

  @Get('contacts') @ApiOperation({ summary: 'Contacts with marketing status: status=ALL|ELIGIBLE|OPTED_OUT|NO_CONSENT, q=search' })
  contacts(@Param('bid') bid: string, @Query('status') status?: string, @Query('q') q?: string) {
    return this.c.contacts(reader(), uuidParam(bid), { status, q });
  }
  @Put('contacts/:cid/preference') @ApiOperation({ summary: 'Record a customer’s consent (with how they agreed) or remove them from marketing' })
  preference(@Param('bid') bid: string, @Param('cid') cid: string, @Body() b: unknown) {
    return this.c.setPreference(manager(), uuidParam(bid), uuidParam(cid), obj(b));
  }

  @Post('import') @HttpCode(200)
  @ApiOperation({ summary: 'Import customers (name, phone) from a spreadsheet, with a note on how they agreed; returns contact ids for a SELECTED audience' })
  importContacts(@Param('bid') bid: string, @Body() b: unknown) { return this.c.importContacts(manager(), uuidParam(bid), obj(b)); }

  @Post('ai-draft') @HttpCode(200) @ApiOperation({ summary: 'Three AI-written message options from a short brief' })
  aiDraft(@Param('bid') bid: string, @Body() b: unknown) { return this.c.aiDraft(manager(), uuidParam(bid), obj(b)); }

  @Get() list(@Param('bid') bid: string) { return this.c.list(reader(), uuidParam(bid)); }
  @Post() create(@Param('bid') bid: string, @Body() b: unknown) { return this.c.create(manager(), uuidParam(bid), obj(b)); }
  @Get(':id') get(@Param('bid') bid: string, @Param('id') id: string) { return this.c.get(reader(), uuidParam(bid), uuidParam(id)); }
  @Put(':id') update(@Param('bid') bid: string, @Param('id') id: string, @Body() b: unknown) {
    return this.c.update(manager(), uuidParam(bid), uuidParam(id), obj(b));
  }
  @Post(':id/start') @HttpCode(200) @ApiOperation({ summary: 'Start now, or at scheduledAt; sending is paced and only inside sending hours' })
  start(@Param('bid') bid: string, @Param('id') id: string, @Body() b: unknown) { return this.c.start(manager(), uuidParam(bid), uuidParam(id), obj(b ?? {})); }
  @Post(':id/pause') @HttpCode(200) pause(@Param('bid') bid: string, @Param('id') id: string) { return this.c.pause(manager(), uuidParam(bid), uuidParam(id)); }
  @Post(':id/resume') @HttpCode(200) resume(@Param('bid') bid: string, @Param('id') id: string) { return this.c.resume(manager(), uuidParam(bid), uuidParam(id)); }
  @Post(':id/cancel') @HttpCode(200) cancel(@Param('bid') bid: string, @Param('id') id: string) { return this.c.cancel(manager(), uuidParam(bid), uuidParam(id)); }
}
