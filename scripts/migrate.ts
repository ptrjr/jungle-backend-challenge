import { createDataSource } from '../src/database/data-source';

async function main(): Promise<void> {
  const direction = process.argv[2];
  if (direction !== 'up' && direction !== 'down') throw new Error('Use up or down');
  const source = await createDataSource().initialize();
  try {
    if (direction === 'up') console.log((await source.runMigrations({ transaction: 'all' })).map(m => m.name));
    else await source.undoLastMigration({ transaction: 'all' });
  } finally { await source.destroy(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
