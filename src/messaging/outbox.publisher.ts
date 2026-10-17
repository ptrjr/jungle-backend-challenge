import { BeforeApplicationShutdown, Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { OutboxEntity } from '../database/delivery-entities';
import { OutboxMessage } from '../domain/outbox-message';
import { SqsService } from './sqs.service';
import { errorCode } from './failure';
import { messagingMetrics } from './metrics';

@Injectable()
export class OutboxPublisher implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(OutboxPublisher.name);
  private timer?: ReturnType<typeof setInterval>;
  private inFlight?: Promise<void>;
  private stopping = false;

  constructor(@Inject(DataSource) private readonly source: DataSource, @Inject(SqsService) private readonly sqs: SqsService) {}

  onApplicationBootstrap(): void {
    if (process.env.MESSAGING_ENABLED !== 'true') return;
    this.timer = setInterval(() => {
      if (this.inFlight) return;
      this.inFlight = this.runBatch().catch(error => {
        this.logger.error({ code: 'OUTBOX_WORKER_RETRY', errorCode: errorCode(error) });
      }).finally(() => { this.inFlight = undefined; });
    }, 1000);
    this.timer.unref();
  }
  async publishOne(now = new Date()): Promise<boolean> {
    let published = false;
    const found = await this.source.transaction('READ COMMITTED', async manager => {
      const row = await manager.createQueryBuilder(OutboxEntity, 'message')
        .where('message.publishedAt IS NULL AND (message.nextAttemptAt IS NULL OR message.nextAttemptAt <= :now)', { now })
        .orderBy('COALESCE(message.nextAttemptAt, message.occurredAt)', 'ASC').addOrderBy('message.id', 'ASC')
        .setLock('pessimistic_write').setOnLocked('skip_locked').take(1).getOne();
      if (!row) return false;
      const message = OutboxMessage.rehydrate({ ...row, nextAttemptAt: row.nextAttemptAt ?? undefined,
        publishedAt: row.publishedAt ?? undefined, lastErrorCode: row.lastErrorCode ?? undefined });
      try {
        await this.sqs.publish(message.payload);
        message.markPublished(new Date());
        published = true;
      } catch (error) {
        message.scheduleRetry(now, errorCode(error));
        this.logger.warn({ code: 'OUTBOX_PUBLISH_RETRY', correlationId: row.payload.correlationId,
          messageId: row.id, transactionId: row.transactionId, walletId: row.aggregateId,
          providerId: row.payload.data.providerId ?? null, errorCode: errorCode(error) });
      }
      await manager.update(OutboxEntity, { id: message.id }, { attempts: message.attempts,
        publishedAt: message.publishedAt ?? null, nextAttemptAt: message.nextAttemptAt ?? null, lastErrorCode: message.lastErrorCode ?? null });
      return true;
    });
    if (found) {
      if (published) messagingMetrics.published++;
      else messagingMetrics.retries++;
    }
    return found;
  }
  async runBatch(now = new Date()): Promise<void> {
    for (let processed = 0; !this.stopping && processed < 25; processed++) if (!await this.publishOne(now)) break;
  }
  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.inFlight;
  }
}
