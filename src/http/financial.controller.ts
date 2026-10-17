import { BadRequestException, Body, Controller, Get, Headers, Inject, Param, ParseUUIDPipe, Post, Query, Res, UseGuards, ValidationPipe } from '@nestjs/common';
import type { Response } from 'express';
import { FinancialService } from '../application/financial-service';
import { WagerTransactionStatus } from '../domain/wager-transaction';
import { CreateWagerDto, CreateWalletDto } from './dto';
import { ProviderAuthGuard } from './provider-auth.guard';
import { randomUUID } from 'node:crypto';

@Controller()
@UseGuards(ProviderAuthGuard)
export class FinancialController {
  constructor(@Inject(FinancialService) private readonly service: FinancialService) {}

  @Post('wallets')
  open(@Body(new ValidationPipe({ ...bodyValidationOptions(), expectedType: CreateWalletDto })) body: CreateWalletDto,
    @Headers('x-correlation-id') correlationId?: string) {
    return this.service.openWallet(body.playerId, body.initialBalance, requestContext(correlationId));
  }
  @Get('wallets/:walletId')
  wallet(@Param('walletId', ParseUUIDPipe) id: string) { return this.service.getWallet(id); }

  @Get('wallets/:walletId/ledger')
  ledger(@Param('walletId', ParseUUIDPipe) id: string, @Query('limit') limitString?: string, @Query('cursor') cursor?: string) {
    const limit = limitString === undefined ? 50 : Number(limitString);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (limitString !== undefined && !/^\d+$/.test(limitString))) {
      throw new BadRequestException({ code: 'INVALID_LIMIT' });
    }
    let after: string | undefined;
    if (cursor !== undefined) {
      try {
        if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
        const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (!decoded || typeof decoded !== 'object' || !('walletId' in decoded) || decoded.walletId !== id || !('after' in decoded)
          || typeof decoded.after !== 'string' || !/^[1-9]\d{0,18}$/.test(decoded.after) || BigInt(decoded.after) > 9223372036854775807n) throw new Error();
        after = decoded.after;
      } catch { throw new BadRequestException({ code: 'INVALID_CURSOR' }); }
    }
    return this.service.getLedger(id, limit, after);
  }

  @Post('wagering/transactions')
  async wager(
    @Body(new ValidationPipe({ ...bodyValidationOptions(), expectedType: CreateWagerDto })) body: CreateWagerDto,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) response: Response,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    if (!key || key.length > 256 || key.trim() !== key || !/\S/.test(key)) {
      throw new BadRequestException({ code: 'INVALID_IDEMPOTENCY_KEY' });
    }
    const result = await this.service.process(body, key, requestContext(correlationId));
    response.status(result.status === WagerTransactionStatus.PendingReference ? 202 : result.status === WagerTransactionStatus.Rejected ? 422 : 200);
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  transaction(@Param('transactionId', ParseUUIDPipe) id: string) { return this.service.getTransaction(id); }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  providerTransaction(@Param('providerId') provider: string, @Param('externalTransactionId') external: string) {
    return this.service.getProviderTransaction(provider, external);
  }
}

function bodyValidationOptions() {
  return { transform: true, whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true };
}

function requestContext(correlationId?: string) {
  if (correlationId !== undefined && (!correlationId.trim() || correlationId.trim() !== correlationId || correlationId.length > 128)) {
    throw new BadRequestException({ code: 'INVALID_CORRELATION_ID' });
  }
  return { correlationId: correlationId ?? randomUUID() };
}
