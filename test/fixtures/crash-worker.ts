import { writeFile } from 'node:fs/promises';
import { createDataSource } from '../../src/database/data-source';
import { FinancialService } from '../../src/application/financial-service';
import { InboxProcessor } from '../../src/messaging/inbox.processor';
import { SqsConsumer } from '../../src/messaging/sqs.consumer';
import { OutboxPublisher } from '../../src/messaging/outbox.publisher';
import { SqsService, loadSqsConfig } from '../../src/messaging/sqs.service';
import { EventEnvelope } from '../../src/domain/integration-event';
import type { Message } from '@aws-sdk/client-sqs';

// Barriers pause only the selected crash window; all SQL and SQS calls before it are real.
class CrashBarrierSqs extends SqsService {
  private async barrier(): Promise<never> {
    await writeFile(process.env.CRASH_MARKER!, 'ready');
    return new Promise<never>(() => {});
  }
  override async acknowledge(message: Message): Promise<void> {
    if (process.env.CRASH_WINDOW === 'before-ack') await this.barrier();
    await super.acknowledge(message);
  }
  override async publish(event: EventEnvelope): Promise<void> {
    await super.publish(event);
    if (process.env.CRASH_WINDOW === 'after-publish') await this.barrier();
  }
}

async function main(): Promise<void> {
const source = await createDataSource(process.env.CRASH_DATABASE_URL).initialize();
const sqs = new CrashBarrierSqs({ ...loadSqsConfig(), visibilitySeconds: 3 });
const keepAlive = setInterval(() => {}, 1000);
try {
  if (process.env.CRASH_WINDOW === 'before-ack') {
    await new SqsConsumer(sqs, new InboxProcessor(source, new FinancialService(source))).runOnce(2);
  } else await new OutboxPublisher(source, sqs).publishOne();
} finally { clearInterval(keepAlive); sqs.onApplicationShutdown(); await source.destroy(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Crash fixture failed'); process.exitCode = 1; });
