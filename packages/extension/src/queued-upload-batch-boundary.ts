import { exclusionIds } from './bookmark-subscriptions/guards.js';
import { plannedCreateNativeId } from './bookmark-event-codec.js';
import { classifyBookmarkApiFailure } from './bookmark-api-error.js';
import { batchableBootstrapCreate } from './outbound-push-batch.js';
import { boundNativeId, isNonChromeNativeId } from './pull-mount-apply.js';
import { assertQueuedUploadAllowed } from './queued-upload-boundary.js';
import type { ChromeBookmarkNode } from './chrome-bookmark-tree.js';
import type { QueuedUploadBoundaryFacts } from './sync-state/queued-upload-boundary-repository.js';
import type { JsonObject, QueueOperation, SyncScope, createSyncStateStore } from './sync-state-store.js';

type Store = ReturnType<typeof createSyncStateStore>;
class MissingBatchNative extends Error {}
type Native = Pick<ChromeBookmarkNode, 'id' | 'parentId' | 'type' | 'unmodifiable' | 'folderType'>;

/** Reuse reads only inside this invocation. Fresh native ancestry and coherent
 * IDB proof close the batch, including facts that do not bump boundaryVersion. */
export async function assertQueuedUploadBatchAllowed(input: {
  readonly store: Store; readonly scope: SyncScope; readonly rows: readonly QueueOperation[];
  readonly getMany: (ids: readonly string[]) => Promise<readonly Native[]>;
  readonly parentOf: (id: string) => Promise<string | undefined>;
}): Promise<void> {
  const individual = async () => {
    for (const queue of input.rows) await assertQueuedUploadAllowed({ ...input, queue });
  };
  if (!input.rows.length) return;
  if (!input.rows.every(row => batchableBootstrapCreate(row) && plannedCreateNativeId(row.opId))) return individual();
  const facts = await input.store.readQueuedUploadBoundaryFacts(input.scope, input.rows);
  const subscriptions = await exclusionIds();
  const sources = sourceIds(input.rows, facts), view = boundaryView(input.store, facts), used = new Set<string>();
  let tree: Map<string, Native>;
  try {
    tree = await readAncestry(sources, input.getMany);
    for (const queue of input.rows) await assertQueuedUploadAllowed({ store: view, scope: input.scope, queue,
      subscriptionExclusions: subscriptions, parentOf: async id => {
        const node = tree.get(id);
        if (!node) throw new MissingBatchNative();
        used.add(id); return node.parentId;
      } });
  } catch (error) {
    // Captured removals need their original journal and current native reads.
    // Never invent that evidence from a missing node in this batch snapshot.
    if (error instanceof MissingBatchNative || classifyBookmarkApiFailure(error) === 'not_found') return individual();
    throw error;
  }
  const currentTree = await readAncestry(sources, input.getMany);
  const currentSubscriptions = await exclusionIds();
  const current = await input.store.readQueuedUploadBoundaryFacts(input.scope, input.rows);
  if (JSON.stringify(facts) !== JSON.stringify(current)
      || subscriptions.size !== currentSubscriptions.size || [...subscriptions].some(id => !currentSubscriptions.has(id))) {
    throw new Error('upload_boundary_unavailable');
  }
  for (const id of used) {
    const before = tree.get(id)!, after = currentTree.get(id);
    if (!after || before.parentId !== after.parentId || before.unmodifiable !== after.unmodifiable
      || before.folderType !== after.folderType || before.type !== after.type) throw new Error('upload_boundary_unavailable');
  }
}

function sourceIds(rows: readonly QueueOperation[], facts: QueuedUploadBoundaryFacts): string[] {
  const result = new Set(rows.map(row => plannedCreateNativeId(row.opId)!));
  for (const event of facts.events) {
    if (event.original) result.add(event.original.nativeId);
    for (const linked of event.linked) result.add(linked.nativeId);
  }
  const mappings = new Map(facts.mappings.map(row => [row.colpId, row.mapping]));
  for (const row of rows) {
    const inner = row.payload.payload as JsonObject;
    for (const id of [`pending-${row.opId}`, row.payload.targetId, inner.parentId, inner.newParentId]) {
      if (typeof id !== 'string') continue;
      const mapping = mappings.get(id);
      if (mapping) {
        const nativeId = boundNativeId(mapping, facts.mounts);
        if (!isNonChromeNativeId(nativeId)) result.add(nativeId);
      }
    }
  }
  return [...result];
}

/** Read each relevant native once per proof, one multi-ID call per depth.
 * A moved node's new parent is followed, even outside the previous hints. */
async function readAncestry(sources: readonly string[], read: (ids: readonly string[]) => Promise<readonly Native[]>) {
  const result = new Map<string, Native>(); let pending = [...new Set(sources)];
  for (let depth = 0; pending.length; depth++) {
    if (depth >= 256) throw new Error('upload_boundary_unavailable');
    const nodes = await read(pending), current = new Map(nodes.map(node => [node.id, node]));
    if (nodes.length !== pending.length || current.size !== pending.length) throw new MissingBatchNative();
    for (const id of pending) {
      const node = current.get(id);
      if (!node) throw new MissingBatchNative();
      result.set(id, { id, parentId: node.parentId, type: node.type,
        unmodifiable: node.unmodifiable, folderType: node.folderType });
    }
    pending = [...new Set(nodes.flatMap(node => node.parentId && !result.has(node.parentId) ? [node.parentId] : []))];
  }
  return result;
}

function boundaryView(store: Store, facts: QueuedUploadBoundaryFacts): Store {
  const mappings = new Map(facts.mappings.map(row => [row.colpId, row.mapping]));
  const events = new Map(facts.events.map(row => [row.opId, row]));
  const commands = new Map(facts.commands.map(row => [row.commandId, row.plan]));
  const exclusions = new Map(facts.exclusions.map(row => [row.nativeId, row]));
  return { ...store, getScope: async () => facts.recorded, listMountBindings: async () => facts.mounts,
    listBootstrapRuns: async () => facts.runs,
    getScopePreview: async (_scope, id) => facts.preview?.previewId === id ? facts.preview : null,
    getMappingByColpId: async (_scope, id) => mappings.get(id) ?? null,
    getBookmarkEvent: async (_scope, id) => events.get(id)?.original ?? null,
    listBookmarkEventsByOperation: async (_scope, id, after = 0, limit = 100) =>
      (events.get(id)?.linked ?? []).filter(row => row.ordinal > after).slice(0, limit),
    getScopeCommandPlan: async (_scope, id) => commands.get(id) ?? null,
    getLocalSyncExclusion: async (_scope, id) => exclusions.get(id) ?? null };
}
