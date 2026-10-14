import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { RunOncePreview } from '@know-n/colp/automation';
import { AutomationError, parseContract, type AutomationActor, type AutomationPorts } from '../../modules/automation/index.js';
import type { RunOnceService } from '../../modules/automation/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { manualConfiguration, previewManualRun, type ManualSnapshot } from './manual-preview-store.js';
import { lockPlacementCollection, canonicalPlacementMove } from './canonical-placement.js';
import { recordPlacementHistory, recordPlacementHistories } from './placement-history-store.js';
import { validateManualMembers, insertManualRuns } from './manual-run-members.js';
import { initializeRunTasks, advanceRunTasks } from './task-scheduler.js';
import { reserveManualCapacity } from './intake-capacity.js';
import { createPostgresCollectionVersionStore, withCanonicalTreeCapacityBatch } from '../collections/index.js';
import { captureCollectionTreeVersion, CollectionVersionNodeLimitError } from '../../modules/collections/index.js';
interface PreviewRow {
  id: string;
  digest: string;
  snapshot_json: ManualSnapshot;
  result_json: RunOncePreview;
  expires_at: Date;
  run_id: string | null;
}
const stale = () => new AutomationError('automation_stale_input', 'Run-once preview changed or expired; refresh the preview.');
export function createManualRunStore(tx: DatabaseTransaction, ports: AutomationPorts, actor: AutomationActor, serverUuid: string): RunOnceService {
  return { async authorizePreview(previewId) {
      const row = (await sql<{
        snapshot_json: ManualSnapshot;
      }>`SELECT snapshot_json FROM automation_manual_previews WHERE id=${previewId} AND owner_id=${actor.accountId}`.execute(tx)).rows[0];
      const collection = row ? await ports.reads.readCollection(actor, row.snapshot_json.collectionId) : null;
      if (!collection?.currentOwner)
        throw new AutomationError('resource_not_found', 'Preview is unavailable under current Owner authority.');
    }, preview: (id, input) => previewManualRun(tx, ports, actor, serverUuid, id, input), async start(ruleId, body) {
      if (!ports.runtimeEnabled)
        throw new AutomationError('automation_unsupported_capability', 'Execution runtime unavailable.');
      const input = parseContract('RunOnceStartInput', body);
      const row = (await sql<PreviewRow>`SELECT * FROM automation_manual_previews WHERE id=${input.previewId} AND owner_id=${actor.accountId} AND rule_id=${ruleId} FOR UPDATE`.execute(tx)).rows[0];
      if (!row || row.digest !== input.previewDigest)
        throw stale();
      const snapshot = row.snapshot_json;
      // The replica gate must precede every collection read, including the SHARE
      // locks hidden inside configuration/binding authorization.
      const collection = await lockPlacementCollection(tx, actor, snapshot.collectionId);
      const { digest } = await manualConfiguration(ports, actor, ruleId, snapshot.input);
      if (row.run_id) {
        const previous = await ports.runs.load(row.run_id);
        if (!previous)
          throw stale();
        return previous.view;
      }
      if (!row.result_json.canStart || row.expires_at <= await ports.now() || digest !== snapshot.configurationDigest)
        throw stale();
      if ((await ports.settings.get(actor.accountId)).paused)
        throw new AutomationError('automation_paused', 'Resume before starting the preview.');
      if (collection.content_revision !== snapshot.collectionRevision)
        throw stale();
      const nodes = await validateManualMembers(tx, snapshot);
      const selected = snapshot.members.filter(m => ['matched', 'placed', 'preserved'].includes(m.plan.kind));
      const parentId = randomUUID(), runTasks = snapshot.input.tasks === 'all' && snapshot.definition.tasks.length > 0;
      const children = selected.map(member => ({ member, id: randomUUID() }));
      await insertManualRuns(tx, actor, parentId, snapshot, children);
      // Every member that starts worker tasks is a run against the daily limit, not just the parent.
      const charged = [parentId, ...(runTasks ? children.map(child => child.id) : [])];
      if (!await reserveManualCapacity(tx, { ownerId: actor.accountId, ruleId, runIds: charged, maxRunsPerDay: snapshot.definition.policy.maxRunsPerDay }))
        throw new AutomationError('automation_command_conflict', `Daily run capacity cannot cover this run-once (${charged.length} runs); start again with a current preview after capacity is available.`);
      if (selected.some(m => m.plan.kind === 'placed')) {
        const versions = createPostgresCollectionVersionStore(tx), before = await versions.getOwnedLive(snapshot.collectionId, actor.subjectId);
        if (!before)
          throw stale();
        try {
          await captureCollectionTreeVersion({ versions, clock: { now: () => new Date() } }, { accountId: actor.accountId, collection: before, kind: 'pre_mutation', cause: `automation:${ruleId}`, label: 'Before explicit run-once placement' });
        }
        catch (error) {
          if (error instanceof CollectionVersionNodeLimitError)
            throw new AutomationError('payload_too_large', 'Collection history capacity prevents this manual placement.');
          throw error;
        }
      }
      await withCanonicalTreeCapacityBatch(tx, snapshot.collectionId, async admission => {
        const placements: { runId: string; operationId: string }[] = [];
        for (const { member, id } of children) {
          if (member.plan.kind === 'placed' && nodes.get(member.event.nodeId)!.parent_id !== member.plan.folder.nodeId) {
            const moved = await canonicalPlacementMove(tx, actor, { collectionId: snapshot.collectionId, nodeId: member.event.nodeId, parentId: member.plan.folder.nodeId, expectedRevision: member.revision, runId: id, stage: 'intake' }, admission);
            // Successors must see their receipt before their immutable inputs are pinned.
            if (runTasks) await recordPlacementHistory(tx, actor, serverUuid, id, moved.operationId);
            else placements.push({ runId: id, operationId: moved.operationId });
          }
          if (runTasks) {
            await initializeRunTasks(tx, actor, id);
            await advanceRunTasks(tx, actor, serverUuid, id);
          }
        }
        await recordPlacementHistories(tx, actor, serverUuid, placements);
      });
      await sql`UPDATE automation_manual_previews SET run_id=${parentId} WHERE id=${row.id}`.execute(tx);
      return (await ports.runs.load(parentId))!.view;
    } };
}
