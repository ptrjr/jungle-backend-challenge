import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { QueryFailedError } from 'typeorm';
import { DomainError, InvalidTransactionStateError } from '../domain/domain-error';

@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(ErrorFilter.name);
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (error instanceof HttpException) { response.status(error.getStatus()).json(error.getResponse()); return; }
    if (error instanceof DomainError && !(error instanceof InvalidTransactionStateError)) {
      response.status(400).json({ code: error.code, message: error.message }); return;
    }
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
    const databaseCode = error instanceof QueryFailedError ? (error.driverError as { code?: string }).code : code;
    const connectionTimeout = error instanceof Error && [
      'Connection terminated unexpectedly', 'Connection terminated due to connection timeout', 'timeout exceeded when trying to connect',
    ].includes(error.message);
    if (connectionTimeout || (databaseCode && (/^(08|53|57|58)/.test(databaseCode) || ['40001', '40P01', '55P03', '57014', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(databaseCode)))) {
      response.status(503).json({ code: 'INFRASTRUCTURE_UNAVAILABLE' });
      return;
    }
    this.logger.error({ code: 'INTERNAL_ERROR', errorType: error instanceof Error ? error.name : 'Unknown' });
    response.status(500).json({ code: 'INTERNAL_ERROR' });
  }
}
