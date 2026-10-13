import { sql } from 'kysely';
import type { CanonicalDomainEvent, CanonicalMutationInput, AllocatedMutationState } from '../../modules/collections/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';

export interface AutomationNodeSnapshot {
  kind: string;
  title: string | null;
  url: string | null;
  tags: readonly string[];
  parentId: string | null;
  parentIsIntakeRoot?: boolean;
  ancestorIds: readonly string[];
  ancestryComplete: boolean;
  resourceRevision: string | null;
}
export interface PlannedAutomationFacts {
  before: AutomationNodeSnapshot | null;
  after: AutomationNodeSnapshot | null;
}
type NodeFields = { kind: string; title: string | null; url: string | null; tags: unknown };
type BeforeNode = NodeFields & { parent_id: string | null; resource_revision: string };
const MAX_ANCESTORS = 128;

/** Runs only during locked planning. No post-mutation reads can contaminate before-state. */
export async function planAutomationFacts(tx: DatabaseTransaction, input: CanonicalMutationInput,
  before: BeforeNode | null, after: NodeFields | null, afterParent: string | null): Promise<PlannedAutomationFacts> {
  const paths = new Map<string, { ids: string[]; complete: boolean; intakeRoot: boolean }>();
  async function snapshot(fields: NodeFields, parentId: string | null, revision: string | null): Promise<AutomationNodeSnapshot> {
    let path = parentId === null ? { ids: [], complete: true, intakeRoot: false } : paths.get(parentId);
    if (!path) {
      const result = await sql<{ id: string; parent_id: string | null; depth: number; cycle: boolean; is_root: boolean; folder_role: string | null }>`
        WITH RECURSIVE ancestors AS (
          SELECT id, parent_id, is_root, payload_json->>'folderRole' AS folder_role, 1 AS depth, ARRAY[id] AS seen, false AS cycle FROM nodes
          WHERE collection_id = ${input.collectionId} AND id = ${parentId} AND deleted_at IS NULL
          UNION ALL
          SELECT n.id, n.parent_id, n.is_root, n.payload_json->>'folderRole', a.depth + 1, a.seen || n.id, n.id = ANY(a.seen)
          FROM nodes n JOIN ancestors a ON n.id = a.parent_id
          WHERE n.collection_id = ${input.collectionId} AND n.deleted_at IS NULL
            AND a.depth < ${MAX_ANCESTORS} AND NOT a.cycle
        ) SELECT id, parent_id, depth, cycle, is_root, folder_role FROM ancestors ORDER BY depth`.execute(tx);
      path = { ids: result.rows.map(row => row.id), intakeRoot: result.rows[0]?.is_root === true
        || ['bookmarks-bar','other-bookmarks','mobile-bookmarks'].includes(result.rows[0]?.folder_role ?? ''), complete: result.rows.length > 0
        && result.rows.at(-1)!.parent_id === null && !result.rows.some(row => row.cycle) };
      paths.set(parentId!, path);
    }
    return { kind: fields.kind, title: fields.title, url: fields.url,
      tags: Array.isArray(fields.tags) ? fields.tags.filter((tag): tag is string => typeof tag === 'string') : [],
      parentId, parentIsIntakeRoot: path.intakeRoot, ancestorIds: path.ids, ancestryComplete: path.complete, resourceRevision: revision };
  }
  return { before: before ? await snapshot(before, before.parent_id, before.resource_revision) : null,
    after: after ? await snapshot(after, afterParent, null) : null };
}

/** Private bounded facts only; no description, readable content, extensions or credential payload. */
export async function captureAutomationFacts(tx: DatabaseTransaction, event: CanonicalDomainEvent,
  input: CanonicalMutationInput, allocation: AllocatedMutationState, planned: PlannedAutomationFacts): Promise<void> {
  const context = input.automationContext ?? { origin: input.operationSyncWire ? 'sync' : 'system' };
  const origin = input.mutation.action === 'restore' ? 'restore' : context.origin;
  const facts = { ...planned, after: planned.after ? { ...planned.after, resourceRevision: allocation.resourceRevision! } : null,
    action: input.mutation.action, actorPrincipalId: input.actor.principalId,
    rootRunId: context.rootRunId ?? null, stageId: context.stageId ?? null, hopCount: context.hopCount ?? 0 };
  await sql`INSERT INTO automation_event_facts
    (source_event_id, operation_id, collection_id, node_id, commit_ordinal, occurred_at, origin, facts_json, facts_version, root_run_id)
    VALUES (${event.domainEventId}, ${event.operationId}, ${event.collectionId}, ${event.aggregateId},
      ${event.commitOrdinal}, clock_timestamp(), ${origin}, ${JSON.stringify(facts)}::jsonb, 1, ${context.rootRunId ?? null})`.execute(tx);
}
