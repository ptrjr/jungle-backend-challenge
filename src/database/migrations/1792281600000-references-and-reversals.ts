import { MigrationInterface, QueryRunner } from 'typeorm';

export class ReferencesAndReversals1792281600000 implements MigrationInterface {
  name = 'ReferencesAndReversals1792281600000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      ALTER TABLE wager_transactions
        ADD COLUMN reference_external_transaction_id varchar(128),
        ADD COLUMN reference_transaction_id uuid REFERENCES wager_transactions(id),
        ADD COLUMN reference_attempts integer NOT NULL DEFAULT 0,
        ADD COLUMN next_attempt_at timestamptz,
        DROP CONSTRAINT wager_transactions_kind_check,
        DROP CONSTRAINT wager_transactions_status_check,
        DROP CONSTRAINT wager_transactions_check2,
        ADD CONSTRAINT transactions_kind_check CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        ADD CONSTRAINT transactions_status_check CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        ADD CONSTRAINT transactions_reference_required CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        ADD CONSTRAINT transactions_reference_kind CHECK (reference_external_transaction_id IS NULL OR
          (kind IN ('WIN','REFUND','ROLLBACK') AND length(trim(reference_external_transaction_id)) > 0)),
        ADD CONSTRAINT transactions_reference_link CHECK (reference_transaction_id IS NULL OR reference_external_transaction_id IS NOT NULL),
        ADD CONSTRAINT transactions_reference_attempts CHECK (reference_attempts BETWEEN 0 AND 8),
        ADD CONSTRAINT transactions_result_state_check CHECK (
          (status = 'PENDING' AND processed_at IS NULL AND result_balance IS NULL AND result_currency IS NULL AND next_attempt_at IS NULL)
          OR (status = 'PENDING_REFERENCE' AND processed_at IS NULL AND result_balance IS NOT NULL AND result_currency IS NOT NULL
            AND reference_external_transaction_id IS NOT NULL AND next_attempt_at IS NOT NULL AND reference_attempts < 8)
          OR (status IN ('PROCESSED','REJECTED','FAILED') AND processed_at IS NOT NULL AND result_balance IS NOT NULL
            AND result_currency IS NOT NULL AND next_attempt_at IS NULL)
        );
      CREATE UNIQUE INDEX transactions_reversal_once_idx ON wager_transactions(reference_transaction_id, kind)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK');
      CREATE INDEX transactions_reference_due_idx ON wager_transactions(next_attempt_at, wallet_id)
        WHERE status = 'PENDING_REFERENCE';

      CREATE OR REPLACE FUNCTION protect_transaction_state() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status NOT IN ('PENDING','PENDING_REFERENCE')
          OR (OLD.status = 'PENDING_REFERENCE' AND NEW.status = 'PENDING')
          OR NEW.reference_attempts < OLD.reference_attempts OR NEW.reference_attempts > OLD.reference_attempts + 1
          OR (to_jsonb(OLD) - ARRAY['status','failure_code','processed_at','result_balance','result_currency','reference_transaction_id','reference_attempts','next_attempt_at']) <>
             (to_jsonb(NEW) - ARRAY['status','failure_code','processed_at','result_balance','result_currency','reference_transaction_id','reference_attempts','next_attempt_at']) THEN
          RAISE EXCEPTION 'Invalid transaction transition' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $$;

