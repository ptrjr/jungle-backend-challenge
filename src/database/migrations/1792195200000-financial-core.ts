import { MigrationInterface, QueryRunner } from 'typeorm';

export class FinancialCore1792195200000 implements MigrationInterface {
  name = 'FinancialCore1792195200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE DOMAIN exact_amount AS numeric
        CHECK (VALUE >= 0 AND VALUE <= 999999999999999999.99 AND scale(VALUE) = 2);

      CREATE TABLE wallets (
        id uuid PRIMARY KEY,
        player_id uuid NOT NULL,
        currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        balance exact_amount NOT NULL,
        version integer NOT NULL CHECK (version >= 1),
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        CONSTRAINT wallets_player_currency_unique UNIQUE (player_id, currency),
        UNIQUE (id, currency)
      );

      CREATE TABLE wager_transactions (
        id uuid PRIMARY KEY,
        provider_id varchar(128) NOT NULL CHECK (length(provider_id) > 0),
        external_transaction_id varchar(128) NOT NULL CHECK (length(external_transaction_id) > 0),
        idempotency_key varchar(256) NOT NULL UNIQUE CHECK (length(idempotency_key) > 0),
        payload_hash varchar(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
        wallet_id uuid NOT NULL REFERENCES wallets(id),
        player_id uuid NOT NULL,
        round_id varchar(128) NOT NULL,
        game_id varchar(128) NOT NULL,
        kind varchar(16) NOT NULL CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS')),
        amount exact_amount NOT NULL,
        currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        status varchar(24) NOT NULL CHECK (status IN ('PENDING', 'PROCESSED', 'REJECTED', 'FAILED')),
        failure_code varchar(64),
        result_balance exact_amount,
        result_currency varchar(3),
        created_at timestamptz NOT NULL,
        processed_at timestamptz,
        CONSTRAINT transactions_provider_external_unique UNIQUE (provider_id, external_transaction_id),
        CHECK (kind = 'LOSS' OR amount > 0),
        CHECK ((status IN ('REJECTED', 'FAILED')) = (failure_code IS NOT NULL)),
        CHECK ((status = 'PENDING' AND processed_at IS NULL AND result_balance IS NULL AND result_currency IS NULL)
          OR (status <> 'PENDING' AND processed_at IS NOT NULL AND result_balance IS NOT NULL AND result_currency IS NOT NULL))
      );
      CREATE INDEX transactions_wallet_created_idx ON wager_transactions(wallet_id, created_at, id);

      CREATE TABLE wallet_ledger_entries (
        id uuid PRIMARY KEY,
        sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
        wallet_id uuid NOT NULL,
        transaction_id uuid NOT NULL REFERENCES wager_transactions(id),
        direction varchar(6) NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
        amount exact_amount NOT NULL CHECK (amount > 0),
        currency varchar(3) NOT NULL,
        balance_before exact_amount NOT NULL,
        balance_after exact_amount NOT NULL,
        created_at timestamptz NOT NULL,
        CONSTRAINT ledger_wallet_currency_fk FOREIGN KEY(wallet_id, currency) REFERENCES wallets(id, currency),
        CONSTRAINT ledger_transaction_unique UNIQUE (transaction_id),
        CHECK ((direction = 'CREDIT' AND balance_before + amount = balance_after)
          OR (direction = 'DEBIT' AND balance_before - amount = balance_after))
      );
      CREATE INDEX ledger_wallet_sequence_idx ON wallet_ledger_entries(wallet_id, sequence);

      CREATE FUNCTION prevent_financial_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'Financial history is immutable' USING ERRCODE = '23514';
      END $$;
      CREATE TRIGGER ledger_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION prevent_financial_mutation();
      CREATE TRIGGER transactions_no_delete BEFORE DELETE OR TRUNCATE ON wager_transactions
        FOR EACH STATEMENT EXECUTE FUNCTION prevent_financial_mutation();

      CREATE FUNCTION protect_transaction_state() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status <> 'PENDING' OR
          (to_jsonb(OLD) - ARRAY['status','failure_code','processed_at','result_balance','result_currency']) <>
          (to_jsonb(NEW) - ARRAY['status','failure_code','processed_at','result_balance','result_currency']) THEN
          RAISE EXCEPTION 'Invalid transaction transition' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER transactions_terminal BEFORE UPDATE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION protect_transaction_state();

      CREATE FUNCTION protect_wallet_state() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (NEW.id, NEW.player_id, NEW.currency, NEW.created_at) IS DISTINCT FROM
           (OLD.id, OLD.player_id, OLD.currency, OLD.created_at) OR
           NEW.version <> OLD.version + (CASE WHEN NEW.balance <> OLD.balance THEN 1 ELSE 0 END) THEN
          RAISE EXCEPTION 'Invalid wallet identity or version' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER wallets_version BEFORE UPDATE ON wallets
        FOR EACH ROW EXECUTE FUNCTION protect_wallet_state();

      CREATE FUNCTION check_wallet_ledger_balance() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE target_id uuid; stored numeric; calculated numeric;
      BEGIN
        IF TG_TABLE_NAME = 'wallets' THEN target_id := NEW.id;
        ELSE target_id := NEW.wallet_id; END IF;
        SELECT balance INTO stored FROM wallets WHERE id = target_id FOR UPDATE;
        SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)
          INTO calculated FROM wallet_ledger_entries WHERE wallet_id = target_id;
        IF stored IS DISTINCT FROM calculated THEN
          RAISE EXCEPTION 'Wallet balance must equal ledger sum' USING ERRCODE = '23514';
        END IF;
        RETURN NULL;
      END $$;
      CREATE CONSTRAINT TRIGGER wallets_ledger_consistent AFTER INSERT OR UPDATE ON wallets
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_wallet_ledger_balance();
      CREATE CONSTRAINT TRIGGER ledger_wallet_consistent AFTER INSERT ON wallet_ledger_entries
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_wallet_ledger_balance();

      CREATE FUNCTION check_transaction_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE t wager_transactions; e wallet_ledger_entries; target_id uuid; has_entry boolean;
      BEGIN
        IF TG_TABLE_NAME = 'wager_transactions' THEN target_id := NEW.id;
        ELSE target_id := NEW.transaction_id; END IF;
        SELECT * INTO t FROM wager_transactions WHERE id = target_id;
        SELECT * INTO e FROM wallet_ledger_entries WHERE transaction_id = target_id;
        has_entry := FOUND;
        IF (t.status = 'PROCESSED' AND t.kind <> 'LOSS') THEN
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
      CREATE CONSTRAINT TRIGGER transactions_ledger_consistent AFTER INSERT OR UPDATE ON wager_transactions
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_transaction_ledger();
      CREATE CONSTRAINT TRIGGER ledger_transaction_consistent AFTER INSERT ON wallet_ledger_entries
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_transaction_ledger();
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE wallet_ledger_entries;
      DROP TABLE wager_transactions;
      DROP TABLE wallets;
      DROP FUNCTION check_transaction_ledger();
      DROP FUNCTION check_wallet_ledger_balance();
      DROP FUNCTION protect_wallet_state();
      DROP FUNCTION protect_transaction_state();
      DROP FUNCTION prevent_financial_mutation();
      DROP DOMAIN exact_amount;
    `);
  }
}
