import { sql, type Kysely, type Migration } from 'kysely';

/**
 * Phase 1 durable collection/node mutation projection (Task 12).
 *
 * Separate from Product write transactions and from outbox claim/complete CAS.
 * - applied: idempotent delivery ledger on (handler_name, domain_event_id)
 * - resources: materialised resource projection fenced by commit_ordinal
 * - watermarks: per-handler scoped fence used inside the projection transaction
 *
 * outbox_projection_watermarks (worker complete path) remains the outbox skip
 * optimizer; these tables are the durable side-effect state.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE collection_mutation_projection_applied (
    handler_name text NOT NULL,
    domain_event_id text NOT NULL,
    event_type text NOT NULL,
    event_version integer NOT NULL CHECK (event_version >= 1),
    aggregate_id text NOT NULL,
    aggregate_scope text NOT NULL,
    commit_ordinal bigint NOT NULL CHECK (commit_ordinal > 0),
    disposition text NOT NULL CHECK (disposition IN ('applied', 'stale_skipped')),
    payload_json jsonb NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (handler_name, domain_event_id)
  )`.execute(db);

  await sql`CREATE INDEX collection_mutation_projection_applied_scope_idx
    ON collection_mutation_projection_applied (handler_name, aggregate_scope, commit_ordinal)`.execute(db);

  await sql`CREATE TABLE collection_mutation_projection_resources (
    collection_id text NOT NULL,
    resource_type text NOT NULL CHECK (resource_type IN ('collection', 'node')),
    resource_id text NOT NULL,
    last_handler_name text NOT NULL,
    last_event_type text NOT NULL,
    last_event_version integer NOT NULL CHECK (last_event_version >= 1),
    last_domain_event_id text NOT NULL,
    last_commit_ordinal bigint NOT NULL CHECK (last_commit_ordinal > 0),
    state_json jsonb NOT NULL,
    deleted boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (collection_id, resource_type, resource_id)
  )`.execute(db);

  await sql`CREATE INDEX collection_mutation_projection_resources_collection_idx
    ON collection_mutation_projection_resources (collection_id)`.execute(db);

  await sql`CREATE TABLE collection_mutation_projection_watermarks (
    handler_name text NOT NULL,
    aggregate_scope text NOT NULL,
    last_commit_ordinal bigint NOT NULL CHECK (last_commit_ordinal > 0),
    last_domain_event_id text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (handler_name, aggregate_scope)
  )`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS collection_mutation_projection_watermarks`.execute(db);
  await sql`DROP TABLE IF EXISTS collection_mutation_projection_resources`.execute(db);
  await sql`DROP INDEX IF EXISTS collection_mutation_projection_applied_scope_idx`.execute(db);
  await sql`DROP TABLE IF EXISTS collection_mutation_projection_applied`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