      CREATE OR REPLACE FUNCTION check_transaction_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE t wager_transactions; ref wager_transactions; e wallet_ledger_entries;
        target_id uuid; has_entry boolean; expected_direction text; reference_direction text;
      BEGIN
        IF TG_TABLE_NAME = 'wager_transactions' THEN target_id := NEW.id;
        ELSE target_id := NEW.transaction_id; END IF;
        SELECT * INTO t FROM wager_transactions WHERE id = target_id;
        IF t.status = 'PROCESSED' AND t.reference_external_transaction_id IS NOT NULL THEN
          SELECT * INTO ref FROM wager_transactions WHERE id = t.reference_transaction_id;
          IF NOT FOUND OR ref.id = t.id OR ref.status <> 'PROCESSED'
            OR (ref.provider_id,ref.external_transaction_id,ref.player_id,ref.wallet_id,ref.currency,ref.round_id) IS DISTINCT FROM
               (t.provider_id,t.reference_external_transaction_id,t.player_id,t.wallet_id,t.currency,t.round_id)
            OR (t.kind IN ('REFUND','WIN') AND ref.kind <> 'BET')
            OR (t.kind = 'ROLLBACK' AND ref.kind NOT IN ('BET','WIN','REFUND'))
            OR (t.kind IN ('REFUND','ROLLBACK') AND t.amount <> ref.amount) THEN
            RAISE EXCEPTION 'Invalid processed reference' USING ERRCODE = '23514';
          END IF;
        END IF;
        SELECT * INTO e FROM wallet_ledger_entries WHERE transaction_id = target_id;
        has_entry := FOUND;
        IF t.status = 'PROCESSED' AND t.kind <> 'LOSS' THEN
          expected_direction := CASE WHEN t.kind = 'BET' THEN 'DEBIT' ELSE 'CREDIT' END;
          IF t.kind = 'ROLLBACK' THEN
            SELECT direction INTO reference_direction FROM wallet_ledger_entries WHERE transaction_id = t.reference_transaction_id;
            expected_direction := CASE WHEN reference_direction = 'CREDIT' THEN 'DEBIT' ELSE 'CREDIT' END;
          END IF;
          IF NOT has_entry OR e.wallet_id <> t.wallet_id OR e.currency <> t.currency OR e.amount <> t.amount
            OR e.balance_after <> t.result_balance OR t.result_currency <> t.currency OR e.direction <> expected_direction THEN
            RAISE EXCEPTION 'Processed movement requires its matching ledger entry' USING ERRCODE = '23514';
          END IF;
        ELSIF has_entry THEN
          RAISE EXCEPTION 'Non-financial transaction cannot have a ledger entry' USING ERRCODE = '23514';
        END IF;
        IF t.status = 'PROCESSED' AND NOT EXISTS (
          SELECT 1 FROM wallets w WHERE w.id = t.wallet_id AND w.player_id = t.player_id AND w.currency = t.currency
        ) THEN
          RAISE EXCEPTION 'Processed transaction must match wallet owner and currency' USING ERRCODE = '23514';
        END IF;
        RETURN NULL;
      END $$;
    `);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM wager_transactions WHERE kind IN ('REFUND','ROLLBACK')
          OR status = 'PENDING_REFERENCE' OR reference_external_transaction_id IS NOT NULL) THEN
          RAISE EXCEPTION 'Cannot revert references migration while stage two history exists';
        END IF;
      END $$;
      DROP INDEX transactions_reversal_once_idx;
      DROP INDEX transactions_reference_due_idx;
      ALTER TABLE wager_transactions
        DROP CONSTRAINT transactions_kind_check,
        DROP CONSTRAINT transactions_status_check,
        DROP CONSTRAINT transactions_reference_required,
        DROP CONSTRAINT transactions_reference_kind,
        DROP CONSTRAINT transactions_reference_link,
        DROP CONSTRAINT transactions_reference_attempts,
        DROP CONSTRAINT transactions_result_state_check,
        DROP COLUMN reference_external_transaction_id,
        DROP COLUMN reference_transaction_id,
        DROP COLUMN reference_attempts,
        DROP COLUMN next_attempt_at,
        ADD CONSTRAINT wager_transactions_kind_check CHECK (kind IN ('OPENING','BET','WIN','LOSS')),
        ADD CONSTRAINT wager_transactions_status_check CHECK (status IN ('PENDING','PROCESSED','REJECTED','FAILED')),
        ADD CONSTRAINT wager_transactions_check2 CHECK (
          (status = 'PENDING' AND processed_at IS NULL AND result_balance IS NULL AND result_currency IS NULL)
          OR (status <> 'PENDING' AND processed_at IS NOT NULL AND result_balance IS NOT NULL AND result_currency IS NOT NULL)
        );
      CREATE OR REPLACE FUNCTION protect_transaction_state() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status <> 'PENDING' OR
          (to_jsonb(OLD) - ARRAY['status','failure_code','processed_at','result_balance','result_currency']) <>
          (to_jsonb(NEW) - ARRAY['status','failure_code','processed_at','result_balance','result_currency']) THEN
          RAISE EXCEPTION 'Invalid transaction transition' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $$;
      CREATE OR REPLACE FUNCTION check_transaction_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE t wager_transactions; e wallet_ledger_entries; target_id uuid; has_entry boolean;
      BEGIN
        IF TG_TABLE_NAME = 'wager_transactions' THEN target_id := NEW.id;
        ELSE target_id := NEW.transaction_id; END IF;
        SELECT * INTO t FROM wager_transactions WHERE id = target_id;
        SELECT * INTO e FROM wallet_ledger_entries WHERE transaction_id = target_id;
        has_entry := FOUND;
        IF t.status = 'PROCESSED' AND t.kind <> 'LOSS' THEN
          IF NOT has_entry OR e.wallet_id <> t.wallet_id OR e.currency <> t.currency OR e.amount <> t.amount
            OR e.balance_after <> t.result_balance OR t.result_currency <> t.currency
            OR e.direction <> (CASE WHEN t.kind = 'BET' THEN 'DEBIT' ELSE 'CREDIT' END) THEN
            RAISE EXCEPTION 'Processed movement requires its matching ledger entry' USING ERRCODE = '23514';
          END IF;
        ELSIF has_entry THEN
          RAISE EXCEPTION 'Non-financial transaction cannot have a ledger entry' USING ERRCODE = '23514';
        END IF;
        IF t.status = 'PROCESSED' AND NOT EXISTS (
          SELECT 1 FROM wallets w WHERE w.id = t.wallet_id AND w.player_id = t.player_id AND w.currency = t.currency
        ) THEN
          RAISE EXCEPTION 'Processed transaction must match wallet owner and currency' USING ERRCODE = '23514';
        END IF;
        RETURN NULL;
      END $$;
    `);
  }
}
