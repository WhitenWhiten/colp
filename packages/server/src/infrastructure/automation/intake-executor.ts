import { sql } from 'kysely';
import type { RuleDefinition, RoleBindings } from '@know-n/colp/automation';
import { serverIntakeBlock, resolveBindings, assessIntakeBindings, type AutomationActor } from '../../modules/automation/index.js';
import { captureCollectionTreeVersion, CollectionVersionNodeLimitError } from '../../modules/collections/index.js';
import { createPostgresCollectionVersionStore } from '../collections/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { createBindingReadPort } from './bindings.js';
import { canonicalPlacementMove, lockPlacementCollection } from './canonical-placement.js';
import { recordPlacementHistory } from './placement-history-store.js';
import type { AutomationSource } from './source-position-store.js';
interface PendingPlacement {
  id: string; definition_json: RuleDefinition; values_json: RoleBindings; rule_id: string;
  source_event_id: string; operation_id: string; node_id: string; origin: string; facts_json: NonNullable<AutomationSource['facts_json']>;
}
export async function executePendingIntake(tx: DatabaseTransaction, actor: AutomationActor, collectionId: string, serverUuid: string): Promise<boolean> {
  const settings = await tx.selectFrom('automation_settings').select('paused').where('owner_id', '=', actor.accountId).executeTakeFirst();
  if (settings?.paused) return false;
  const pending = (await sql<PendingPlacement>`SELECT r.id,v.definition_json,v.rule_id,b.values_json,f.source_event_id,
    f.operation_id,f.node_id,f.origin,f.facts_json FROM automation_runs r
    JOIN automation_rule_revisions v ON v.id=r.rule_revision_id
    JOIN automation_binding_revisions b ON b.binding_set_id=r.binding_set_id AND b.revision=r.binding_revision
    JOIN automation_event_facts f ON f.source_event_id=r.member_ids->>0
    WHERE r.owner_id=${actor.accountId} AND f.collection_id=${collectionId} AND r.state='waiting' AND NOT r.held
      AND r.kind='intake' AND r.policy_revision IS NULL
    ORDER BY f.commit_ordinal,r.created_at,r.id LIMIT 11 FOR UPDATE OF r`.execute(tx)).rows;
  if (!pending.length) return false;
  const collection = await lockPlacementCollection(tx, actor, collectionId), reads = createBindingReadPort(tx, serverUuid);
  for (const run of pending.slice(0, 10)) {
    const source = run.facts_json.after;
    const current = await tx.selectFrom('nodes').select(['resource_revision','parent_id','deleted_at']).where('id', '=', run.node_id)
      .where('collection_id', '=', collectionId).executeTakeFirst();
    const resolutions = await resolveBindings(reads, actor, run.definition_json, run.values_json);
    const destination = resolutions[run.definition_json.intake?.folderRole ?? ''];
    // Compatible matching rules share the already committed canonical effect, never another move.
    const shared = (await sql<{ operation_id: string; after_revision: string; after_parent_id: string }>`SELECT e.operation_id,e.after_revision,e.after_parent_id
      FROM automation_effect_receipts e JOIN automation_runs r ON r.id=e.run_id
      WHERE r.owner_id=${actor.accountId} AND r.member_ids @> ${JSON.stringify([run.source_event_id])}::jsonb
        AND e.step_id='intake' AND e.undone_operation_id IS NULL ORDER BY e.created_at LIMIT 1`.execute(tx)).rows[0];
    if (shared && destination?.status === 'valid' && destination.snapshot.folder.nodeId === shared.after_parent_id
      && current?.resource_revision === shared.after_revision && !current.deleted_at) {
      await recordPlacementHistory(tx, actor, serverUuid, run.id, shared.operation_id);
      await finish(run.id, 'completed', 'A compatible rule already committed this placement.'); continue;
    }
    const currentParent = current?.parent_id ? await reads.readFolder(actor, { serverUuid, collectionId, nodeId: current.parent_id }) : undefined;
    const ancestryCurrent = currentParent?.status === 'valid' && source?.ancestryComplete
      && JSON.stringify([current!.parent_id, ...currentParent.snapshot.ancestors.map(folder => folder.nodeId)]) === JSON.stringify(source.ancestorIds);
    const reason = serverIntakeBlock({ origin: run.origin, action: run.facts_json.action,
      defaultRoot: !!source && (source.parentId === collection.root_node_id || source.parentIsIntakeRoot === true),
      currentRevision: current && !current.deleted_at ? current.resource_revision : null, sourceRevision: source?.resourceRevision ?? null,
      sourceParent: source?.parentId ?? null, currentParent: current?.parent_id ?? null,
      bindingAvailable: !!ancestryCurrent && destination?.status === 'valid' && assessIntakeBindings(run.definition_json, resolutions).available });
    if (reason || destination?.status !== 'valid' || !current) { await finish(run.id, 'review', reason ?? 'Destination unavailable.'); continue; }
    if (destination.snapshot.folder.nodeId === current.parent_id) { await finish(run.id, 'completed', 'Already in the verified destination; no canonical mutation required.'); continue; }
    const versions = createPostgresCollectionVersionStore(tx);
    const before = await versions.getOwnedLive(collectionId, actor.subjectId);
    if (!before) { await finish(run.id, 'review', 'Current Owner authority is unavailable.'); continue; }
    try {
      await captureCollectionTreeVersion({ versions, clock: { now: () => new Date() } }, { accountId: actor.accountId,
        collection: before, kind: 'pre_mutation', cause: `automation:${run.rule_id}`, label: 'Before deterministic automation placement' });
    } catch (error) {
      if (!(error instanceof CollectionVersionNodeLimitError)) throw error;
      await finish(run.id, 'blocked', 'Collection exceeds the existing version-history capacity; no placement was committed.'); continue;
    }
    const moved = await canonicalPlacementMove(tx, actor, { collectionId, nodeId: run.node_id, parentId: destination.snapshot.folder.nodeId,
      expectedRevision: current.resource_revision, runId: run.id, stage: 'intake' });
    await recordPlacementHistory(tx, actor, serverUuid, run.id, moved.operationId);
    await finish(run.id, 'completed', 'Matched the pinned rule and moved from the default root to its verified canonical destination.');
  }
  return pending.length > 10;
  async function finish(id: string, state: 'completed' | 'review' | 'blocked', explanation: string) {
    await sql`UPDATE automation_runs SET state=${state},revision=revision+1,updated_at=clock_timestamp(),
      explanation_json=explanation_json || ${JSON.stringify({ explanation })}::jsonb WHERE id=${id}`.execute(tx);
  }
}
