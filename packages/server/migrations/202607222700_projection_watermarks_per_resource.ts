import { sql, type Kysely, type Migration } from 'kysely';

/**
 * Correct projection fencing from collection scope to the mutated resource.
 * Existing scope watermarks are optimization state and cannot be translated
 * safely, so rebuild them from subsequent successful deliveries.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`TRUNCATE TABLE outbox_projection_watermarks`.execute(db);
  await sql`ALTER TABLE outbox_projection_watermarks
    DROP CONSTRAINT outbox_projection_watermarks_pkey`.execute(db);
  await sql`ALTER TABLE outbox_projection_watermarks
    RENAME COLUMN aggregate_scope TO aggregate_id`.execute(db);
  await sql`ALTER TABLE outbox_projection_watermarks
    ADD CONSTRAINT outbox_projection_watermarks_pkey
      PRIMARY KEY (handler_name, aggregate_id)`.execute(db);

  await sql`TRUNCATE TABLE collection_mutation_projection_watermarks`.execute(db);
  await sql`ALTER TABLE collection_mutation_projection_watermarks
    DROP CONSTRAINT collection_mutation_projection_watermarks_pkey`.execute(db);
  await sql`ALTER TABLE collection_mutation_projection_watermarks
    RENAME COLUMN aggregate_scope TO aggregate_id`.execute(db);
  await sql`ALTER TABLE collection_mutation_projection_watermarks
    ADD CONSTRAINT collection_mutation_projection_watermarks_pkey
      PRIMARY KEY (handler_name, aggregate_id)`.execute(db);

  await sql`DROP INDEX collection_mutation_projection_applied_scope_idx`.execute(db);
  await sql`CREATE INDEX collection_mutation_projection_applied_resource_idx
    ON collection_mutation_projection_applied
      (handler_name, aggregate_id, commit_ordinal)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX collection_mutation_projection_applied_resource_idx`.execute(db);
  await sql`CREATE INDEX collection_mutation_projection_applied_scope_idx
    ON collection_mutation_projection_applied
      (handler_name, aggregate_scope, commit_ordinal)`.execute(db);

  await sql`TRUNCATE TABLE collection_mutation_projection_watermarks`.execute(db);
  await sql`ALTER TABLE collection_mutation_projection_watermarks
    DROP CONSTRAINT collection_mutation_projection_watermarks_pkey`.execute(db);
  await sql`ALTER TABLE collection_mutation_projection_watermarks
    RENAME COLUMN aggregate_id TO aggregate_scope`.execute(db);
  await sql`ALTER TABLE collection_mutation_projection_watermarks
    ADD CONSTRAINT collection_mutation_projection_watermarks_pkey
      PRIMARY KEY (handler_name, aggregate_scope)`.execute(db);

  await sql`TRUNCATE TABLE outbox_projection_watermarks`.execute(db);
  await sql`ALTER TABLE outbox_projection_watermarks
    DROP CONSTRAINT outbox_projection_watermarks_pkey`.execute(db);
  await sql`ALTER TABLE outbox_projection_watermarks
    RENAME COLUMN aggregate_id TO aggregate_scope`.execute(db);
  await sql`ALTER TABLE outbox_projection_watermarks
    ADD CONSTRAINT outbox_projection_watermarks_pkey
      PRIMARY KEY (handler_name, aggregate_scope)`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
