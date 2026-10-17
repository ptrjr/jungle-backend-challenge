import { DomainError, InvalidTransactionStateError } from './domain-error';
import { Money } from './money';
import { LedgerDirection } from './wallet-ledger-entry';

export enum WagerTransactionKind { Opening = 'OPENING', Bet = 'BET', Win = 'WIN', Loss = 'LOSS', Refund = 'REFUND', Rollback = 'ROLLBACK' }
export enum WagerTransactionStatus { Pending = 'PENDING', PendingReference = 'PENDING_REFERENCE', Processed = 'PROCESSED', Rejected = 'REJECTED', Failed = 'FAILED' }
export type FailureCode = 'INSUFFICIENT_FUNDS' | 'CURRENCY_MISMATCH' | 'PLAYER_MISMATCH' | 'BALANCE_LIMIT_EXCEEDED'
  | 'INVALID_REFERENCE' | 'REFERENCE_PROVIDER_MISMATCH' | 'REFERENCE_PLAYER_MISMATCH' | 'REFERENCE_WALLET_MISMATCH'
  | 'REFERENCE_CURRENCY_MISMATCH' | 'REFERENCE_ROUND_MISMATCH' | 'REFERENCE_KIND_MISMATCH' | 'REFERENCE_AMOUNT_MISMATCH'
  | 'REFERENCE_NOT_PROCESSED' | 'REFERENCE_ALREADY_REVERSED' | 'REFERENCE_NOT_FOUND' | 'REVERSAL_INSUFFICIENT_FUNDS';

export const MAX_REFERENCE_ATTEMPTS = 8;
export function referenceRetryDelay(attempts: number): number { return Math.min(5000 * 2 ** attempts, 300000); }

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
  referenceExternalTransactionId?: string;
}
export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  createdAt: Date;
  processedAt?: Date;
  failureCode?: FailureCode;
  resultBalance?: Money;
  referenceTransactionId?: string;
  referenceAttempts?: number;
  nextAttemptAt?: Date;
}

export class WagerTransaction {
  private constructor(private readonly state: WagerTransactionState) {}
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.money.isNegative() || (props.kind !== WagerTransactionKind.Loss && !props.money.isPositive())) {
      throw new DomainError('INVALID_AMOUNT', 'Financial movements require a positive amount');
    }
    const reversal = props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;
    if (reversal && !props.referenceExternalTransactionId?.trim()) {
      throw new DomainError('REFERENCE_REQUIRED', 'Reversals require an external reference');
    }
    if (props.referenceExternalTransactionId !== undefined && ![WagerTransactionKind.Win, WagerTransactionKind.Refund, WagerTransactionKind.Rollback].includes(props.kind)) {
      throw new DomainError('INVALID_REFERENCE', 'This operation does not accept a reference');
    }
    if (props.referenceExternalTransactionId !== undefined && !props.referenceExternalTransactionId.trim()) {
      throw new DomainError('INVALID_REFERENCE', 'External reference cannot be empty');
    }
    return new WagerTransaction({ ...props, status: WagerTransactionStatus.Pending, createdAt: new Date(), referenceAttempts: 0 });
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
  get referenceExternalTransactionId(): string | undefined { return this.state.referenceExternalTransactionId; }
  get referenceTransactionId(): string | undefined { return this.state.referenceTransactionId; }
  get referenceAttempts(): number { return this.state.referenceAttempts ?? 0; }
  get nextAttemptAt(): Date | undefined { return this.state.nextAttemptAt ? new Date(this.state.nextAttemptAt) : undefined; }
  isTerminal(): boolean { return [WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected, WagerTransactionStatus.Failed].includes(this.status); }
  requiresReference(): boolean { return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback; }
  affectsBalance(): boolean { return this.kind !== WagerTransactionKind.Loss; }
  matchesPayload(hash: string): boolean { return this.payloadHash === hash; }
  referenceFailure(reference: WagerTransaction): FailureCode | undefined {
    if (reference.id === this.id) return 'INVALID_REFERENCE';
    if (reference.providerId !== this.providerId) return 'REFERENCE_PROVIDER_MISMATCH';
    if (reference.externalTransactionId !== this.referenceExternalTransactionId) return 'INVALID_REFERENCE';
    if (reference.playerId !== this.playerId) return 'REFERENCE_PLAYER_MISMATCH';
    if (reference.walletId !== this.walletId) return 'REFERENCE_WALLET_MISMATCH';
    if (reference.money.currency !== this.money.currency) return 'REFERENCE_CURRENCY_MISMATCH';
    if (reference.roundId !== this.roundId) return 'REFERENCE_ROUND_MISMATCH';
    const allowedKinds = this.kind === WagerTransactionKind.Rollback
      ? [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund] : [WagerTransactionKind.Bet];
    if (!allowedKinds.includes(reference.kind)) return 'REFERENCE_KIND_MISMATCH';
    if (this.requiresReference() && !this.money.equals(reference.money)) return 'REFERENCE_AMOUNT_MISMATCH';
    if (reference.isTerminal() && reference.status !== WagerTransactionStatus.Processed) return 'REFERENCE_NOT_PROCESSED';
    return undefined;
  }
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    if (!this.affectsBalance()) throw new DomainError('NO_LEDGER_DIRECTION', 'LOSS has no ledger direction');
    if (this.kind === WagerTransactionKind.Rollback) {
      if (!reference || this.referenceFailure(reference) || reference.status !== WagerTransactionStatus.Processed) {
        throw new DomainError('INVALID_REFERENCE', 'ROLLBACK requires a valid processed reference');
      }
      return reference.kind === WagerTransactionKind.Bet ? LedgerDirection.Credit : LedgerDirection.Debit;
    }
    return this.kind === WagerTransactionKind.Bet ? LedgerDirection.Debit : LedgerDirection.Credit;
  }
  recordReferenceAttempt(): void {
    if (this.status !== WagerTransactionStatus.PendingReference) throw new InvalidTransactionStateError();
    this.state.referenceAttempts = this.referenceAttempts + 1;
  }
  markPendingReference(balance: Money, at: Date): void {
    if (this.isTerminal()) throw new InvalidTransactionStateError();
    if (!this.referenceExternalTransactionId || this.referenceAttempts >= MAX_REFERENCE_ATTEMPTS) {
      throw new DomainError('INVALID_REFERENCE_STATE', 'Pending reference requires a reference and remaining attempts');
    }
    this.state.status = WagerTransactionStatus.PendingReference;
    this.state.resultBalance ??= balance;
    this.state.nextAttemptAt = new Date(at.getTime() + referenceRetryDelay(this.referenceAttempts));
  }
  markProcessed(balance: Money, at: Date, referenceTransactionId?: string): void {
    if (this.isTerminal()) throw new InvalidTransactionStateError();
    if (this.referenceExternalTransactionId && !referenceTransactionId) throw new DomainError('INVALID_REFERENCE', 'Reference must be resolved before processing');
    this.transition(WagerTransactionStatus.Processed, balance, at);
    this.state.referenceTransactionId = referenceTransactionId;
  }
  reject(code: FailureCode, balance: Money, at: Date): void {
    this.transition(WagerTransactionStatus.Rejected, balance, at);
    this.state.failureCode = code;
  }
  private transition(status: WagerTransactionStatus, balance: Money, at: Date): void {
    if (this.isTerminal()) throw new InvalidTransactionStateError();
    this.state.status = status;
    this.state.resultBalance = balance;
    this.state.processedAt = new Date(at);
    this.state.nextAttemptAt = undefined;
  }
}
