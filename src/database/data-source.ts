import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { LedgerEntity, TransactionEntity, WalletEntity } from './entities';
import { FinancialCore1792195200000 } from './migrations/1792195200000-financial-core';

export function createDataSource(url = process.env.DATABASE_URL): DataSource {
  if (!url) throw new Error('DATABASE_URL is required');
  return new DataSource({
    type: 'postgres', url, entities: [WalletEntity, TransactionEntity, LedgerEntity],
    migrations: [FinancialCore1792195200000], synchronize: false, migrationsRun: false,
    extra: { max: 10, connectionTimeoutMillis: 5000, statement_timeout: 10000, lock_timeout: 5000 },
  });
}
