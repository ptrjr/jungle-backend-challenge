import { afterEach, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Logger, type INestApplication } from '@nestjs/common';
import { createApp } from '../../src/bootstrap';
import { createMessagingFixture, requested } from '../helpers/messaging';
import { captureFailure } from '../helpers/postgres';
import { WagerInput, TransactionResult } from '../../src/application/financial-service';
import { payloadHash } from '../../src/application/payload-hash';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../src/domain/wager-transaction';
import { TransactionEntity, LedgerEntity } from '../../src/database/entities';
import { InboxEntity, OutboxEntity } from '../../src/database/delivery-entities';
import { WAGER_CONSUMER_NAME } from '../../src/messaging/inbox.processor';

let fixture: Awaited<ReturnType<typeof createMessagingFixture>>;
let app: INestApplication;
let base: string;
let previous: NodeJS.ProcessEnv;
beforeEach(async () => {
  Logger.overrideLogger(false);
  previous = { ...process.env };
  fixture = await createMessagingFixture();
  process.env.DATABASE_URL = fixture.scopedUrl;
  process.env.MESSAGING_ENABLED = 'false'; process.env.REFERENCE_WORKER_ENABLED = 'false';
  app = await createApp(); app.useLogger(false); await app.listen(0, '127.0.0.1'); base = await app.getUrl();
});
afterEach(async () => {
  try {
    const rows = await fixture.source.query(`SELECT w.id FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id=w.id
      GROUP BY w.id HAVING w.balance < 0 OR w.balance <> COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END),0)`);
    expect(rows).toHaveLength(0);
  } finally {
    if (app) await app.close();
    if (fixture) await fixture.close();
    for (const key of ['DATABASE_URL', 'MESSAGING_ENABLED', 'REFERENCE_WORKER_ENABLED']) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
});
function input(wallet: { id: string; playerId: string }, kind: WagerInput['kind'] = Kind.Bet, amount = '10.00'): WagerInput {
  return { providerId: 'Provider-A', externalTransactionId: `External-${randomUUID()}`, playerId: wallet.playerId, walletId: wallet.id,
    roundId: 'Round-A', gameId: 'Game-A', kind, money: { amount, currency: 'BRL' } };
}
async function post(body: WagerInput, key = `${body.providerId}:${body.externalTransactionId}`, correlationId?: string) {
  const response = await fetch(`${base}/wagering/transactions`, { method: 'POST', headers: {
    'Content-Type': 'application/json', 'Idempotency-Key': key, ...(correlationId === undefined ? {} : { 'X-Correlation-Id': correlationId }),
  }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as TransactionResult };
}

test('HTTP UUID spelling is canonical before opening, movements, reversals, replay and cursor comparison', async () => {
  const playerId = randomUUID();
  const response = await fetch(`${base}/wallets`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId: playerId.toUpperCase(), initialBalance: { amount: '100.00', currency: 'BRL' } }) });
  expect(response.status).toBe(201);
  const wallet = await response.json() as { id: string; playerId: string };
  expect(wallet.playerId).toBe(playerId);
  const bet = input(wallet, Kind.Bet, '80.00');
  const applied = await post(bet);
  expect(applied.status).toBe(200);
  const win = input(wallet, Kind.Win);
  expect((await post({ ...win, walletId: wallet.id.toUpperCase() })).status).toBe(200);
  const refund = { ...input(wallet, Kind.Refund, '80.00'), referenceExternalTransactionId: bet.externalTransactionId,
    walletId: wallet.id.toUpperCase(), playerId: playerId.toUpperCase() };
  expect((await post(refund)).status).toBe(200);
  const replay = await post({ ...bet, playerId: playerId.toUpperCase(), walletId: wallet.id.toUpperCase() });
  expect(replay.body).toEqual({ ...applied.body, idempotentReplay: true });
  expect((await fixture.financial.getWallet(wallet.id)).balance.amount).toBe('110.00');
  const events = await fixture.source.manager.find(OutboxEntity);
  expect(events).toHaveLength(8);
  expect(events.every(e => e.payload.aggregateId === wallet.id && e.payload.data.walletId === wallet.id)).toBe(true);
  const row = await fixture.source.manager.findOneByOrFail(TransactionEntity, { id: applied.body.transactionId });
  expect([row.providerId, row.externalTransactionId, row.roundId, row.gameId, row.idempotencyKey]).toEqual([
    bet.providerId, bet.externalTransactionId, bet.roundId, bet.gameId, `${bet.providerId}:${bet.externalTransactionId}`,
  ]);
  expect((await post({ ...bet, roundId: 'round-a' })).status).toBe(409);
  expect((await post(bet, `${bet.providerId}:${bet.externalTransactionId}`.toLowerCase())).status).toBe(409);
  const page = await (await fetch(`${base}/wallets/${wallet.id.toUpperCase()}/ledger?limit=1`)).json() as { nextCursor: string };
  expect((await fetch(`${base}/wallets/${wallet.id}/ledger?cursor=${page.nextCursor}`)).status).toBe(200);
  expect((await fetch(`${base}/wagering/transactions/${row.id.toUpperCase()}`)).status).toBe(200);
  const report = await (await fetch(`${base}/wallets/${wallet.id.toUpperCase()}/reconciliation`, { method: 'POST' })).json() as { walletId: string; consistent: boolean };
  expect(report).toMatchObject({ walletId: wallet.id, consistent: true });
});

