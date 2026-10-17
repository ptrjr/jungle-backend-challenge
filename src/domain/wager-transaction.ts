import { DomainError, InvalidTransactionStateError } from './domain-error';
import { Money } from './money';
import { LedgerDirection } from './wallet-ledger-entry';

export enum WagerTransactionKind { Opening = 'OPENING', Bet = 'BET', Win = 'WIN', Loss = 'LOSS' }
export enum WagerTransactionStatus { Pending = 'PENDING', Processed = 'PROCESSED', Rejected = 'REJECTED', Failed = 'FAILED' }
export type FailureCode = 'INSUFFICIENT_FUNDS' | 'CURRENCY_MISMATCH' | 'PLAYER_MISMATCH' | 'BALANCE_LIMIT_EXCEEDED';

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
}
export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  createdAt: Date;
  processedAt?: Date;
  failureCode?: FailureCode;
  resultBalance?: Money;
}

export class WagerTransaction {
  private constructor(private readonly state: WagerTransactionState) {}
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.money.isNegative() || (props.kind !== WagerTransactionKind.Loss && !props.money.isPositive())) {
      throw new DomainError('INVALID_AMOUNT', 'Financial movements require a positive amount');
    }
    return new WagerTransaction({ ...props, status: WagerTransactionStatus.Pending, createdAt: new Date() });
  }
  static rehydrate(state: WagerTransactionState): WagerTransaction { return new WagerTransaction({ ...state }); }
  get id(): string { return this.state.id; }
  get walletId(): string { return this.state.walletId; }
  get providerId(): string { return this.state.providerId; }
  get externalTransactionId(): string { return this.state.externalTransactionId; }
  get idempotencyKey(): string { return this.state.idempotencyKey; }
  get payloadHash(): string { return this.state.payloadHash; }
  get playerId(): string { return this.state.playerId; }
  get roundId(): string { return this.state.roundId; }
  get gameId(): string { return this.state.gameId; }
  get kind(): WagerTransactionKind { return this.state.kind; }
  get money(): Money { return this.state.money; }
  get status(): WagerTransactionStatus { return this.state.status; }
  get failureCode(): FailureCode | undefined { return this.state.failureCode; }
  get processedAt(): Date | undefined { return this.state.processedAt ? new Date(this.state.processedAt) : undefined; }
  get createdAt(): Date { return new Date(this.state.createdAt); }
  get resultBalance(): Money | undefined { return this.state.resultBalance; }
  isTerminal(): boolean { return this.status !== WagerTransactionStatus.Pending; }
  affectsBalance(): boolean { return this.kind !== WagerTransactionKind.Loss; }
  matchesPayload(hash: string): boolean { return this.payloadHash === hash; }
  ledgerDirectionFor(): LedgerDirection {
    if (!this.affectsBalance()) throw new DomainError('NO_LEDGER_DIRECTION', 'LOSS has no ledger direction');
    return this.kind === WagerTransactionKind.Bet ? LedgerDirection.Debit : LedgerDirection.Credit;
  }
  markProcessed(balance: Money, at: Date): void { this.transition(WagerTransactionStatus.Processed, balance, at); }
  reject(code: FailureCode, balance: Money, at: Date): void {
    this.transition(WagerTransactionStatus.Rejected, balance, at);
    this.state.failureCode = code;
  }
  private transition(status: WagerTransactionStatus, balance: Money, at: Date): void {
    if (this.isTerminal()) throw new InvalidTransactionStateError();
    this.state.status = status;
    this.state.resultBalance = balance;
    this.state.processedAt = new Date(at);
  }
}
