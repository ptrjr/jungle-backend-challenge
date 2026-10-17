import { ChangeMessageVisibilityCommand, DeleteMessageCommand, GetQueueAttributesCommand, GetQueueUrlCommand, Message,
  ReceiveMessageCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';
import { EventEnvelope } from '../domain/integration-event';

export interface SqsConfig {
  endpoint: string; region: string; requestQueue: string; deadLetterQueue: string; eventQueue: string;
  visibilitySeconds: number; requestTimeoutMs: number;
}
export function loadSqsConfig(): SqsConfig {
  return { endpoint: process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566', region: process.env.AWS_REGION ?? 'us-east-1',
    requestQueue: process.env.SQS_REQUEST_QUEUE ?? 'wager-transactions.fifo',
    deadLetterQueue: process.env.SQS_DLQ ?? 'wager-transactions-dlq.fifo',
    eventQueue: process.env.SQS_EVENT_QUEUE ?? 'wager-events.fifo', visibilitySeconds: 60, requestTimeoutMs: 5000 };
}
export class SqsService {
  readonly client: SQSClient;
  private readonly queueUrls = new Map<string, string>();

  constructor(readonly config: SqsConfig = loadSqsConfig()) {
    this.client = new SQSClient({ endpoint: config.endpoint, region: config.region, maxAttempts: 1,
      credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test', secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test' },
      useQueueUrlAsEndpoint: false,
      requestHandler: { requestTimeout: config.requestTimeoutMs, connectionTimeout: 1500, throwOnRequestTimeout: true },
    });
  }
  async queueUrl(name: string): Promise<string> {
    const existing = this.queueUrls.get(name);
    if (existing) return existing;
    const response = await this.client.send(new GetQueueUrlCommand({ QueueName: name }));
    if (!response.QueueUrl) throw new Error('SQS returned no queue URL');
    this.queueUrls.set(name, response.QueueUrl);
    return response.QueueUrl;
  }
  async receive(waitSeconds = 2, abortSignal?: AbortSignal): Promise<Message | undefined> {
    const response = await this.client.send(new ReceiveMessageCommand({ QueueUrl: await this.queueUrl(this.config.requestQueue),
      WaitTimeSeconds: waitSeconds, MaxNumberOfMessages: 1, VisibilityTimeout: this.config.visibilitySeconds,
      MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
    }), { abortSignal });
    return response.Messages?.[0];
  }
  async acknowledge(message: Message): Promise<void> {
    await this.client.send(new DeleteMessageCommand({ QueueUrl: await this.queueUrl(this.config.requestQueue), ReceiptHandle: message.ReceiptHandle! }));
  }
  async visibility(message: Message, seconds: number): Promise<void> {
    await this.client.send(new ChangeMessageVisibilityCommand({ QueueUrl: await this.queueUrl(this.config.requestQueue), ReceiptHandle: message.ReceiptHandle!, VisibilityTimeout: seconds }));
  }
  async deadLetter(message: Message, reason: string): Promise<void> {
    await this.client.send(new SendMessageCommand({ QueueUrl: await this.queueUrl(this.config.deadLetterQueue), MessageBody: message.Body ?? '',
      MessageGroupId: message.Attributes?.MessageGroupId ?? 'invalid', MessageDeduplicationId: randomUUID(),
      MessageAttributes: { failureCode: { DataType: 'String', StringValue: reason }, sourceMessageId: { DataType: 'String', StringValue: message.MessageId ?? 'unknown' } },
    }));
  }
  async publish(event: EventEnvelope): Promise<void> {
    await this.client.send(new SendMessageCommand({ QueueUrl: await this.queueUrl(this.config.eventQueue), MessageBody: JSON.stringify(event),
      MessageGroupId: event.aggregateId, MessageDeduplicationId: randomUUID(),
    }));
  }
  async ready(): Promise<void> {
    await Promise.all([this.config.requestQueue, this.config.deadLetterQueue, this.config.eventQueue].map(async name => {
      await this.client.send(new GetQueueAttributesCommand({ QueueUrl: await this.queueUrl(name), AttributeNames: ['QueueArn'] }));
    }));
  }
  async deadLetterDepth(): Promise<number> {
    const result = await this.client.send(new GetQueueAttributesCommand({ QueueUrl: await this.queueUrl(this.config.deadLetterQueue),
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] }));
    return Number(result.Attributes?.ApproximateNumberOfMessages ?? '0') + Number(result.Attributes?.ApproximateNumberOfMessagesNotVisible ?? '0');
  }
  onApplicationShutdown(): void { this.client.destroy(); }
}
