import { sql, type Kysely, type Migration } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE accounts (
    id text PRIMARY KEY, subject_id text NOT NULL UNIQUE,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','deleted')),
    created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
  )`.execute(db);
  await sql`CREATE TABLE profiles (
    account_id text PRIMARY KEY REFERENCES accounts(id) ON DELETE RESTRICT,
    display_name text NOT NULL DEFAULT '', avatar_url text, updated_at timestamptz NOT NULL DEFAULT now()
  )`.execute(db);
  await sql`CREATE TABLE sessions (
    id text PRIMARY KEY, account_id text NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    expires_at timestamptz NOT NULL, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
  )`.execute(db);

  await sql`CREATE TABLE resource_id_ledger (
    resource_id text PRIMARY KEY, resource_type text NOT NULL, reserved_at timestamptz NOT NULL DEFAULT now(),
    committed_at timestamptz
  )`.execute(db);
  await sql`CREATE FUNCTION forbid_resource_id_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'resource_id_ledger rows are immutable'; END
  $$`.execute(db);
  await sql`CREATE TRIGGER resource_id_ledger_immutable BEFORE UPDATE OR DELETE ON resource_id_ledger
    FOR EACH ROW EXECUTE FUNCTION forbid_resource_id_ledger_mutation()`.execute(db);
  await sql`COMMENT ON COLUMN resource_id_ledger.committed_at IS
    'Optional immutable commitment timestamp supplied when the ledger row is inserted; ledger rows are never updated or deleted.'`.execute(db);

  await sql`CREATE TABLE collections (
    id text PRIMARY KEY REFERENCES resource_id_ledger(resource_id) ON DELETE RESTRICT,
    owner_subject_id text NOT NULL, title text NOT NULL CHECK (length(title) BETWEEN 1 AND 512),
    kind text NOT NULL CHECK (kind IN ('bookmarks','reading_path','knowledge_collection','mixed')),
    visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','protected','public','unlisted')),
    root_node_id text NOT NULL, root_node_is_root boolean NOT NULL DEFAULT true CHECK (root_node_is_root),
    resource_revision text NOT NULL CHECK (length(resource_revision) BETWEEN 1 AND 128 AND resource_revision ~ '^[A-Za-z0-9._~-]+$'),
    content_revision text NOT NULL CHECK (length(content_revision) BETWEEN 1 AND 128 AND content_revision ~ '^[A-Za-z0-9._~-]+$'),
    policy_revision text NOT NULL CHECK (length(policy_revision) BETWEEN 1 AND 128 AND policy_revision ~ '^[A-Za-z0-9._~-]+$'),
    commit_ordinal bigint NOT NULL DEFAULT 0 CHECK (commit_ordinal >= 0),
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
    UNIQUE (id, root_node_id)
  )`.execute(db);
  await sql`CREATE FUNCTION forbid_collection_root_reassignment() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.root_node_id IS DISTINCT FROM OLD.root_node_id THEN
        RAISE EXCEPTION 'collection root_node_id is immutable' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
  $$`.execute(db);
  await sql`CREATE TRIGGER collections_root_id_immutable
    BEFORE UPDATE OF root_node_id ON collections
    FOR EACH ROW EXECUTE FUNCTION forbid_collection_root_reassignment()`.execute(db);

  await sql`CREATE TABLE nodes (
    id text PRIMARY KEY REFERENCES resource_id_ledger(resource_id) ON DELETE RESTRICT,
    collection_id text NOT NULL REFERENCES collections(id) ON DELETE RESTRICT,
    parent_id text, kind text NOT NULL CHECK (kind IN ('folder','bookmark')), is_root boolean NOT NULL DEFAULT false,
    title text NOT NULL CHECK (length(title) BETWEEN 1 AND 512), url text, description text, tags jsonb,
    position_token text, resource_revision text NOT NULL CHECK (length(resource_revision) BETWEEN 1 AND 128 AND resource_revision ~ '^[A-Za-z0-9._~-]+$'),
    children_revision text NOT NULL CHECK (length(children_revision) BETWEEN 1 AND 128 AND children_revision ~ '^[A-Za-z0-9._~-]+$'),
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz, deleted_commit_ordinal bigint CHECK (deleted_commit_ordinal IS NULL OR deleted_commit_ordinal >= 0),
    FOREIGN KEY (collection_id, parent_id) REFERENCES nodes(collection_id, id) DEFERRABLE INITIALLY DEFERRED,
    CHECK ((is_root AND kind = 'folder' AND parent_id IS NULL AND url IS NULL) OR (NOT is_root AND parent_id IS NOT NULL)),
    CHECK ((NOT is_root AND position_token IS NOT NULL) OR (is_root AND position_token IS NULL)),
    CHECK (position_token IS NULL OR (octet_length(position_token) BETWEEN 1 AND 512 AND position_token !~ '[^!-~]')),
    CHECK ((kind = 'bookmark' AND url IS NOT NULL) OR kind <> 'bookmark'),
    UNIQUE (collection_id, id), UNIQUE (collection_id, id, is_root)
  )`.execute(db);
  await sql`ALTER TABLE collections ADD CONSTRAINT collections_root_fk FOREIGN KEY (id, root_node_id, root_node_is_root) REFERENCES nodes(collection_id, id, is_root) DEFERRABLE INITIALLY DEFERRED`.execute(db);
  await sql`CREATE UNIQUE INDEX collections_live_root_unique ON nodes(collection_id) WHERE is_root AND parent_id IS NULL AND deleted_at IS NULL`.execute(db);
  await sql`CREATE UNIQUE INDEX nodes_live_sibling_position_unique ON nodes(collection_id, parent_id, position_token) WHERE deleted_at IS NULL`.execute(db);
  await sql`CREATE INDEX nodes_collection_parent_position_idx ON nodes(collection_id, parent_id, position_token, id)`.execute(db);

  // Parent kind and Root lifecycle are deferred so collection/root bootstrap can be
  // inserted in either order, while the final transaction state remains authoritative.
  await sql`CREATE FUNCTION validate_node_parent_and_root() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE parent_kind text; parent_is_root boolean; parent_deleted timestamptz;
    DECLARE collection_deleted timestamptz; collection_root text;
    BEGIN
      IF NEW.parent_id IS NOT NULL THEN
        SELECT kind, is_root, deleted_at INTO parent_kind, parent_is_root, parent_deleted
          FROM nodes WHERE collection_id = NEW.collection_id AND id = NEW.parent_id;
        IF NOT FOUND OR (parent_kind <> 'folder' AND NOT parent_is_root) THEN
          RAISE EXCEPTION 'node parent must be a folder or root' USING ERRCODE = '23514';
        END IF;
        IF NEW.deleted_at IS NULL AND parent_deleted IS NOT NULL THEN
          RAISE EXCEPTION 'live node cannot have a deleted parent' USING ERRCODE = '23514';
        END IF;
      END IF;
      IF NEW.is_root THEN
        SELECT deleted_at, root_node_id INTO collection_deleted, collection_root
          FROM collections WHERE id = NEW.collection_id;
        IF NOT FOUND OR collection_root <> NEW.id THEN
          RAISE EXCEPTION 'root node must be the collection root' USING ERRCODE = '23514';
        END IF;
        IF NEW.deleted_at IS NOT NULL AND collection_deleted IS NULL THEN
          RAISE EXCEPTION 'root node may only be deleted with its collection' USING ERRCODE = '23514';
        END IF;
      END IF;
      RETURN NEW;
    END
  $$`.execute(db);
  await sql`CREATE FUNCTION validate_node_children_parent() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF (NEW.deleted_at IS NOT NULL OR (NEW.kind <> 'folder' AND NOT NEW.is_root))
         AND EXISTS (SELECT 1 FROM nodes WHERE collection_id = NEW.collection_id AND parent_id = NEW.id AND deleted_at IS NULL) THEN
        RAISE EXCEPTION 'a parent with live children must remain a folder or root and live' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
  $$`.execute(db);
  await sql`CREATE CONSTRAINT TRIGGER nodes_children_parent_integrity
    AFTER INSERT OR UPDATE ON nodes DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION validate_node_children_parent()`.execute(db);
  await sql`CREATE CONSTRAINT TRIGGER nodes_parent_and_root_integrity
    AFTER INSERT OR UPDATE ON nodes DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION validate_node_parent_and_root()`.execute(db);
  await sql`CREATE FUNCTION validate_collection_root_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE root_deleted timestamptz;
    BEGIN
      SELECT deleted_at INTO root_deleted FROM nodes WHERE collection_id = NEW.id AND id = NEW.root_node_id;
      IF NOT FOUND OR ((NEW.deleted_at IS NULL) <> (root_deleted IS NULL)) THEN
        RAISE EXCEPTION 'collection and root deletion state must match' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
  $$`.execute(db);
  await sql`CREATE CONSTRAINT TRIGGER collections_root_lifecycle_integrity
    AFTER INSERT OR UPDATE ON collections DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION validate_collection_root_lifecycle()`.execute(db);

  await sql`CREATE TABLE collection_members (
    collection_id text NOT NULL REFERENCES collections(id) ON DELETE RESTRICT, subject_id text NOT NULL,
    role text NOT NULL CHECK (role IN ('owner','editor','viewer')), granted_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (collection_id, subject_id)
  )`.execute(db);
  await sql`CREATE TABLE collection_policies (
    collection_id text PRIMARY KEY REFERENCES collections(id) ON DELETE RESTRICT,
    policy_json jsonb NOT NULL DEFAULT '{}'::jsonb, updated_at timestamptz NOT NULL DEFAULT now()
  )`.execute(db);
  await sql`CREATE TABLE resource_revisions (
    collection_id text NOT NULL REFERENCES collections(id) ON DELETE RESTRICT,
    resource_id text NOT NULL REFERENCES resource_id_ledger(resource_id) ON DELETE RESTRICT,
    revision text NOT NULL CHECK (length(revision) BETWEEN 1 AND 128 AND revision ~ '^[A-Za-z0-9._~-]+$'),
    ordinal bigint NOT NULL CHECK (ordinal > 0),
    created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (resource_id, revision),
    CONSTRAINT resource_revisions_resource_ordinal_unique UNIQUE (collection_id, resource_id, ordinal)
  )`.execute(db);
  await sql`CREATE FUNCTION validate_resource_revision_scope() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.resource_id <> NEW.collection_id AND NOT EXISTS (
        SELECT 1 FROM nodes WHERE id = NEW.resource_id AND collection_id = NEW.collection_id
      ) THEN
        RAISE EXCEPTION 'resource revision must belong to its collection' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
  $$`.execute(db);
  await sql`CREATE CONSTRAINT TRIGGER resource_revisions_collection_scope
    AFTER INSERT OR UPDATE ON resource_revisions DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION validate_resource_revision_scope()`.execute(db);
  await sql`CREATE TABLE children_revisions (
    collection_id text NOT NULL REFERENCES collections(id) ON DELETE RESTRICT, parent_id text NOT NULL,
    revision text NOT NULL CHECK (length(revision) BETWEEN 1 AND 128 AND revision ~ '^[A-Za-z0-9._~-]+$'),
    ordinal bigint NOT NULL CHECK (ordinal > 0),
    PRIMARY KEY (collection_id, parent_id, revision),
    FOREIGN KEY (collection_id, parent_id) REFERENCES nodes(collection_id, id) ON DELETE RESTRICT,
    UNIQUE (collection_id, parent_id, ordinal)
  )`.execute(db);
  await sql`CREATE TABLE content_revisions (
    collection_id text NOT NULL REFERENCES collections(id) ON DELETE RESTRICT,
    revision text NOT NULL CHECK (length(revision) BETWEEN 1 AND 128 AND revision ~ '^[A-Za-z0-9._~-]+$'),
    ordinal bigint NOT NULL CHECK (ordinal > 0),
    created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (collection_id, revision), UNIQUE (collection_id, ordinal)
  )`.execute(db);
  await sql`CREATE TABLE policy_revisions (
    collection_id text NOT NULL REFERENCES collections(id) ON DELETE RESTRICT,
    revision text NOT NULL CHECK (length(revision) BETWEEN 1 AND 128 AND revision ~ '^[A-Za-z0-9._~-]+$'),
    ordinal bigint NOT NULL CHECK (ordinal > 0), created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (collection_id, revision), UNIQUE (collection_id, ordinal)
  )`.execute(db);

  await sql`CREATE TABLE operations (
    operation_id text PRIMARY KEY REFERENCES resource_id_ledger(resource_id) ON DELETE RESTRICT,
    collection_id text NOT NULL REFERENCES collections(id) ON DELETE RESTRICT,
    commit_ordinal bigint NOT NULL CHECK (commit_ordinal > 0), operation_type text NOT NULL,
    payload_json jsonb NOT NULL DEFAULT '{}'::jsonb, actor_principal_id text, created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT operations_collection_ordinal_unique UNIQUE (collection_id, commit_ordinal),
    CONSTRAINT operations_operation_collection_unique UNIQUE (operation_id, collection_id)
  )`.execute(db);
  await sql`CREATE TABLE audit_events (
    id bigserial PRIMARY KEY, operation_id text NOT NULL, collection_id text NOT NULL,
    CONSTRAINT audit_events_operation_collection_fk FOREIGN KEY (operation_id, collection_id)
      REFERENCES operations(operation_id, collection_id) ON DELETE RESTRICT,
    principal_id text, event_type text NOT NULL,
    details_json jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
  )`.execute(db);
  await sql`CREATE TABLE outbox_events (
    outbox_id text PRIMARY KEY REFERENCES resource_id_ledger(resource_id) ON DELETE RESTRICT,
    domain_event_id text NOT NULL REFERENCES resource_id_ledger(resource_id) ON DELETE RESTRICT,
    event_type text NOT NULL, event_version integer NOT NULL CHECK (event_version > 0),
    handler_name text NOT NULL, handler_mode text NOT NULL CHECK (handler_mode IN ('projection_latest_only','delivery_each_event')),
    aggregate_scope text, aggregate_revision text CHECK (aggregate_revision IS NULL OR (length(aggregate_revision) BETWEEN 1 AND 128 AND aggregate_revision ~ '^[A-Za-z0-9._~-]+$')),
    commit_ordinal bigint CHECK (commit_ordinal IS NULL OR commit_ordinal > 0),
    payload_json jsonb NOT NULL DEFAULT '{}'::jsonb, state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','leased','retryable','completed','dead_letter')),
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0), available_at timestamptz NOT NULL DEFAULT now(), locked_until timestamptz,
    lease_generation bigint NOT NULL DEFAULT 0 CHECK (lease_generation >= 0), completed_at timestamptz, last_error text,
    UNIQUE (domain_event_id, handler_name)
  )`.execute(db);
  await sql`CREATE INDEX outbox_claim_idx ON outbox_events(available_at, locked_until) WHERE state IN ('pending','retryable')`.execute(db);
  await sql`CREATE TABLE product_command_receipts (
    principal_id text NOT NULL, command_scope text NOT NULL, command_id text NOT NULL,
    request_fingerprint text NOT NULL, target_identity text, result_status integer, result_headers jsonb,
    result_media_type text, result_bytes bytea, result_digest text, contract_version text NOT NULL DEFAULT '0.1.0-draft',
    claimed_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, result_expires_at timestamptz,
    result_purged_at timestamptz, compact_claim boolean NOT NULL DEFAULT false,
    PRIMARY KEY (principal_id, command_scope, command_id), CHECK (result_status IS NULL OR result_status BETWEEN 100 AND 599)
  )`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of ['product_command_receipts','outbox_events','audit_events','operations','policy_revisions','content_revisions','children_revisions','resource_revisions','collection_policies','collection_members','nodes','collections','sessions','profiles','accounts','resource_id_ledger']) {
    await sql.raw(`DROP TABLE IF EXISTS ${table} CASCADE`).execute(db);
  }
  await sql`DROP FUNCTION IF EXISTS forbid_resource_id_ledger_mutation()`.execute(db);
  await sql`DROP FUNCTION IF EXISTS validate_node_parent_and_root()`.execute(db);
  await sql`DROP FUNCTION IF EXISTS validate_node_children_parent()`.execute(db);
  await sql`DROP FUNCTION IF EXISTS validate_collection_root_lifecycle()`.execute(db);
  await sql`DROP FUNCTION IF EXISTS validate_resource_revision_scope()`.execute(db);
  await sql`DROP FUNCTION IF EXISTS forbid_collection_root_reassignment()`.execute(db);
}

export const migration: Migration = { up, down };
