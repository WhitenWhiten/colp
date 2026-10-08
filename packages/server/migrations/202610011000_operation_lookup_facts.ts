import { sql, type Kysely, type Migration } from 'kysely';

const LOOKUP_TYPES = sql`('attachment.finalized', 'attachment.retired')`;

/**
 * Retain the small identity/idempotency subset of archiveable Operation JSON.
 * The facts are permanent and deliberately contain no arbitrary JSON.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`LOCK TABLE operations, operation_payloads IN ACCESS EXCLUSIVE MODE`.execute(db);

  await sql`CREATE FUNCTION operation_lookup_fact_text(
      payload jsonb, field_name text, required boolean
    ) RETURNS text LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $body$
    DECLARE value text;
    BEGIN
      IF NOT payload ? field_name THEN
        IF required THEN
          RAISE EXCEPTION 'Operation lookup fact % is required', field_name
            USING ERRCODE='23514', CONSTRAINT='operation_lookup_facts_payload_shape';
        END IF;
        RETURN NULL;
      END IF;
      IF jsonb_typeof(payload -> field_name) <> 'string' THEN
        RAISE EXCEPTION 'Operation lookup fact % must be a string', field_name
          USING ERRCODE='23514', CONSTRAINT='operation_lookup_facts_payload_shape';
      END IF;
      value := payload ->> field_name;
      IF length(value) = 0 THEN
        RAISE EXCEPTION 'Operation lookup fact % must not be empty', field_name
          USING ERRCODE='23514', CONSTRAINT='operation_lookup_facts_payload_shape';
      END IF;
      RETURN value;
    END $body$`.execute(db);

  await sql`ALTER TABLE operations ADD CONSTRAINT operations_lookup_fact_binding_unique
    UNIQUE (operation_id, collection_id, commit_ordinal, operation_type)`.execute(db);
  await sql`CREATE TABLE operation_lookup_facts (
    operation_id text PRIMARY KEY,
    collection_id text NOT NULL,
    commit_ordinal bigint NOT NULL CHECK (commit_ordinal > 0),
    operation_type text NOT NULL CHECK (operation_type IN ${LOOKUP_TYPES}),
    command_id text CHECK (command_id IS NULL OR length(command_id) > 0),
    attachment_id text NOT NULL CHECK (length(attachment_id) > 0),
    blob_id text NOT NULL CHECK (length(blob_id) > 0),
    CONSTRAINT operation_lookup_facts_operation_fk FOREIGN KEY (
      operation_id, collection_id, commit_ordinal, operation_type
    ) REFERENCES operations(operation_id, collection_id, commit_ordinal, operation_type)
      ON DELETE RESTRICT,
    CONSTRAINT operation_lookup_facts_attachment_unique UNIQUE (
      operation_type, collection_id, attachment_id
    ),
    CONSTRAINT operation_lookup_facts_blob_unique UNIQUE (operation_type, blob_id)
  )`.execute(db);
  await sql`CREATE UNIQUE INDEX operation_lookup_facts_command_unique
    ON operation_lookup_facts(operation_type, command_id)
    WHERE command_id IS NOT NULL`.execute(db);

  await sql`INSERT INTO operation_lookup_facts (
      operation_id, collection_id, commit_ordinal, operation_type,
      command_id, attachment_id, blob_id
    )
    SELECT operation.operation_id, operation.collection_id, operation.commit_ordinal,
      operation.operation_type,
      operation_lookup_fact_text(payload.payload_json, 'commandId', false),
      operation_lookup_fact_text(payload.payload_json, 'attachmentId', true),
      operation_lookup_fact_text(payload.payload_json, 'blobId', true)
    FROM operations operation
    JOIN operation_payloads payload ON payload.operation_id = operation.operation_id
    WHERE operation.operation_type IN ${LOOKUP_TYPES}`.execute(db);

  await sql`DO $body$ BEGIN
    IF (SELECT count(*) FROM operation_lookup_facts) <>
       (SELECT count(*) FROM operations WHERE operation_type IN
         ('attachment.finalized', 'attachment.retired'))
      OR EXISTS (
        SELECT 1 FROM operations operation
        LEFT JOIN operation_payloads payload ON payload.operation_id=operation.operation_id
        LEFT JOIN operation_lookup_facts fact ON fact.operation_id=operation.operation_id
        WHERE operation.operation_type IN ('attachment.finalized', 'attachment.retired')
          AND (payload.operation_id IS NULL OR fact.operation_id IS NULL
            OR fact.collection_id IS DISTINCT FROM operation.collection_id
            OR fact.commit_ordinal IS DISTINCT FROM operation.commit_ordinal
            OR fact.operation_type IS DISTINCT FROM operation.operation_type
            OR fact.command_id IS DISTINCT FROM
              operation_lookup_fact_text(payload.payload_json, 'commandId', false)
            OR fact.attachment_id IS DISTINCT FROM
              operation_lookup_fact_text(payload.payload_json, 'attachmentId', true)
            OR fact.blob_id IS DISTINCT FROM
              operation_lookup_fact_text(payload.payload_json, 'blobId', true))
      ) THEN
      RAISE EXCEPTION 'Operation lookup fact backfill failed exactness validation';
    END IF;
  END $body$`.execute(db);

  await sql`DROP INDEX IF EXISTS operation_payloads_command_idx`.execute(db);
  await createGuards(db);
  await sql`COMMENT ON TABLE operation_lookup_facts IS
    'Permanent minimal Operation identity/idempotency lookup facts; monitor append-only identity-lifetime growth. No payload JSON is retained here.'`.execute(db);
}

async function createGuards(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE FUNCTION guard_operation_lookup_fact_mutation() RETURNS trigger
    LANGUAGE plpgsql AS $body$ BEGIN
      RAISE EXCEPTION 'Operation lookup facts are permanent and immutable'
        USING ERRCODE='23514', CONSTRAINT='operation_lookup_facts_immutable';
    END $body$`.execute(db);
  await sql`CREATE TRIGGER operation_lookup_facts_immutable
    BEFORE UPDATE OR DELETE ON operation_lookup_facts FOR EACH ROW
    EXECUTE FUNCTION guard_operation_lookup_fact_mutation()`.execute(db);
  await sql`CREATE TRIGGER operation_lookup_facts_truncate_guard
    BEFORE TRUNCATE ON operation_lookup_facts FOR EACH STATEMENT
    EXECUTE FUNCTION guard_operation_lookup_fact_mutation()`.execute(db);
}

/** Developer-only rollback; every recognized payload must still be hot and exact. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`LOCK TABLE operations, operation_payloads, operation_lookup_facts
    IN ACCESS EXCLUSIVE MODE`.execute(db);
  await sql`DO $body$ BEGIN
    IF (SELECT count(*) FROM operation_lookup_facts) <>
       (SELECT count(*) FROM operations WHERE operation_type IN
         ('attachment.finalized', 'attachment.retired'))
      OR EXISTS (
        SELECT 1 FROM operations operation
        LEFT JOIN operation_payloads payload ON payload.operation_id=operation.operation_id
        LEFT JOIN operation_lookup_facts fact ON fact.operation_id=operation.operation_id
        WHERE operation.operation_type IN ('attachment.finalized', 'attachment.retired')
          AND (operation.payload_source <> 'hot' OR payload.operation_id IS NULL
            OR fact.operation_id IS NULL
            OR fact.command_id IS DISTINCT FROM
              operation_lookup_fact_text(payload.payload_json, 'commandId', false)
            OR fact.attachment_id IS DISTINCT FROM
              operation_lookup_fact_text(payload.payload_json, 'attachmentId', true)
            OR fact.blob_id IS DISTINCT FROM
              operation_lookup_fact_text(payload.payload_json, 'blobId', true))
      ) THEN
      RAISE EXCEPTION 'Cannot drop Operation lookup facts: hot payload reconstruction is incomplete';
    END IF;
  END $body$`.execute(db);
  await sql`DROP TRIGGER operation_lookup_facts_truncate_guard ON operation_lookup_facts`.execute(db);
  await sql`DROP TRIGGER operation_lookup_facts_immutable ON operation_lookup_facts`.execute(db);
  await sql`DROP FUNCTION guard_operation_lookup_fact_mutation()`.execute(db);
  await sql`DROP TABLE operation_lookup_facts`.execute(db);
  await sql`ALTER TABLE operations DROP CONSTRAINT operations_lookup_fact_binding_unique`.execute(db);
  await sql`CREATE INDEX operation_payloads_command_idx
    ON operation_payloads((payload_json ->> 'commandId'), commit_ordinal DESC)
    INCLUDE (operation_id, collection_id)
    WHERE payload_json ? 'commandId'`.execute(db);
  await sql`DROP FUNCTION operation_lookup_fact_text(jsonb, text, boolean)`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
