import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { ConflictException, type INestApplication } from '@nestjs/common';
import { FinancialService, WagerInput } from '../../src/application/financial-service';
import { createDataSource } from '../../src/database/data-source';
import { LedgerEntity, TransactionEntity, WalletEntity } from '../../src/database/entities';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../src/domain/wager-transaction';
import { LedgerDirection } from '../../src/domain/wallet-ledger-entry';
import { createApp } from '../../src/bootstrap';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required; integration tests use real PostgreSQL');
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Test database name must end in _test');
const schema = `core_${randomUUID().replaceAll('-', '')}`;
let admin: DataSource;
let sources: DataSource[] = [];
let services: FinancialService[] = [];
let service: FinancialService;
let app: INestApplication;
let baseUrl: string;
let scopedUrl: string;

beforeAll(async () => {
  admin = await createDataSource(databaseUrl).initialize();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(databaseUrl!);
  url.searchParams.set('options', `-csearch_path=${schema}`);
  scopedUrl = url.toString();
  sources = await Promise.all([0, 1, 2].map(() => createDataSource(scopedUrl).initialize()));
  await sources[0]!.runMigrations({ transaction: 'all' });
  services = sources.map(source => new FinancialService(source));
  service = services[0]!;
  process.env.DATABASE_URL = scopedUrl;
  app = await createApp();
  app.useLogger(false);
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
});

afterAll(async () => {
  if (app) await app.close();
  try {
    if (sources[0]?.isInitialized) {
      await sources[0].undoLastMigration({ transaction: 'all' });
      await sources[0].undoLastMigration({ transaction: 'all' });
      const [row] = await sources[0].query("SELECT to_regclass('wallets') AS name");
      expect(row.name).toBeNull();
      await sources[0].runMigrations({ transaction: 'all' });
    }
  } finally {
    await Promise.all(sources.filter(s => s.isInitialized).map(s => s.destroy()));
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.destroy();
    }
  }
});

async function open(amount = '100.00') {
  return service.openWallet(randomUUID(), { amount, currency: 'BRL' });
}
function input(wallet: { id: string; playerId: string }, kind: WagerInput['kind'] = Kind.Bet, amount = '10.00'): WagerInput {
  return { providerId: 'provider-a', externalTransactionId: randomUUID(), playerId: wallet.playerId, walletId: wallet.id, roundId: 'round-1', gameId: 'game-1', kind, money: { amount, currency: 'BRL' } };
}
async function consistent(walletId: string): Promise<void> {
  const [row] = await sources[0]!.query(`SELECT w.balance = COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0) AS consistent
    FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id WHERE w.id = $1 GROUP BY w.id`, [walletId]);
  expect(row.consistent).toBe(true);
}
async function post(path: string, body: unknown, key?: string) {
  return fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: JSON.stringify(body) });
}

async function expectFailure(operation: Promise<unknown>, message?: string): Promise<void> {
  let failure: unknown;
  try { await operation; }
  catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  if (message) expect((failure as Error).message).toContain(message);
}

