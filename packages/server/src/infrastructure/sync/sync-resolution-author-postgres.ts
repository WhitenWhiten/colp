import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import type { DatabaseTransaction } from '../database/unit-of-work.js';

/** Each immutable command owns a one-operation server lane, like Product restore. */
export async function claimResolutionAuthor(tx: DatabaseTransaction, input: {
  readonly operationId: string; readonly collectionId: string; readonly conflictId: string; readonly requestDigest: string;
}) {
  const replicaId = `resolution-author-${randomBytes(16).toString('base64url')}`;
  await tx.insertInto('resource_id_ledger').values({ resource_id: replicaId, resource_type: 'sync_replica' }).execute();
  await sql`INSERT INTO sync_resolution_authors(operation_id,author_id,collection_id,conflict_id,request_digest)
    VALUES (${input.operationId},${replicaId},${input.collectionId},${input.conflictId},${input.requestDigest})`.execute(tx);
  return { replicaId, sequence: 1 } as const;
}

export async function hasResolutionClaim(tx: DatabaseTransaction, operationId: string): Promise<boolean> {
  return (await sql`SELECT operation_id FROM sync_resolution_authors WHERE operation_id=${operationId}`.execute(tx)).rows.length === 1;
}
