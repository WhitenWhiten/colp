import { sql, type Kysely, type Migration } from 'kysely';

/**
 * Expand-only Publishing Insights fact tables (PI-01).
 *
 * Events are the product authority; daily rows are the dual-written UTC-day
 * projection. N-1 binaries ignore both tables. Application rollback leaves
 * the tables installed. The `down` path drops only these two tables and is
 * developer-only, not a data-preserving rollback.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE publication_insight_events (
      id            text PRIMARY KEY,
      collection_id text NOT NULL REFERENCES collections(id) ON DELETE RESTRICT,
      event_type    text NOT NULL CHECK (event_type IN ('collection_view','preview_open','resource_open')),
      node_id       text NULL REFERENCES nodes(id) ON DELETE RESTRICT,
      visitor_hash  bytea NOT NULL CHECK (octet_length(visitor_hash) = 32),
      occurred_at   timestamptz NOT NULL,
      CONSTRAINT publication_insight_events_node_ck CHECK (
        (event_type = 'resource_open' AND node_id IS NOT NULL)
        OR (event_type IN ('collection_view','preview_open') AND node_id IS NULL)
      )
    )
  `.execute(db);
  await sql`
    CREATE INDEX publication_insight_events_collection_time_idx
      ON publication_insight_events (collection_id, occurred_at)
  `.execute(db);

  await sql`
    CREATE TABLE publication_insight_daily (
      collection_id text NOT NULL REFERENCES collections(id) ON DELETE RESTRICT,
      day           date NOT NULL,
      event_type    text NOT NULL CHECK (event_type IN ('collection_view','preview_open','resource_open')),
      node_id       text NOT NULL DEFAULT '',
      count         bigint NOT NULL CHECK (count > 0),
      PRIMARY KEY (collection_id, day, event_type, node_id)
    )
  `.execute(db);
  await sql`
    CREATE INDEX publication_insight_daily_owner_window_idx
      ON publication_insight_daily (collection_id, day)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS publication_insight_daily`.execute(db);
  await sql`DROP TABLE IF EXISTS publication_insight_events`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
