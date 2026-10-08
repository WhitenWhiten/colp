import { sql, type Kysely } from 'kysely';

/**
 * KNS-06: Product-authored restore_node writes the same node_restored effect as
 * Push. origin_replica_id stays an OpaqueId on the effect row; it is not a
 * device Replica, so the FK to sync_replicas would force a fake device into
 * Sync Center status. Expand: drop that FK only.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE sync_operation_effects
      DROP CONSTRAINT IF EXISTS sync_operation_effects_origin_replica_id_fkey
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE sync_operation_effects
      ADD CONSTRAINT sync_operation_effects_origin_replica_id_fkey
      FOREIGN KEY (origin_replica_id) REFERENCES sync_replicas(replica_id) ON DELETE RESTRICT
  `.execute(db);
}
