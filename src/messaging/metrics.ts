import { DataSource } from 'typeorm';

class MessagingMetrics {
  duplicates = 0;
  retries = 0;
  deadLetters = 0;
  published = 0;
  lockConflicts = 0;
  private latencySum = 0;
  private latencyCount = 0;

  observe(seconds: number): void { this.latencySum += seconds; this.latencyCount++; }
  async render(source: DataSource, deadLetterDepth?: number): Promise<string> {
    const statuses: { status: string; count: string }[] = await source.query('SELECT status, COUNT(*)::text AS count FROM wager_transactions GROUP BY status');
    const [outbox]: { lag: string; pending: string }[] = await source.query(`SELECT COUNT(*)::text AS pending,
      COALESCE(EXTRACT(EPOCH FROM (now() - MIN(occurred_at))), 0)::text AS lag FROM outbox_messages WHERE published_at IS NULL`);
    return [
      '# TYPE wager_transactions gauge', ...statuses.map(row => `wager_transactions{status="${row.status}"} ${row.count}`),
      '# TYPE messaging_duplicates_total counter', `messaging_duplicates_total ${this.duplicates}`,
      '# TYPE messaging_retries_total counter', `messaging_retries_total ${this.retries}`,
      '# TYPE messaging_dlq_total counter', `messaging_dlq_total ${this.deadLetters}`,
      ...(deadLetterDepth === undefined ? [] : ['# TYPE sqs_dlq_messages gauge', `sqs_dlq_messages ${deadLetterDepth}`]),
      '# TYPE outbox_published_total counter', `outbox_published_total ${this.published}`,
      '# TYPE wallet_lock_conflicts_total counter', `wallet_lock_conflicts_total ${this.lockConflicts}`,
      '# TYPE outbox_pending gauge', `outbox_pending ${outbox!.pending}`,
      '# TYPE outbox_lag_seconds gauge', `outbox_lag_seconds ${Math.max(0, Number(outbox!.lag))}`,
      '# TYPE processing_seconds summary', `processing_seconds_sum ${this.latencySum}`, `processing_seconds_count ${this.latencyCount}`, '',
    ].join('\n');
  }
}

export const messagingMetrics = new MessagingMetrics();
