import { IntegrationEvent, EventEnvelope } from './integration-event';
import { InvalidTransactionStateError } from './domain-error';

export interface OutboxState {
  id: string; aggregateId: string; transactionId: string; eventType: string; payload: EventEnvelope;
  occurredAt: Date; attempts: number; nextAttemptAt?: Date; publishedAt?: Date; lastErrorCode?: string;
}
export class OutboxMessage {
  private constructor(private readonly state: OutboxState) {}
  static enqueue<T extends { transactionId: string }>(event: IntegrationEvent<T>): OutboxMessage {
    return new OutboxMessage({ id: event.eventId, aggregateId: event.aggregateId, transactionId: event.data.transactionId,
      eventType: event.eventType, payload: event.toJSON() as EventEnvelope, occurredAt: new Date(event.occurredAt), attempts: 0 });
  }
  static rehydrate(state: OutboxState): OutboxMessage { return new OutboxMessage({ ...state, payload: structuredClone(state.payload) }); }
  get id(): string { return this.state.id; }
  get aggregateId(): string { return this.state.aggregateId; }
  get transactionId(): string { return this.state.transactionId; }
  get eventType(): string { return this.state.eventType; }
  get payload(): EventEnvelope { return structuredClone(this.state.payload); }
  get occurredAt(): Date { return new Date(this.state.occurredAt); }
  get attempts(): number { return this.state.attempts; }
  get nextAttemptAt(): Date | undefined { return this.state.nextAttemptAt ? new Date(this.state.nextAttemptAt) : undefined; }
  get publishedAt(): Date | undefined { return this.state.publishedAt ? new Date(this.state.publishedAt) : undefined; }
  get lastErrorCode(): string | undefined { return this.state.lastErrorCode; }
  isPending(): boolean { return !this.state.publishedAt; }
  isDue(now: Date): boolean { return this.isPending() && (!this.nextAttemptAt || this.nextAttemptAt <= now); }
  markPublished(at: Date): void {
    if (!this.isPending()) throw new InvalidTransactionStateError();
    this.state.attempts++;
    this.state.publishedAt = new Date(at);
    this.state.nextAttemptAt = undefined;
    this.state.lastErrorCode = undefined;
  }
  scheduleRetry(now: Date, errorCode: string): void {
    if (!this.isPending()) throw new InvalidTransactionStateError();
    this.state.attempts++;
    this.state.lastErrorCode = errorCode;
    this.state.nextAttemptAt = new Date(now.getTime() + Math.min(1000 * 2 ** Math.min(this.attempts - 1, 12), 300000));
  }
}
