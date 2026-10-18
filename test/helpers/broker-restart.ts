import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { CreateQueueCommand, DeleteMessageCommand, ListQueuesCommand, ReceiveMessageCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { waitUntil } from './messaging';
import { createTestDatabase } from './postgres';
import { createDataSource } from '../../src/database/data-source';
import { SqsService, loadSqsConfig } from '../../src/messaging/sqs.service';
import { OutboxPublisher } from '../../src/messaging/outbox.publisher';
import { WagerTransactionKind } from '../../src/domain/wager-transaction';

export async function brokerRestart(explicitSnapshots: boolean) {
  Logger.overrideLogger(false);
  const project = `jungle-broker-${randomUUID().slice(0, 8)}`;
  async function compose(...args: string[]) {
    const child = Bun.spawn(['docker', 'compose', '-f', 'compose.broker-test.yaml', '-p', project, ...args], {
      env: { ...process.env, BROKER_SAVE_STRATEGY: explicitSnapshots ? 'ON_SHUTDOWN' : '',
        BROKER_LOAD_STRATEGY: explicitSnapshots ? 'ON_STARTUP' : '' }, stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`Isolated compose failed: ${stderr}`);
    return stdout.trim();
  }
  const database = await createTestDatabase();
  const source = database.sources[0]!;
  let sqs: SqsService | undefined;
  try {
    await compose('up', '-d', '--wait');
    sqs = new SqsService({ ...loadSqsConfig(), endpoint: `http://${await compose('port', 'broker', '4566')}` });
    async function ensureQueues() {
      for (const name of [sqs!.config.requestQueue, sqs!.config.deadLetterQueue, sqs!.config.eventQueue]) {
        await sqs!.client.send(new CreateQueueCommand({ QueueName: name, Attributes: { FifoQueue: 'true' } }));
      }
    }
    async function drain(queue: string): Promise<string[]> {
      const bodies: string[] = [];
      try {
        const url = await sqs!.queueUrl(queue);
        for (let i = 0; i < 10; i++) {
          const response = await sqs!.client.send(new ReceiveMessageCommand({ QueueUrl: url, WaitTimeSeconds: 1 }));
          const message = response.Messages?.[0];
          if (!message) break;
          bodies.push(message.Body!);
          await sqs!.client.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: message.ReceiptHandle! }));
        }
      } catch (error) {
        if (!(error instanceof Error) || !['QueueDoesNotExist', 'AWS.SimpleQueueService.NonExistentQueue'].includes(error.name)) throw error;
      }
      return bodies;
    }
    await ensureQueues();
    const wallet = await database.services[0]!.openWallet(randomUUID(), { amount: '100.00', currency: 'BRL' });
    await new OutboxPublisher(source, sqs).runBatch();
    const published = await source.query('SELECT id FROM outbox_messages WHERE published_at IS NOT NULL') as { id: string }[];
    await database.services[0]!.process({ providerId: 'broker-test', externalTransactionId: randomUUID(), walletId: wallet.id,
      playerId: wallet.playerId, roundId: 'round', gameId: 'game', kind: WagerTransactionKind.Bet,
      money: { amount: '10.00', currency: 'BRL' } }, randomUUID());
    const pending = await source.query('SELECT id FROM outbox_messages WHERE published_at IS NULL') as { id: string }[];
    await sqs.client.send(new SendMessageCommand({ QueueUrl: await sqs.queueUrl(sqs.config.requestQueue), MessageBody: 'durability-probe',
      MessageGroupId: 'probe', MessageDeduplicationId: randomUUID() }));
    await compose('exec', '-T', 'broker', 'sh', '-c', 'echo preserved > /var/lib/localstack/volume-probe');
    const runtime = await compose('exec', '-T', 'broker', '/opt/code/localstack/.venv/bin/python', '-c',
      "import json,importlib.util,localstack.config as c; print(json.dumps(dict(persistence=c.PERSISTENCE,save=c.SNAPSHOT_SAVE_STRATEGY,load=c.SNAPSHOT_LOAD_STRATEGY,pro=importlib.util.find_spec('localstack.pro') is not None)))");
    await compose('restart', '--timeout', '45', 'broker');
    await compose('up', '-d', '--wait');
    sqs.onApplicationShutdown();
    sqs = new SqsService({ ...loadSqsConfig(), endpoint: `http://${await compose('port', 'broker', '4566')}` });
    await waitUntil(async () => {
      try { await sqs!.client.send(new ListQueuesCommand({})); return true; } catch { return undefined; }
    }, 15000);
    const volumeMarkerSurvived = (await compose('exec', '-T', 'broker', 'cat', '/var/lib/localstack/volume-probe')) === 'preserved';
    const requestSurvived = (await drain(sqs.config.requestQueue)).includes('durability-probe');
    const survivingPublishedEventIds = (await drain(sqs.config.eventQueue)).map(body => (JSON.parse(body) as { eventId: string }).eventId);
    await ensureQueues();
    const recoveredSource = await createDataSource(database.scopedUrl).initialize();
    try { await new OutboxPublisher(recoveredSource, sqs).runBatch(); } finally { await recoveredSource.destroy(); }
    const recovered = (await drain(sqs.config.eventQueue)).map(body => (JSON.parse(body) as { eventId: string }).eventId);
    const [balance] = await source.query(`SELECT w.balance = SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END) AS consistent
      FROM wallets w JOIN wallet_ledger_entries l ON l.wallet_id=w.id GROUP BY w.id`);
    const report = { scenario: 'broker-restart-diagnostic', project, explicitSnapshots, runtime: JSON.parse(runtime) as unknown,
      volumeMarkerSurvived, requestSurvived, expectedPublishedEventIds: published.map(row => row.id), survivingPublishedEventIds,
      recoveredPendingEvents: recovered.filter(id => pending.some(row => row.id === id)).length,
      alreadyPublishedEventsReplayed: recovered.filter(id => published.some(row => row.id === id)).length,
      consistent: balance.consistent as boolean };
    console.log(JSON.stringify(report));
    return report;
  } finally {
    sqs?.onApplicationShutdown();
    try { await compose('down'); } finally { await database.close(); }
  }
}
