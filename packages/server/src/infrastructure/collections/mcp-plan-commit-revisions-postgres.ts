import { sql, type Kysely } from 'kysely';
import { captureCollectionTreeVersion } from '../../modules/collections/index.js';
import { rethrowAgentPlanHistoryError } from '../../modules/mcp/index.js';
import type {
  McpCommittedContentRevisionFacts,
  McpPreCommitVersionFacts,
} from '../../modules/mcp/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { createPostgresCollectionVersionStore } from './collection-tree-version-postgres.js';

/**
 * Runs inside the plan's commit transaction, before its first operation, so
 * the saved version is exactly the tree the plan changed. A plan the owner
 * approved gets an Undo receipt here; a trusted auto-approval has already
 * captured its version and saves its own receipt after the commit.
 */
export async function captureMcpPlanPreCommitVersions(
  transaction: DatabaseTransaction,
  facts: McpPreCommitVersionFacts,
): Promise<void> {
  const cause = `agent-plan:${facts.planId}` as const;
  const versions = createPostgresCollectionVersionStore(transaction);
  for (const collectionId of facts.collectionIds) {
    const prior = await transaction.selectFrom('collection_tree_versions')
      .select('version_id')
      .where('collection_id', '=', collectionId)
      .where('cause', '=', cause)
      .executeTakeFirst();

    const collection = await versions.lockOwnedLive(collectionId, facts.subjectId);
    if (collection === null) continue;
    // History is a prerequisite: rejecting here rolls back the approval
    // claim and the entire commit before any canonical operation executes.
    const captured = prior ? undefined : await captureCollectionTreeVersion(
      { versions, clock: { now: () => new Date() } },
      {
        accountId: facts.principalId,
        collection,
        kind: 'pre_mutation',
        cause,
        label: 'Before agent plan',
      },
    ).catch(rethrowAgentPlanHistoryError);
    const versionId = prior?.version_id ?? captured!.record.versionId;
    if (!facts.undoable) continue;
    await sql`
      INSERT INTO mcp_plan_policy_receipts (
        plan_id, client_id, approved_by, version_id, collection_id, cause
      ) VALUES (
        ${facts.planId}, ${facts.clientId}, 'owner', ${versionId}, ${collectionId}, ${cause}
      )
      ON CONFLICT (plan_id) DO NOTHING
    `.execute(transaction);
  }
}

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
