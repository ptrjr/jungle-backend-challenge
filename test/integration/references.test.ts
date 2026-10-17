import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { FinancialService, WagerInput } from '../../src/application/financial-service';
import { ReferenceWorker } from '../../src/application/reference.worker';
import { ReconciliationService } from '../../src/application/reconciliation.service';
import { LedgerEntity, TransactionEntity, TransactionRow } from '../../src/database/entities';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../src/domain/wager-transaction';
import { Money } from '../../src/domain/money';
import { createApp } from '../../src/bootstrap';
import { captureFailure, createTestDatabase } from '../helpers/postgres';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let source: DataSource;
let service: FinancialService;
let reconciliation: ReconciliationService;
let app: INestApplication;
let baseUrl: string;
const previousUrl = process.env.DATABASE_URL;
const previousWorker = process.env.REFERENCE_WORKER_ENABLED;

beforeAll(async () => {
  database = await createTestDatabase();
  source = database.sources[0]!;
  service = database.services[0]!;
  process.env.DATABASE_URL = database.scopedUrl;
  process.env.REFERENCE_WORKER_ENABLED = 'false';
  app = await createApp();
  app.useLogger(false);
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
  reconciliation = app.get(ReconciliationService);
});

afterAll(async () => {
  try {
    if (source?.isInitialized) {
      const inconsistent: unknown[] = await source.query(`SELECT w.id FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
        GROUP BY w.id HAVING w.balance <> COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)`);
      expect(inconsistent).toHaveLength(0);
    }
  } finally {
    if (app) await app.close();
    if (database) await database.close();
    if (previousUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousUrl;
    if (previousWorker === undefined) delete process.env.REFERENCE_WORKER_ENABLED; else process.env.REFERENCE_WORKER_ENABLED = previousWorker;
  }
});

const open = (amount = '100.00', playerId: string = randomUUID(), currency = 'BRL') => service.openWallet(playerId, { amount, currency });
function request(wallet: { id: string; playerId: string }, kind: WagerInput['kind'], amount = '10.00', reference?: string, overrides: Partial<WagerInput> = {}): WagerInput {
  return { providerId: 'provider-a', externalTransactionId: randomUUID(), walletId: wallet.id, playerId: wallet.playerId,
    roundId: 'round', gameId: 'game', kind, money: { amount, currency: 'BRL' },
    ...(reference !== undefined ? { referenceExternalTransactionId: reference } : {}), ...overrides };
}
const keyFor = (input: WagerInput) => `${input.providerId}:${input.externalTransactionId}`;
const send = (input: WagerInput) => service.process(input, keyFor(input));
async function stored(id: string): Promise<TransactionRow> { return source.manager.findOneByOrFail(TransactionEntity, { id }); }
async function retry(id: string): Promise<TransactionRow> {
  const row = await stored(id);
  await new ReferenceWorker(service).runBatch(row.nextAttemptAt!);
  return stored(id);
}
async function post(input: WagerInput) {
  return fetch(`${baseUrl}/wagering/transactions`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': keyFor(input) }, body: JSON.stringify(input) });
}

describe('REFUND and ROLLBACK with real PostgreSQL', () => {
  test('REFUND credits a processed BET exactly once and replays the original balance', async () => {
    const wallet = await open();
    const bet = request(wallet, Kind.Bet, '80.00');
    await send(bet);
    const refund = request(wallet, Kind.Refund, '80.00', bet.externalTransactionId);
    const result = await send(refund);
    expect(result.status).toBe(Status.Processed);
    expect(result.balance.amount).toBe('100.00');
    await send(request(wallet, Kind.Win, '10.00'));
    expect(await send(refund)).toEqual({ ...result, idempotentReplay: true });
    expect((await service.getWallet(wallet.id)).balance.amount).toBe('110.00');
    expect(await source.manager.countBy(LedgerEntity, { transactionId: result.transactionId })).toBe(1);
    expect((await reconciliation.reconcile(wallet.id)).consistent).toBe(true);
  });

  test.each([Kind.Bet, Kind.Win, Kind.Refund])('ROLLBACK inverts processed %s', async kind => {
    const wallet = await open();
    let reference = request(wallet, kind, '10.00');
    if (kind === Kind.Refund) {
      const bet = request(wallet, Kind.Bet);
      await send(bet);
      reference = request(wallet, Kind.Refund, '10.00', bet.externalTransactionId);
    }
    const applied = await send(reference);
    const rollback = await send(request(wallet, Kind.Rollback, '10.00', reference.externalTransactionId));
    expect(rollback.status).toBe(Status.Processed);
    const expected = Money.from(applied.balance)[kind === Kind.Bet ? 'add' : 'subtract'](Money.from({ amount: '10.00', currency: 'BRL' }));
    expect(rollback.balance).toEqual(expected.toJSON());
    expect((await reconciliation.reconcile(wallet.id)).consistent).toBe(true);
  });

  test('rejects invalid reference kinds, nonprocessed references, partial amounts and self-reference', async () => {
    const wallet = await open();
    const win = request(wallet, Kind.Win);
    const loss = request(wallet, Kind.Loss, '0.00');
    await send(win); await send(loss);
    expect((await send(request(wallet, Kind.Refund, '10.00', win.externalTransactionId))).failureCode).toBe('REFERENCE_KIND_MISMATCH');
    expect((await send(request(wallet, Kind.Rollback, '10.00', loss.externalTransactionId))).failureCode).toBe('REFERENCE_KIND_MISMATCH');
    const bet = request(wallet, Kind.Bet);
    await send(bet);
    expect((await send(request(wallet, Kind.Refund, '9.00', bet.externalTransactionId))).failureCode).toBe('REFERENCE_AMOUNT_MISMATCH');
    const empty = await open('0.00');
    const rejectedBet = request(empty, Kind.Bet);
    await send(rejectedBet);
    expect((await send(request(empty, Kind.Refund, '10.00', rejectedBet.externalTransactionId))).failureCode).toBe('REFERENCE_NOT_PROCESSED');
    const self = request(wallet, Kind.Rollback);
    self.referenceExternalTransactionId = self.externalTransactionId;
    expect((await send(self)).failureCode).toBe('INVALID_REFERENCE');
  });

  test('validates wallet owner, reference player/wallet, currency and round', async () => {
    const wallet = await open();
    const other = await open();
    const bet = request(other, Kind.Bet);
    await send(bet);
    expect((await send(request(wallet, Kind.Refund, '10.00', bet.externalTransactionId))).failureCode).toBe('REFERENCE_PLAYER_MISMATCH');
    const usd = await open('100.00', wallet.playerId, 'USD');
    const usdBet = request(usd, Kind.Bet, '10.00', undefined, { money: { amount: '10.00', currency: 'USD' } });
    await send(usdBet);
    expect((await send(request(wallet, Kind.Refund, '10.00', usdBet.externalTransactionId))).failureCode).toBe('REFERENCE_WALLET_MISMATCH');
    const ownBet = request(wallet, Kind.Bet);
    await send(ownBet);
    expect((await send(request(wallet, Kind.Refund, '10.00', ownBet.externalTransactionId, { playerId: randomUUID() }))).failureCode).toBe('PLAYER_MISMATCH');
    expect((await send(request(wallet, Kind.Refund, '10.00', ownBet.externalTransactionId, { money: { amount: '10.00', currency: 'USD' } }))).failureCode).toBe('CURRENCY_MISMATCH');
    expect((await send(request(wallet, Kind.Refund, '10.00', ownBet.externalTransactionId, { roundId: 'other-round' }))).failureCode).toBe('REFERENCE_ROUND_MISMATCH');
  });

  test('resolves external IDs inside their provider scope', async () => {
    const wallet = await open();
    const betA = request(wallet, Kind.Bet);
    await send(betA);
    const refundB = request(wallet, Kind.Refund, '10.00', betA.externalTransactionId, { providerId: 'provider-b' });
    const pending = await send(refundB);
    expect(pending.status).toBe(Status.PendingReference);
    const betB = { ...betA, providerId: 'provider-b' };
    const ownReference = await send(betB);
    expect((await retry(pending.transactionId)).referenceTransactionId).toBe(ownReference.transactionId);
    expect((await service.getWallet(wallet.id)).balance.amount).toBe('90.00');
  });

  test('concurrent different refunds produce one credit and audit every rejection', async () => {
    const wallet = await open();
    const bet = request(wallet, Kind.Bet, '80.00');
    await send(bet);
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => {
      const refund = request(wallet, Kind.Refund, '80.00', bet.externalTransactionId);
      return database.services[i % 3]!.process(refund, keyFor(refund));
    }));
    expect(results.filter(r => r.status === Status.Processed)).toHaveLength(1);
    expect(results.filter(r => r.failureCode === 'REFERENCE_ALREADY_REVERSED')).toHaveLength(11);
    expect((await service.getWallet(wallet.id)).balance.amount).toBe('100.00');
    expect(await source.manager.countBy(LedgerEntity, { walletId: wallet.id })).toBe(3);
    expect((await reconciliation.reconcile(wallet.id)).consistent).toBe(true);
  });

  test('concurrent duplicate rollbacks debit a WIN once; uniqueness is per reference and type', async () => {
    const wallet = await open();
    const win = request(wallet, Kind.Win, '50.00');
    await send(win);
    const rollback = request(wallet, Kind.Rollback, '50.00', win.externalTransactionId);
    const results = await Promise.all(database.services.map(s => s.process(rollback, keyFor(rollback))));
    expect(new Set(results.map(r => r.transactionId)).size).toBe(1);
    expect((await service.getWallet(wallet.id)).balance.amount).toBe('100.00');
    const bet = request(wallet, Kind.Bet);
    await send(bet);
    expect((await send(request(wallet, Kind.Refund, '10.00', bet.externalTransactionId))).status).toBe(Status.Processed);
    expect((await send(request(wallet, Kind.Rollback, '10.00', bet.externalTransactionId))).status).toBe(Status.Processed);
    expect((await send(request(wallet, Kind.Rollback, '10.00', bet.externalTransactionId))).failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    expect((await reconciliation.reconcile(wallet.id)).consistent).toBe(true);
  });

  test('negative reversal is rejected with its own code and never becomes a debit on replay', async () => {
    const wallet = await open('0.00');
    const win = request(wallet, Kind.Win, '50.00');
    await send(win);
    await send(request(wallet, Kind.Bet, '50.00'));
    const rollback = request(wallet, Kind.Rollback, '50.00', win.externalTransactionId);
    const result = await send(rollback);
    expect(result.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
    expect(result.balance.amount).toBe('0.00');
    await send(request(wallet, Kind.Win, '50.00'));
    expect(await send(rollback)).toEqual({ ...result, idempotentReplay: true });
    expect(await source.manager.countBy(LedgerEntity, { transactionId: result.transactionId })).toBe(0);
  });

  test('PostgreSQL itself enforces processed reference identity and reversal uniqueness', async () => {
    const wallet = await open();
    const bet = request(wallet, Kind.Bet);
    await send(bet);
    const refund = await send(request(wallet, Kind.Refund, '10.00', bet.externalTransactionId));
    const row = await stored(refund.transactionId);
    const duplicate = { ...row, id: randomUUID(), externalTransactionId: randomUUID(), idempotencyKey: randomUUID() };
    const unique = await captureFailure(source.manager.insert(TransactionEntity, duplicate));
    expect(unique.driverError?.code).toBe('23505');
    const nextBet = request(wallet, Kind.Bet);
    const next = await send(nextBet);
    const invalid = { ...duplicate, id: randomUUID(), referenceTransactionId: next.transactionId, referenceExternalTransactionId: bet.externalTransactionId };
    expect((await captureFailure(source.manager.insert(TransactionEntity, invalid))).message).toContain('Invalid processed reference');
    const partial = { ...duplicate, id: randomUUID(), referenceTransactionId: next.transactionId, referenceExternalTransactionId: nextBet.externalTransactionId, amount: '9.00' };
    expect((await captureFailure(source.manager.insert(TransactionEntity, partial))).message).toContain('Invalid processed reference');
    expect((await reconciliation.reconcile(wallet.id)).consistent).toBe(true);
  });
});

describe('persistent reference retries', () => {
  test.each([Kind.Refund, Kind.Rollback])('%s delivered before its reference is persisted then resolved', async kind => {
    const wallet = await open();
    const reference = request(wallet, kind === Kind.Refund ? Kind.Bet : Kind.Win, '20.00');
    const input = request(wallet, kind, '20.00', reference.externalTransactionId);
    const pending = await send(input);
    expect(pending.status).toBe(Status.PendingReference);
    expect(await send(input)).toEqual({ ...pending, idempotentReplay: true });
    expect(await source.manager.countBy(LedgerEntity, { transactionId: pending.transactionId })).toBe(0);
    const conflict = await captureFailure(service.process({ ...input, referenceExternalTransactionId: randomUUID() }, keyFor(input)));
    expect(conflict.message).toContain('Conflict');
    const appliedReference = await send(reference);
    const processed = await retry(pending.transactionId);
    expect(processed.status).toBe(Status.Processed);
    expect(processed.referenceTransactionId).toBe(appliedReference.transactionId);
    expect(processed.referenceAttempts).toBe(1);
    expect((await send(input)).balance.amount).toBe('100.00');
  });

  test('missing reference expires after eight scheduled attempts and stays auditably rejected', async () => {
    const wallet = await open();
    const input = request(wallet, Kind.Refund, '10.00', randomUUID());
    const result = await send(input);
    let row = await stored(result.transactionId);
    for (let attempt = 1; attempt <= 8; attempt++) {
      const nextAt = row.nextAttemptAt!;
      row = await retry(row.id);
      expect(row.referenceAttempts).toBe(attempt);
      if (attempt < 8) expect(row.nextAttemptAt!.getTime()).toBeGreaterThan(nextAt.getTime());
    }
    expect(row.status).toBe(Status.Rejected);
    expect(row.failureCode).toBe('REFERENCE_NOT_FOUND');
    expect(row.nextAttemptAt).toBeNull();
    expect((await send(input)).failureCode).toBe('REFERENCE_NOT_FOUND');
    expect((await service.getWallet(wallet.id)).version).toBe(1);
    expect(await source.manager.countBy(LedgerEntity, { transactionId: row.id })).toBe(0);
  });

  test('dependent pending references are resolved in stages', async () => {
    const wallet = await open();
    const bet = request(wallet, Kind.Bet);
    const refund = request(wallet, Kind.Refund, '10.00', bet.externalTransactionId);
    const rollback = await send(request(wallet, Kind.Rollback, '10.00', refund.externalTransactionId));
    const pendingRefund = await send(refund);
    await retry(rollback.transactionId);
    expect((await stored(rollback.transactionId)).status).toBe(Status.PendingReference);
    await send(bet);
    await retry(pendingRefund.transactionId);
    expect((await retry(rollback.transactionId)).status).toBe(Status.Processed);
    expect((await service.getWallet(wallet.id)).balance.amount).toBe('90.00');
  });

  test('three workers compete for due references without duplicate application', async () => {
    const wallet = await open();
    const bet = request(wallet, Kind.Bet, '80.00');
    const pending = await send(request(wallet, Kind.Refund, '80.00', bet.externalTransactionId));
    await send(bet);
    const due = (await stored(pending.transactionId)).nextAttemptAt!;
    await Promise.all(database.services.map(s => new ReferenceWorker(s).runBatch(due)));
    const row = await stored(pending.transactionId);
    expect(row.status).toBe(Status.Processed);
    expect(row.referenceAttempts).toBe(1);
    expect(await source.manager.countBy(LedgerEntity, { transactionId: row.id })).toBe(1);
    expect((await service.getWallet(wallet.id)).balance.amount).toBe('100.00');
  });

  test('SKIP LOCKED lets a worker process another wallet while the first is busy', async () => {
    const wallets = await Promise.all([open(), open()]);
    const pendings = [];
    for (const wallet of wallets) {
      const bet = request(wallet, Kind.Bet);
      pendings.push(await send(request(wallet, Kind.Refund, '10.00', bet.externalTransactionId)));
      await send(bet);
    }
    const blocker = database.sources[1]!.createQueryRunner();
    await blocker.connect(); await blocker.startTransaction();
    const due = new Date(Math.max(...(await Promise.all(pendings.map(p => stored(p.transactionId)))).map(r => r.nextAttemptAt!.getTime())));
    try {
      await blocker.query('SELECT id FROM wallets WHERE id = $1 FOR UPDATE', [wallets[0]!.id]);
      expect(await service.reprocessPendingReference(due)).toBe(true);
      expect((await stored(pendings[1]!.transactionId)).status).toBe(Status.Processed);
      expect((await stored(pendings[0]!.transactionId)).status).toBe(Status.PendingReference);
    } finally { await blocker.rollbackTransaction(); await blocker.release(); }
    await retry(pendings[0]!.transactionId);
  });

  test('failure during retry rolls back effects and attempt count before a safe retry', async () => {
    const wallet = await open();
    const bet = request(wallet, Kind.Bet);
    const pending = await send(request(wallet, Kind.Refund, '10.00', bet.externalTransactionId));
    await send(bet);
    await source.query(`CREATE FUNCTION fail_reference_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.wallet_id = '${wallet.id}'::uuid THEN RAISE EXCEPTION 'Injected reversal failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_reference_test BEFORE INSERT ON wallet_ledger_entries FOR EACH ROW EXECUTE FUNCTION fail_reference_test();`);
    try {
      const due = (await stored(pending.transactionId)).nextAttemptAt!;
      expect((await captureFailure(service.reprocessPendingReference(due))).message).toContain('Injected reversal failure');
    } finally { await source.query('DROP TRIGGER fail_reference_test ON wallet_ledger_entries; DROP FUNCTION fail_reference_test();'); }
    expect((await stored(pending.transactionId)).referenceAttempts).toBe(0);
    expect((await service.getWallet(wallet.id)).balance.amount).toBe('90.00');
    expect((await retry(pending.transactionId)).status).toBe(Status.Processed);
  });

  test('scheduled worker resumes persisted pending work and shuts down cleanly', async () => {
    const wallet = await open();
    const bet = request(wallet, Kind.Bet);
    const pending = await send(request(wallet, Kind.Refund, '10.00', bet.externalTransactionId));
    await send(bet);
    await source.query('UPDATE wager_transactions SET next_attempt_at = now() WHERE id = $1', [pending.transactionId]);
    const worker = new ReferenceWorker(database.services[2]!);
    process.env.REFERENCE_WORKER_ENABLED = 'true';
    worker.onApplicationBootstrap();
    process.env.REFERENCE_WORKER_ENABLED = 'false';
    try {
      const deadline = Date.now() + 5000;
      while ((await stored(pending.transactionId)).status !== Status.Processed && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      expect((await stored(pending.transactionId)).status).toBe(Status.Processed);
    } finally { await worker.beforeApplicationShutdown(); }
  });
});

describe('HTTP and reconciliation', () => {
  test('HTTP distinguishes pending, rejection, processed and replay results', async () => {
    const wallet = await open();
    const bet = request(wallet, Kind.Bet);
    const refund = request(wallet, Kind.Refund, '10.00', bet.externalTransactionId);
    expect((await post(refund)).status).toBe(202);
    expect((await post(refund)).status).toBe(202);
    await send(bet);
    const pending = await service.getProviderTransaction(refund.providerId, refund.externalTransactionId);
    await retry(pending.transactionId);
    expect((await post(refund)).status).toBe(200);
    expect((await post(request(wallet, Kind.Refund, '10.00', bet.externalTransactionId))).status).toBe(422);
    expect((await post(request(wallet, Kind.Refund))).status).toBe(400);
    const response = await fetch(`${baseUrl}/wallets/${wallet.id}/reconciliation`, { method: 'POST' });
    const report = await response.json() as { consistent: boolean; checkedEntries: number };
    expect(response.status).toBe(200);
    expect(report.consistent).toBe(true);
    expect(report.checkedEntries).toBe(3);
    expect((await fetch(`${baseUrl}/wallets/${randomUUID()}/reconciliation`, { method: 'POST' })).status).toBe(404);
  });

  test('optional WIN reference must resolve a BET, while an unreferenced WIN still works', async () => {
    const wallet = await open();
    const bet = request(wallet, Kind.Bet);
    const win = request(wallet, Kind.Win, '20.00', bet.externalTransactionId);
    const pending = await send(win);
    expect(pending.status).toBe(Status.PendingReference);
    await send(bet);
    expect((await retry(pending.transactionId)).status).toBe(Status.Processed);
    expect((await service.getWallet(wallet.id)).balance.amount).toBe('110.00');
    expect((await reconciliation.reconcile(wallet.id)).consistent).toBe(true);
  });

  test('reconciliation uses one snapshot during concurrent financial writes', async () => {
    const wallet = await open();
    const [reports] = await Promise.all([
      Promise.all(Array.from({ length: 25 }, () => reconciliation.reconcile(wallet.id))),
      Promise.all(Array.from({ length: 30 }, (_, i) => {
        const input = request(wallet, i % 2 === 0 ? Kind.Bet : Kind.Win, '1.00');
        return database.services[i % 3]!.process(input, keyFor(input));
      })),
    ]);
    expect(reports.every(r => r.consistent && r.difference.amount === '0.00')).toBe(true);
    const final = await reconciliation.reconcile(wallet.id);
    expect(final.checkedEntries).toBe(31);
    expect(final.storedBalance.amount).toBe('100.00');
    const empty = await open('0.00');
    expect((await reconciliation.reconcile(empty.id)).checkedEntries).toBe(0);
  });

  test('divergence is reported and counted without correcting stored balance', async () => {
    const wallet = await open();
    // Only this isolated test schema bypasses the consistency trigger to simulate corruption.
    await source.query(`ALTER TABLE wallets DISABLE TRIGGER wallets_ledger_consistent;
      UPDATE wallets SET balance = balance + 1.00, version = version + 1 WHERE id = '${wallet.id}'::uuid;
      ALTER TABLE wallets ENABLE TRIGGER wallets_ledger_consistent;`);
    try {
      const response = await fetch(`${baseUrl}/wallets/${wallet.id}/reconciliation`, { method: 'POST' });
      const report = await response.json() as { storedBalance: { amount: string }; calculatedBalance: { amount: string }; difference: { amount: string }; consistent: boolean };
      expect(report.consistent).toBe(false);
      expect(report.storedBalance.amount).toBe('101.00');
      expect(report.calculatedBalance.amount).toBe('100.00');
      expect(report.difference.amount).toBe('1.00');
      expect((await service.getWallet(wallet.id)).balance.amount).toBe('101.00');
      expect(await (await fetch(`${baseUrl}/metrics`)).text()).toContain('wallet_reconciliation_divergences_total 1');
    } finally {
      await source.query('UPDATE wallets SET balance = balance - 1.00, version = version + 1 WHERE id = $1', [wallet.id]);
    }
  });

  test('migration down/up preserves stage one history and replay; refuses to erase stage two history', async () => {
    const isolated = await createTestDatabase();
    try {
      const s = isolated.services[0]!;
      const connection = isolated.sources[0]!;
      const wallet = await s.openWallet(randomUUID(), { amount: '100.00', currency: 'BRL' });
      const bet = request(wallet, Kind.Bet);
      const applied = await s.process(bet, keyFor(bet));
      await connection.undoLastMigration({ transaction: 'all' });
      expect((await s.getWallet(wallet.id)).balance.amount).toBe('90.00');
      await connection.runMigrations({ transaction: 'all' });
      expect(await s.process(bet, keyFor(bet))).toEqual({ ...applied, idempotentReplay: true });
      const refund = request(wallet, Kind.Refund, '10.00', bet.externalTransactionId);
      await s.process(refund, keyFor(refund));
      expect((await captureFailure(connection.undoLastMigration({ transaction: 'all' }))).message).toContain('stage two history exists');
    } finally { await isolated.close(); }
  });
});
