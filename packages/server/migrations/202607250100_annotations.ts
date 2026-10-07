import { sql, type Kysely } from 'kysely';

/** Expand-only P2B-04 Annotation authority. Old N-1 binaries ignore this table. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE annotations (
    id text PRIMARY KEY,
    collection_id text NOT NULL,
    subject_type text NOT NULL,
    subject_id text NOT NULL,
    creator_principal_id text NOT NULL,
    type text NOT NULL,
    format text,
    value_json jsonb NOT NULL,
    visibility text NOT NULL,
    resource_revision text NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    deleted_at timestamptz,
    deleted_commit_ordinal bigint,
    payload_json jsonb NOT NULL,
    payload_schema_version integer NOT NULL DEFAULT 1,
    payload_authority_status text NOT NULL DEFAULT 'backfilled',
    CONSTRAINT annotations_ledger_fk FOREIGN KEY (id) REFERENCES resource_id_ledger(resource_id) ON DELETE RESTRICT,
    CONSTRAINT annotations_collection_fk FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE RESTRICT,
    CONSTRAINT annotations_collection_subject_shape CHECK (
      subject_type IN ('collection','node') AND
      ((subject_type = 'collection' AND subject_id = collection_id) OR subject_type = 'node')
    ),
    CONSTRAINT annotations_creator_nonempty CHECK (length(creator_principal_id) BETWEEN 1 AND 512),
    CONSTRAINT annotations_type_supported CHECK (type IN ('note','summary','tldr','highlight','rating','custom')),
    CONSTRAINT annotations_format_supported CHECK (format IS NULL OR format IN ('plain','markdown','html','json')),
    CONSTRAINT annotations_visibility_supported CHECK (visibility IN ('public','unlisted','protected','private')),
    CONSTRAINT annotations_revision_format CHECK (
      length(resource_revision) BETWEEN 1 AND 128 AND resource_revision ~ '^[A-Za-z0-9._~-]+$'
    ),
    CONSTRAINT annotations_deletion_facts CHECK (
      (deleted_at IS NULL AND deleted_commit_ordinal IS NULL) OR
      (deleted_at IS NOT NULL AND deleted_commit_ordinal IS NOT NULL AND deleted_commit_ordinal > 0)
    ),
    CONSTRAINT annotations_payload_object CHECK (jsonb_typeof(payload_json) = 'object'),
    CONSTRAINT annotations_payload_budget CHECK (octet_length(payload_json::text) <= 131072),
    CONSTRAINT annotations_payload_authority CHECK (
      payload_json ?& ARRAY[
        'id','collectionId','subject','creator','type','value','visibility',
        'revision','createdAt','updatedAt'
      ] AND
      jsonb_typeof(payload_json->'subject') = 'object' AND
      jsonb_typeof(payload_json->'creator') = 'object' AND
      payload_json->>'id' = id AND
      payload_json->>'collectionId' = collection_id AND
      payload_json#>>'{subject,type}' = subject_type AND
      payload_json#>>'{subject,id}' = subject_id AND
      payload_json->>'type' = type AND
      payload_json->'value' = value_json AND
      ((format IS NULL AND NOT (payload_json ? 'format')) OR payload_json->>'format' = format) AND
      payload_json->>'visibility' = visibility AND
      payload_json->>'revision' = resource_revision
    ),
    CONSTRAINT annotations_payload_schema CHECK (payload_schema_version = 1),
    CONSTRAINT annotations_authority_status CHECK (payload_authority_status = 'backfilled')
  )`.execute(db);

  await sql`CREATE INDEX annotations_live_subject_count_idx
    ON annotations (collection_id, subject_type, subject_id, id)
    WHERE deleted_at IS NULL`.execute(db);
  await sql`CREATE INDEX annotations_live_collection_updated_idx
    ON annotations (collection_id, updated_at DESC, (id COLLATE "C") ASC)
    WHERE deleted_at IS NULL`.execute(db);

  await sql`ALTER TABLE collection_mutation_projection_resources
    DROP CONSTRAINT collection_mutation_projection_resources_resource_type_check,
    ADD CONSTRAINT collection_mutation_projection_resources_resource_type_check
      CHECK (resource_type IN ('collection', 'node', 'annotation'))`.execute(db);

  await sql`CREATE FUNCTION validate_annotation_subject() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.subject_type = 'node' AND NOT EXISTS (
        SELECT 1 FROM nodes
         WHERE id = NEW.subject_id AND collection_id = NEW.collection_id
           AND (NEW.deleted_at IS NOT NULL OR deleted_at IS NULL)
      ) THEN
        RAISE EXCEPTION 'live annotation subject must be a live node in the same collection'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
  $$`.execute(db);
  await sql`CREATE CONSTRAINT TRIGGER annotations_subject_integrity
    AFTER INSERT OR UPDATE ON annotations DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION validate_annotation_subject()`.execute(db);

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
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DELETE FROM collection_mutation_projection_resources WHERE resource_type = 'annotation'`.execute(db);
  await sql`ALTER TABLE collection_mutation_projection_resources
    DROP CONSTRAINT collection_mutation_projection_resources_resource_type_check,
    ADD CONSTRAINT collection_mutation_projection_resources_resource_type_check
      CHECK (resource_type IN ('collection', 'node'))`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION validate_resource_revision_scope() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.resource_id <> NEW.collection_id AND NOT EXISTS (
        SELECT 1 FROM nodes WHERE id = NEW.resource_id AND collection_id = NEW.collection_id
      ) THEN
        RAISE EXCEPTION 'resource revision must belong to its collection' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
  $$`.execute(db);
  await sql`DROP TABLE IF EXISTS annotations`.execute(db);
  await sql`DROP FUNCTION IF EXISTS validate_annotation_subject()`.execute(db);
}
