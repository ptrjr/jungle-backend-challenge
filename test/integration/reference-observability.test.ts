import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createTestDatabase, captureFailure } from '../helpers/postgres';
import { ReferenceWorker } from '../../src/application/reference.worker';
import { WagerInput } from '../../src/application/financial-service';
import { WagerTransactionKind as Kind } from '../../src/domain/wager-transaction';
import { TransactionEntity } from '../../src/database/entities';
import { messagingMetrics } from '../../src/messaging/metrics';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeEach(async () => { Logger.overrideLogger(false); database = await createTestDatabase(); });
afterEach(async () => {
  try {
    const rows = await database.sources[0]!.query(`SELECT w.id FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id=w.id
      GROUP BY w.id HAVING w.balance <> COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END),0)`);
    expect(rows).toHaveLength(0);
  } finally { await database.close(); }
});
function input(wallet: { id: string; playerId: string }, kind: WagerInput['kind'], reference?: string): WagerInput {
  return { providerId: 'provider', externalTransactionId: randomUUID(), playerId: wallet.playerId, walletId: wallet.id,
    roundId: 'round', gameId: 'game', kind, money: { amount: '10.00', currency: 'BRL' },
    ...(reference ? { referenceExternalTransactionId: reference } : {}) };
}
async function metricCount() {
  return Number((await messagingMetrics.render(database.sources[0]!)).match(/^processing_seconds_count (\d+)$/m)![1]);
}
test('reference resolution and expiration log correlated terminal outcomes and measure committed attempts', async () => {
  const service = database.services[0]!;
  const source = database.sources[0]!;
  const wallet = await service.openWallet(randomUUID(), { amount: '100.00', currency: 'BRL' });
  const bet = input(wallet, Kind.Bet);
  const refund = await service.process(input(wallet, Kind.Refund, bet.externalTransactionId), randomUUID(), { correlationId: 'resolve-trace' });
  await service.process(bet, randomUUID());
  const expiring = await service.process(input(wallet, Kind.Refund, randomUUID()), randomUUID(), { correlationId: 'expire-trace' });
  const before = await metricCount();
  const log = spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  try {
    const worker = new ReferenceWorker(service);
    const due = await source.manager.findOneByOrFail(TransactionEntity, { id: refund.transactionId });
    await worker.runBatch(due.nextAttemptAt!);
    for (let i = 0; i < 8; i++) {
      const row = await source.manager.findOneByOrFail(TransactionEntity, { id: expiring.transactionId });
      if (row.status === 'REJECTED') break;
      await worker.runBatch(row.nextAttemptAt!);
    }
    const records = log.mock.calls.map(call => call[0]).filter(value => value?.code === 'REFERENCE_TRANSACTION_RESULT');
    expect(records).toHaveLength(2);
    expect(records).toContainEqual({ code: 'REFERENCE_TRANSACTION_RESULT', transactionId: refund.transactionId,
      walletId: wallet.id, providerId: 'provider', correlationId: 'resolve-trace', status: 'PROCESSED' });
    expect(records).toContainEqual({ code: 'REFERENCE_TRANSACTION_RESULT', transactionId: expiring.transactionId,
      walletId: wallet.id, providerId: 'provider', correlationId: 'expire-trace', status: 'REJECTED', failureCode: 'REFERENCE_NOT_FOUND' });
    expect(await metricCount()).toBe(before + 9);
    expect(records.every(value => !('money' in value) && !('balance' in value))).toBe(true);
  } finally { log.mockRestore(); }
});

test('a deferred commit failure emits no reference success log or committed latency sample', async () => {
  const source = database.sources[0]!;
  const service = database.services[0]!;
  const wallet = await service.openWallet(randomUUID(), { amount: '100.00', currency: 'BRL' });
  const bet = input(wallet, Kind.Bet);
  const pending = await service.process(input(wallet, Kind.Refund, bet.externalTransactionId), randomUUID());
  await service.process(bet, randomUUID());
  const row = await source.manager.findOneByOrFail(TransactionEntity, { id: pending.transactionId });
  await source.query(`CREATE FUNCTION fail_commit_test() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Injected deferred commit failure'; END $$;
    CREATE CONSTRAINT TRIGGER fail_commit_test AFTER UPDATE ON wager_transactions DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION fail_commit_test();`);
  const before = await metricCount();
  const log = spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  try {
    expect((await captureFailure(new ReferenceWorker(service).runBatch(row.nextAttemptAt!))).message).toContain('deferred commit failure');
    expect(log.mock.calls.filter(call => call[0]?.code === 'REFERENCE_TRANSACTION_RESULT')).toHaveLength(0);
    expect(await metricCount()).toBe(before);
    expect((await source.manager.findOneByOrFail(TransactionEntity, { id: row.id })).referenceAttempts).toBe(0);
    expect((await service.getWallet(wallet.id)).balance.amount).toBe('90.00');
  } finally {
    log.mockRestore();
    await source.query('DROP TRIGGER fail_commit_test ON wager_transactions; DROP FUNCTION fail_commit_test();');
  }
});
