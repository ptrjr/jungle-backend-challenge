import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Logger, type INestApplication } from '@nestjs/common';
import { createMessagingFixture, configureProxies, enableProxy, requested, waitUntil } from '../helpers/messaging';
import { captureFailure } from '../helpers/postgres';
import { InboxEntity, OutboxEntity } from '../../src/database/delivery-entities';
import { LedgerEntity, TransactionEntity } from '../../src/database/entities';
import { WagerTransactionKind as Kind } from '../../src/domain/wager-transaction';
import { WagerInput, FinancialService } from '../../src/application/financial-service';
import { ReferenceWorker } from '../../src/application/reference.worker';
import { ReconciliationService } from '../../src/application/reconciliation.service';
import { InboxProcessor } from '../../src/messaging/inbox.processor';
import { SqsConsumer } from '../../src/messaging/sqs.consumer';
import { SqsService } from '../../src/messaging/sqs.service';
import { OutboxPublisher } from '../../src/messaging/outbox.publisher';
import { parseRequestedMessage, RequestedWagerMessage } from '../../src/messaging/request-message';
import { createDataSource } from '../../src/database/data-source';
import { createApp } from '../../src/bootstrap';

let fixture: Awaited<ReturnType<typeof createMessagingFixture>>;
const previousMessaging = process.env.MESSAGING_ENABLED;
beforeAll(async () => { Logger.overrideLogger(false); process.env.MESSAGING_ENABLED = 'false'; await configureProxies(); });
beforeEach(async () => { fixture = await createMessagingFixture(); });
afterEach(async () => {
  await Promise.all([enableProxy('postgres', true), enableProxy('sqs', true)]);
  if (fixture) {
    try {
      const rows: unknown[] = await fixture.source.query(`SELECT w.id FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
        GROUP BY w.id HAVING w.balance <> COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)`);
      expect(rows).toHaveLength(0);
    } finally { await fixture.close(); }
  }
});
afterAll(async () => { if (previousMessaging === undefined) delete process.env.MESSAGING_ENABLED; else process.env.MESSAGING_ENABLED = previousMessaging; });

const open = (amount = '100.00') => fixture.financial.openWallet(randomUUID(), { amount, currency: 'BRL' });
function input(wallet: { id: string; playerId: string }, kind: WagerInput['kind'] = Kind.Bet, amount = '10.00', reference?: string): WagerInput {
  return { providerId: 'provider', externalTransactionId: randomUUID(), walletId: wallet.id, playerId: wallet.playerId,
    roundId: 'round', gameId: 'game', kind, money: { amount, currency: 'BRL' },
    ...(reference ? { referenceExternalTransactionId: reference } : {}) };
}
const eventCount = (id: string, type?: string) => fixture.source.manager.countBy(OutboxEntity, { transactionId: id, ...(type ? { eventType: type } : {}) });
async function receiveAndProcess(body: RequestedWagerMessage): Promise<string> {
  await fixture.send(body);
  expect(await fixture.consumer.runOnce(1)).toBe(true);
  const inbox = await fixture.source.manager.findOneByOrFail(InboxEntity, { messageId: body.messageId });
  return inbox.transactionId!;
}

async function crashAt(window: 'before-ack' | 'after-publish'): Promise<void> {
  const marker = resolve('.local', `crash-${randomUUID()}.marker`);
  await mkdir(resolve('.local'), { recursive: true });
  const child = Bun.spawn([process.execPath, 'test/fixtures/crash-worker.ts'], {
    env: { ...process.env, CRASH_DATABASE_URL: fixture.scopedUrl, CRASH_MARKER: marker, CRASH_WINDOW: window,
      SQS_ENDPOINT: fixture.config.endpoint, SQS_REQUEST_QUEUE: fixture.config.requestQueue,
      SQS_DLQ: fixture.config.deadLetterQueue, SQS_EVENT_QUEUE: fixture.config.eventQueue },
    stdout: 'ignore', stderr: 'pipe',
  });
  try {
    await waitUntil(async () => {
      if (child.exitCode !== null) throw new Error(await new Response(child.stderr).text());
      return existsSync(marker) ? true : undefined;
    }, 12000);
  } finally {
    child.kill('SIGKILL');
    await child.exited;
    if (existsSync(marker)) await unlink(marker);
  }
}

