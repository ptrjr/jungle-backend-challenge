import { randomUUID } from 'node:crypto';
import { MoneyProps } from './money';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus, FailureCode } from './wager-transaction';
import { Wallet } from './wallet';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface EventContext {
  correlationId: string;
  causationId?: string;
  messageId?: string;
}
export interface IntegrationEventProps<T> extends EventContext {
  eventId: string;
  aggregateId: string;
  occurredAt: Date;
  data: T;
}
export interface EventEnvelope<T = Record<string, unknown>> {
  eventId: string; eventType: string; version: number; aggregateId: string;
  correlationId: string; causationId?: string; occurredAt: string; data: T;
}
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;
  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = new Date(props.occurredAt);
    this.data = Object.freeze(structuredClone(props.data));
  }
  toJSON(): EventEnvelope<T> {
    return { eventId: this.eventId, eventType: this.eventType, version: this.version, aggregateId: this.aggregateId,
      correlationId: this.correlationId, ...(this.causationId ? { causationId: this.causationId } : {}),
      occurredAt: this.occurredAt.toISOString(), data: structuredClone(this.data) };
  }
}

interface TransactionEventData {
  transactionId: string; walletId: string; providerId: string; kind: WagerTransactionKind;
  status: WagerTransactionStatus; money: MoneyProps; balance: MoneyProps; failureCode?: FailureCode;
}
function transactionProps(transaction: WagerTransaction, context: EventContext): IntegrationEventProps<TransactionEventData> {
  if (!transaction.resultBalance) throw new Error('Event requires an accepted transaction result');
  return { ...context, causationId: context.causationId ?? transaction.id, eventId: randomUUID(), aggregateId: transaction.walletId,
    occurredAt: transaction.processedAt ?? new Date(), data: {
      transactionId: transaction.id, walletId: transaction.walletId, providerId: transaction.providerId,
      kind: transaction.kind, status: transaction.status, money: transaction.money.toJSON(), balance: transaction.resultBalance.toJSON(),
      ...(transaction.failureCode ? { failureCode: transaction.failureCode } : {}),
    } };
}
export class WagerTransactionProcessed extends IntegrationEvent<TransactionEventData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;
  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed(transactionProps(transaction, context));
  }
}
export class WagerTransactionRejected extends IntegrationEvent<TransactionEventData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;
  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected(transactionProps(transaction, context));
  }
}
export class WagerTransactionPendingReference extends IntegrationEvent<TransactionEventData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;
  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(transactionProps(transaction, context));
  }
}
interface WalletBalanceChangedData {
  transactionId: string; walletId: string; direction: LedgerDirection; money: MoneyProps;
  balanceBefore: MoneyProps; balanceAfter: MoneyProps; walletVersion: number;
}
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;
  static from(wallet: Wallet, entry: WalletLedgerEntry, context: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({ ...context, causationId: context.causationId ?? entry.transactionId,
      eventId: randomUUID(), aggregateId: wallet.id, occurredAt: entry.createdAt, data: {
        transactionId: entry.transactionId, walletId: wallet.id, direction: entry.direction, money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(), balanceAfter: entry.balanceAfter.toJSON(), walletVersion: wallet.version,
      } });
  }
}