test('SQS shares UUID normalization and deduplicates alternate spelling in inbox and financial replay', async () => {
  const wallet = await fixture.financial.openWallet(randomUUID().toUpperCase(), { amount: '100.00', currency: 'BRL' });
  const bet = input(wallet, Kind.Bet, '80.00');
  const message = requested({ ...bet, playerId: wallet.playerId.toUpperCase(), walletId: wallet.id.toUpperCase() });
  await fixture.send(message); await fixture.consumer.runOnce(1);
  await fixture.send({ ...message, data: { ...message.data, playerId: wallet.playerId, walletId: wallet.id } });
  await fixture.consumer.runOnce(1);
  const win = input(wallet, Kind.Win);
  await fixture.send(requested({ ...win, walletId: wallet.id.toUpperCase() })); await fixture.consumer.runOnce(1);
  const refund = { ...input(wallet, Kind.Refund, '80.00'), referenceExternalTransactionId: bet.externalTransactionId,
    playerId: wallet.playerId.toUpperCase(), walletId: wallet.id.toUpperCase() };
  await fixture.send(requested(refund)); await fixture.consumer.runOnce(1);
  const replay = await post(bet);
  expect(replay.body).toMatchObject({ status: 'PROCESSED', idempotentReplay: true, balance: { amount: '20.00', currency: 'BRL' } });
  expect(await fixture.source.manager.countBy(InboxEntity, { messageId: message.messageId })).toBe(1);
  expect(await fixture.source.manager.countBy(LedgerEntity, { transactionId: replay.body.transactionId })).toBe(1);
  expect(await fixture.source.manager.count(OutboxEntity)).toBe(8);
  expect((await fixture.financial.getWallet(wallet.id)).balance.amount).toBe('110.00');
  expect(await fixture.sqs.deadLetterDepth()).toBe(0);
});

test('legacy uppercase hashes replay through HTTP and inbox without rewriting history or accepting business changes', async () => {
  const wallet = await fixture.financial.openWallet(randomUUID(), { amount: '100.00', currency: 'BRL' });
  const original = input(wallet, Kind.Loss, '0.00');
  const applied = await fixture.financial.process(original, 'seed');
  const seed = await fixture.source.manager.findOneByOrFail(TransactionEntity, { id: applied.transactionId });
  const oldInput = { ...original, externalTransactionId: randomUUID(), playerId: wallet.playerId.toUpperCase(), walletId: wallet.id.toUpperCase() };
  const key = 'Legacy-Key';
  const legacyHash = payloadHash(oldInput);
  const row = { ...seed, id: randomUUID(), externalTransactionId: oldInput.externalTransactionId, idempotencyKey: key, payloadHash: legacyHash };
  await fixture.source.manager.insert(TransactionEntity, row);
  const message = requested(oldInput); message.data.idempotencyKey = key;
  const oldInboxHash = payloadHash({ ...oldInput, idempotencyKey: key });
  await fixture.source.manager.insert(InboxEntity, { consumerName: WAGER_CONSUMER_NAME, messageId: message.messageId,
    payloadHash: oldInboxHash, transactionId: row.id, receivedAt: new Date(), processedAt: new Date() });
  const normalized = { ...oldInput, playerId: wallet.playerId, walletId: wallet.id };
  expect((await post(normalized, key)).body).toMatchObject({ transactionId: row.id, idempotentReplay: true, status: 'PROCESSED' });
  message.data = { ...normalized, idempotencyKey: key };
  expect((await fixture.inbox.process(message)).idempotentReplay).toBe(true);
  expect((await post({ ...normalized, gameId: 'different' }, key)).status).toBe(409);
  const conflict = await captureFailure(fixture.inbox.process({ ...message, data: { ...message.data, roundId: 'different' } }));
  expect(conflict.message).toContain('Conflict');
  expect((await fixture.source.manager.findOneByOrFail(TransactionEntity, { id: row.id })).payloadHash).toBe(legacyHash);
  expect((await fixture.source.manager.findOneByOrFail(InboxEntity, { messageId: message.messageId })).payloadHash).toBe(oldInboxHash);
  const rejectedInput = { ...input(wallet), playerId: wallet.playerId.toUpperCase() };
  await fixture.source.manager.insert(TransactionEntity, { ...seed, id: randomUUID(), externalTransactionId: rejectedInput.externalTransactionId,
    kind: Kind.Bet, amount: '10.00', idempotencyKey: 'Legacy-Rejected', payloadHash: payloadHash(rejectedInput),
    status: Status.Rejected, failureCode: 'PLAYER_MISMATCH' });
  const rejectedReplay = await post({ ...rejectedInput, playerId: wallet.playerId }, 'Legacy-Rejected');
  expect(rejectedReplay.status).toBe(422);
  expect(rejectedReplay.body).toMatchObject({ status: 'REJECTED', failureCode: 'PLAYER_MISMATCH', idempotentReplay: true });
  expect((await fixture.financial.getWallet(wallet.id)).balance.amount).toBe('100.00');
});

