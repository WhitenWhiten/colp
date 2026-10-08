import { sql, type Kysely } from 'kysely';
import type { McpCommittedContentRevisionFacts } from '../../modules/mcp/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';

/**
 * Runs inside the plan's commit transaction, after its last operation. The
 * plan's own writes hold the collection row lock until commit, so the value
 * read here is the revision this plan left; any later writer advances it.
 */
export async function recordMcpPlanCommitRevisions(
  transaction: DatabaseTransaction,
  facts: McpCommittedContentRevisionFacts,
): Promise<void> {
  for (const collectionId of facts.collectionIds) {
    const row = await transaction.selectFrom('collections')
      .select('content_revision')
      .where('id', '=', collectionId)
      .executeTakeFirst();
    if (row === undefined) continue;
    await sql`
      INSERT INTO mcp_plan_commit_revisions (plan_id, collection_id, content_revision)
      VALUES (${facts.planId}, ${collectionId}, ${row.content_revision})
      ON CONFLICT (plan_id, collection_id) DO UPDATE
        SET content_revision = EXCLUDED.content_revision
    `.execute(transaction);
  }
}

/** The revision a committed plan left on one collection, or null. */
export async function readMcpPlanCommitRevision(
  db: Kysely<DatabaseSchema>,
  planId: string,
  collectionId: string,
): Promise<string | null> {
  const result = await sql<{ content_revision: string }>`
    SELECT content_revision FROM mcp_plan_commit_revisions
    WHERE plan_id = ${planId} AND collection_id = ${collectionId}
  `.execute(db);
  return result.rows[0]?.content_revision ?? null;
}
