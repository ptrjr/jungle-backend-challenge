import { EntitySchema } from 'typeorm';
import { FailureCode, WagerTransactionKind, WagerTransactionStatus } from '../domain/wager-transaction';
import { LedgerDirection } from '../domain/wallet-ledger-entry';

export interface WalletRow {
  id: string; playerId: string; currency: string; balance: string; version: number; createdAt: Date; updatedAt: Date;
}
export interface TransactionRow {
  id: string; providerId: string; externalTransactionId: string; idempotencyKey: string; payloadHash: string;
  walletId: string; playerId: string; roundId: string; gameId: string; kind: WagerTransactionKind;
  amount: string; currency: string; status: WagerTransactionStatus; failureCode: FailureCode | null;
  resultBalance: string | null; resultCurrency: string | null; createdAt: Date; processedAt: Date | null;
}
export interface LedgerRow {
  id: string; walletId: string; transactionId: string; direction: LedgerDirection;
  amount: string; currency: string; balanceBefore: string; balanceAfter: string; createdAt: Date; sequence: string;
}

export const WalletEntity = new EntitySchema<WalletRow>({
  name: 'WalletRow', tableName: 'wallets', columns: {
    id: { type: 'uuid', primary: true }, playerId: { type: 'uuid', name: 'player_id' },
    currency: { type: 'varchar', length: 3 }, balance: { type: 'numeric' }, version: { type: 'integer' },
    createdAt: { type: 'timestamptz', name: 'created_at' }, updatedAt: { type: 'timestamptz', name: 'updated_at' },
  },
});
export const TransactionEntity = new EntitySchema<TransactionRow>({
  name: 'TransactionRow', tableName: 'wager_transactions', columns: {
    id: { type: 'uuid', primary: true }, providerId: { type: 'varchar', name: 'provider_id' },
    externalTransactionId: { type: 'varchar', name: 'external_transaction_id' }, idempotencyKey: { type: 'varchar', name: 'idempotency_key' },
    payloadHash: { type: 'varchar', name: 'payload_hash' }, walletId: { type: 'uuid', name: 'wallet_id' }, playerId: { type: 'uuid', name: 'player_id' },
    roundId: { type: 'varchar', name: 'round_id' }, gameId: { type: 'varchar', name: 'game_id' }, kind: { type: 'varchar' },
    amount: { type: 'numeric' }, currency: { type: 'varchar' }, status: { type: 'varchar' },
    failureCode: { type: 'varchar', name: 'failure_code', nullable: true },
    resultBalance: { type: 'numeric', name: 'result_balance', nullable: true }, resultCurrency: { type: 'varchar', name: 'result_currency', nullable: true },
    createdAt: { type: 'timestamptz', name: 'created_at' }, processedAt: { type: 'timestamptz', name: 'processed_at', nullable: true },
  },
});
export const LedgerEntity = new EntitySchema<LedgerRow>({
  name: 'LedgerRow', tableName: 'wallet_ledger_entries', columns: {
    id: { type: 'uuid', primary: true }, walletId: { type: 'uuid', name: 'wallet_id' }, transactionId: { type: 'uuid', name: 'transaction_id' },
    direction: { type: 'varchar' }, amount: { type: 'numeric' }, currency: { type: 'varchar' },
    balanceBefore: { type: 'numeric', name: 'balance_before' }, balanceAfter: { type: 'numeric', name: 'balance_after' },
    createdAt: { type: 'timestamptz', name: 'created_at' }, sequence: { type: 'bigint', generated: 'increment' },
  },
});