test('NUL in every external text field is rejected before financial processing by HTTP and SQS', async () => {
  const wallet = await fixture.financial.openWallet(randomUUID(), { amount: '100.00', currency: 'BRL' });
  const valid = input(wallet);
  for (const field of ['providerId', 'externalTransactionId', 'roundId', 'gameId', 'referenceExternalTransactionId']) {
    const bad = { ...valid, [field]: 'bad\u0000id' };
    expect((await post(bad, 'valid-key')).status).toBe(400);
    await fixture.send(requested(bad)); await fixture.consumer.runOnce(1);
    const dead = await fixture.receive(fixture.config.deadLetterQueue);
    expect(dead?.MessageAttributes?.failureCode?.StringValue).toBe('MALFORMED_SQS_REQUEST');
    await fixture.acknowledge(fixture.config.deadLetterQueue, dead!);
  }
  expect((await fetch(`${base}/providers/bad%00id/wagering/transactions/id`)).status).toBe(400);
  expect((await fetch(`${base}/providers/provider/wagering/transactions/bad%00id`)).status).toBe(400);
  for (const field of ['messageId', 'correlationId', 'idempotencyKey'] as const) {
    const message = requested(valid);
    if (field === 'idempotencyKey') message.data.idempotencyKey = 'bad\u0000key';
    else message[field] = 'bad\u0000id';
    await fixture.send(message); await fixture.consumer.runOnce(1);
    const dead = await fixture.receive(fixture.config.deadLetterQueue);
    expect(dead?.MessageAttributes?.failureCode?.StringValue).toBe('MALFORMED_SQS_REQUEST');
    await fixture.acknowledge(fixture.config.deadLetterQueue, dead!);
  }
  expect(await fixture.source.manager.count(InboxEntity)).toBe(0);
  expect(await fixture.source.manager.count(TransactionEntity)).toBe(1);
  expect(await fixture.source.manager.count(OutboxEntity)).toBe(2);
  expect((await fixture.financial.getWallet(wallet.id)).balance.amount).toBe('100.00');
  expect((await post(valid)).status).toBe(200);
});

test('SQS rejects blank correlation and defaults an omitted correlation to messageId', async () => {
  const wallet = await fixture.financial.openWallet(randomUUID(), { amount: '100.00', currency: 'BRL' });
  const message = requested(input(wallet));
  await fixture.send({ ...message, correlationId: '   ' }); await fixture.consumer.runOnce(1);
  const dead = await fixture.receive(fixture.config.deadLetterQueue);
  expect(dead?.MessageAttributes?.failureCode?.StringValue).toBe('MALFORMED_SQS_REQUEST');
  expect(await fixture.source.manager.count(InboxEntity)).toBe(0);
  delete message.correlationId;
  await fixture.send(message); await fixture.consumer.runOnce(1);
  const receipt = await fixture.source.manager.findOneByOrFail(InboxEntity, { messageId: message.messageId });
  const event = await fixture.source.manager.findOneByOrFail(OutboxEntity, { transactionId: receipt.transactionId!, eventType: 'WagerTransactionProcessed' });
  expect(event.payload.correlationId).toBe(message.messageId);
});
