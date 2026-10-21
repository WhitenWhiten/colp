import { sql, type Kysely } from 'kysely';
import { captureCollectionTreeVersion } from '../../modules/collections/index.js';
import { rethrowAgentPlanHistoryError } from '../../modules/mcp/index.js';
import type {
  McpCommittedContentRevisionFacts,
  McpPreCommitVersionFacts,
} from '../../modules/mcp/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { appendAuditEvent } from '../database/audit-event-payload.js';
import { createPostgresCollectionVersionStore } from './collection-tree-version-postgres.js';

/**
 * Runs inside the plan's commit transaction, before its first operation, so
 * the saved version is exactly the tree the plan changed. A plan the owner
 * approved gets an Undo receipt here, including trusted auto-approvals.
 * Failed commits roll history, receipts and approval audit back together.
 */
export async function captureMcpPlanPreCommitVersions(
  transaction: DatabaseTransaction,
  facts: McpPreCommitVersionFacts,
): Promise<void> {
  const cause = `agent-plan:${facts.planId}` as const;
  const policy = facts.policyApproved ? await sql<{ policy: string }>`SELECT policy FROM agent_policies
    WHERE principal_id=${facts.principalId} AND client_id=${facts.clientId}`.execute(transaction) : undefined;
  const approvedBy = policy?.rows[0]?.policy === 'trusted' ? 'policy' : 'owner';
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
        ${facts.planId}, ${facts.clientId}, ${approvedBy}, ${versionId}, ${collectionId}, ${cause}
      )
      ON CONFLICT (plan_id) DO NOTHING
    `.execute(transaction);
    if (approvedBy === 'policy') {
      const plan = await transaction.selectFrom('mcp_change_plans').select(['risk', 'operations_digest'])
        .where('plan_id', '=', facts.planId).executeTakeFirstOrThrow();
      await appendAuditEvent(transaction, { operationId: null, collectionId: null,
        principalId: facts.principalId, eventType: 'mcp.approval_decision', details: {
          planId: facts.planId, collectionId, decision: 'auto-approved', approvedBy,
          status: 'consumed', versionId, cause, risk: plan.risk, operationsDigest: plan.operations_digest,
        } });
    }
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
