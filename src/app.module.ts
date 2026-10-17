import { Module, OnApplicationShutdown, Inject } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { FinancialService } from './application/financial-service';
import { createDataSource } from './database/data-source';
import { FinancialController } from './http/financial.controller';
import { ProviderAuthGuard } from './http/provider-auth.guard';

@Module({
  controllers: [FinancialController],
  providers: [
    { provide: DataSource, useFactory: () => createDataSource().initialize() },
    FinancialService, ProviderAuthGuard,
  ],
})
export class AppModule implements OnApplicationShutdown {
  constructor(@Inject(DataSource) private readonly source: DataSource) {}
  async onApplicationShutdown(): Promise<void> { if (this.source.isInitialized) await this.source.destroy(); }
}
