import { BeforeApplicationShutdown, Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { Message } from '@aws-sdk/client-sqs';
import { InboxProcessor } from './inbox.processor';
import { SqsService } from './sqs.service';
import { errorCode, permanentMessageFailure } from './failure';
import { parseRequestedMessage, RequestedWagerMessage } from './request-message';
import { messagingMetrics } from './metrics';

@Injectable()
export class SqsConsumer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(SqsConsumer.name);
  private stopping = false;
  private loop?: Promise<void>;
  private pollAbort?: AbortController;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private finishWait?: () => void;

  constructor(@Inject(SqsService) private readonly sqs: SqsService, @Inject(InboxProcessor) private readonly inbox: InboxProcessor) {}

  onApplicationBootstrap(): void {
    if (process.env.MESSAGING_ENABLED !== 'true') return;
    this.loop = this.poll();
  }
  private async poll(): Promise<void> {
    let failures = 0;
    while (!this.stopping) {
      try {
        this.pollAbort = new AbortController();
        const message = await this.sqs.receive(2, this.pollAbort.signal);
        failures = 0;
        if (message) await this.processReceived(message);
      } catch (error) {
        if (this.stopping) break;
        messagingMetrics.retries++;
        this.logger.warn({ code: 'SQS_POLL_RETRY', errorCode: errorCode(error) });
        await new Promise<void>(resolve => {
          this.finishWait = resolve;
          this.retryTimer = setTimeout(resolve, Math.min(1000 * 2 ** Math.min(failures++, 5), 30000));
        });
      }
    }
  }
  async runOnce(waitSeconds = 0): Promise<boolean> {
    const message = await this.sqs.receive(waitSeconds);
    if (!message) return false;
    await this.processReceived(message);
    return true;
  }
  async processReceived(message: Message): Promise<void> {
    const started = performance.now();
    let request: RequestedWagerMessage | undefined;
    let transactionId: string | undefined;
    let heartbeatInFlight: Promise<void> | undefined;
    const heartbeat = setInterval(() => {
      if (heartbeatInFlight) return;
      heartbeatInFlight = this.sqs.visibility(message, this.sqs.config.visibilitySeconds)
        .catch(error => { this.logger.warn({ code: 'SQS_HEARTBEAT_RETRY', messageId: message.MessageId, errorCode: errorCode(error) }); })
        .finally(() => { heartbeatInFlight = undefined; });
    }, Math.max(1000, Math.min(10000, this.sqs.config.visibilitySeconds * 1000 / 3)));
    try {
      request = parseRequestedMessage(message.Body);
      const result = await this.inbox.process(request);
      transactionId = result.transactionId;
      if (result.idempotentReplay) messagingMetrics.duplicates++;
      this.logger.log({ code: 'SQS_MESSAGE_COMMITTED', ...this.identifiers(request, message, transactionId), replay: result.idempotentReplay });
      await this.sqs.acknowledge(message);
    } catch (error) {
      const identifiers = this.identifiers(request, message, transactionId);
      if (['55P03', '40P01'].includes(errorCode(error))) messagingMetrics.lockConflicts++;
      if (permanentMessageFailure(error)) {
        try {
          await this.sqs.deadLetter(message, errorCode(error));
          await this.sqs.acknowledge(message);
          messagingMetrics.deadLetters++;
          this.logger.warn({ code: 'SQS_MESSAGE_DLQ', ...identifiers, errorCode: errorCode(error) });
          return;
        } catch (deliveryError) {
          this.logger.warn({ code: 'SQS_DLQ_RETRY', ...identifiers, errorCode: errorCode(deliveryError) });
        }
      }
      messagingMetrics.retries++;
      const attempts = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
      const delay = this.stopping ? 0 : Math.min(2 ** Math.min(attempts - 1, 6), 60);
      try { await this.sqs.visibility(message, delay); }
      catch (visibilityError) { this.logger.warn({ code: 'SQS_VISIBILITY_RETRY', ...identifiers, errorCode: errorCode(visibilityError) }); }
      this.logger.warn({ code: 'SQS_MESSAGE_RETRY', ...identifiers, errorCode: errorCode(error), attempts });
    } finally {
      clearInterval(heartbeat);
      await heartbeatInFlight;
      messagingMetrics.observe((performance.now() - started) / 1000);
    }
  }
  private identifiers(request: RequestedWagerMessage | undefined, message: Message, transactionId?: string) {
    return { correlationId: request?.correlationId ?? request?.messageId ?? message.MessageId ?? null,
      messageId: request?.messageId ?? message.MessageId ?? null, transactionId: transactionId ?? null,
      walletId: request?.data.walletId ?? null, providerId: request?.data.providerId ?? null };
  }
  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    this.pollAbort?.abort();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.finishWait?.();
    await this.loop;
  }
}
