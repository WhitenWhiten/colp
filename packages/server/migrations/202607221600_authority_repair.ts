import { sql, type Kysely, type Migration } from 'kysely';

/** Repairs constraints introduced by the original Phase 0 schema without rewriting data. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE resource_revisions
    DROP CONSTRAINT IF EXISTS resource_revisions_collection_id_ordinal_key,
    DROP CONSTRAINT IF EXISTS resource_revisions_collection_ordinal_key,
    DROP CONSTRAINT IF EXISTS resource_revisions_resource_ordinal_unique`.execute(db);
  await sql`ALTER TABLE resource_revisions
    ADD CONSTRAINT resource_revisions_resource_ordinal_unique UNIQUE (collection_id, resource_id, ordinal)`.execute(db);

  await sql`DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'operations'::regclass
        AND conname = 'operations_operation_collection_unique'
    ) THEN
      ALTER TABLE operations ADD CONSTRAINT operations_operation_collection_unique
        UNIQUE (operation_id, collection_id);
    END IF;
  END $$`.execute(db);
  await sql`ALTER TABLE audit_events
    DROP CONSTRAINT IF EXISTS audit_events_operation_id_fkey,
    DROP CONSTRAINT IF EXISTS audit_events_collection_id_fkey,
    DROP CONSTRAINT IF EXISTS audit_events_operation_collection_fk,
    ADD CONSTRAINT audit_events_operation_collection_fk
      FOREIGN KEY (operation_id, collection_id)
      REFERENCES operations(operation_id, collection_id) ON DELETE RESTRICT`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE audit_events
    DROP CONSTRAINT IF EXISTS audit_events_operation_collection_fk,
    ADD CONSTRAINT audit_events_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES operations(operation_id) ON DELETE RESTRICT,
    ADD CONSTRAINT audit_events_collection_id_fkey FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE RESTRICT`.execute(db);
  await sql`ALTER TABLE operations DROP CONSTRAINT IF EXISTS operations_operation_collection_unique`.execute(db);
  await sql`ALTER TABLE resource_revisions
    DROP CONSTRAINT IF EXISTS resource_revisions_resource_ordinal_unique,
    ADD CONSTRAINT resource_revisions_resource_ordinal_unique
      UNIQUE (collection_id, resource_id, ordinal)`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
