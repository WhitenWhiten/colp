import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE sync_delete_group_members (
    collection_id text NOT NULL, operation_id text NOT NULL, target_id text NOT NULL,
    delete_commit_ordinal bigint NOT NULL, delete_revision text NOT NULL,
    affected_count integer NOT NULL CHECK (affected_count > 0),
    PRIMARY KEY (collection_id, operation_id, target_id)
  )`.execute(db);
  await sql`CREATE TABLE sync_restored_tombstones (
    collection_id text NOT NULL, operation_id text NOT NULL, target_id text NOT NULL,
    restore_operation_id text NOT NULL REFERENCES operations(operation_id),
    restored_at timestamptz NOT NULL DEFAULT current_timestamp,
    PRIMARY KEY (collection_id, operation_id, target_id),
    FOREIGN KEY (collection_id, operation_id, target_id)
      REFERENCES sync_delete_group_members(collection_id, operation_id, target_id)
  )`.execute(db);
  await sql`INSERT INTO sync_delete_group_members
    SELECT collection_id, operation_id, target_id, delete_commit_ordinal, delete_revision, affected_count
    FROM sync_node_tombstones`.execute(db);
  // Recover historical consumption only from durable authoritative restore effects.
  // Missing evidence is deliberately not guessed from current live nodes.
  await sql`INSERT INTO sync_delete_group_members
    SELECT e.collection_id, e.effect_json->'consumedTombstone'->>'operationId',
      e.effect_json->'consumedTombstone'->>'targetId', o.commit_ordinal,
      e.effect_json->'consumedTombstone'->>'deleteRevision',
      (e.effect_json->'consumedTombstone'->>'affectedCount')::integer
    FROM sync_operation_effects e JOIN operations o
      ON o.operation_id = e.effect_json->'consumedTombstone'->>'operationId'
      AND o.collection_id = e.collection_id
    WHERE e.effect_json->>'kind' = 'node_restored'
    ON CONFLICT DO NOTHING`.execute(db);
  await sql`INSERT INTO sync_restored_tombstones (collection_id, operation_id, target_id, restore_operation_id)
    SELECT e.collection_id, m.operation_id, m.target_id, e.operation_id
    FROM sync_operation_effects e JOIN sync_delete_group_members m
      ON m.collection_id=e.collection_id
      AND m.operation_id=e.effect_json->'consumedTombstone'->>'operationId'
      AND m.target_id=e.effect_json->'consumedTombstone'->>'targetId'
    WHERE e.effect_json->>'kind'='node_restored'
    ON CONFLICT DO NOTHING`.execute(db);
  await sql`CREATE FUNCTION record_sync_delete_group_member() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO sync_delete_group_members VALUES (NEW.collection_id, NEW.operation_id, NEW.target_id,
        NEW.delete_commit_ordinal, NEW.delete_revision, NEW.affected_count);
      RETURN NEW;
    END $$`.execute(db);
  await sql`CREATE TRIGGER sync_delete_group_member_insert AFTER INSERT ON sync_node_tombstones
    FOR EACH ROW EXECUTE FUNCTION record_sync_delete_group_member()`.execute(db);
  await sql`CREATE FUNCTION protect_sync_delete_group_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'delete group evidence is immutable'; END $$`.execute(db);
  for (const table of ['sync_delete_group_members', 'sync_restored_tombstones']) {
    await sql.raw(`CREATE TRIGGER ${table}_immutable BEFORE UPDATE OR DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION protect_sync_delete_group_evidence()`).execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER sync_delete_group_member_insert ON sync_node_tombstones`.execute(db);
  await sql`DROP FUNCTION record_sync_delete_group_member()`.execute(db);
  await sql`DROP TABLE sync_restored_tombstones, sync_delete_group_members`.execute(db);
  await sql`DROP FUNCTION protect_sync_delete_group_evidence()`.execute(db);
}
