import { ConflictException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { FinancialService, wagerPayload } from '../application/financial-service';
import { payloadHash } from '../application/payload-hash';
import { InboxEntity } from '../database/delivery-entities';
import { InboxMessage } from '../domain/inbox-message';
import { RequestedWagerMessage } from './request-message';

export const WAGER_CONSUMER_NAME = 'wager-transactions-v1';

@Injectable()
export class InboxProcessor {
  constructor(@Inject(DataSource) private readonly source: DataSource, @Inject(FinancialService) private readonly financial: FinancialService) {}

  async process(message: RequestedWagerMessage): Promise<{ transactionId: string; idempotentReplay: boolean }> {
    const { idempotencyKey, ...input } = message.data;
    const hash = payloadHash({ ...wagerPayload(input), idempotencyKey });
    const inbox = InboxMessage.receive({ consumerName: WAGER_CONSUMER_NAME, messageId: message.messageId, payloadHash: hash });
    return this.source.transaction('READ COMMITTED', async manager => {
      const inserted = await manager.createQueryBuilder().insert().into(InboxEntity).values({
        consumerName: inbox.consumerName, messageId: inbox.messageId, payloadHash: inbox.payloadHash,
        receivedAt: inbox.receivedAt, processedAt: null, transactionId: null,
      }).onConflict('DO NOTHING').returning('message_id').execute();
      if (inserted.raw.length === 0) {
        const existing = await manager.findOneByOrFail(InboxEntity, { consumerName: inbox.consumerName, messageId: inbox.messageId });
        if (existing.payloadHash !== hash) throw new ConflictException({ code: 'INBOX_PAYLOAD_CONFLICT' });
        if (!existing.processedAt || !existing.transactionId) throw new ServiceUnavailableException({ code: 'INBOX_IN_PROGRESS' });
        return { transactionId: existing.transactionId, idempotentReplay: true };
      }
      const result = await this.financial.process(input, idempotencyKey, {
        correlationId: message.correlationId ?? message.messageId, causationId: message.messageId, messageId: message.messageId,
      }, manager);
      inbox.markProcessed(result.transactionId, new Date());
      await manager.update(InboxEntity, { consumerName: inbox.consumerName, messageId: inbox.messageId }, {
        processedAt: inbox.processedAt!, transactionId: inbox.transactionId!,
      });
      return { transactionId: result.transactionId, idempotentReplay: result.idempotentReplay };
    });
  }
}
