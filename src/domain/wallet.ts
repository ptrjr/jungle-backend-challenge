import { randomUUID } from 'node:crypto';
import { DomainError } from './domain-error';
import { Money } from './money';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Wallet {
  private constructor(private readonly state: WalletState) {}
  static open(props: { id: string; playerId: string; initialBalance: Money }): Wallet {
    if (props.initialBalance.isNegative()) throw new DomainError('NEGATIVE_BALANCE', 'Initial balance cannot be negative');
    const now = new Date();
    return new Wallet({ id: props.id, playerId: props.playerId, balance: props.initialBalance, version: 1, createdAt: now, updatedAt: now });
  }
  static rehydrate(state: WalletState): Wallet { return new Wallet({ ...state }); }
  get id(): string { return this.state.id; }
  get playerId(): string { return this.state.playerId; }
  get currency(): string { return this.balance.currency; }
  get balance(): Money { return this.state.balance; }
  get version(): number { return this.state.version; }
  get createdAt(): Date { return new Date(this.state.createdAt); }
  get updatedAt(): Date { return new Date(this.state.updatedAt); }

  debit(money: Money, transactionId: string): WalletLedgerEntry {
    if (this.balance.isLessThan(money)) throw new DomainError('INSUFFICIENT_FUNDS', 'Insufficient wallet balance');
    return this.move(money, transactionId, LedgerDirection.Debit);
  }
  credit(money: Money, transactionId: string): WalletLedgerEntry {
    return this.move(money, transactionId, LedgerDirection.Credit);
  }
  private move(money: Money, transactionId: string, direction: LedgerDirection): WalletLedgerEntry {
    const balanceBefore = this.balance;
    const balanceAfter = direction === LedgerDirection.Credit ? balanceBefore.add(money) : balanceBefore.subtract(money);
    const entry = WalletLedgerEntry.create({ id: randomUUID(), walletId: this.id, transactionId, direction, money, balanceBefore, balanceAfter, createdAt: new Date() });
    this.state.balance = balanceAfter;
    this.state.version++;
    this.state.updatedAt = entry.createdAt;
    return entry;
  }
}
