import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from '../app.module.js';
import { buildOpenApiDocument } from './openapi.js';

/** Builds the API application (used by main.ts, tests and the OpenAPI export script). */
export async function createApiApp(opts: { swagger?: boolean } = {}): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['error', 'warn'], bodyParser: false });
  // Media sends carry base64 payloads (WHATSAPP_MEDIA_MAX_BYTES * 4/3); everything else is small.
  app.useBodyParser('json', { limit: process.env.HTTP_JSON_LIMIT ?? '25mb' });
  app.disable('x-powered-by');
  app.enableShutdownHooks();
  if (opts.swagger !== false) SwaggerModule.setup('docs', app, buildOpenApiDocument(app));
  return app;
}
