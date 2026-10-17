import { Controller, Get, Header, HttpCode, Inject, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ReconciliationService } from '../application/reconciliation.service';
import { ProviderAuthGuard } from './provider-auth.guard';

@Controller()
@UseGuards(ProviderAuthGuard)
export class ReconciliationController {
  constructor(@Inject(ReconciliationService) private readonly service: ReconciliationService) {}

  @Post('wallets/:walletId/reconciliation')
  @HttpCode(200)
  reconcile(@Param('walletId', ParseUUIDPipe) walletId: string) { return this.service.reconcile(walletId); }

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  metrics(): string { return this.service.metrics(); }
}
