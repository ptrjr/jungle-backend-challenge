import { DomainError } from './domain-error';
import { Money } from './money';

export enum LedgerDirection { Debit = 'DEBIT', Credit = 'CREDIT' }

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export class WalletLedgerEntry {
  private constructor(private readonly state: Readonly<LedgerEntryState>) {
    Object.freeze(this.state);
    Object.freeze(this);
  }

  static create(props: LedgerEntryState): WalletLedgerEntry {
    const entry = new WalletLedgerEntry({ ...props, createdAt: new Date(props.createdAt) });
    if (!props.money.isPositive() || props.balanceBefore.isNegative() || props.balanceAfter.isNegative() || !entry.isBalanced()) {
      throw new DomainError('INVALID_LEDGER_ENTRY', 'Ledger entry must balance and keep balances non-negative');
    }
    return entry;
  }
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry({ ...state, createdAt: new Date(state.createdAt) });
  }
  get id(): string { return this.state.id; }
  get walletId(): string { return this.state.walletId; }
  get transactionId(): string { return this.state.transactionId; }
  get direction(): LedgerDirection { return this.state.direction; }
  get money(): Money { return this.state.money; }
  get balanceBefore(): Money { return this.state.balanceBefore; }
  get balanceAfter(): Money { return this.state.balanceAfter; }
  get createdAt(): Date { return new Date(this.state.createdAt); }
  isBalanced(): boolean {
    const expected = this.direction === LedgerDirection.Credit
      ? this.balanceBefore.add(this.money) : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}
