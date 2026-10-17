import { BeforeApplicationShutdown, Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { FinancialService } from './financial-service';

@Injectable()
export class ReferenceWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(ReferenceWorker.name);
  private timer?: ReturnType<typeof setInterval>;
  private inFlight?: Promise<void>;

  constructor(@Inject(FinancialService) private readonly service: FinancialService) {}

  onApplicationBootstrap(): void {
    if (process.env.REFERENCE_WORKER_ENABLED === 'false') return;
    this.timer = setInterval(() => {
      if (this.inFlight) return;
      this.inFlight = this.runBatch().catch(error => {
        this.logger.error({ code: 'REFERENCE_WORKER_ERROR', errorType: error instanceof Error ? error.name : 'Unknown' });
      }).finally(() => { this.inFlight = undefined; });
    }, 1000);
    this.timer.unref();
  }

  async runBatch(now = new Date()): Promise<void> {
    for (let processed = 0; processed < 25; processed++) {
      if (!await this.service.reprocessPendingReference(now)) break;
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.inFlight;
  }
}
