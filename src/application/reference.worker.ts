import { BeforeApplicationShutdown, Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { FinancialService } from './financial-service';

@Injectable()
export class ReferenceWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(ReferenceWorker.name);
  private timer?: ReturnType<typeof setInterval>;
  private inFlight?: Promise<void>;
  private stopping = false;

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
    for (let processed = 0; !this.stopping && processed < 25; processed++) {
      if (!await this.service.reprocessPendingReference(now)) break;
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.inFlight;
  }
}
