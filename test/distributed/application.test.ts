import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Logger } from '@nestjs/common';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { createMessagingFixture, requested, waitUntil } from '../helpers/messaging';
import { WagerInput, TransactionResult } from '../../src/application/financial-service';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../src/domain/wager-transaction';
import { LedgerDirection } from '../../src/domain/wallet-ledger-entry';
import { InboxEntity, OutboxEntity } from '../../src/database/delivery-entities';
import { LedgerEntity, TransactionEntity } from '../../src/database/entities';

let fixture: Awaited<ReturnType<typeof createMessagingFixture>>;
const processes: { child: ReturnType<typeof Bun.spawn>; pid: number; url: string }[] = [];
const runId = randomUUID().replaceAll('-', '');

async function start(messaging: boolean) {
  await mkdir(resolve('.local'), { recursive: true });
  for (let index = 0; index < 3; index++) {
    const marker = resolve('.local', `application-${runId}-${index}.json`);
    const databaseUrl = new URL(fixture.scopedUrl);
    databaseUrl.searchParams.set('application_name', `distributed-${runId}-${index}`);
    const child = Bun.spawn([process.execPath, 'test/fixtures/application-process.ts'], {
      env: { ...process.env, DATABASE_URL: databaseUrl.toString(), PROCESS_READY_FILE: marker,
        MESSAGING_ENABLED: String(messaging), REFERENCE_WORKER_ENABLED: 'true',
        SQS_ENDPOINT: fixture.config.endpoint, SQS_REQUEST_QUEUE: fixture.config.requestQueue,
        SQS_DLQ: fixture.config.deadLetterQueue, SQS_EVENT_QUEUE: fixture.config.eventQueue },
      stdout: 'ignore', stderr: 'pipe',
    });
    processes.push({ child, pid: child.pid, url: '' });
    await waitUntil(async () => {
      if (child.exitCode !== null) throw new Error(await new Response(child.stderr).text());
      return existsSync(marker) ? true : undefined;
    }, 15000);
    const ready = JSON.parse(await readFile(marker, 'utf8')) as { pid: number; url: string };
    Object.assign(processes[index]!, ready);
    await unlink(marker);
  }
  expect(new Set(processes.map(p => p.pid)).size).toBe(3);
  expect(processes.every(p => p.child.exitCode === null)).toBe(true);
  console.log(JSON.stringify({ scenario: 'independent-applications', messaging, pids: processes.map(p => p.pid), urls: processes.map(p => p.url) }));
}

async function stop() {
  await Promise.all(processes.map(async ({ child }) => {
    child.kill('SIGTERM');
    const deadline = setTimeout(() => child.kill('SIGKILL'), 12000);
    try { await child.exited; } finally { clearTimeout(deadline); }
  }));
  processes.length = 0;
}

beforeAll(async () => {
  Logger.overrideLogger(false);
  fixture = await createMessagingFixture();
  await start(false);
});
afterAll(async () => {
  await stop();
  if (fixture) {
    try { await consistent(); } finally { await fixture.close(); }
  }
});

const open = () => fixture.financial.openWallet(randomUUID(), { amount: '100.00', currency: 'BRL' });
function bet(wallet: { id: string; playerId: string }, amount = '80.00'): WagerInput {
  return { providerId: 'distributed', externalTransactionId: randomUUID(), walletId: wallet.id, playerId: wallet.playerId,
    roundId: 'round', gameId: 'game', kind: Kind.Bet, money: { amount, currency: 'BRL' } };
}
async function post(index: number, input: WagerInput): Promise<{ status: number; result: TransactionResult }> {
  const response = await fetch(`${processes[index]!.url}/wagering/transactions`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `${input.providerId}:${input.externalTransactionId}` },
    body: JSON.stringify(input) });
  return { status: response.status, result: await response.json() as TransactionResult };
}
async function locked(walletId: string) {
  const runner = fixture.source.createQueryRunner();
  await runner.connect(); await runner.startTransaction();
  await runner.query('SELECT id FROM wallets WHERE id = $1 FOR UPDATE', [walletId]);
  return runner;
}
async function waitingProcesses(count: number) {
  return waitUntil(async () => {
    const rows = await fixture.source.query(`SELECT DISTINCT application_name FROM pg_stat_activity
      WHERE application_name LIKE $1 AND wait_event_type = 'Lock'`, [`distributed-${runId}-%`]) as unknown[];
    return rows.length >= count ? rows.length : undefined;
  }, 4000);
}
async function consistent() {
  const rows = await fixture.source.query(`SELECT w.id FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
    GROUP BY w.id HAVING w.balance < 0 OR w.balance <> COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END),0)`);
  expect(rows).toHaveLength(0);
}

test('two independent processes really overlap: 80 + 80 against 100 debits once', async () => {
  const wallet = await open();
  const blocker = await locked(wallet.id);
  const pending = Promise.all([post(0, bet(wallet)), post(1, bet(wallet))]);
  try { expect(await waitingProcesses(2)).toBe(2); }
  finally { await blocker.rollbackTransaction(); await blocker.release(); }
  const results = await pending;
  expect(results.map(r => r.status).sort()).toEqual([200, 422]);
  expect(results.filter(r => r.result.status === 'PROCESSED')).toHaveLength(1);
  expect(results.find(r => r.status === 422)!.result.failureCode).toBe('INSUFFICIENT_FUNDS');
  expect((await fixture.financial.getWallet(wallet.id)).balance.amount).toBe('20.00');
  expect(await fixture.source.manager.countBy(LedgerEntity, { walletId: wallet.id, direction: LedgerDirection.Debit })).toBe(1);
  await consistent();
});

