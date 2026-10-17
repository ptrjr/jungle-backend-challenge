import { randomUUID } from 'node:crypto';
import { createDataSource } from '../../src/database/data-source';
import { FinancialService } from '../../src/application/financial-service';

export async function createTestDatabase() {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith('_test')) {
    throw new Error('TEST_DATABASE_URL must point to a disposable PostgreSQL database ending in _test');
  }
  const schema = `references_${randomUUID().replaceAll('-', '')}`;
  const admin = await createDataSource(databaseUrl).initialize();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(databaseUrl);
  url.searchParams.set('options', `-csearch_path=${schema}`);
  const scopedUrl = url.toString();
  const sources = await Promise.all([0, 1, 2].map(() => createDataSource(scopedUrl).initialize()));
  await sources[0]!.runMigrations({ transaction: 'all' });
  return {
    scopedUrl, sources, services: sources.map(source => new FinancialService(source)),
    async close() {
      await Promise.all(sources.map(source => source.destroy()));
      try { await admin.query(`DROP SCHEMA ${schema} CASCADE`); }
      finally { await admin.destroy(); }
    },
  };
}

// Await errors in JavaScript: Bun's native async rejection matcher crashed on Windows.
export async function captureFailure(operation: Promise<unknown>): Promise<Error & { driverError?: { code: string } }> {
  try { await operation; }
  catch (error) {
    if (error instanceof Error) return error;
    throw new Error('Expected an Error instance');
  }
  throw new Error('Expected the operation to fail');
}
