import { sql } from 'kysely';
import { isIntakeRootFolder } from '../../modules/automation/index.js';
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

let captureEnabled = false;
/**
 * Host switch for KNOWN_FEATURE_AUTOMATION_CAPTURE (design 07 §7, 09 §9). API and worker
 * install it once from validated config; while off, canonical mutations plan no ancestry,
 * write no facts and enqueue no automation Outbox rows.
 */
export function setAutomationCaptureEnabled(enabled: boolean): void { captureEnabled = enabled; }
export function automationCaptureEnabled(): boolean { return captureEnabled; }

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
      const parent = result.rows[0];
      path = { ids: result.rows.map(row => row.id), intakeRoot: isIntakeRootFolder(parent
        ? { isRoot: parent.is_root, folderRole: parent.folder_role } : undefined), complete: result.rows.length > 0
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
  await captureAutomationFactsBatch(tx, [{ event, input, allocation, planned }]);
}

export async function captureAutomationFactsBatch(tx: DatabaseTransaction, entries: readonly {
  event: CanonicalDomainEvent; input: CanonicalMutationInput; allocation: AllocatedMutationState; planned: PlannedAutomationFacts;
}[]) {
  if (!entries.length) return;
  const rows = entries.map(e => automationFactValues(e.event, e.input, e.allocation, e.planned));
  await sql`INSERT INTO automation_event_facts
    (source_event_id,operation_id,collection_id,node_id,commit_ordinal,occurred_at,origin,facts_json,facts_version,root_run_id)
    SELECT source_event_id,operation_id,collection_id,node_id,commit_ordinal,clock_timestamp(),origin,facts_json,1,root_run_id
    FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS i(source_event_id text,operation_id text,
      collection_id text,node_id text,commit_ordinal bigint,origin text,facts_json jsonb,root_run_id text)`.execute(tx);
}

/** Shared by single canonical writes and the atomic bookmark move batch. */
function automationFactValues(event: CanonicalDomainEvent, input: CanonicalMutationInput,
  allocation: AllocatedMutationState, planned: PlannedAutomationFacts) {
  const context = input.automationContext ?? { origin: input.operationSyncWire ? 'sync' : 'system' };
  const origin = input.mutation.action === 'restore' ? 'restore' : context.origin;
  const facts = { ...planned, after: planned.after ? { ...planned.after, resourceRevision: allocation.resourceRevision! } : null,
    intakeDisposition: input.intakeDisposition ?? 'unknown', agent: context.agent ?? null,
    action: input.mutation.action, actorPrincipalId: input.actor.principalId,
    rootRunId: context.rootRunId ?? null, stageId: context.stageId ?? null, hopCount: context.hopCount ?? 0 };
  return { source_event_id: event.domainEventId, operation_id: event.operationId, collection_id: event.collectionId,
    node_id: event.aggregateId, commit_ordinal: allocation.commitOrdinal.toString(),
    origin, facts_json: facts, facts_version: 1, root_run_id: context.rootRunId ?? null };
}
