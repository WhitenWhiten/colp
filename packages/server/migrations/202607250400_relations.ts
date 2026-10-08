import { sql, type Kysely } from 'kysely';

/** Expand-only P2B-10 Relation authority. N-1 binaries ignore the new table/event. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE relations (
    id text PRIMARY KEY,
    collection_id text NOT NULL,
    from_node_id text NOT NULL,
    to_node_id text NOT NULL,
    type text NOT NULL,
    label text,
    visibility text NOT NULL,
    resource_revision text NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    deleted_at timestamptz,
    deleted_commit_ordinal bigint,
    payload_json jsonb NOT NULL,
    payload_schema_version integer NOT NULL DEFAULT 1,
    payload_authority_status text NOT NULL DEFAULT 'backfilled',
    CONSTRAINT relations_ledger_fk FOREIGN KEY (id) REFERENCES resource_id_ledger(resource_id) ON DELETE RESTRICT,
    CONSTRAINT relations_collection_fk FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE RESTRICT,
    CONSTRAINT relations_from_node_fk FOREIGN KEY (from_node_id) REFERENCES nodes(id) ON DELETE RESTRICT,
    CONSTRAINT relations_to_node_fk FOREIGN KEY (to_node_id) REFERENCES nodes(id) ON DELETE RESTRICT,
    CONSTRAINT relations_distinct_endpoints CHECK (from_node_id <> to_node_id),
    CONSTRAINT relations_type_supported CHECK (
      type IN ('related','precedes','follows','supports','contradicts','duplicate_of','derived_from','mentions','custom')
    ),
    CONSTRAINT relations_custom_label CHECK (type <> 'custom' OR (label IS NOT NULL AND length(btrim(label)) > 0)),
    CONSTRAINT relations_label_budget CHECK (label IS NULL OR octet_length(label) <= 4096),
    CONSTRAINT relations_visibility_supported CHECK (visibility IN ('public','unlisted','protected','private')),
    CONSTRAINT relations_revision_format CHECK (
      length(resource_revision) BETWEEN 1 AND 128 AND resource_revision ~ '^[A-Za-z0-9._~-]+$'
    ),
    CONSTRAINT relations_deletion_facts CHECK (
      (deleted_at IS NULL AND deleted_commit_ordinal IS NULL) OR
      (deleted_at IS NOT NULL AND deleted_commit_ordinal IS NOT NULL AND deleted_commit_ordinal > 0)
    ),
    CONSTRAINT relations_payload_object CHECK (jsonb_typeof(payload_json) = 'object'),
    CONSTRAINT relations_payload_budget CHECK (octet_length(payload_json::text) <= 131072),
    CONSTRAINT relations_payload_authority CHECK (
      payload_json ?& ARRAY[
        'id','collectionId','type','fromNodeId','toNodeId','visibility','revision','createdAt','updatedAt'
      ] AND
      jsonb_typeof(payload_json->'id') = 'string' AND
      jsonb_typeof(payload_json->'collectionId') = 'string' AND
      jsonb_typeof(payload_json->'type') = 'string' AND
      jsonb_typeof(payload_json->'fromNodeId') = 'string' AND
      jsonb_typeof(payload_json->'toNodeId') = 'string' AND
      jsonb_typeof(payload_json->'visibility') = 'string' AND
      jsonb_typeof(payload_json->'revision') = 'string' AND
      jsonb_typeof(payload_json->'createdAt') = 'string' AND
      jsonb_typeof(payload_json->'updatedAt') = 'string' AND
      (payload_json - ARRAY[
        'id','collectionId','type','fromNodeId','toNodeId','label','visibility',
        'createdAt','updatedAt','revision','extensions','deletedAt','deletedCommitOrdinal',
        'deletionOperationId','purgeAfter'
      ]) = '{}'::jsonb AND
      (NOT (payload_json ? 'extensions') OR jsonb_typeof(payload_json->'extensions') = 'object') AND
      payload_json->>'id' = id AND
      payload_json->>'collectionId' = collection_id AND
      payload_json->>'type' = type AND
      payload_json->>'fromNodeId' = from_node_id AND
      payload_json->>'toNodeId' = to_node_id AND
      ((label IS NULL AND NOT (payload_json ? 'label')) OR
       (label IS NOT NULL AND payload_json ? 'label'
        AND jsonb_typeof(payload_json->'label') = 'string' AND payload_json->>'label' = label)) AND
      payload_json->>'visibility' = visibility AND
      payload_json->>'revision' = resource_revision AND
      (payload_json->>'createdAt')::timestamptz = created_at AND
      (payload_json->>'updatedAt')::timestamptz = updated_at
    ),
    CONSTRAINT relations_payload_schema CHECK (payload_schema_version = 1),
    CONSTRAINT relations_authority_status CHECK (payload_authority_status = 'backfilled')
  )`.execute(db);

  // Product decision: directed edges are unique by endpoints + type. Label is metadata,
  // not semantic identity; reverse direction/different type are distinct; tombstones release the key.
  await sql`CREATE UNIQUE INDEX relations_live_semantic_edge_uidx
    ON relations (collection_id, from_node_id, to_node_id, type)
    WHERE deleted_at IS NULL`.execute(db);
  await sql`CREATE INDEX relations_live_from_idx
    ON relations (collection_id, from_node_id, type, to_node_id, id)
    WHERE deleted_at IS NULL`.execute(db);
  await sql`CREATE INDEX relations_live_to_idx
    ON relations (collection_id, to_node_id, type, from_node_id, id)
    WHERE deleted_at IS NULL`.execute(db);

  await sql`ALTER TABLE collection_mutation_projection_resources
    DROP CONSTRAINT collection_mutation_projection_resources_resource_type_check,
    ADD CONSTRAINT collection_mutation_projection_resources_resource_type_check
      CHECK (resource_type IN ('collection', 'node', 'annotation', 'relation'))`.execute(db);

  await sql`CREATE FUNCTION validate_relation_endpoints() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM nodes WHERE id = NEW.from_node_id AND collection_id = NEW.collection_id
          AND (NEW.deleted_at IS NOT NULL OR deleted_at IS NULL)
      ) OR NOT EXISTS (
        SELECT 1 FROM nodes WHERE id = NEW.to_node_id AND collection_id = NEW.collection_id
          AND (NEW.deleted_at IS NOT NULL OR deleted_at IS NULL)
      ) THEN
        RAISE EXCEPTION 'live relation endpoints must be live nodes in the same collection'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
  $$`.execute(db);
  await sql`CREATE CONSTRAINT TRIGGER relations_endpoint_integrity
    AFTER INSERT OR UPDATE ON relations DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION validate_relation_endpoints()`.execute(db);

  // P2B-10 fail-closed bridge: canonical endpoint deletion cannot commit an orphan.
  // P2B-11 replaces the loser path with a canonical Relation cascade plan.
  await sql`CREATE FUNCTION prevent_live_relation_endpoint_delete() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL AND EXISTS (
        SELECT 1 FROM relations
         WHERE collection_id = NEW.collection_id AND deleted_at IS NULL
           AND (from_node_id = NEW.id OR to_node_id = NEW.id)
      ) THEN
        RAISE EXCEPTION 'node endpoint has live relations requiring canonical cascade'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
  $$`.execute(db);
  await sql`CREATE CONSTRAINT TRIGGER nodes_live_relation_integrity
    AFTER UPDATE ON nodes DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION prevent_live_relation_endpoint_delete()`.execute(db);

  await sql`CREATE OR REPLACE FUNCTION validate_resource_revision_scope() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.resource_id <> NEW.collection_id AND NOT EXISTS (
        SELECT 1 FROM nodes WHERE id = NEW.resource_id AND collection_id = NEW.collection_id
        UNION ALL
        SELECT 1 FROM annotations WHERE id = NEW.resource_id AND collection_id = NEW.collection_id
        UNION ALL
        SELECT 1 FROM relations WHERE id = NEW.resource_id AND collection_id = NEW.collection_id
      ) THEN
        RAISE EXCEPTION 'resource revision must belong to its collection' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
  $$`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS nodes_live_relation_integrity ON nodes`.execute(db);
  await sql`DROP FUNCTION IF EXISTS prevent_live_relation_endpoint_delete()`.execute(db);
  await sql`DELETE FROM collection_mutation_projection_resources WHERE resource_type = 'relation'`.execute(db);
  await sql`ALTER TABLE collection_mutation_projection_resources
    DROP CONSTRAINT collection_mutation_projection_resources_resource_type_check,
    ADD CONSTRAINT collection_mutation_projection_resources_resource_type_check
      CHECK (resource_type IN ('collection', 'node', 'annotation'))`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION validate_resource_revision_scope() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.resource_id <> NEW.collection_id AND NOT EXISTS (
        SELECT 1 FROM nodes WHERE id = NEW.resource_id AND collection_id = NEW.collection_id
        UNION ALL
        SELECT 1 FROM annotations WHERE id = NEW.resource_id AND collection_id = NEW.collection_id
      ) THEN
        RAISE EXCEPTION 'resource revision must belong to its collection' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
  $$`.execute(db);
  await sql`DROP TABLE IF EXISTS relations`.execute(db);
  await sql`DROP FUNCTION IF EXISTS validate_relation_endpoints()`.execute(db);
}
