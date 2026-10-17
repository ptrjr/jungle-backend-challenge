import { Controller, Get, Header, HttpCode, Inject, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ReconciliationService } from '../application/reconciliation.service';
import { ProviderAuthGuard } from './provider-auth.guard';
import { DataSource } from 'typeorm';
import { messagingMetrics } from '../messaging/metrics';
import { SqsService } from '../messaging/sqs.service';

@Controller()
@UseGuards(ProviderAuthGuard)
export class ReconciliationController {
  constructor(@Inject(ReconciliationService) private readonly service: ReconciliationService,
    @Inject(DataSource) private readonly source: DataSource, @Inject(SqsService) private readonly sqs: SqsService) {}

  @Post('wallets/:walletId/reconciliation')
  @HttpCode(200)
  reconcile(@Param('walletId', ParseUUIDPipe) walletId: string) { return this.service.reconcile(walletId); }

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async metrics(): Promise<string> {
    let deadLetterDepth: number | undefined;
    try { deadLetterDepth = await this.sqs.deadLetterDepth(); } catch { /* Database metrics remain available during an SQS outage. */ }
    return this.service.metrics() + await messagingMetrics.render(this.source, deadLetterDepth);
  }
}