describe('atomic inbox and outbox', () => {
  test('concurrent SQS duplicates across independent FIFO groups debit once', async () => {
    const wallet = await open();
    const message = requested(input(wallet));
    await Promise.all(Array.from({ length: 8 }, () => fixture.send(message)));
    const consumers = fixture.sources.map((source, i) => new SqsConsumer(fixture.sqs, new InboxProcessor(source, fixture.services[i]!)));
    await Promise.all(consumers.map(async consumer => { for (let i = 0; i < 8; i++) if (!await consumer.runOnce()) break; }));
    expect(await fixture.source.manager.countBy(InboxEntity, { messageId: message.messageId })).toBe(1);
    expect((await fixture.financial.getWallet(wallet.id)).balance.amount).toBe('90.00');
    const row = await fixture.source.manager.findOneByOrFail(TransactionEntity, { externalTransactionId: message.data.externalTransactionId });
    expect(await fixture.source.manager.countBy(LedgerEntity, { transactionId: row.id })).toBe(1);
    expect(await eventCount(row.id)).toBe(2);
    expect(await fixture.sqs.receive()).toBeUndefined();
  });

  test('redelivery after commit skips effects and preserves original result', async () => {
    const wallet = await open();
    const body = requested(input(wallet));
    await fixture.send(body);
    const delivery = await fixture.sqs.receive(1);
    const first = await fixture.inbox.process(parseRequestedMessage(delivery!.Body));
    await fixture.sqs.visibility(delivery!, 0);
    expect(await fixture.consumer.runOnce(1)).toBe(true);
    expect((await fixture.financial.getWallet(wallet.id)).balance.amount).toBe('90.00');
    expect(await eventCount(first.transactionId)).toBe(2);
    expect(await fixture.source.manager.countBy(InboxEntity, { messageId: body.messageId })).toBe(1);
  });

  test('conflicting inbox payload goes to DLQ without a second debit', async () => {
    const wallet = await open();
    const first = requested(input(wallet));
    await receiveAndProcess(first);
    await fixture.send({ ...first, data: { ...first.data, money: { amount: '11.00', currency: 'BRL' } } });
    await fixture.consumer.runOnce(1);
    const rejected = await fixture.receive(fixture.config.deadLetterQueue);
    expect(rejected?.MessageAttributes?.failureCode?.StringValue).toBe('INBOX_PAYLOAD_CONFLICT');
    expect((await fixture.financial.getWallet(wallet.id)).balance.amount).toBe('90.00');
  });

  test('financial identity shared by HTTP and SQS produces one effect and two accepted inbox receipts', async () => {
    const wallet = await open();
    const request = input(wallet);
    const first = requested(request);
    const applied = await fixture.financial.process(request, first.data.idempotencyKey);
    await receiveAndProcess(first);
    await receiveAndProcess(requested(request));
    expect(await fixture.source.manager.countBy(InboxEntity, { transactionId: applied.transactionId })).toBe(2);
    expect(await eventCount(applied.transactionId)).toBe(2);
    expect((await fixture.financial.getWallet(wallet.id)).balance.amount).toBe('90.00');
  });

  test('an outbox failure rolls back inbox, transaction, balance and ledger together', async () => {
    const wallet = await open();
    const body = requested(input(wallet));
    await fixture.send(body);
    const delivery = await fixture.sqs.receive(1);
    await fixture.source.query(`CREATE FUNCTION fail_outbox_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Injected outbox failure'; END $$;
      CREATE TRIGGER fail_outbox_test BEFORE INSERT ON outbox_messages FOR EACH ROW EXECUTE FUNCTION fail_outbox_test();`);
    try { expect((await captureFailure(fixture.inbox.process(parseRequestedMessage(delivery!.Body)))).message).toContain('Injected outbox failure'); }
    finally { await fixture.source.query('DROP TRIGGER fail_outbox_test ON outbox_messages; DROP FUNCTION fail_outbox_test();'); }
    expect(await fixture.source.manager.countBy(InboxEntity, { messageId: body.messageId })).toBe(0);
    expect(await fixture.source.manager.countBy(TransactionEntity, { externalTransactionId: body.data.externalTransactionId })).toBe(0);
    expect(await fixture.source.manager.countBy(LedgerEntity, { walletId: wallet.id })).toBe(1);
    expect((await fixture.financial.getWallet(wallet.id)).balance.amount).toBe('100.00');
    await fixture.consumer.processReceived(delivery!);
    expect((await fixture.financial.getWallet(wallet.id)).balance.amount).toBe('90.00');
  });

  test('uncommitted events cannot be seen or published by another connection', async () => {
    const wallet = await open('0.00');
    const runner = fixture.sources[1]!.createQueryRunner();
    await runner.connect(); await runner.startTransaction();
    try {
      const request = input(wallet, Kind.Win);
      const result = await fixture.services[1]!.process(request, randomUUID(), { correlationId: 'uncommitted' }, runner.manager);
      expect(await eventCount(result.transactionId)).toBe(0);
      expect(await fixture.publisher.publishOne()).toBe(false);
      expect(await fixture.receive(fixture.config.eventQueue)).toBeUndefined();
      await runner.commitTransaction();
      expect(await eventCount(result.transactionId)).toBe(2);
      expect(await fixture.publisher.publishOne()).toBe(true);
    } finally { if (runner.isTransactionActive) await runner.rollbackTransaction(); await runner.release(); }
  });

  test('LOSS and business rejection emit transaction events without balance-change events', async () => {
    const wallet = await open('0.00');
    const loss = await receiveAndProcess(requested(input(wallet, Kind.Loss, '0.00')));
    const rejection = await receiveAndProcess(requested(input(wallet, Kind.Bet)));
    expect(await eventCount(loss, 'WagerTransactionProcessed')).toBe(1);
    expect(await eventCount(rejection, 'WagerTransactionRejected')).toBe(1);
    expect(await eventCount(loss, 'WalletBalanceChanged')).toBe(0);
    expect(await eventCount(rejection, 'WalletBalanceChanged')).toBe(0);
    expect(await fixture.receive(fixture.config.deadLetterQueue)).toBeUndefined();
    expect(await fixture.sqs.receive()).toBeUndefined();
  });

  test('delivery history and event payload are protected by PostgreSQL', async () => {
    const wallet = await open();
    const message = requested(input(wallet));
    const id = await receiveAndProcess(message);
    expect((await captureFailure(fixture.source.query('UPDATE outbox_messages SET payload = $1 WHERE transaction_id = $2', [{}, id]))).driverError?.code).toBe('23514');
    expect((await captureFailure(fixture.source.query('DELETE FROM outbox_messages WHERE transaction_id = $1', [id]))).driverError?.code).toBe('23514');
    expect((await captureFailure(fixture.source.query("UPDATE inbox_messages SET payload_hash = repeat('b',64) WHERE message_id = $1", [message.messageId]))).driverError?.code).toBe('23514');
  });
});

