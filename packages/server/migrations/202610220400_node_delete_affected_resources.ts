import { sql, type Kysely, type Migration } from 'kysely';

/**
 * Immutable node ids affected by one canonical delete operation.
 * Projection reads these facts. It must not reconstruct ids from live tombstones.
 * Hot operation payloads remain the only backfill source for deletes that
 * committed before this table existed. UPDATE and DELETE are refused;
 * TRUNCATE stays available so operation resets can cascade.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE node_delete_affected_resources (
    collection_id text NOT NULL,
    commit_ordinal bigint NOT NULL CHECK (commit_ordinal > 0),
    root_node_id text NOT NULL CHECK (length(root_node_id) > 0),
    resource_id text NOT NULL CHECK (length(resource_id) > 0),
    fact_ordinal integer NOT NULL CHECK (fact_ordinal >= 0),
    operation_id text NOT NULL CHECK (length(operation_id) > 0),
    recorded_at timestamptz NOT NULL DEFAULT current_timestamp,
    PRIMARY KEY (collection_id, commit_ordinal, resource_id),
    UNIQUE (collection_id, commit_ordinal, fact_ordinal),
    CONSTRAINT node_delete_affected_resources_operation_fk
      FOREIGN KEY (operation_id, collection_id, commit_ordinal)
      REFERENCES operations(operation_id, collection_id, commit_ordinal)
      ON DELETE RESTRICT
  )`.execute(db);
  await sql`COMMENT ON TABLE node_delete_affected_resources IS
    'Immutable affected node ids for one canonical delete. Do not rebuild this set from the live tree.'`.execute(db);
  await sql`CREATE FUNCTION forbid_node_delete_affected_resource_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'node delete affected resource facts are immutable';
    END $$`.execute(db);
  await sql`CREATE TRIGGER node_delete_affected_resources_immutable
    BEFORE UPDATE OR DELETE ON node_delete_affected_resources
    FOR EACH ROW EXECUTE FUNCTION forbid_node_delete_affected_resource_mutation()`.execute(db);
}

/** Developer-only destructive rollback. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS node_delete_affected_resources_immutable
    ON node_delete_affected_resources`.execute(db);
  await sql`DROP FUNCTION IF EXISTS forbid_node_delete_affected_resource_mutation()`.execute(db);
  await sql`DROP TABLE IF EXISTS node_delete_affected_resources`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
