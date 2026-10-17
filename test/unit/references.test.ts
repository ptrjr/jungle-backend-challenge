import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Money } from '../../src/domain/money';
import { InvalidTransactionStateError } from '../../src/domain/domain-error';
import { LedgerDirection } from '../../src/domain/wallet-ledger-entry';
import { CreateWagerTransactionProps, referenceRetryDelay, WagerTransaction as Transaction, WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../src/domain/wager-transaction';

const money = (amount = '10.00', currency = 'BRL') => Money.from({ amount, currency });
const identity = { providerId: 'provider', playerId: randomUUID(), walletId: randomUUID(), roundId: 'round', gameId: 'game' };
function create(kind: Kind, props: Partial<CreateWagerTransactionProps> = {}): Transaction {
  return Transaction.create({ ...identity, id: randomUUID(), externalTransactionId: 'reference', idempotencyKey: randomUUID(),
    payloadHash: 'a'.repeat(64), kind, money: money(), ...props });
}
function processed(kind: Kind): Transaction {
  const transaction = create(kind, kind === Kind.Refund ? { referenceExternalTransactionId: 'bet' } : {});
  transaction.markProcessed(money('100.00'), new Date(), kind === Kind.Refund ? randomUUID() : undefined);
  return transaction;
}
const reversal = (kind: Kind = Kind.Refund, props: Partial<CreateWagerTransactionProps> = {}) => create(kind, {
  externalTransactionId: 'reversal', referenceExternalTransactionId: 'reference', ...props,
});

describe('reference domain rules', () => {
  test('reversals require a reference and BET/LOSS cannot carry one', () => {
    for (const kind of [Kind.Refund, Kind.Rollback]) expect(() => create(kind)).toThrow('require an external reference');
    expect(() => create(Kind.Bet, { referenceExternalTransactionId: 'bet' })).toThrow();
    expect(() => create(Kind.Loss, { referenceExternalTransactionId: 'bet' })).toThrow();
  });
  test('REFUND only accepts BET; ROLLBACK accepts BET, WIN or REFUND with inverse direction', () => {
    const bet = processed(Kind.Bet);
    const win = processed(Kind.Win);
    const refund = processed(Kind.Refund);
    expect(reversal().referenceFailure(bet)).toBeUndefined();
    expect(reversal().referenceFailure(win)).toBe('REFERENCE_KIND_MISMATCH');
    expect(reversal(Kind.Rollback).ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(reversal(Kind.Rollback).ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(reversal(Kind.Rollback).ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
    expect(() => reversal(Kind.Rollback).ledgerDirectionFor()).toThrow();
    expect(reversal(Kind.Rollback).referenceFailure(create(Kind.Opening))).toBe('REFERENCE_KIND_MISMATCH');
  });
  test.each([
    ['providerId', 'other', 'REFERENCE_PROVIDER_MISMATCH'],
    ['playerId', randomUUID(), 'REFERENCE_PLAYER_MISMATCH'],
    ['walletId', randomUUID(), 'REFERENCE_WALLET_MISMATCH'],
    ['roundId', 'other', 'REFERENCE_ROUND_MISMATCH'],
  ] as const)('validates reference %s', (field, value, code) => {
    expect(reversal().referenceFailure(create(Kind.Bet, { [field]: value }))).toBe(code);
  });
  test('validates reference currency, full amount, status and self-reference', () => {
    expect(reversal().referenceFailure(create(Kind.Bet, { money: money('10.00', 'USD') }))).toBe('REFERENCE_CURRENCY_MISMATCH');
    expect(reversal().referenceFailure(create(Kind.Bet, { money: money('9.00') }))).toBe('REFERENCE_AMOUNT_MISMATCH');
    expect(reversal().referenceFailure(create(Kind.Bet, { externalTransactionId: 'other' }))).toBe('INVALID_REFERENCE');
    const rejected = create(Kind.Bet);
    rejected.reject('INSUFFICIENT_FUNDS', money('0.00'), new Date());
    expect(reversal().referenceFailure(rejected)).toBe('REFERENCE_NOT_PROCESSED');
    const self = reversal();
    expect(self.referenceFailure(self)).toBe('INVALID_REFERENCE');
  });
  test('pending reference is nonterminal; retries increase backoff and terminal state clears its schedule', () => {
    const transaction = reversal();
    const now = new Date('2026-10-17T12:00:00Z');
    transaction.markPendingReference(money('100.00'), now);
    expect(transaction.status).toBe(Status.PendingReference);
    expect(transaction.isTerminal()).toBe(false);
    expect(transaction.nextAttemptAt?.getTime()).toBe(now.getTime() + 5000);
    transaction.recordReferenceAttempt();
    transaction.markPendingReference(money('200.00'), now);
    expect(transaction.resultBalance?.toString()).toBe('100.00');
    expect(transaction.nextAttemptAt?.getTime()).toBe(now.getTime() + 10000);
    expect(referenceRetryDelay(7)).toBe(300000);
    transaction.markProcessed(money('110.00'), now, randomUUID());
    expect(transaction.nextAttemptAt).toBeUndefined();
    expect(() => transaction.markPendingReference(money(), now)).toThrow(InvalidTransactionStateError);
    expect(() => transaction.recordReferenceAttempt()).toThrow(InvalidTransactionStateError);
    expect(() => transaction.markProcessed(money(), now)).toThrow(InvalidTransactionStateError);
  });
  test('pending expiration is terminal and cannot be rejected twice', () => {
    const transaction = reversal();
    transaction.markPendingReference(money(), new Date());
    for (let attempt = 0; attempt < 8; attempt++) transaction.recordReferenceAttempt();
    expect(() => transaction.markPendingReference(money(), new Date())).toThrow();
    transaction.reject('REFERENCE_NOT_FOUND', money(), new Date());
    expect(transaction.isTerminal()).toBe(true);
    expect(() => transaction.reject('REFERENCE_NOT_FOUND', money(), new Date())).toThrow(InvalidTransactionStateError);
  });
});
