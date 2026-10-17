import { randomUUID } from 'node:crypto';
import { ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { LedgerEntity, LedgerRow, TransactionEntity, TransactionRow, WalletEntity, WalletRow } from '../database/entities';
import { DomainError } from '../domain/domain-error';
import { Money, MoneyProps } from '../domain/money';
import { FailureCode, MAX_REFERENCE_ATTEMPTS, WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../domain/wager-transaction';
import { Wallet } from '../domain/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { payloadHash } from './payload-hash';

export interface WagerInput {
  providerId: string; externalTransactionId: string; playerId: string; walletId: string;
  roundId: string; gameId: string;
  kind: Exclude<WagerTransactionKind, WagerTransactionKind.Opening>;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}
export interface TransactionResult {
  transactionId: string; status: WagerTransactionStatus; balance: MoneyProps;
  failureCode?: FailureCode; idempotentReplay: boolean;
  nextAttemptAt?: string;
  referenceAttempts?: number;
}

@Injectable()
export class FinancialService {
  constructor(@Inject(DataSource) private readonly source: DataSource) {}

  async openWallet(playerId: string, initialBalance: MoneyProps) {
    const wallet = Wallet.open({ id: randomUUID(), playerId, initialBalance: Money.from(initialBalance) });
    try {
      return await this.source.transaction(async manager => {
        await manager.insert(WalletEntity, this.walletRow(wallet));
        if (wallet.balance.isPositive()) {
          const transaction = WagerTransaction.create({
            id: randomUUID(), providerId: '__internal__', externalTransactionId: wallet.id,
            idempotencyKey: `opening:${wallet.id}`, payloadHash: payloadHash({ walletId: wallet.id, initialBalance }),
            walletId: wallet.id, playerId, roundId: wallet.id, gameId: 'wallet-opening',
            kind: WagerTransactionKind.Opening, money: wallet.balance,
          });
          transaction.markProcessed(wallet.balance, new Date());
          await manager.insert(TransactionEntity, this.transactionRow(transaction));
          await this.insertLedger(manager, WalletLedgerEntry.create({
            id: randomUUID(), walletId: wallet.id, transactionId: transaction.id,
            direction: LedgerDirection.Credit, money: wallet.balance,
            balanceBefore: Money.zero(wallet.currency), balanceAfter: wallet.balance, createdAt: new Date(),
          }));
        }
        return this.walletView(wallet);
      });
    } catch (error) {
      if (this.hasDatabaseCode(error, '23505')) throw new ConflictException({ code: 'WALLET_ALREADY_EXISTS' });
      throw error;
    }
  }

  async process(input: WagerInput, idempotencyKey: string): Promise<TransactionResult> {
    const hash = payloadHash({
      providerId: input.providerId, externalTransactionId: input.externalTransactionId,
      playerId: input.playerId, walletId: input.walletId, roundId: input.roundId, gameId: input.gameId,
      kind: input.kind, money: { amount: input.money.amount, currency: input.money.currency },
      ...(input.referenceExternalTransactionId !== undefined ? { referenceExternalTransactionId: input.referenceExternalTransactionId } : {}),
    });
    const transaction = WagerTransaction.create({ ...input, id: randomUUID(), idempotencyKey, payloadHash: hash, money: Money.from(input.money) });
    return this.source.transaction('READ COMMITTED', async manager => {
      const existing = await this.findDuplicate(manager, input, idempotencyKey);
      if (existing) return this.replay(existing, idempotencyKey, hash);

      const row = await manager.findOne(WalletEntity, { where: { id: input.walletId }, lock: { mode: 'pessimistic_write' } });
      if (!row) throw new NotFoundException({ code: 'WALLET_NOT_FOUND' });
      const wallet = this.hydrateWallet(row);

      const inserted = await manager.createQueryBuilder().insert().into(TransactionEntity)
        .values(this.transactionRow(transaction)).onConflict('DO NOTHING').returning('id').execute();
      if (inserted.raw.length === 0) {
        const duplicate = await this.findDuplicate(manager, input, idempotencyKey);
        if (!duplicate) throw new ServiceUnavailableException({ code: 'IDEMPOTENCY_RETRY_REQUIRED' });
        return this.replay(duplicate, idempotencyKey, hash);
      }

      await this.applyTransaction(manager, wallet, transaction, new Date());
      return this.result(transaction, false);
    });
  }

  async reprocessPendingReference(now = new Date()): Promise<boolean> {
    return this.source.transaction('READ COMMITTED', async manager => {
      // All financial paths lock wallet before transaction to avoid lock-order deadlocks.
      const row = await manager.createQueryBuilder(WalletEntity, 'wallet')
        .where(`EXISTS (SELECT 1 FROM wager_transactions t WHERE t.wallet_id = wallet.id
          AND t.status = 'PENDING_REFERENCE' AND t.next_attempt_at <= :now)`, { now })
        .orderBy('wallet.id', 'ASC').setLock('pessimistic_write').setOnLocked('skip_locked').take(1).getOne();
      if (!row) return false;
      const pending = await manager.createQueryBuilder(TransactionEntity, 'transaction')
        .where('transaction.walletId = :id AND transaction.status = :status AND transaction.nextAttemptAt <= :now', {
          id: row.id, status: WagerTransactionStatus.PendingReference, now,
        }).orderBy('transaction.nextAttemptAt', 'ASC').addOrderBy('transaction.id', 'ASC')
        .setLock('pessimistic_write').setOnLocked('skip_locked').take(1).getOne();
      if (!pending) return false;
      const transaction = this.hydrateTransaction(pending);
      transaction.recordReferenceAttempt();
      await this.applyTransaction(manager, this.hydrateWallet(row), transaction, now);
      return true;
    });
  }

  private async applyTransaction(manager: EntityManager, wallet: Wallet, transaction: WagerTransaction, now: Date): Promise<void> {
    let failure: FailureCode | undefined;
    let reference: WagerTransaction | undefined;
    let waiting = false;
    let entry: WalletLedgerEntry | undefined;
    if (wallet.playerId !== transaction.playerId) failure = 'PLAYER_MISMATCH';
    else if (wallet.currency !== transaction.money.currency) failure = 'CURRENCY_MISMATCH';
    else if (transaction.referenceExternalTransactionId !== undefined) {
      const referenceRow = await manager.findOneBy(TransactionEntity, {
        providerId: transaction.providerId, externalTransactionId: transaction.referenceExternalTransactionId,
      });
      if (referenceRow) {
        reference = this.hydrateTransaction(referenceRow);
        failure = transaction.referenceFailure(reference);
      }
      if (!failure && (!reference || !reference.isTerminal())) {
        if (transaction.referenceAttempts >= MAX_REFERENCE_ATTEMPTS) {
          failure = reference ? 'REFERENCE_NOT_PROCESSED' : 'REFERENCE_NOT_FOUND';
        } else waiting = true;
      }
      if (!failure && !waiting && reference && transaction.requiresReference()) {
        const reversed = await manager.existsBy(TransactionEntity, {
          referenceTransactionId: reference.id, kind: transaction.kind, status: WagerTransactionStatus.Processed,
        });
        if (reversed) failure = 'REFERENCE_ALREADY_REVERSED';
      }
    }
    if (!failure && !waiting && transaction.affectsBalance()) {
      const direction = transaction.ledgerDirectionFor(reference);
      if (direction === LedgerDirection.Debit && wallet.balance.isLessThan(transaction.money)) {
        failure = transaction.requiresReference() ? 'REVERSAL_INSUFFICIENT_FUNDS' : 'INSUFFICIENT_FUNDS';
      } else {
        try {
          entry = direction === LedgerDirection.Debit
            ? wallet.debit(transaction.money, transaction.id) : wallet.credit(transaction.money, transaction.id);
        } catch (error) {
          if (error instanceof DomainError && error.code === 'MONEY_OUT_OF_RANGE') failure = 'BALANCE_LIMIT_EXCEEDED';
          else throw error;
        }
      }
    }
    if (failure) transaction.reject(failure, wallet.balance, now);
    else if (waiting) transaction.markPendingReference(wallet.balance, now);
    else transaction.markProcessed(wallet.balance, now, reference?.id);
    await manager.update(TransactionEntity, { id: transaction.id }, this.transactionRow(transaction));
    if (entry) {
      await this.insertLedger(manager, entry);
      await manager.update(WalletEntity, { id: wallet.id }, this.walletRow(wallet));
    }
  }

  async getWallet(id: string) {
    const row = await this.source.manager.findOneBy(WalletEntity, { id });
    if (!row) throw new NotFoundException({ code: 'WALLET_NOT_FOUND' });
    return this.walletView(this.hydrateWallet(row));
  }

  async getTransaction(id: string) {
    const row = await this.source.manager.findOneBy(TransactionEntity, { id });
    if (!row) throw new NotFoundException({ code: 'TRANSACTION_NOT_FOUND' });
    return this.transactionView(row);
  }

  async getProviderTransaction(providerId: string, externalTransactionId: string) {
    const row = await this.source.manager.findOneBy(TransactionEntity, { providerId, externalTransactionId });
    if (!row) throw new NotFoundException({ code: 'TRANSACTION_NOT_FOUND' });
    return this.transactionView(row);
  }

  async getLedger(walletId: string, limit: number, after?: string) {
    await this.getWallet(walletId);
    const query = this.source.manager.createQueryBuilder(LedgerEntity, 'entry')
      .where('entry.walletId = :walletId', { walletId }).orderBy('entry.sequence', 'ASC').take(limit + 1);
    if (after) query.andWhere('entry.sequence > :after', { after });
    const rows = await query.getMany();
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      entries: page.map(row => ({
        id: row.id, walletId: row.walletId, transactionId: row.transactionId, direction: row.direction,
        money: this.money(row.amount, row.currency).toJSON(),
        balanceBefore: this.money(row.balanceBefore, row.currency).toJSON(),
        balanceAfter: this.money(row.balanceAfter, row.currency).toJSON(), createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ walletId, after: last.sequence })).toString('base64url') : null,
    };
  }

  private findDuplicate(manager: EntityManager, input: WagerInput, key: string): Promise<TransactionRow | null> {
    return manager.findOne(TransactionEntity, { where: [{ idempotencyKey: key }, { providerId: input.providerId, externalTransactionId: input.externalTransactionId }] });
  }
  private replay(row: TransactionRow, key: string, hash: string): TransactionResult {
    const transaction = this.hydrateTransaction(row);
    if (transaction.idempotencyKey !== key) throw new ConflictException({ code: 'EXTERNAL_TRANSACTION_CONFLICT' });
    if (!transaction.matchesPayload(hash)) throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT' });
    if (transaction.status === WagerTransactionStatus.Pending) throw new ServiceUnavailableException({ code: 'TRANSACTION_IN_PROGRESS' });
    return this.result(transaction, true);
  }
  private result(transaction: WagerTransaction, replay: boolean): TransactionResult {
    if (!transaction.resultBalance) throw new Error('Terminal transaction has no persisted result');
    return {
      transactionId: transaction.id, status: transaction.status, balance: transaction.resultBalance.toJSON(),
      ...(transaction.failureCode ? { failureCode: transaction.failureCode } : {}), idempotentReplay: replay,
      ...(transaction.status === WagerTransactionStatus.PendingReference ? {
        nextAttemptAt: transaction.nextAttemptAt!.toISOString(), referenceAttempts: transaction.referenceAttempts,
      } : {}),
    };
  }
  private transactionView(row: TransactionRow) {
    return {
      ...this.result(this.hydrateTransaction(row), false), providerId: row.providerId,
      externalTransactionId: row.externalTransactionId, walletId: row.walletId, playerId: row.playerId,
      roundId: row.roundId, gameId: row.gameId, kind: row.kind,
      money: this.money(row.amount, row.currency).toJSON(), createdAt: row.createdAt.toISOString(), processedAt: row.processedAt?.toISOString(),
      referenceExternalTransactionId: row.referenceExternalTransactionId,
      referenceTransactionId: row.referenceTransactionId, referenceAttempts: row.referenceAttempts,
    };
  }
  private walletView(wallet: Wallet) {
    return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
  }
  private walletRow(wallet: Wallet): WalletRow {
    return { id: wallet.id, playerId: wallet.playerId, currency: wallet.currency, balance: wallet.balance.toString(), version: wallet.version, createdAt: wallet.createdAt, updatedAt: wallet.updatedAt };
  }
  private transactionRow(transaction: WagerTransaction): TransactionRow {
    return {
      id: transaction.id, providerId: transaction.providerId, externalTransactionId: transaction.externalTransactionId,
      idempotencyKey: transaction.idempotencyKey, payloadHash: transaction.payloadHash, walletId: transaction.walletId,
      playerId: transaction.playerId, roundId: transaction.roundId, gameId: transaction.gameId, kind: transaction.kind,
      amount: transaction.money.toString(), currency: transaction.money.currency, status: transaction.status,
      failureCode: transaction.failureCode ?? null, resultBalance: transaction.resultBalance?.toString() ?? null,
      resultCurrency: transaction.resultBalance?.currency ?? null, createdAt: transaction.createdAt, processedAt: transaction.processedAt ?? null,
      referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
      referenceTransactionId: transaction.referenceTransactionId ?? null,
      referenceAttempts: transaction.referenceAttempts, nextAttemptAt: transaction.nextAttemptAt ?? null,
    };
  }
  private async insertLedger(manager: EntityManager, entry: WalletLedgerEntry): Promise<void> {
    const row: Omit<LedgerRow, 'sequence'> = {
      id: entry.id, walletId: entry.walletId, transactionId: entry.transactionId, direction: entry.direction,
      amount: entry.money.toString(), currency: entry.money.currency,
      balanceBefore: entry.balanceBefore.toString(), balanceAfter: entry.balanceAfter.toString(), createdAt: entry.createdAt,
    };
    await manager.insert(LedgerEntity, row);
  }
  private hydrateWallet(row: WalletRow): Wallet {
    return Wallet.rehydrate({ ...row, balance: this.money(row.balance, row.currency) });
  }
  private hydrateTransaction(row: TransactionRow): WagerTransaction {
    return WagerTransaction.rehydrate({
      ...row, money: this.money(row.amount, row.currency), failureCode: row.failureCode ?? undefined,
      processedAt: row.processedAt ?? undefined,
      referenceExternalTransactionId: row.referenceExternalTransactionId ?? undefined,
      referenceTransactionId: row.referenceTransactionId ?? undefined, nextAttemptAt: row.nextAttemptAt ?? undefined,
      resultBalance: row.resultBalance !== null && row.resultCurrency ? this.money(row.resultBalance, row.resultCurrency) : undefined,
    });
  }
  private money(amount: string, currency: string): Money { return Money.from({ amount, currency }); }
  private hasDatabaseCode(error: unknown, code: string): boolean {
    return error !== null && typeof error === 'object' && 'driverError' in error
      && (error.driverError as { code?: string }).code === code;
  }
}
