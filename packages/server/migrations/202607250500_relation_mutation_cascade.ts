import { sql, type Kysely } from 'kysely';

/** P2B-11 enables canonical Relation cascade before removing the temporary fail-closed bridge. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS nodes_live_relation_integrity ON nodes`.execute(db);
  await sql`DROP FUNCTION IF EXISTS prevent_live_relation_endpoint_delete()`.execute(db);
}

/** Rollback is safe only after the P2B-11 writer has been removed from service. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE FUNCTION prevent_live_relation_endpoint_delete() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL AND EXISTS (
        SELECT 1 FROM relations
         WHERE collection_id = NEW.collection_id AND deleted_at IS NULL
           AND (from_node_id = NEW.id OR to_node_id = NEW.id)
      ) THEN
        RAISE EXCEPTION 'node endpoint has live relations requiring canonical Relation cascade'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
  $$`.execute(db);
  await sql`CREATE CONSTRAINT TRIGGER nodes_live_relation_integrity
    AFTER UPDATE ON nodes DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION prevent_live_relation_endpoint_delete()`.execute(db);
}
