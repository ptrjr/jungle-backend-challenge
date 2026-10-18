import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { InboxMessage } from '../../src/domain/inbox-message';
import { OutboxMessage } from '../../src/domain/outbox-message';
import { WagerTransactionProcessed } from '../../src/domain/integration-event';
import { WagerTransaction, WagerTransactionKind } from '../../src/domain/wager-transaction';
import { Money } from '../../src/domain/money';
import { parseRequestedMessage } from '../../src/messaging/request-message';
import { validCorrelationId } from '../../src/http/input-validation';

function event() {
  const money = Money.from({ amount: '0.00', currency: 'BRL' });
  const transaction = WagerTransaction.create({ id: randomUUID(), providerId: 'provider', externalTransactionId: 'loss',
    idempotencyKey: 'key', payloadHash: 'a'.repeat(64), walletId: randomUUID(), playerId: randomUUID(),
    roundId: 'round', gameId: 'game', kind: WagerTransactionKind.Loss, money });
  transaction.markProcessed(money, new Date());
  return WagerTransactionProcessed.from(transaction, { correlationId: 'correlation', causationId: 'request' });
}
describe('delivery domain', () => {
  test('HTTP and SQS share correlation validation while omission remains allowed', () => {
    const body = { messageId: 'message', type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(),
      data: { providerId: 'provider', externalTransactionId: 'bet', idempotencyKey: 'key', playerId: randomUUID(), walletId: randomUUID(),
        roundId: 'round', gameId: 'game', kind: 'BET', money: { amount: '1.00', currency: 'BRL' } } };
    expect(parseRequestedMessage(JSON.stringify(body)).correlationId).toBeUndefined();
    for (const value of ['', ' ', '\t', ' trace', 'trace ', 'bad\u0000id', 'x'.repeat(129)]) {
      expect(validCorrelationId(value)).toBe(false);
      expect(() => parseRequestedMessage(JSON.stringify({ ...body, correlationId: value }))).toThrow();
    }
    for (const value of ['trace', 'Trace With Spaces', 'x'.repeat(128)]) {
      expect(validCorrelationId(value)).toBe(true);
      expect(parseRequestedMessage(JSON.stringify({ ...body, correlationId: value })).correlationId).toBe(value);
    }
  });
  test('inbox factory and processed transition are persistent-state compatible and terminal', () => {
    const inbox = InboxMessage.receive({ consumerName: 'consumer', messageId: 'message', payloadHash: 'a'.repeat(64) });
    expect(inbox.isProcessed()).toBe(false);
    const transactionId = randomUUID();
    inbox.markProcessed(transactionId, new Date());
    expect(inbox.isProcessed()).toBe(true);
    expect(inbox.transactionId).toBe(transactionId);
    expect(() => inbox.markProcessed(transactionId, new Date())).toThrow();
  });
  test('events serialize versioned envelopes and decimal strings with stable identity', () => {
    const message = event();
    const envelope = message.toJSON();
    expect(envelope.eventType).toBe('WagerTransactionProcessed');
    expect(envelope.version).toBe(1);
    expect(envelope.correlationId).toBe('correlation');
    expect(envelope.causationId).toBe('request');
    expect(envelope.data.money).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(message.toJSON()).toEqual(envelope);
    envelope.data.money.amount = '1.00';
    expect(message.toJSON().data.money.amount).toBe('0.00');
  });
  test('outbox retries preserve payload/eventId, back off, and cannot retry after publication', () => {
    const message = OutboxMessage.enqueue(event());
    const original = message.payload;
    const now = new Date('2026-10-17T12:00:00Z');
    expect(message.isDue(now)).toBe(true);
    message.scheduleRetry(now, 'TimeoutError');
    expect(message.attempts).toBe(1);
    expect(message.isDue(now)).toBe(false);
    expect(message.nextAttemptAt?.getTime()).toBe(now.getTime() + 1000);
    message.scheduleRetry(now, 'TimeoutError');
    expect(message.nextAttemptAt?.getTime()).toBe(now.getTime() + 2000);
    expect(message.payload).toEqual(original);
    message.markPublished(now);
    expect(message.isPending()).toBe(false);
    expect(message.attempts).toBe(3);
    expect(() => message.scheduleRetry(now, 'error')).toThrow();
    expect(() => message.markPublished(now)).toThrow();
  });
  test('outbox rehydration preserves a pending retry after restart', () => {
    const original = OutboxMessage.enqueue(event());
    const nextAttemptAt = new Date('2026-10-17T12:00:02Z');
    const message = OutboxMessage.rehydrate({ id: original.id, aggregateId: original.aggregateId, transactionId: original.transactionId,
      eventType: original.eventType, payload: original.payload, occurredAt: original.occurredAt, attempts: 2, nextAttemptAt, lastErrorCode: 'TimeoutError' });
    expect(message.isDue(new Date(nextAttemptAt.getTime() - 1))).toBe(false);
    expect(message.isDue(nextAttemptAt)).toBe(true);
    expect(message.attempts).toBe(2);
    expect(message.id).toBe(original.id);
  });
  test('SQS contract rejects invalid envelopes, OPENING, missing keys and invalid money', () => {
    const body = { messageId: 'message', type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(),
      data: { providerId: 'provider', externalTransactionId: 'bet', idempotencyKey: 'key', playerId: randomUUID(), walletId: randomUUID(),
        roundId: 'round', gameId: 'game', kind: 'BET', money: { amount: '1.00', currency: 'BRL' } } };
    expect(parseRequestedMessage(JSON.stringify(body)).data.kind).toBe(WagerTransactionKind.Bet);
    for (const invalid of [null, [], { ...body, data: { ...body.data, kind: 'OPENING' } },
      { ...body, data: { ...body.data, idempotencyKey: undefined } },
      { ...body, data: { ...body.data, money: { amount: 1, currency: 'BRL' } } },
      { ...body, data: { ...body.data, money: { amount: '1.001', currency: 'BRL' } } }]) {
      expect(() => parseRequestedMessage(JSON.stringify(invalid))).toThrow();
    }
    expect(() => parseRequestedMessage('{')).toThrow();
  });
});
