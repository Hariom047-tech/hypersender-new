import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import type { Logger } from 'pino';
import { isPgError, PgCode } from '../database/errors.js';
import { InvalidPhoneNumberError } from '../whatsapp/domain/phone.js';
import { WhatsAppError } from '../whatsapp/domain/whatsapp-errors.js';

interface Res { status(code: number): Res; json(body: unknown): void; headersSent?: boolean }

/**
 * Stable public error model: { error: { code, message } }.
 * Provider/database internals and stack traces never reach clients; unexpected
 * errors are logged (without secrets) and returned as INTERNAL_ERROR.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Res>();
    const req = host.switchToHttp().getRequest<{ headers: Record<string, unknown>; tenant?: { requestId?: string } }>();
    if (res.headersSent) return;
    const send = (status: number, code: string, message: string) => res.status(status).json({ error: { code, message } });

    if (exception instanceof WhatsAppError) return void send(exception.httpStatus, exception.code, ['VALIDATION_FAILED', 'FORBIDDEN', 'UNAUTHENTICATED', 'PLAN_LIMIT_REACHED', 'FEATURE_NOT_IN_PLAN', 'CONFLICT', 'NOT_FOUND'].includes(exception.code) ? exception.message : exception.code);
    if (exception instanceof InvalidPhoneNumberError) return void send(422, 'WHATSAPP_INVALID_RECIPIENT', 'recipient is not a valid phone number');
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return void send(status, status === 404 ? 'NOT_FOUND' : 'HTTP_ERROR', status === 404 ? 'not found' : 'request failed');
    }
    if (isPgError(exception, PgCode.FOREIGN_KEY_VIOLATION) || isPgError(exception, PgCode.CHECK_VIOLATION)) {
      return void send(422, 'VALIDATION_FAILED', 'request references unknown or invalid data');
    }
    this.logger.error({ event_name: 'http.unhandled_error', request_id: req?.tenant?.requestId,
                        err: { name: (exception as Error)?.name, message: String((exception as Error)?.message ?? '').slice(0, 300) } });
    send(500, 'INTERNAL_ERROR', 'internal error');
  }
}
