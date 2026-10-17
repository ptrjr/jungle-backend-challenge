import { InvalidTransactionStateError } from './domain-error';

export interface InboxState {
  consumerName: string; messageId: string; payloadHash: string; receivedAt: Date;
  processedAt?: Date; transactionId?: string;
}
export class InboxMessage {
  private constructor(private readonly state: InboxState) {}
  static receive(props: Omit<InboxState, 'processedAt' | 'transactionId' | 'receivedAt'>): InboxMessage {
    return new InboxMessage({ ...props, receivedAt: new Date() });
  }
  static rehydrate(state: InboxState): InboxMessage { return new InboxMessage({ ...state }); }
  get consumerName(): string { return this.state.consumerName; }
  get messageId(): string { return this.state.messageId; }
  get payloadHash(): string { return this.state.payloadHash; }
  get receivedAt(): Date { return new Date(this.state.receivedAt); }
  get processedAt(): Date | undefined { return this.state.processedAt ? new Date(this.state.processedAt) : undefined; }
  get transactionId(): string | undefined { return this.state.transactionId; }
  isProcessed(): boolean { return this.state.processedAt !== undefined; }
  markProcessed(transactionId: string, at: Date): void {
    if (this.isProcessed()) throw new InvalidTransactionStateError();
    this.state.transactionId = transactionId;
    this.state.processedAt = new Date(at);
  }
}
