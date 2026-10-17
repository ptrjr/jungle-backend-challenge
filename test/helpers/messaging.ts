import { randomUUID } from 'node:crypto';
import { CreateQueueCommand, DeleteMessageCommand, DeleteQueueCommand, GetQueueAttributesCommand, ReceiveMessageCommand, SendMessageCommand, Message } from '@aws-sdk/client-sqs';
import { SqsService, loadSqsConfig } from '../../src/messaging/sqs.service';
import { InboxProcessor } from '../../src/messaging/inbox.processor';
import { SqsConsumer } from '../../src/messaging/sqs.consumer';
import { OutboxPublisher } from '../../src/messaging/outbox.publisher';
import { WagerInput } from '../../src/application/financial-service';
import { RequestedWagerMessage } from '../../src/messaging/request-message';
import { createTestDatabase } from './postgres';

export async function createMessagingFixture() {
  const database = await createTestDatabase();
  const prefix = `stage3-${randomUUID().replaceAll('-', '')}`;
  const config = { ...loadSqsConfig(), requestQueue: `${prefix}-requests.fifo`, deadLetterQueue: `${prefix}-dlq.fifo`,
    eventQueue: `${prefix}-events.fifo`, visibilitySeconds: 3, requestTimeoutMs: 4000 };
  const sqs = new SqsService(config);
  await sqs.client.send(new CreateQueueCommand({ QueueName: config.deadLetterQueue, Attributes: { FifoQueue: 'true' } }));
  const dlqUrl = await sqs.queueUrl(config.deadLetterQueue);
  const dlq = await sqs.client.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }));
  await sqs.client.send(new CreateQueueCommand({ QueueName: config.requestQueue, Attributes: { FifoQueue: 'true', VisibilityTimeout: '3',
    RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlq.Attributes!.QueueArn, maxReceiveCount: '3' }) } }));
  await sqs.client.send(new CreateQueueCommand({ QueueName: config.eventQueue, Attributes: { FifoQueue: 'true' } }));
  const source = database.sources[0]!;
  const financial = database.services[0]!;
  const inbox = new InboxProcessor(source, financial);
  const consumer = new SqsConsumer(sqs, inbox);
  const publisher = new OutboxPublisher(source, sqs);
  return {
    ...database, source, financial, inbox, sqs, consumer, publisher, config,
    async send(body: RequestedWagerMessage | Record<string, unknown> | string, groupId = randomUUID()) {
      await sqs.client.send(new SendMessageCommand({ QueueUrl: await sqs.queueUrl(config.requestQueue),
        MessageBody: typeof body === 'string' ? body : JSON.stringify(body), MessageGroupId: groupId, MessageDeduplicationId: randomUUID() }));
    },
    async receive(queue: string): Promise<Message | undefined> {
      const response = await sqs.client.send(new ReceiveMessageCommand({ QueueUrl: await sqs.queueUrl(queue),
        MaxNumberOfMessages: 1, WaitTimeSeconds: 0, VisibilityTimeout: 3, MessageAttributeNames: ['All'],
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      }));
      return response.Messages?.[0];
    },
    async acknowledge(queue: string, message: Message): Promise<void> {
      await sqs.client.send(new DeleteMessageCommand({ QueueUrl: await sqs.queueUrl(queue), ReceiptHandle: message.ReceiptHandle! }));
    },
    async close() {
      await consumer.beforeApplicationShutdown();
      await publisher.beforeApplicationShutdown();
      await Promise.all([config.requestQueue, config.deadLetterQueue, config.eventQueue].map(async name => {
        await sqs.client.send(new DeleteQueueCommand({ QueueUrl: await sqs.queueUrl(name) }));
      }));
      sqs.onApplicationShutdown();
      await database.close();
    },
  };
}

export function requested(input: WagerInput, messageId = randomUUID()): RequestedWagerMessage {
  return { messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), correlationId: `correlation-${messageId}`,
    data: { ...input, idempotencyKey: `${input.providerId}:${input.externalTransactionId}` } };
}

export async function waitUntil<T>(operation: () => Promise<T | undefined>, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await operation();
    if (result !== undefined) return result;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for the expected persistent state');
}

const proxyApi = process.env.TOXIPROXY_URL ?? 'http://127.0.0.1:8474';
export async function configureProxies(): Promise<void> {
  for (const [name, listen, upstream] of [
    ['stage3-postgres', '0.0.0.0:8666', 'postgres-test:5432'], ['stage3-sqs', '0.0.0.0:8667', 'localstack:4566'],
  ]) {
    await fetch(`${proxyApi}/proxies/${name}`, { method: 'DELETE' });
    const response = await fetch(`${proxyApi}/proxies`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, listen, upstream }) });
    if (!response.ok) throw new Error(`Could not configure test proxy: ${response.status}`);
  }
}
export async function enableProxy(name: 'postgres' | 'sqs', enabled: boolean): Promise<void> {
  const response = await fetch(`${proxyApi}/proxies/stage3-${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) });
  if (!response.ok) throw new Error(`Could not change test proxy state: ${response.status}`);
}
