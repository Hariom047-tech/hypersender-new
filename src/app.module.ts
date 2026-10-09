import { type MiddlewareConsumer, Module, type NestModule, RequestMethod } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuthController, ApiKeysController, InternalHealthController, WebhookLogsController, WebhooksController } from './api/platform.controllers.js';
import { AccountController } from './api/account.controller.js';
import { AiAssistantsController, AiTemplatesController } from './api/ai.controllers.js';
import { BookingsController, BusinessSetupController, CampaignsController, GoogleOAuthController, HavanSetupController, OrdersController, RestaurantSetupController } from './api/business-setup.controllers.js';
import { HavanAdminService } from './havan/havan-admin.service.js';
import { GoogleCalendarService, googleCalendarConfigFromEnv } from './integrations/google-calendar.js';
import { CatalogService } from './catalog/catalog.service.js';
import { OrderingAdminService } from './ordering/ordering-admin.service.js';
import { AssistantAdminService } from './ai/admin/assistant-admin.service.js';
import { SandboxService } from './ai/admin/sandbox.service.js';
import { TranslationService } from './ai/translation.service.js';
import { GoogleSignInService } from './services/google-signin.service.js';
import { CampaignAdminService } from './marketing/campaign-admin.service.js';
import { AI_MODEL_PROVIDER, EMBEDDING_PROVIDER, type EmbeddingProvider, type ModelProviderRegistry } from './ai/model/model-provider.js';
import { aiProvidersFromEnv } from './ai/model/providers-from-env.js';
import { ToolRegistry } from './ai/tools/registry.js';
import { BookingService } from './services/booking.service.js';
import { LeadService } from './services/lead.service.js';
import { OrderingService } from './ordering/ordering.service.js';
import { MediaController } from './api/media.controller.js';
import { RealtimeController } from './api/realtime.controller.js';
import { BusinessesController, ContactsController, ConversationsController, DashboardController, OrganizationController, TeamController, UsageBillingController } from './api/workspace.controllers.js';
import { HmacSessionService } from './api/auth/session.service.js';
import { ApiExceptionFilter } from './api/http-exception.filter.js';
import { createLogger, LOGGER, type Logger } from './common/logger.js';
import { DatabaseModule } from './database/database.module.js';
import { APP_TX, TransactionRunner } from './database/transaction-runner.js';
import { AiRepository } from './repositories/ai.repository.js';
import { BookingRepository } from './repositories/booking.repository.js';
import { IdentityRepository } from './repositories/identity.repository.js';
import { KnowledgeRepository } from './repositories/knowledge.repository.js';
import { OpsRepository } from './repositories/ops.repository.js';
import { WebhookRepository } from './repositories/webhook.repository.js';
import { WhatsAppRepository } from './repositories/whatsapp.repository.js';
import { KEY_PROVIDER, type KeyProvider } from './security/crypto/key-provider.js';
import { ApiKeyService } from './services/api-key.service.js';
import { OnboardingService } from './services/onboarding.service.js';
import { WebhookService } from './services/webhook.service.js';
import { SESSION_VERIFIER, TenantContextMiddleware } from './tenancy/tenant-context.middleware.js';
import { WhatsAppApiModule } from './whatsapp/whatsapp.module.js';
import { InstanceApiKeyController, InstanceWhatsAppApiController, OtpApiController } from './api/instance-api.controllers.js';
import { OtpService } from './otp/otp.service.js';
import { BillingController } from './api/billing.controller.js';
import { BillingService } from './api/billing.service.js';

