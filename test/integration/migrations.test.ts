import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '../helpers/postgres';

test('empty disposable schema supports complete down/up and repeated up is a no-op', async () => {
  const database = await createTestDatabase();
  const source = database.sources[0]!;
  async function down() {
    const child = Bun.spawn([process.execPath, 'scripts/migrate.ts', 'down'], {
      env: { ...process.env, DATABASE_URL: database.scopedUrl }, stdout: 'ignore', stderr: 'pipe',
    });
    const message = await new Response(child.stderr).text();
    return { code: await child.exited, message };
  }
  try {
    expect(await source.runMigrations({ transaction: 'all' })).toHaveLength(0);
    for (let i = 0; i < 3; i++) expect((await down()).code).toBe(0);
    const [row] = await source.query("SELECT to_regclass('wallets') AS wallets, to_regclass('outbox_messages') AS outbox");
    expect(row).toEqual({ wallets: null, outbox: null });
    expect(await source.runMigrations({ transaction: 'all' })).toHaveLength(3);
    const wallet = await database.services[0]!.openWallet(randomUUID(), { amount: '100.00', currency: 'BRL' });
    const before = await source.query('SELECT * FROM wallet_ledger_entries');
    expect(await source.runMigrations({ transaction: 'all' })).toHaveLength(0);
    expect(await source.query('SELECT * FROM wallet_ledger_entries')).toEqual(before);
    expect((await database.services[0]!.getWallet(wallet.id)).balance.amount).toBe('100.00');
    const outboxRefusal = await down();
    expect(outboxRefusal.code).toBe(1);
    expect(outboxRefusal.message).toContain('Downgrade refused');
    expect(await source.runMigrations({ transaction: 'all' })).toHaveLength(0);
    expect(await source.query('SELECT * FROM wallet_ledger_entries')).toEqual(before);
    // This schema is disposable; direct ORM downgrade exercises the original financial migration guard separately.
    await source.undoLastMigration({ transaction: 'all' });
    expect((await down()).code).toBe(0);
    const financialRefusal = await down();
    expect(financialRefusal.code).toBe(1);
    expect(financialRefusal.message).toContain('financial history must be preserved');
    expect(await source.query('SELECT * FROM wallet_ledger_entries')).toEqual(before);
  } finally { await database.close(); }
});
