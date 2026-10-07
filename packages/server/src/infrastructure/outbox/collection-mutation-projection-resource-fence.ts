import type { PoolClient } from 'pg';

/** A different handler may already have projected a newer event for this resource. */
export async function assertProjectedResourceIsStale(
  client: PoolClient,
  target: { readonly collectionId: string; readonly resourceType: string; readonly resourceId: string },
  commitOrdinal: bigint,
  projectedCount: number,
): Promise<void> {
  const held = await client.query<{ last_commit_ordinal: string }>(
    `SELECT last_commit_ordinal FROM collection_mutation_projection_resources
     WHERE collection_id = $1 AND resource_type = $2 AND resource_id = $3`,
    [target.collectionId, target.resourceType, target.resourceId],
  );
  const heldOrdinal = held.rows[0] ? BigInt(held.rows[0].last_commit_ordinal) : null;
  if (heldOrdinal === null || heldOrdinal < commitOrdinal) {
    throw new Error(
      `collection mutation projection expected exactly one resource, `
      + `but atomically materialised ${projectedCount}`,
    );
  }
}
