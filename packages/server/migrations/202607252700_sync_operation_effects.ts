import { sql, type Kysely, type Migration } from 'kysely';

/** P3-32B expand: immutable COLP 0.2 effect authority; historical effects are never inferred. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`LOCK TABLE collections IN SHARE ROW EXCLUSIVE MODE`.execute(db);
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM nodes WHERE position_token IS NOT NULL
      AND (octet_length(position_token) NOT BETWEEN 1 AND 128 OR position_token !~ '^[0-9A-Za-z_-]+$')) THEN
      RAISE EXCEPTION 'COLP 0.2 cutover requires canonical Node positions to satisfy orderKey';
    END IF;
  END $$`.execute(db);
  await sql`ALTER TABLE nodes ADD CONSTRAINT nodes_position_token_colp_check
    CHECK (position_token IS NULL OR
      (octet_length(position_token) BETWEEN 1 AND 128 AND position_token ~ '^[0-9A-Za-z_-]+$'))`.execute(db);
  await sql`ALTER TABLE operations ADD CONSTRAINT operations_collection_operation_unique
    UNIQUE (collection_id, operation_id)`.execute(db);
  await sql`ALTER TABLE sync_sessions DROP CONSTRAINT sync_sessions_protocol_version_check`.execute(db);
  await sql`ALTER TABLE sync_sessions ADD CONSTRAINT sync_sessions_protocol_version_check
    CHECK (protocol_version IN ('0.1', '0.2'))`.execute(db);
  await sql`ALTER TABLE sync_pull_cursor_evidence
    DROP CONSTRAINT sync_pull_cursor_evidence_protocol_version_check`.execute(db);
  await sql`ALTER TABLE sync_pull_cursor_evidence
    ADD CONSTRAINT sync_pull_cursor_evidence_protocol_version_check
    CHECK (protocol_version IN ('0.1', '0.2'))`.execute(db);

  await sql`CREATE TABLE sync_collection_effect_cutovers (
    collection_id text PRIMARY KEY REFERENCES collections(id) ON DELETE RESTRICT,
    effect_cutover_ordinal bigint NOT NULL CHECK (effect_cutover_ordinal > 0),
    created_at timestamptz NOT NULL DEFAULT current_timestamp
  )`.execute(db);
  await sql`INSERT INTO sync_collection_effect_cutovers (collection_id, effect_cutover_ordinal)
    SELECT collection.id, COALESCE(MAX(operation.commit_ordinal), 0) + 1
    FROM collections collection
    LEFT JOIN operations operation ON operation.collection_id = collection.id
    GROUP BY collection.id`.execute(db);
  await sql`CREATE FUNCTION initialize_sync_effect_cutover() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM set_config('known.sync_authority', 'server', true);
      INSERT INTO sync_collection_effect_cutovers (collection_id, effect_cutover_ordinal)
      VALUES (NEW.id, 1) ON CONFLICT (collection_id) DO NOTHING;
      RETURN NEW;
    END $$`.execute(db);
  await sql`CREATE TRIGGER collections_sync_effect_cutover
    AFTER INSERT ON collections FOR EACH ROW EXECUTE FUNCTION initialize_sync_effect_cutover()`.execute(db);

  await sql`CREATE TABLE sync_operation_effects (
    effect_id text PRIMARY KEY CHECK (length(effect_id) BETWEEN 1 AND 128),
    collection_id text NOT NULL REFERENCES collections(id) ON DELETE RESTRICT,
    operation_id text NOT NULL,
    origin_replica_id text NOT NULL REFERENCES sync_replicas(replica_id) ON DELETE RESTRICT,
    origin_sequence bigint NOT NULL CHECK (origin_sequence > 0),
    commit_ordinal bigint NOT NULL CHECK (commit_ordinal > 0),
    protocol_version text NOT NULL CHECK (protocol_version = '0.2'),
    terminal_status text NOT NULL CHECK (terminal_status IN ('applied', 'rebased')),
    operation_digest text NOT NULL CHECK (operation_digest ~ '^sha-256=:[A-Za-z0-9+/]{43}=:$'),
    effect_json jsonb NOT NULL CHECK (jsonb_typeof(effect_json) = 'object'),
    effect_digest text NOT NULL CHECK (effect_digest ~ '^sha-256=:[A-Za-z0-9+/]{43}=:$'),
    created_at timestamptz NOT NULL DEFAULT current_timestamp,
    CONSTRAINT sync_operation_effect_operation_fk FOREIGN KEY (collection_id, operation_id)
      REFERENCES operations (collection_id, operation_id) ON DELETE RESTRICT,
    UNIQUE (collection_id, operation_id),
    UNIQUE (collection_id, origin_replica_id, origin_sequence),
    UNIQUE (collection_id, commit_ordinal),
    UNIQUE (effect_id, collection_id)
  )`.execute(db);
  await sql`CREATE INDEX sync_operation_effects_retention_idx
    ON sync_operation_effects (collection_id, commit_ordinal, effect_id)`.execute(db);

  await sql`CREATE TABLE sync_operation_effect_pages (
    effect_id text NOT NULL REFERENCES sync_operation_effects(effect_id) ON DELETE RESTRICT,
    page_number integer NOT NULL CHECK (page_number > 0),
    page_count integer NOT NULL CHECK (page_count > 0 AND page_number <= page_count),
    member_count integer NOT NULL CHECK (member_count > 0 AND member_count <= 10000),
    page_json jsonb NOT NULL CHECK (jsonb_typeof(page_json) = 'object'),
    page_digest text NOT NULL CHECK (page_digest ~ '^sha-256=:[A-Za-z0-9+/]{43}=:$'),
    previous_page_digest text CHECK (previous_page_digest IS NULL OR previous_page_digest ~ '^sha-256=:[A-Za-z0-9+/]{43}=:$'),
    created_at timestamptz NOT NULL DEFAULT current_timestamp,
    PRIMARY KEY (effect_id, page_number),
    UNIQUE (effect_id, page_digest),
    CHECK ((page_number = 1) = (previous_page_digest IS NULL))
  )`.execute(db);

  await sql`CREATE FUNCTION forbid_sync_operation_effect_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' AND current_setting('known.sync_effect_purge', true) = 'server' THEN
        RETURN OLD;
      END IF;
      RAISE EXCEPTION 'Sync operation effect authority is immutable';
    END $$`.execute(db);
  await sql`CREATE FUNCTION forbid_sync_effect_cutover_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Sync effect cutover authority is immutable'; END $$`.execute(db);
  await sql`CREATE TRIGGER sync_collection_effect_cutovers_immutable
    BEFORE UPDATE OR DELETE ON sync_collection_effect_cutovers
    FOR EACH ROW EXECUTE FUNCTION forbid_sync_effect_cutover_mutation()`.execute(db);
  await sql`CREATE TRIGGER sync_operation_effects_immutable BEFORE UPDATE OR DELETE ON sync_operation_effects
    FOR EACH ROW EXECUTE FUNCTION forbid_sync_operation_effect_mutation()`.execute(db);
  await sql`CREATE TRIGGER sync_operation_effect_pages_immutable BEFORE UPDATE OR DELETE ON sync_operation_effect_pages
    FOR EACH ROW EXECUTE FUNCTION forbid_sync_operation_effect_mutation()`.execute(db);

  for (const table of ['sync_collection_effect_cutovers', 'sync_operation_effects', 'sync_operation_effect_pages'] as const) {
    await sql.raw(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`).execute(db);
    await sql.raw(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`).execute(db);
    await sql.raw(`CREATE POLICY ${table}_server_authority ON ${table}
      USING (current_setting('known.sync_authority', true) = 'server')
      WITH CHECK (current_setting('known.sync_authority', true) = 'server')`).execute(db);
  }
}

/** Developer-only destructive rollback; rollback the 0.2 writer before migrating down. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS sync_collection_effect_cutovers_immutable ON sync_collection_effect_cutovers`.execute(db);
  await sql`DROP FUNCTION IF EXISTS forbid_sync_effect_cutover_mutation()`.execute(db);
  await sql`DROP TRIGGER IF EXISTS sync_operation_effect_pages_immutable ON sync_operation_effect_pages`.execute(db);
  await sql`DROP TRIGGER IF EXISTS sync_operation_effects_immutable ON sync_operation_effects`.execute(db);
  await sql`DROP FUNCTION IF EXISTS forbid_sync_operation_effect_mutation()`.execute(db);
  await sql`DROP TABLE IF EXISTS sync_operation_effect_pages`.execute(db);
  await sql`DROP TABLE IF EXISTS sync_operation_effects`.execute(db);
  await sql`DROP TRIGGER IF EXISTS collections_sync_effect_cutover ON collections`.execute(db);
  await sql`DROP FUNCTION IF EXISTS initialize_sync_effect_cutover()`.execute(db);
  await sql`DROP TABLE IF EXISTS sync_collection_effect_cutovers`.execute(db);
  await sql`ALTER TABLE operations DROP CONSTRAINT IF EXISTS operations_collection_operation_unique`.execute(db);
  await sql`ALTER TABLE nodes DROP CONSTRAINT IF EXISTS nodes_position_token_colp_check`.execute(db);
  await sql`ALTER TABLE sync_pull_cursor_evidence DROP CONSTRAINT IF EXISTS sync_pull_cursor_evidence_protocol_version_check`.execute(db);
  await sql`ALTER TABLE sync_pull_cursor_evidence ADD CONSTRAINT sync_pull_cursor_evidence_protocol_version_check
    CHECK (protocol_version = '0.1')`.execute(db);
  await sql`ALTER TABLE sync_sessions DROP CONSTRAINT IF EXISTS sync_sessions_protocol_version_check`.execute(db);
  await sql`ALTER TABLE sync_sessions ADD CONSTRAINT sync_sessions_protocol_version_check
    CHECK (protocol_version = '0.1')`.execute(db);
}

export const migration: Migration = { up, down };