test('50 simultaneous HTTP duplicates across three processes preserve the original financial result', async () => {
  const wallet = await open();
  const input = bet(wallet);
  const blocker = await locked(wallet.id);
  const started = performance.now();
  const pending = Promise.all(Array.from({ length: 50 }, (_, index) => post(index % 3, input)));
  try { expect(await waitingProcesses(3)).toBe(3); }
  finally { await blocker.rollbackTransaction(); await blocker.release(); }
  const responses = await pending;
  expect(responses.every(r => r.status === 200 && r.result.status === 'PROCESSED' && r.result.balance.amount === '20.00')).toBe(true);
  expect(new Set(responses.map(r => r.result.transactionId)).size).toBe(1);
  expect(responses.filter(r => !r.result.idempotentReplay)).toHaveLength(1);
  const id = responses[0]!.result.transactionId;
  expect(await fixture.source.manager.countBy(LedgerEntity, { transactionId: id })).toBe(1);
  expect(await fixture.source.manager.countBy(OutboxEntity, { transactionId: id })).toBe(2);
  await fixture.financial.process({ ...bet(wallet, '10.00'), kind: Kind.Win }, randomUUID());
  expect((await post(2, input)).result).toEqual({ ...responses[0]!.result, idempotentReplay: true });
  expect((await fixture.financial.getWallet(wallet.id)).balance.amount).toBe('30.00');
  console.log(JSON.stringify({ scenario: '50-http-duplicates', requests: 50, processes: 3, debits: 1, durationMs: Math.round(performance.now() - started) }));
  await consistent();
});

test('a locked wallet does not block other wallets on either of the other processes', async () => {
  const wallets = await Promise.all([open(), open(), open()]);
  const blocker = await locked(wallets[0]!.id);
  const blocked = post(0, bet(wallets[0]!));
  try {
    await waitingProcesses(1);
    const others = await Promise.all([post(1, bet(wallets[1]!)), post(2, bet(wallets[2]!))]);
    expect(others.every(r => r.status === 200 && r.result.balance.amount === '20.00')).toBe(true);
    expect((await fixture.financial.getWallet(wallets[0]!.id)).balance.amount).toBe('100.00');
  } finally { await blocker.rollbackTransaction(); await blocker.release(); }
  expect((await blocked).status).toBe(200);
  await consistent();
});

test('three restarted consumers drain 50 SQS duplicates and concurrent publishers recover pending events', async () => {
  await stop();
  const wallet = await open();
  for (let index = 0; index < 60; index++) {
    const loss: WagerInput = { ...bet(wallet, '0.00'), kind: Kind.Loss };
    await fixture.financial.process(loss, randomUUID());
  }
  const message = requested(bet(wallet));
  await Promise.all(Array.from({ length: 50 }, () => fixture.send(message)));
  const [{ pending }] = await fixture.source.query('SELECT count(*)::int AS pending FROM outbox_messages WHERE published_at IS NULL');
  expect(pending).toBeGreaterThan(0);
  const blocker = await locked(wallet.id);
  await blocker.query('SELECT id FROM outbox_messages WHERE published_at IS NULL FOR UPDATE');
  try {
    await start(true);
    expect(await waitingProcesses(3)).toBe(3);
  } finally { await blocker.rollbackTransaction(); await blocker.release(); }
  await waitUntil(async () => {
    const response = await fixture.sqs.client.send(new GetQueueAttributesCommand({ QueueUrl: await fixture.sqs.queueUrl(fixture.config.requestQueue),
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] }));
    return response.Attributes?.ApproximateNumberOfMessages === '0' && response.Attributes?.ApproximateNumberOfMessagesNotVisible === '0' ? true : undefined;
  }, 20000);
  const receipt = await fixture.source.manager.findOneByOrFail(InboxEntity, { messageId: message.messageId });
  expect(receipt.processedAt).not.toBeNull();
  expect(await fixture.source.manager.countBy(InboxEntity, { messageId: message.messageId })).toBe(1);
  expect(await fixture.source.manager.countBy(LedgerEntity, { transactionId: receipt.transactionId! })).toBe(1);
  expect((await fixture.financial.getWallet(wallet.id)).balance.amount).toBe('20.00');
  await waitUntil(async () => {
    const [{ pending }] = await fixture.source.query('SELECT count(*)::int AS pending FROM outbox_messages WHERE published_at IS NULL');
    return pending === 0 ? true : undefined;
  }, 15000);
  const metrics = await Promise.all(processes.map(async p => (await (await fetch(`${p.url}/metrics`)).text())));
  expect(metrics.every(text => /^processing_seconds_count [1-9]\d*$/m.test(text))).toBe(true);
  expect(metrics.reduce((sum, text) => sum + Number(text.match(/^messaging_duplicates_total (\d+)$/m)![1]), 0)).toBe(49);
  expect(metrics.filter(text => /^outbox_published_total [1-9]\d*$/m.test(text)).length).toBeGreaterThanOrEqual(2);
  expect(await fixture.sqs.deadLetterDepth()).toBe(0);
  const row = await fixture.source.manager.findOneByOrFail(TransactionEntity, { id: receipt.transactionId! });
  expect(row.status).toBe(Status.Processed);
  const [{ repeated }] = await fixture.source.query('SELECT count(*)::int AS repeated FROM outbox_messages WHERE attempts <> 1');
  expect(repeated).toBe(0);
  console.log(JSON.stringify({ scenario: '50-sqs-duplicates-after-restart', deliveries: 50, processes: 3, inboxReceipts: 1, debits: 1, pendingEvents: 0 }));
  await consistent();
});