describe('PostgreSQL financial core', () => {
  test('OPENING is atomic and zero opening creates no transaction or ledger', async () => {
    const wallet = await open();
    expect(wallet.version).toBe(1);
    const entries = await sources[0]!.manager.findBy(LedgerEntity, { walletId: wallet.id });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.direction).toBe(LedgerDirection.Credit);
    expect((await service.getTransaction(entries[0]!.transactionId)).kind).toBe(Kind.Opening);
    const zero = await open('0.00');
    expect(await sources[0]!.manager.countBy(LedgerEntity, { walletId: zero.id })).toBe(0);
    expect(await sources[0]!.manager.countBy(TransactionEntity, { walletId: zero.id })).toBe(0);
    let conflict: unknown;
    try { await service.openWallet(wallet.playerId, wallet.balance); }
    catch (error) { conflict = error; }
    expect(conflict).toBeInstanceOf(ConflictException);
    await consistent(wallet.id);
    await consistent(zero.id);
  });

  test('two simultaneous 80.00 bets on 100.00 process exactly one across independent pools', async () => {
    const wallet = await open();
    const a = input(wallet, Kind.Bet, '80.00');
    const b = input(wallet, Kind.Bet, '80.00');
    const results = await Promise.all([services[0]!.process(a, randomUUID()), services[1]!.process(b, randomUUID())]);
    expect(results.map(r => r.status).sort()).toEqual([Status.Processed, Status.Rejected]);
    expect(results.find(r => r.status === 'REJECTED')?.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect((await service.getWallet(wallet.id)).balance.amount).toBe('20.00');
    expect(await sources[0]!.manager.countBy(LedgerEntity, { walletId: wallet.id, direction: LedgerDirection.Debit })).toBe(1);
    expect((await service.getWallet(wallet.id)).version).toBe(2);
    await consistent(wallet.id);
  });

  test('concurrent duplicates persist one effect and replay survives a new connection pool', async () => {
    const wallet = await open();
    const request = input(wallet);
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => services[i % 3]!.process(request, key)));
    expect(new Set(results.map(r => r.transactionId)).size).toBe(1);
    expect(results.filter(r => !r.idempotentReplay)).toHaveLength(1);
    expect((await service.getWallet(wallet.id)).balance.amount).toBe('90.00');
    await service.process(input(wallet, Kind.Win, '5.00'), randomUUID());
    const restarted = await createDataSource(scopedUrl).initialize();
    try {
      const replay = await new FinancialService(restarted).process(request, key);
      expect(replay.balance.amount).toBe('90.00');
      expect(replay.idempotentReplay).toBe(true);
    } finally { await restarted.destroy(); }
    await expectFailure(service.process({ ...request, money: { amount: '11.00', currency: 'BRL' } }, key));
    await expectFailure(service.process(request, randomUUID()));
    await consistent(wallet.id);
  });

  test('WIN credits once; LOSS and rejected operations never generate ledger or increment version', async () => {
    const wallet = await open();
    const win = input(wallet, Kind.Win, '25.00');
    const key = randomUUID();
    expect((await service.process(win, key)).balance.amount).toBe('125.00');
    await service.process(win, key);
    const loss = await service.process(input(wallet, Kind.Loss, '0.00'), randomUUID());
    expect(loss.status).toBe(Status.Processed);
    const rejectedRequest = input(wallet, Kind.Bet, '200.00');
    const rejectedKey = randomUUID();
    const rejected = await service.process(rejectedRequest, rejectedKey);
    expect(rejected.failureCode).toBe('INSUFFICIENT_FUNDS');
    await service.process(input(wallet, Kind.Win, '200.00'), randomUUID());
    const replay = await service.process(rejectedRequest, rejectedKey);
    expect(replay).toEqual({ ...rejected, idempotentReplay: true });
    for (const result of [loss, rejected]) {
      expect(await sources[0]!.manager.countBy(LedgerEntity, { transactionId: result.transactionId })).toBe(0);
    }
    expect((await service.getWallet(wallet.id)).version).toBe(3);
    await consistent(wallet.id);
  });

  test('owner and currency mismatches are persistent auditable rejections', async () => {
    const wallet = await open();
    const mismatch = await service.process({ ...input(wallet), playerId: randomUUID() }, randomUUID());
    expect(mismatch.failureCode).toBe('PLAYER_MISMATCH');
    const currency = await service.process({ ...input(wallet), money: { amount: '1.00', currency: 'USD' } }, randomUUID());
    expect(currency.failureCode).toBe('CURRENCY_MISMATCH');
    expect((await service.getWallet(wallet.id)).balance.amount).toBe('100.00');
    expect((await service.getWallet(wallet.id)).version).toBe(1);
    await consistent(wallet.id);
  });

  test('different wallets process concurrently with exact amounts above Number.MAX_SAFE_INTEGER', async () => {
    const wallets = await Promise.all([open('9007199254740993.00'), open('9007199254740993.00')]);
    const results = await Promise.all(wallets.map((w, i) => services[i]!.process(input(w, Kind.Bet, '0.01'), randomUUID())));
    expect(results.map(r => r.balance.amount)).toEqual(['9007199254740992.99', '9007199254740992.99']);
    await Promise.all(wallets.map(w => consistent(w.id)));
  });

  test('ledger insertion failure rolls back transaction and wallet; a retry is safe', async () => {
    const wallet = await open();
    const request = input(wallet);
    const key = randomUUID();
    await sources[0]!.query(`CREATE FUNCTION fail_test_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.wallet_id = '${wallet.id}'::uuid THEN RAISE EXCEPTION 'Injected ledger failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_test_ledger BEFORE INSERT ON wallet_ledger_entries FOR EACH ROW EXECUTE FUNCTION fail_test_ledger();`);
    try { await expectFailure(service.process(request, key), 'Injected ledger failure'); }
    finally { await sources[0]!.query('DROP TRIGGER fail_test_ledger ON wallet_ledger_entries; DROP FUNCTION fail_test_ledger();'); }
    expect((await service.getWallet(wallet.id)).balance.amount).toBe('100.00');
    expect(await sources[0]!.manager.countBy(TransactionEntity, { idempotencyKey: key })).toBe(0);
    expect((await service.process(request, key)).balance.amount).toBe('90.00');
    await consistent(wallet.id);
  });

  test('schema rejects mutation, negative balance, excess scale, orphan balance and invalid version', async () => {
    const wallet = await open();
    const [entry] = await sources[0]!.manager.findBy(LedgerEntity, { walletId: wallet.id });
    for (const statement of [
      'UPDATE wallet_ledger_entries SET amount = amount WHERE wallet_id = $1',
      'DELETE FROM wallet_ledger_entries WHERE wallet_id = $1',
      'UPDATE wallets SET balance = -1.00, version = version + 1 WHERE id = $1',
      'UPDATE wallets SET balance = 1.001, version = version + 1 WHERE id = $1',
      'UPDATE wallets SET balance = 99.00, version = version + 1 WHERE id = $1',
      'UPDATE wallets SET version = version + 1 WHERE id = $1',
    ]) await expectFailure(sources[0]!.query(statement, [wallet.id]));
    await expectFailure(sources[0]!.query('TRUNCATE wallet_ledger_entries'));
    await expectFailure(sources[0]!.query("UPDATE wager_transactions SET status = 'PENDING' WHERE id = $1", [entry!.transactionId]));
    await expectFailure(sources[0]!.query('DELETE FROM wager_transactions WHERE id = $1', [entry!.transactionId]));
    await consistent(wallet.id);
  });
});