/** API process wiring (hs_app credentials only). */
@Module({
  imports: [DatabaseModule.forApi(), WhatsAppApiModule.register()],
  controllers: [AuthController, AccountController, BusinessesController, ApiKeysController, WebhooksController, InternalHealthController,
    DashboardController, ConversationsController, ContactsController, OrganizationController, TeamController, UsageBillingController,
    RealtimeController, MediaController, AiTemplatesController, AiAssistantsController,
    BusinessSetupController, BookingsController, RestaurantSetupController, OrdersController, HavanSetupController, GoogleOAuthController, CampaignsController,
    InstanceApiKeyController, InstanceWhatsAppApiController, OtpApiController, BillingController, WebhookLogsController],
  providers: [
    IdentityRepository, WhatsAppRepository, OpsRepository, WebhookRepository, AiRepository, BookingRepository, KnowledgeRepository,
    OnboardingService,
    OtpService,
    BillingService,
    HmacSessionService,
    { provide: SESSION_VERIFIER, useExisting: HmacSessionService },
    { provide: LOGGER, useFactory: () => createLogger({ bindings: { process: 'api' } }) },
    { provide: APP_FILTER, inject: [LOGGER], useFactory: (logger: Logger) => new ApiExceptionFilter(logger) },
    { provide: 'AI_PROVIDERS', useFactory: () => aiProvidersFromEnv() },
    { provide: AI_MODEL_PROVIDER, inject: ['AI_PROVIDERS'], useFactory: (p: ReturnType<typeof aiProvidersFromEnv>) => p.models },
    { provide: EMBEDDING_PROVIDER, inject: ['AI_PROVIDERS'], useFactory: (p: ReturnType<typeof aiProvidersFromEnv>) => p.embedder },
    { provide: ToolRegistry, useFactory: () => new ToolRegistry() },
    { provide: CatalogService, inject: [APP_TX], useFactory: (tx: TransactionRunner) => new CatalogService(tx) },
    { provide: OrderingAdminService, inject: [APP_TX], useFactory: (tx: TransactionRunner) => new OrderingAdminService(tx) },
    { provide: GoogleCalendarService, inject: [KEY_PROVIDER], useFactory: (k: KeyProvider) => new GoogleCalendarService(googleCalendarConfigFromEnv(), k) },
    { provide: HavanAdminService, inject: [APP_TX, GoogleCalendarService], useFactory: (tx: TransactionRunner, c: GoogleCalendarService) => new HavanAdminService(tx, c) },
    { provide: CampaignAdminService, inject: [APP_TX, AI_MODEL_PROVIDER], useFactory: (tx: TransactionRunner, m: ModelProviderRegistry) => new CampaignAdminService(tx, m) },
    { provide: GoogleSignInService, useFactory: () => new GoogleSignInService() },
    { provide: TranslationService, inject: [AI_MODEL_PROVIDER], useFactory: (m: ModelProviderRegistry) => new TranslationService(m) },
    { provide: AssistantAdminService, inject: [APP_TX, AI_MODEL_PROVIDER],
      useFactory: (tx: TransactionRunner, models: ModelProviderRegistry) => new AssistantAdminService(tx, models) },
    { provide: SandboxService, inject: [APP_TX, AI_MODEL_PROVIDER, ToolRegistry, BookingRepository, KnowledgeRepository, OpsRepository, EMBEDDING_PROVIDER, LOGGER, GoogleCalendarService],
      useFactory: (tx: TransactionRunner, models: ModelProviderRegistry, registry: ToolRegistry, b: BookingRepository, k: KnowledgeRepository, o: OpsRepository, e: EmbeddingProvider, logger: Logger, cal: GoogleCalendarService) =>
        new SandboxService(tx, models, registry, { tx, bookings: new BookingService(tx, b, o), leads: new LeadService(tx, o), knowledge: k, ops: o, embedder: e, ordering: new OrderingService(), calendar: cal }, logger) },
    { provide: WebhookService, inject: [APP_TX, WebhookRepository, OpsRepository, KEY_PROVIDER],
      useFactory: (tx: TransactionRunner, w: WebhookRepository, o: OpsRepository, k: KeyProvider) => new WebhookService(tx, w, o, k) },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantContextMiddleware)
      .exclude({ path: 'v1/auth/{*path}', method: RequestMethod.ALL }, { path: 'internal/{*path}', method: RequestMethod.ALL },
               { path: 'v1/account/{*path}', method: RequestMethod.ALL }, { path: 'v1/media/download/{*path}', method: RequestMethod.ALL },
               { path: 'docs', method: RequestMethod.ALL }, { path: 'docs/{*path}', method: RequestMethod.ALL },
               { path: 'v1/oauth/google/callback', method: RequestMethod.GET })
      .forRoutes({ path: '{*path}', method: RequestMethod.ALL });
  }
}
