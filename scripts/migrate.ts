import { createDataSource } from '../src/database/data-source';
import { MigrationExecutor } from 'typeorm';

async function main(): Promise<void> {
  const direction = process.argv[2];
  if (direction !== 'up' && direction !== 'down') throw new Error('Use up or down');
  const source = await createDataSource().initialize();
  try {
    if (direction === 'up') console.log((await source.runMigrations({ transaction: 'all' })).map(m => m.name));
    else {
      const runner = source.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        const [latest] = await runner.query('SELECT name FROM migrations ORDER BY id DESC LIMIT 1') as { name: string }[];
        if (latest?.name === 'InboxOutbox1792368000000') {
          await runner.query('LOCK TABLE inbox_messages, outbox_messages IN ACCESS EXCLUSIVE MODE');
          const [history] = await runner.query(`SELECT EXISTS(SELECT 1 FROM inbox_messages)
            OR EXISTS(SELECT 1 FROM outbox_messages) AS present`);
          if (history.present) throw new Error('Downgrade refused: inbox/outbox history must be preserved. Use an empty disposable database.');
        }
        if (latest?.name === 'FinancialCore1792195200000') {
          await runner.query('LOCK TABLE wallets, wager_transactions, wallet_ledger_entries IN ACCESS EXCLUSIVE MODE');
          const [history] = await runner.query('SELECT EXISTS(SELECT 1 FROM wallets) OR EXISTS(SELECT 1 FROM wager_transactions) AS present');
          if (history.present) throw new Error('Downgrade refused: financial history must be preserved. Use an empty disposable database.');
        }
        const executor = new MigrationExecutor(source, runner);
        executor.transaction = 'all';
        await executor.undoLastMigration();
        await runner.commitTransaction();
      } catch (error) { await runner.rollbackTransaction(); throw error; }
      finally { await runner.release(); }
    }
  } finally { await source.destroy(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
