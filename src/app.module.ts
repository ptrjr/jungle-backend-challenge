import { Module, OnApplicationShutdown, Inject } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { FinancialService } from './application/financial-service';
import { createDataSource } from './database/data-source';
import { FinancialController } from './http/financial.controller';
import { ProviderAuthGuard } from './http/provider-auth.guard';
import { ReferenceWorker } from './application/reference.worker';
import { ReconciliationService } from './application/reconciliation.service';
import { ReconciliationController } from './http/reconciliation.controller';
import { SqsService } from './messaging/sqs.service';
import { InboxProcessor } from './messaging/inbox.processor';
import { SqsConsumer } from './messaging/sqs.consumer';
import { OutboxPublisher } from './messaging/outbox.publisher';
import { HealthController } from './http/health.controller';

@Module({
  controllers: [FinancialController, ReconciliationController, HealthController],
  providers: [
    { provide: DataSource, useFactory: () => createDataSource().initialize() },
    FinancialService, ProviderAuthGuard, ReferenceWorker, ReconciliationService,
    { provide: SqsService, useFactory: () => new SqsService() }, InboxProcessor, SqsConsumer, OutboxPublisher,
  ],
})
export class AppModule implements OnApplicationShutdown {
  constructor(@Inject(DataSource) private readonly source: DataSource) {}
  async onApplicationShutdown(): Promise<void> { if (this.source.isInitialized) await this.source.destroy(); }
}
