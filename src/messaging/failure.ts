import { HttpException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { DomainError } from '../domain/domain-error';

export function errorCode(error: unknown): string {
  if (error instanceof QueryFailedError) return String((error.driverError as { code?: string }).code ?? 'DATABASE_ERROR');
  if (error instanceof DomainError) return error.code;
  if (error instanceof HttpException) {
    const body = error.getResponse();
    if (typeof body === 'object' && body && 'code' in body && typeof body.code === 'string') return body.code;
  }
  if (error instanceof Error) return /^[\w-]{1,64}$/.test(error.name) ? error.name : 'UNKNOWN_ERROR';
  return 'UNKNOWN_ERROR';
}
export function permanentMessageFailure(error: unknown): boolean {
  if (error instanceof DomainError) return true;
  if (error instanceof HttpException) return [400, 404, 409, 422].includes(error.getStatus());
  if (error instanceof QueryFailedError) return /^(22|23)/.test(errorCode(error));
  return false;
}
