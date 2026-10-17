import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../../src/domain/wallet-ledger-entry';
import { InvalidTransactionStateError } from '../../src/domain/domain-error';
import { WagerTransaction, WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../src/domain/wager-transaction';
import { payloadHash } from '../../src/application/payload-hash';

const money = (amount: string, currency = 'BRL') => Money.from({ amount, currency });
const open = () => Wallet.open({ id: randomUUID(), playerId: randomUUID(), initialBalance: money('100.00') });
const wager = (kind = Kind.Bet, amount = '10.00') => WagerTransaction.create({
  id: randomUUID(), providerId: 'provider-a', externalTransactionId: 'external', idempotencyKey: 'key',
  payloadHash: 'a'.repeat(64), walletId: randomUUID(), playerId: randomUUID(), roundId: 'round', gameId: 'game', kind, money: money(amount),
});

describe('Wallet and ledger', () => {
  test('opening has version 1; each movement creates a balanced entry and increments version', () => {
    const wallet = open();
    expect(wallet.version).toBe(1);
    const debit = wallet.debit(money('80.00'), randomUUID());
    expect(wallet.balance.toString()).toBe('20.00');
    expect(debit.direction).toBe(LedgerDirection.Debit);
    expect(debit.isBalanced()).toBe(true);
    const credit = wallet.credit(money('10.00'), randomUUID());
    expect(wallet.balance.toString()).toBe('30.00');
    expect(credit.isBalanced()).toBe(true);
    expect(wallet.version).toBe(3);
    expect(Object.isFrozen(credit)).toBe(true);
  });
  test('failed operations leave wallet balance and version unchanged', () => {
    const wallet = open();
    expect(() => wallet.debit(money('100.01'), randomUUID())).toThrow('Insufficient');
    expect(() => wallet.debit(money('-1.00'), randomUUID())).toThrow();
    expect(() => wallet.credit(money('0.00'), randomUUID())).toThrow();
    expect(() => wallet.credit(money('1.00', 'USD'), randomUUID())).toThrow();
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(() => Wallet.open({ id: randomUUID(), playerId: randomUUID(), initialBalance: money('-0.01') })).toThrow();
  });
  test('ledger rejects inconsistent arithmetic and does not expose mutable dates', () => {
    const wallet = open();
    const entry = wallet.debit(money('5.00'), randomUUID());
    expect(() => WalletLedgerEntry.create({
      id: entry.id, walletId: wallet.id, transactionId: entry.transactionId, direction: LedgerDirection.Debit,
      money: money('5.00'), balanceBefore: money('100.00'), balanceAfter: money('96.00'), createdAt: new Date(),
    })).toThrow();
    const timestamp = entry.createdAt.getTime();
    entry.createdAt.setFullYear(2000);
    expect(entry.createdAt.getTime()).toBe(timestamp);
  });
});

describe('WagerTransaction', () => {
  test('factories and terminal transitions encapsulate state', () => {
    const transaction = wager();
    expect(transaction.status).toBe(Status.Pending);
    expect(transaction.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    transaction.markProcessed(money('90.00'), new Date());
    expect(transaction.isTerminal()).toBe(true);
    expect(() => transaction.markProcessed(money('90.00'), new Date())).toThrow(InvalidTransactionStateError);
    expect(() => transaction.reject('INSUFFICIENT_FUNDS', money('90.00'), new Date())).toThrow(InvalidTransactionStateError);
    const rejected = wager();
    rejected.reject('INSUFFICIENT_FUNDS', money('0.00'), new Date());
    expect(rejected.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(() => rejected.markProcessed(money('0.00'), new Date())).toThrow();
  });
  test('WIN and OPENING credit; LOSS has no balance effect', () => {
    expect(wager(Kind.Win).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(wager(Kind.Opening).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    const loss = wager(Kind.Loss, '0.00');
    expect(loss.affectsBalance()).toBe(false);
    expect(() => loss.ledgerDirectionFor()).toThrow();
    expect(wager(Kind.Loss, '1.00').affectsBalance()).toBe(false);
    expect(() => wager(Kind.Bet, '0.00')).toThrow();
    expect(() => wager(Kind.Win, '-1.00')).toThrow();
  });
  test('rehydrates terminal state without applying transitions', () => {
    const state = {
      id: randomUUID(), providerId: 'p', externalTransactionId: 'e', idempotencyKey: 'k', payloadHash: 'b'.repeat(64),
      walletId: randomUUID(), playerId: randomUUID(), roundId: 'r', gameId: 'g', kind: Kind.Bet, money: money('1.00'),
      status: Status.Processed, createdAt: new Date(), processedAt: new Date(), resultBalance: money('99.00'),
    };
    const transaction = WagerTransaction.rehydrate(state);
    expect(transaction.status).toBe(Status.Processed);
    expect(transaction.resultBalance?.toString()).toBe('99.00');
    expect(transaction.matchesPayload(state.payloadHash)).toBe(true);
    expect(transaction.matchesPayload('c'.repeat(64))).toBe(false);
  });
});

test('payload hash sorts nested keys, preserves business differences and excludes no fields implicitly', () => {
  expect(payloadHash({ walletId: 'wallet', money: { currency: 'BRL', amount: '1.00' } }))
    .toBe(payloadHash({ money: { amount: '1.00', currency: 'BRL' }, walletId: 'wallet' }));
  expect(payloadHash({ amount: '1.00' })).not.toBe(payloadHash({ amount: '1.01' }));
});
