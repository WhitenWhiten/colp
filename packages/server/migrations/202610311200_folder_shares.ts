import { sql, type Kysely, type Migration } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE publication_slug_claims (
    slug text PRIMARY KEY, locator_type text NOT NULL CHECK (locator_type IN ('collection', 'folder')),
    locator_id text NOT NULL
  )`.execute(db);
  await sql`CREATE TABLE folder_shares (
    id text PRIMARY KEY, collection_id text NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    node_id text NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    slug text NOT NULL UNIQUE CHECK (slug = lower(slug) AND length(slug) BETWEEN 3 AND 263
      AND slug ~ '^[a-z0-9][a-z0-9-]*[a-z0-9]$'),
    created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz
  )`.execute(db);
  await sql`CREATE UNIQUE INDEX folder_shares_one_live_per_folder ON folder_shares(collection_id, node_id)
    WHERE revoked_at IS NULL`.execute(db);
  // A shared unique index arbitrates both namespaces, including concurrent writers.
  // Claims survive revocation/deletion: an old link can never become somebody else's page.
  await sql`CREATE FUNCTION claim_publication_slug() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE requested_slug text; requested_kind text;
  BEGIN
    IF TG_TABLE_NAME = 'collections' THEN requested_slug := NEW.publication_slug; requested_kind := 'collection';
    ELSE requested_slug := NEW.slug; requested_kind := 'folder'; END IF;
    IF requested_slug IS NULL THEN RETURN NEW; END IF;
    INSERT INTO publication_slug_claims(slug, locator_type, locator_id)
      VALUES (requested_slug, requested_kind, NEW.id) ON CONFLICT (slug) DO NOTHING;
    IF NOT EXISTS (SELECT 1 FROM publication_slug_claims WHERE slug = requested_slug
      AND locator_type = requested_kind AND locator_id = NEW.id) THEN
      RAISE EXCEPTION 'Publication address is already reserved' USING ERRCODE = '23505', CONSTRAINT = 'publication_slug_namespace_unique';
    END IF;
    RETURN NEW;
  END $$`.execute(db);
  await sql`CREATE TRIGGER collections_claim_publication_slug BEFORE INSERT OR UPDATE OF publication_slug ON collections
    FOR EACH ROW EXECUTE FUNCTION claim_publication_slug()`.execute(db);
  await sql`CREATE TRIGGER folder_shares_claim_slug BEFORE INSERT OR UPDATE OF slug ON folder_shares
    FOR EACH ROW EXECUTE FUNCTION claim_publication_slug()`.execute(db);
  await sql`CREATE FUNCTION revoke_deleted_folder_shares() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    UPDATE folder_shares SET revoked_at = NEW.deleted_at
      WHERE collection_id = NEW.collection_id AND node_id = NEW.id AND revoked_at IS NULL;
    RETURN NEW;
  END $$`.execute(db);
  await sql`CREATE TRIGGER nodes_revoke_deleted_folder_shares AFTER UPDATE OF deleted_at ON nodes
    FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
    EXECUTE FUNCTION revoke_deleted_folder_shares()`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER nodes_revoke_deleted_folder_shares ON nodes`.execute(db);
  await sql`DROP FUNCTION revoke_deleted_folder_shares()`.execute(db);
  await sql`DROP TRIGGER collections_claim_publication_slug ON collections`.execute(db);
  await sql`DROP TABLE folder_shares`.execute(db);
  await sql`DROP FUNCTION claim_publication_slug()`.execute(db);
  await sql`DROP TABLE publication_slug_claims`.execute(db);
}
export const migration: Migration = { up, down };
export default migration;
