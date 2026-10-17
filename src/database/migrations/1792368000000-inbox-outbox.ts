import { MigrationInterface, QueryRunner } from 'typeorm';

export class InboxOutbox1792368000000 implements MigrationInterface {
  name = 'InboxOutbox1792368000000';
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      CREATE TABLE inbox_messages (
        consumer_name varchar(128) NOT NULL CHECK (length(consumer_name) > 0),
        message_id varchar(128) NOT NULL CHECK (length(message_id) > 0),
        payload_hash varchar(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
        received_at timestamptz NOT NULL,
        processed_at timestamptz,
        transaction_id uuid REFERENCES wager_transactions(id),
        PRIMARY KEY (consumer_name, message_id),
        CHECK ((processed_at IS NULL) = (transaction_id IS NULL))
      );
      CREATE TABLE outbox_messages (
        id uuid PRIMARY KEY,
        aggregate_id uuid NOT NULL REFERENCES wallets(id),
        transaction_id uuid NOT NULL REFERENCES wager_transactions(id),
        event_type varchar(64) NOT NULL CHECK (event_type IN ('WagerTransactionProcessed','WagerTransactionRejected','WalletBalanceChanged','WagerTransactionPendingReference')),
        payload jsonb NOT NULL,
        occurred_at timestamptz NOT NULL,
        attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at timestamptz,
        published_at timestamptz,
        last_error_code varchar(64),
        UNIQUE (transaction_id, event_type),
        CHECK (COALESCE(payload->>'eventId' = id::text AND payload->>'eventType' = event_type
          AND payload->>'aggregateId' = aggregate_id::text AND payload->>'version' = '1'
          AND length(payload->>'correlationId') BETWEEN 1 AND 128 AND payload->'data'->>'transactionId' = transaction_id::text, false)),
        CHECK (published_at IS NULL OR (next_attempt_at IS NULL AND last_error_code IS NULL))
      );
      CREATE INDEX outbox_due_idx ON outbox_messages(COALESCE(next_attempt_at, occurred_at), id) WHERE published_at IS NULL;
      CREATE FUNCTION protect_delivery_state() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_TABLE_NAME = 'inbox_messages' THEN
          IF OLD.processed_at IS NOT NULL OR NEW.processed_at IS NULL OR
            (OLD.consumer_name,OLD.message_id,OLD.payload_hash,OLD.received_at) IS DISTINCT FROM
            (NEW.consumer_name,NEW.message_id,NEW.payload_hash,NEW.received_at) THEN
            RAISE EXCEPTION 'Invalid inbox transition' USING ERRCODE = '23514';
          END IF;
        ELSE
          IF OLD.published_at IS NOT NULL OR NEW.attempts <> OLD.attempts + 1 OR
            (to_jsonb(OLD) - ARRAY['attempts','next_attempt_at','published_at','last_error_code']) <>
            (to_jsonb(NEW) - ARRAY['attempts','next_attempt_at','published_at','last_error_code']) THEN
            RAISE EXCEPTION 'Invalid outbox transition' USING ERRCODE = '23514';
          END IF;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER inbox_state BEFORE UPDATE ON inbox_messages FOR EACH ROW EXECUTE FUNCTION protect_delivery_state();
      CREATE TRIGGER outbox_state BEFORE UPDATE ON outbox_messages FOR EACH ROW EXECUTE FUNCTION protect_delivery_state();
      CREATE TRIGGER inbox_no_delete BEFORE DELETE OR TRUNCATE ON inbox_messages FOR EACH STATEMENT EXECUTE FUNCTION prevent_financial_mutation();
      CREATE TRIGGER outbox_no_delete BEFORE DELETE OR TRUNCATE ON outbox_messages FOR EACH STATEMENT EXECUTE FUNCTION prevent_financial_mutation();
    `);
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE inbox_messages; DROP TABLE outbox_messages; DROP FUNCTION protect_delivery_state();');
  }
}
