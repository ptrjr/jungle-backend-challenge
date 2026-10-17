import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

interface ReconciliationRow {
  wallet_id: string;
  currency: string;
  stored_balance: string;
  calculated_balance: string;
  checked_entries: string;
  difference: string;
  consistent: boolean;
}

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);
  private divergenceCount = 0;

  constructor(@Inject(DataSource) private readonly source: DataSource) {}

  async reconcile(walletId: string) {
    const rows: ReconciliationRow[] = await this.source.query(`
      WITH balances AS (
        SELECT w.id AS wallet_id, w.currency, w.balance AS stored_balance,
          COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0.00) AS calculated_balance,
          COUNT(l.id)::text AS checked_entries
        FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
        WHERE w.id = $1 GROUP BY w.id
      )
      SELECT wallet_id, currency, stored_balance::text, calculated_balance::text, checked_entries,
        (stored_balance - calculated_balance)::text AS difference,
        stored_balance = calculated_balance AS consistent FROM balances`, [walletId]);
    const row = rows[0];
    if (!row) throw new NotFoundException({ code: 'WALLET_NOT_FOUND' });
    if (!row.consistent) {
      this.divergenceCount++;
      this.logger.warn({ code: 'RECONCILIATION_MISMATCH', walletId });
    }
    return {
      walletId, storedBalance: { amount: row.stored_balance, currency: row.currency },
      calculatedBalance: { amount: row.calculated_balance, currency: row.currency },
      difference: { amount: row.difference, currency: row.currency },
      consistent: row.consistent, checkedEntries: Number(row.checked_entries),
    };
  }

  metrics(): string {
    return '# HELP wallet_reconciliation_divergences_total Reconciliations with a ledger balance mismatch.\n'
      + '# TYPE wallet_reconciliation_divergences_total counter\n'
      + `wallet_reconciliation_divergences_total ${this.divergenceCount}\n`;
  }
}
