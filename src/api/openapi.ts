import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { WEBHOOK_EVENT_SCHEMA } from '../whatsapp/dto/openapi-schemas.js';

export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('HyperSender WhatsApp Gateway API')
    .setVersion('2.0.0')
    .setDescription([
      'Multi-tenant WhatsApp gateway (Baileys).',
      '',
      '**Authentication** - either a dashboard session (`Authorization: Bearer hs1...` + `X-Organization-Id`) or an API key (`X-Api-Key: hs_live_...`, organization implied by the key).',
      'API keys carry scopes: `instances:read`, `instances:write`, `messages:send`, `messages:read`, `webhooks:manage`.',
      '',
      '**Instance API** - every WhatsApp instance has its own API key (instance page → API). Call `/api/whatsapp/v1/{instance}/...` and `/api/otp/v1/{instance}/...` with `Authorization: Bearer hs_live_...`. An instance key works only for its own instance and only on these routes.',
      '',
      '**Tenant isolation** - resources of other organizations always answer 404.',
      '',
      '**QR flow** - `POST /instances/{id}/connect` (202) then `GET /instances/{id}/events` (Server-Sent Events: `whatsapp.instance.qr`, `whatsapp.instance.status`). QR codes are never stored.',
      '',
      '**Webhooks** - POSTed as JSON (`WebhookEvent` schema), signed: `X-Webhook-Signature: v1=hex(HMAC_SHA256(secret, "{X-Webhook-Id}.{X-Webhook-Timestamp}.{body}"))`.',
    ].join('\n'))
    .addBearerAuth({ type: 'http', scheme: 'bearer', description: 'Dashboard session token; also send X-Organization-Id' }, 'session')
    .addApiKey({ type: 'apiKey', in: 'header', name: 'X-Api-Key' }, 'api-key')
    .addBearerAuth({ type: 'http', scheme: 'bearer', description: 'Instance API key (hs_live_...) or organization API key' }, 'instance-key')
    .build();
  const doc = SwaggerModule.createDocument(app, config);
  doc.components = doc.components ?? {};
  doc.components.schemas = { ...(doc.components.schemas ?? {}), WebhookEvent: WEBHOOK_EVENT_SCHEMA as never };
  return doc;
}
