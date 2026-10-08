import { sql, type Kysely } from 'kysely';

/** A reader replica belongs to one uninterrupted lifetime of a bookmark URL. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE FUNCTION invalidate_node_readable_replica() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      DELETE FROM collection_readable_replicas WHERE node_id = NEW.id;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER nodes_invalidate_readable_replica
      AFTER UPDATE OF url, deleted_at ON nodes FOR EACH ROW
      WHEN (OLD.url IS DISTINCT FROM NEW.url OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
      EXECUTE FUNCTION invalidate_node_readable_replica()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER nodes_invalidate_readable_replica ON nodes`.execute(db);
  await sql`DROP FUNCTION invalidate_node_readable_replica()`.execute(db);
}