describe('HTTP contract with real PostgreSQL', () => {
  test('lock timeout returns 503, rolls back and permits retry with the same key', async () => {
    const wallet = await open();
    const request = input(wallet);
    const key = randomUUID();
    const blocker = sources[1]!.createQueryRunner();
    await blocker.connect();
    await blocker.startTransaction();
    try {
      await blocker.query('SELECT id FROM wallets WHERE id = $1 FOR UPDATE', [wallet.id]);
      const response = await post('/wagering/transactions', request, key);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ code: 'INFRASTRUCTURE_UNAVAILABLE' });
      expect(await sources[0]!.manager.countBy(TransactionEntity, { idempotencyKey: key })).toBe(0);
    } finally {
      await blocker.rollbackTransaction();
      await blocker.release();
    }
    expect((await post('/wagering/transactions', request, key)).status).toBe(200);
    await consistent(wallet.id);
  });

  test('validates DTOs under Bun, forbids OPENING, requires header and distinguishes replay/conflict/rejection', async () => {
    const playerId = randomUUID();
    const created = await post('/wallets', { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
    expect(created.status).toBe(201);
    const wallet = await created.json() as { id: string; playerId: string };
    const request = input(wallet, Kind.Bet, '80.00');
    expect((await post('/wallets', { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } })).status).toBe(409);
    expect((await post('/wagering/transactions', request)).status).toBe(400);
    for (const malformed of [
      { ...request, kind: 'OPENING' }, { ...request, kind: 'REFUND' },
      { ...request, money: { amount: 1, currency: 'BRL' } },
      { ...request, money: { amount: '-1.00', currency: 'BRL' } },
      { ...request, money: { amount: '1.001', currency: 'BRL' } },
      { ...request, referenceExternalTransactionId: 'not-supported-yet' },
      { ...request, walletId: 'invalid' }, { ...request, extra: true },
    ]) expect((await post('/wagering/transactions', malformed, randomUUID())).status).toBe(400);
    const key = randomUUID();
    const applied = await post('/wagering/transactions', request, key);
    expect(applied.status).toBe(200);
    const original = await applied.json() as Record<string, unknown>;
    const replay = await post('/wagering/transactions', request, key);
    expect(await replay.json()).toEqual({ ...original, idempotentReplay: true });
    expect((await post('/wagering/transactions', { ...request, roundId: 'different' }, key)).status).toBe(409);
    expect((await post('/wagering/transactions', input(wallet, Kind.Bet, '80.00'), randomUUID())).status).toBe(422);
    expect((await fetch(`${baseUrl}/wagering/transactions/${original.transactionId}`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/providers/${request.providerId}/wagering/transactions/${request.externalTransactionId}`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/wallets/not-a-uuid`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/wallets/${randomUUID()}`)).status).toBe(404);
    await consistent(wallet.id);
  });

  test('ledger pagination is stable and cursor belongs to its wallet', async () => {
    const wallet = await open();
    await service.process(input(wallet), randomUUID());
    const first = await fetch(`${baseUrl}/wallets/${wallet.id}/ledger?limit=1`);
    const page = await first.json() as { entries: { id: string }[]; nextCursor: string };
    expect(page.entries).toHaveLength(1);
    const second = await fetch(`${baseUrl}/wallets/${wallet.id}/ledger?limit=1&cursor=${page.nextCursor}`);
    const next = await second.json() as { entries: { id: string }[]; nextCursor: null };
    expect(next.entries).toHaveLength(1);
    expect(next.entries[0]!.id).not.toBe(page.entries[0]!.id);
    expect(next.nextCursor).toBeNull();
    const other = await open();
    expect((await fetch(`${baseUrl}/wallets/${other.id}/ledger?cursor=${page.nextCursor}`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/wallets/${wallet.id}/ledger?cursor=invalid`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/wallets/${wallet.id}/ledger?limit=0`)).status).toBe(400);
    await consistent(wallet.id);
  });
});
