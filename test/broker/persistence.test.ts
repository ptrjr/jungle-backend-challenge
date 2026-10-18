import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { CreateQueueCommand, GetQueueAttributesCommand, ListQueuesCommand, ReceiveMessageCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { waitUntil } from '../helpers/messaging';
import { createTestDatabase } from '../helpers/postgres';
import { SqsService, loadSqsConfig } from '../../src/messaging/sqs.service';
import { OutboxPublisher } from '../../src/messaging/outbox.publisher';
import { WagerTransactionKind } from '../../src/domain/wager-transaction';

test('isolated broker restart measures durability and recovers only unconfirmed outbox events', async () => {
  Logger.overrideLogger(false);
  const project = `jungle-broker-${randomUUID().slice(0, 8)}`;
  async function compose(...args: string[]) {
    const child = Bun.spawn(['docker', 'compose', '-f', 'compose.broker-test.yaml', '-p', project, ...args], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`Isolated compose failed: ${stderr}`);
    return stdout.trim();
  }
  const database = await createTestDatabase();
  let sqs: SqsService | undefined;
  try {
    await compose('up', '-d', '--wait');
    const address = await compose('port', 'broker', '4566');
    sqs = new SqsService({ ...loadSqsConfig(), endpoint: `http://${address}` });
    async function ensureQueues() {
      for (const name of [sqs!.config.requestQueue, sqs!.config.deadLetterQueue, sqs!.config.eventQueue]) {
        await sqs!.client.send(new CreateQueueCommand({ QueueName: name, Attributes: { FifoQueue: 'true' } }));
      }
    }
    await ensureQueues();
    const wallet = await database.services[0]!.openWallet(randomUUID(), { amount: '100.00', currency: 'BRL' });
    await new OutboxPublisher(database.sources[0]!, sqs).runBatch();
    await database.services[0]!.process({ providerId: 'broker-test', externalTransactionId: randomUUID(), walletId: wallet.id,
      playerId: wallet.playerId, roundId: 'round', gameId: 'game', kind: WagerTransactionKind.Bet,
      money: { amount: '10.00', currency: 'BRL' } }, randomUUID());
    await sqs.client.send(new SendMessageCommand({ QueueUrl: await sqs.queueUrl(sqs.config.requestQueue), MessageBody: 'durability-probe',
      MessageGroupId: 'probe', MessageDeduplicationId: randomUUID() }));
    await compose('restart', 'broker');
    await compose('up', '-d', '--wait');
    const restartedAddress = await compose('port', 'broker', '4566');
    sqs.onApplicationShutdown();
    sqs = new SqsService({ ...loadSqsConfig(), endpoint: `http://${restartedAddress}` });
    await waitUntil(async () => {
      try { await sqs!.client.send(new ListQueuesCommand({})); return true; }
      catch { return undefined; }
    }, 15000);
    let requestSurvived = false;
    let publishedEventsSurvived = false;
    try {
      const message = await sqs.client.send(new ReceiveMessageCommand({ QueueUrl: await sqs.queueUrl(sqs.config.requestQueue), WaitTimeSeconds: 1 }));
      requestSurvived = message.Messages?.[0]?.Body === 'durability-probe';
      const attributes = await sqs.client.send(new GetQueueAttributesCommand({ QueueUrl: await sqs.queueUrl(sqs.config.eventQueue), AttributeNames: ['ApproximateNumberOfMessages'] }));
      publishedEventsSurvived = attributes.Attributes?.ApproximateNumberOfMessages === '2';
    } catch (error) {
      if (!(error instanceof Error) || !['QueueDoesNotExist', 'AWS.SimpleQueueService.NonExistentQueue'].includes(error.name)) throw error;
    }
    await ensureQueues();
    const source = database.sources[0]!;
    const [before] = await source.query(`SELECT count(*) FILTER (WHERE published_at IS NULL)::int AS pending,
      count(*) FILTER (WHERE published_at IS NOT NULL)::int AS published FROM outbox_messages`);
    expect(before).toEqual({ pending: 2, published: 2 });
    const recoveredSource = await import('../../src/database/data-source').then(m => m.createDataSource(database.scopedUrl).initialize());
    try { await new OutboxPublisher(recoveredSource, sqs).runBatch(); }
    finally { await recoveredSource.destroy(); }
    const [after] = await source.query(`SELECT count(*) FILTER (WHERE published_at IS NULL)::int AS pending,
      count(*) FILTER (WHERE published_at IS NOT NULL)::int AS published FROM outbox_messages`);
    expect(after).toEqual({ pending: 0, published: 4 });
    const attributes = await sqs.client.send(new GetQueueAttributesCommand({ QueueUrl: await sqs.queueUrl(sqs.config.eventQueue), AttributeNames: ['ApproximateNumberOfMessages'] }));
    expect(attributes.Attributes?.ApproximateNumberOfMessages).toBe(publishedEventsSurvived ? '4' : '2');
    const [balance] = await source.query(`SELECT w.balance = SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END) AS consistent
      FROM wallets w JOIN wallet_ledger_entries l ON l.wallet_id=w.id GROUP BY w.id`);
    expect(balance.consistent).toBe(true);
    console.log(JSON.stringify({ scenario: 'broker-restart', project, requestSurvived, publishedEventsSurvived,
      recoveredPendingEvents: 2, alreadyPublishedEventsReplayed: 0, volumePreserved: true }));
  } finally {
    sqs?.onApplicationShutdown();
    await compose('down');
    await database.close();
  }
}, 120000);