describe('crash and network recovery', () => {
  test('a worker killed after commit and before ack is safely redelivered', async () => {
    const wallet = await open();
    const body = requested(input(wallet));
    await fixture.send(body);
    await crashAt('before-ack');
    expect(await fixture.source.manager.countBy(InboxEntity, { messageId: body.messageId })).toBe(1);
    expect((await fixture.financial.getWallet(wallet.id)).balance.amount).toBe('90.00');
    const delivery = await waitUntil(() => fixture.sqs.receive());
    await fixture.consumer.processReceived(delivery);
    expect((await fixture.financial.getWallet(wallet.id)).balance.amount).toBe('90.00');
    expect(await fixture.source.manager.countBy(InboxEntity, { messageId: body.messageId })).toBe(1);
    expect(await fixture.sqs.receive()).toBeUndefined();
  });

  test('a publisher killed after send and before commit republishes the same eventId', async () => {
    await open();
    await crashAt('after-publish');
    const first = await waitUntil(() => fixture.receive(fixture.config.eventQueue));
    const envelope = JSON.parse(first.Body!) as { eventId: string };
    const pending = await fixture.source.manager.findOneByOrFail(OutboxEntity, { id: envelope.eventId });
    expect(pending.publishedAt).toBeNull();
    await fixture.publisher.runBatch();
    const copies = [];
    for (let i = 0; i < 3; i++) {
      const message = await fixture.receive(fixture.config.eventQueue);
      if (message) copies.push(JSON.parse(message.Body!) as { eventId: string });
    }
    // The original receipt blocks its FIFO group until made visible again or acknowledged.
    await fixture.acknowledge(fixture.config.eventQueue, first);
    const duplicate = await waitUntil(() => fixture.receive(fixture.config.eventQueue));
    copies.push(JSON.parse(duplicate.Body!) as { eventId: string });
    expect(copies.some(copy => copy.eventId === envelope.eventId)).toBe(true);
    expect((await fixture.source.manager.findOneByOrFail(OutboxEntity, { id: envelope.eventId })).publishedAt).not.toBeNull();
  });

  test('temporary SQS outage persists outbox backoff and a new publisher recovers it', async () => {
    await open();
    const transport = new SqsService({ ...fixture.config, endpoint: 'http://127.0.0.1:8667', requestTimeoutMs: 700 });
    try {
      await transport.ready();
      await enableProxy('sqs', false);
      expect(await new OutboxPublisher(fixture.source, transport).publishOne()).toBe(true);
      const failed = await fixture.source.manager.findOneByOrFail(OutboxEntity, { attempts: 1 });
      expect(failed.publishedAt).toBeNull();
      expect(failed.nextAttemptAt).not.toBeNull();
      await enableProxy('sqs', true);
      const restarted = await createDataSource(fixture.scopedUrl).initialize();
      try { await new OutboxPublisher(restarted, transport).runBatch(new Date(failed.nextAttemptAt!.getTime() + 1)); }
      finally { await restarted.destroy(); }
      const published = await fixture.source.manager.findOneByOrFail(OutboxEntity, { id: failed.id });
      expect(published.attempts).toBe(2);
      expect(published.publishedAt).not.toBeNull();
    } finally { await enableProxy('sqs', true); transport.onApplicationShutdown(); }
  });

  test('temporary PostgreSQL outage leaves SQS unacked and retry commits once after reconnection', async () => {
    const wallet = await open();
    const url = new URL(fixture.scopedUrl); url.port = '8666';
    const source = await createDataSource(url.toString()).initialize();
    const consumer = new SqsConsumer(fixture.sqs, new InboxProcessor(source, new FinancialService(source)));
    const body = requested(input(wallet));
    await fixture.send(body);
    const delivery = await fixture.sqs.receive(1);
    try {
      await enableProxy('postgres', false);
      await consumer.processReceived(delivery!);
      expect(await fixture.source.manager.countBy(InboxEntity, { messageId: body.messageId })).toBe(0);
      expect((await fixture.financial.getWallet(wallet.id)).balance.amount).toBe('100.00');
      await enableProxy('postgres', true);
      await fixture.sqs.visibility(delivery!, 0);
      expect(await consumer.runOnce(1)).toBe(true);
      expect((await fixture.financial.getWallet(wallet.id)).balance.amount).toBe('90.00');
      expect(await fixture.source.manager.countBy(InboxEntity, { messageId: body.messageId })).toBe(1);
    } finally { await enableProxy('postgres', true); await source.destroy(); }
  });

  test('permanent malformed messages go to DLQ and repeated transient failures follow broker redrive', async () => {
    await fixture.send('{invalid-json');
    await fixture.consumer.runOnce(1);
    const malformed = await fixture.receive(fixture.config.deadLetterQueue);
    expect(malformed?.MessageAttributes?.failureCode?.StringValue).toBe('MALFORMED_SQS_REQUEST');
    await fixture.acknowledge(fixture.config.deadLetterQueue, malformed!);
    const wallet = await open();
    const body = requested(input(wallet));
    await fixture.source.query(`CREATE FUNCTION transient_outbox_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Injected transient infrastructure failure'; END $$;
      CREATE TRIGGER transient_outbox_test BEFORE INSERT ON outbox_messages FOR EACH ROW EXECUTE FUNCTION transient_outbox_test();`);
    try {
      await fixture.send(body);
      for (let attempt = 1; attempt <= 3; attempt++) {
        const delivery = await waitUntil(() => fixture.sqs.receive());
        expect(Number(delivery.Attributes?.ApproximateReceiveCount)).toBe(attempt);
        await fixture.consumer.processReceived(delivery);
        await fixture.sqs.visibility(delivery, 0);
      }
      expect(await fixture.sqs.receive()).toBeUndefined();
      const dead = await waitUntil(() => fixture.receive(fixture.config.deadLetterQueue));
      expect(JSON.parse(dead.Body!).messageId).toBe(body.messageId);
      expect(await fixture.source.manager.countBy(InboxEntity, { messageId: body.messageId })).toBe(0);
      expect((await fixture.financial.getWallet(wallet.id)).balance.amount).toBe('100.00');
    } finally { await fixture.source.query('DROP TRIGGER transient_outbox_test ON outbox_messages; DROP FUNCTION transient_outbox_test();'); }
  });

  test('publishers on independent pools publish each pending row once during normal concurrency', async () => {
    const wallet = await open();
    for (let i = 0; i < 5; i++) {
      const request = input(wallet, Kind.Win);
      await fixture.financial.process(request, randomUUID());
    }
    await Promise.all(fixture.sources.map(source => new OutboxPublisher(source, fixture.sqs).runBatch()));
    const rows = await fixture.source.manager.find(OutboxEntity);
    expect(rows).toHaveLength(12);
    expect(rows.every(row => row.publishedAt !== null && row.attempts === 1)).toBe(true);
  });

  test('shutdown waits for a committed in-flight message before acknowledging and stopping polling', async () => {
    const wallet = await open();
    const body = requested(input(wallet));
    let commitReached!: () => void;
    let release!: () => void;
    const committed = new Promise<void>(resolve => { commitReached = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    class PausedInbox extends InboxProcessor {
      override async process(message: RequestedWagerMessage) {
        const result = await super.process(message);
        commitReached(); await gate;
        return result;
      }
    }
    const consumer = new SqsConsumer(fixture.sqs, new PausedInbox(fixture.source, fixture.financial));
    await fixture.send(body);
    process.env.MESSAGING_ENABLED = 'true'; consumer.onApplicationBootstrap(); process.env.MESSAGING_ENABLED = 'false';
    try {
      await committed;
      let stopped = false;
      const shutdown = consumer.beforeApplicationShutdown().then(() => { stopped = true; });
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(stopped).toBe(false);
      release(); await shutdown;
      expect(await fixture.sqs.receive()).toBeUndefined();
      expect((await fixture.financial.getWallet(wallet.id)).balance.amount).toBe('90.00');
    } finally { release(); await consumer.beforeApplicationShutdown(); }
  });
});

describe('reference events and dependency health', () => {
  test('out-of-order reference recovery and expiration enqueue correlated events exactly once', async () => {
    const wallet = await open();
    const bet = input(wallet);
    const refund = requested(input(wallet, Kind.Refund, '10.00', bet.externalTransactionId));
    const pendingId = await receiveAndProcess(refund);
    expect(await eventCount(pendingId, 'WagerTransactionPendingReference')).toBe(1);
    await receiveAndProcess(requested(bet));
    const pending = await fixture.source.manager.findOneByOrFail(TransactionEntity, { id: pendingId });
    await new ReferenceWorker(fixture.financial).runBatch(pending.nextAttemptAt!);
    expect(await eventCount(pendingId)).toBe(3);
    const processed = await fixture.source.manager.findOneByOrFail(OutboxEntity, { transactionId: pendingId, eventType: 'WagerTransactionProcessed' });
    expect(processed.payload.correlationId).toBe(refund.correlationId!);
    expect(processed.payload.causationId).toBe(refund.messageId);
    const expiringId = await receiveAndProcess(requested(input(wallet, Kind.Refund, '10.00', randomUUID())));
    for (let attempt = 0; attempt < 8; attempt++) {
      const row = await fixture.source.manager.findOneByOrFail(TransactionEntity, { id: expiringId });
      await new ReferenceWorker(fixture.financial).runBatch(row.nextAttemptAt!);
    }
    expect(await eventCount(expiringId, 'WagerTransactionPendingReference')).toBe(1);
    expect(await eventCount(expiringId, 'WagerTransactionRejected')).toBe(1);
    expect(await eventCount(expiringId, 'WalletBalanceChanged')).toBe(0);
    expect((await new ReconciliationService(fixture.source).reconcile(wallet.id)).consistent).toBe(true);
  });

  test('HTTP liveness stays up while readiness reports real SQS or PostgreSQL outages', async () => {
    const previous = { ...process.env };
    const url = new URL(fixture.scopedUrl); url.port = '8666';
    process.env.DATABASE_URL = url.toString();
    process.env.SQS_ENDPOINT = 'http://127.0.0.1:8667';
    process.env.SQS_REQUEST_QUEUE = fixture.config.requestQueue;
    process.env.SQS_DLQ = fixture.config.deadLetterQueue;
    process.env.SQS_EVENT_QUEUE = fixture.config.eventQueue;
    process.env.REFERENCE_WORKER_ENABLED = 'false';
    let app: INestApplication | undefined;
    try {
      app = await createApp(); app.useLogger(false); await app.listen(0, '127.0.0.1');
      const base = await app.getUrl();
      expect((await fetch(`${base}/health/ready`)).status).toBe(200);
      await enableProxy('sqs', false);
      expect((await fetch(`${base}/health/live`)).status).toBe(200);
      expect((await fetch(`${base}/health/ready`)).status).toBe(503);
      await enableProxy('sqs', true); await enableProxy('postgres', false);
      expect((await fetch(`${base}/health/live`)).status).toBe(200);
      expect((await fetch(`${base}/health/ready`)).status).toBe(503);
      await enableProxy('postgres', true);
      expect((await fetch(`${base}/health/ready`)).status).toBe(200);
      const metrics = await (await fetch(`${base}/metrics`)).text();
      expect(metrics).toContain('messaging_retries_total');
      expect(metrics).toContain('outbox_lag_seconds');
    } finally {
      await Promise.all([enableProxy('postgres', true), enableProxy('sqs', true)]);
      if (app) await app.close();
      for (const key of ['DATABASE_URL','SQS_ENDPOINT','SQS_REQUEST_QUEUE','SQS_DLQ','SQS_EVENT_QUEUE','REFERENCE_WORKER_ENABLED']) {
        if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
      }
    }
  });
});
