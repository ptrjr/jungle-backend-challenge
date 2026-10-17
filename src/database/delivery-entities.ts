import { EntitySchema } from 'typeorm';
import { EventEnvelope } from '../domain/integration-event';

export interface InboxRow {
  consumerName: string; messageId: string; payloadHash: string; receivedAt: Date; processedAt: Date | null; transactionId: string | null;
}
export interface OutboxRow {
  id: string; aggregateId: string; transactionId: string; eventType: string; payload: EventEnvelope;
  occurredAt: Date; attempts: number; nextAttemptAt: Date | null; publishedAt: Date | null; lastErrorCode: string | null;
}
export const InboxEntity = new EntitySchema<InboxRow>({ name: 'InboxRow', tableName: 'inbox_messages', columns: {
  consumerName: { type: 'varchar', name: 'consumer_name', primary: true }, messageId: { type: 'varchar', name: 'message_id', primary: true },
  payloadHash: { type: 'varchar', name: 'payload_hash' }, receivedAt: { type: 'timestamptz', name: 'received_at' },
  processedAt: { type: 'timestamptz', name: 'processed_at', nullable: true }, transactionId: { type: 'uuid', name: 'transaction_id', nullable: true },
} });
export const OutboxEntity = new EntitySchema<OutboxRow>({ name: 'OutboxRow', tableName: 'outbox_messages', columns: {
  id: { type: 'uuid', primary: true }, aggregateId: { type: 'uuid', name: 'aggregate_id' }, transactionId: { type: 'uuid', name: 'transaction_id' },
  eventType: { type: 'varchar', name: 'event_type' }, payload: { type: 'jsonb' }, occurredAt: { type: 'timestamptz', name: 'occurred_at' },
  attempts: { type: 'integer' }, nextAttemptAt: { type: 'timestamptz', name: 'next_attempt_at', nullable: true },
  publishedAt: { type: 'timestamptz', name: 'published_at', nullable: true }, lastErrorCode: { type: 'varchar', name: 'last_error_code', nullable: true },
} });
