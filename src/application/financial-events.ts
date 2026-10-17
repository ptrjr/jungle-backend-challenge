import { EntityManager } from 'typeorm';
import { OutboxEntity } from '../database/delivery-entities';
import { EventContext, IntegrationEvent, WagerTransactionPendingReference, WagerTransactionProcessed, WagerTransactionRejected, WalletBalanceChanged } from '../domain/integration-event';
import { OutboxMessage } from '../domain/outbox-message';
import { WagerTransaction, WagerTransactionStatus } from '../domain/wager-transaction';
import { Wallet } from '../domain/wallet';
import { WalletLedgerEntry } from '../domain/wallet-ledger-entry';

export async function enqueueFinancialEvents(manager: EntityManager, wallet: Wallet, transaction: WagerTransaction,
  entry: WalletLedgerEntry | undefined, context: EventContext, previousStatus: WagerTransactionStatus): Promise<void> {
  const events: IntegrationEvent<{ transactionId: string }>[] = [];
  if (transaction.status === WagerTransactionStatus.Processed) events.push(WagerTransactionProcessed.from(transaction, context));
  if (transaction.status === WagerTransactionStatus.Rejected) events.push(WagerTransactionRejected.from(transaction, context));
  if (transaction.status === WagerTransactionStatus.PendingReference && previousStatus !== WagerTransactionStatus.PendingReference) {
    events.push(WagerTransactionPendingReference.from(transaction, context));
  }
  if (entry) events.push(WalletBalanceChanged.from(wallet, entry, context));
  for (const event of events) {
    const message = OutboxMessage.enqueue(event);
    await manager.save(OutboxEntity, {
      id: message.id, aggregateId: message.aggregateId, transactionId: message.transactionId,
      eventType: message.eventType, payload: message.payload, occurredAt: message.occurredAt,
      attempts: 0, nextAttemptAt: null, publishedAt: null, lastErrorCode: null,
    });
  }
}

export async function pendingReferenceContext(manager: EntityManager, transactionId: string): Promise<EventContext> {
  const message = await manager.findOneBy(OutboxEntity, { transactionId, eventType: 'WagerTransactionPendingReference' });
  return message ? { correlationId: message.payload.correlationId, causationId: message.payload.causationId } : { correlationId: transactionId };
}
