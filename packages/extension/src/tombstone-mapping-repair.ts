/**
 * Real native + tombstone observation: proven keep-local becomes exclusion.
 * Unknown Chrome results wait. Queue rows are never deleted.
 */
import { lookupBookmark, lookupBookmarkChildren } from './bookmark-api-error.js';
import { isNonChromeNativeId } from './pull-mount-apply.js';
import type { PullBookmarkApi } from './pull-applier-types.js';
import { remoteDeleteDecisionId } from './remote-delete-policy.js';
import { isTombstonedMappingNativeId } from './tombstone-parent-rebase.js';
import type {
  JsonObject, MappingInput, QueueOperation, SyncScope, createSyncStateStore,
} from './sync-state-store.js';

type Store = Pick<ReturnType<typeof createSyncStateStore>,
  'getScope' | 'listMappings' | 'listRemoteObservations' | 'getLocalSyncExclusion' | 'putLocalSyncExclusion'
  | 'commitTombstoneMappingRepair' | 'getMappingByNativeId'>
  // The queued-create sweep and its "kept, not rewritten" diagnostic read the
  // queue store, which the native-repair entry point's narrow Store Pick does
  // not declare. They stay optional so a caller holding only the mapping facts
  // keeps compiling; the production store always provides both.
  & Partial<Pick<ReturnType<typeof createSyncStateStore>, 'listQueue' | 'putScopeDiagnostic'>>;

/** Statuses a live create row can still be re-anchored from; terminal/rejected are settled history. */
const REBASABLE_QUEUE_STATUSES: readonly QueueOperation['status'][] = [
  'pending', 'claimed', 'deferred', 'gap', 'blocked', 'unknown', 'set_aside',
];
const QUEUE_SCAN_LIMIT = 1_000;

export async function repairTombstonedNativeMappings(store: Store, scope: SyncScope,
  api?: PullBookmarkApi): Promise<{ readonly excluded: number; readonly waiting: number;
    readonly deferred: number }> {
  const [mappings, observations] = await Promise.all([
    store.listMappings(scope), store.listRemoteObservations(scope),
  ]);
  const tombstones = new Set(observations.filter((row) => row.kind === 'tombstone').map((row) => row.colpId));
  const privateIds = new Set((await store.getScope(scope))?.privateRoots ?? []);
  const byId = new Map(mappings.map(row => [row.colpId, row]));
  const byNative = new Map(mappings.map(row => [row.nativeId, row]));
  const isPrivate = (mapping: MappingInput) => {
    const seen = new Set<string>(); let row: MappingInput | undefined = mapping;
    while (row && !seen.has(row.colpId)) {
      if (privateIds.has(row.colpId)) return true;
      seen.add(row.colpId); row = row.parentColpId ? byId.get(row.parentColpId) : row.parentNativeId ? byNative.get(row.parentNativeId) : undefined;
    }
    return false;
  };
  let excluded = 0; let waiting = 0;
  for (const mapping of mappings) {
    if (isNonChromeNativeId(mapping.nativeId) || !tombstones.has(mapping.colpId) || isPrivate(mapping)) continue;
    if (await store.getLocalSyncExclusion(scope, mapping.nativeId)) {
      // Complete a keep-local transition interrupted by an older writer after
      // it persisted the exclusion but before releasing the live identity.
      if (await store.commitTombstoneMappingRepair(scope, mapping)) excluded++;
      continue;
    }
    if (!api) {
      waiting += 1;
      continue;
    }
    const looked = await lookupBookmark((id) => api.get(id), mapping.nativeId);
    if (looked.class === 'not_found') {
      await dropGoneMapping(store, scope, mapping);
      excluded += 1;
      continue;
    }
    if (looked.class !== 'present') {
      waiting += 1;
      continue;
    }
    if (await provenKeepLocal(api, store, scope, mapping)) {
      await persistKeepLocal(store, scope, mapping);
      excluded += 1;
    } else {
      waiting += 1;
    }
  }
  const deferred = await sweepQueuedTombstonedCreates(store, scope, mappings, tombstones);
  return { excluded, waiting, deferred };
}

/**
 * S6/SR-07 sweep for queue rows that were already in flight when their parent
 * was tombstoned: new captures are held by the exclusion, but a row enqueued
 * before the remote delete still carries the dead `parentId`.
 *
 * This pass is fence-free — it holds no lease, so it must not rewrite a row
 * that another worker may be claiming, uploading or binding bytes to (there is
 * no lease-independent "rewrite a pending row" store API, and inventing one
 * would hand every repair pass an unfenced write into the drain's critical
 * section). It therefore only names the stranded rows durably and leaves the
 * actual re-anchor to the fenced drain (`rebasePlacement`), which runs before
 * the first byte is bound and settles the row when no legal anchor exists.
 * Rows are never deleted here — the sequence lane keeps its shape.
 */
async function sweepQueuedTombstonedCreates(store: Store, scope: SyncScope,
  mappings: readonly MappingInput[], tombstones: ReadonlySet<string>): Promise<number> {
  const listQueue = store.listQueue?.bind(store);
  if (!listQueue) return 0;
  const byColp = new Map(mappings.map((mapping) => [mapping.colpId, mapping]));
  const rows: QueueOperation[] = [];
  for (const status of REBASABLE_QUEUE_STATUSES) {
    rows.push(...await listQueue(scope, status, 0, QUEUE_SCAN_LIMIT));
  }
  const stranded: Array<{ readonly opId: string; readonly sequence: number; readonly parentId: string }> = [];
  for (const row of rows) {
    // A bound attempt holds the exact bytes already sent for this row; only the
    // drain may replace them, and only through its own fenced rebase.
    if (row.attempt !== undefined || row.payload.type !== 'create_node') continue;
    const nested = row.payload.payload;
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) continue;
    const parentId = (nested as JsonObject).parentId;
    if (typeof parentId !== 'string') continue;
    if (!await queuedParentIsTombstoned(store, scope, byColp, tombstones, parentId)) continue;
    stranded.push({ opId: row.opId, sequence: row.sequence, parentId });
  }
  if (stranded.length === 0) return 0;
  await store.putScopeDiagnostic?.(scope, { kind: 'tombstoned_parent_rebase',
    code: 'tombstoned_parent_deferred', details: { count: stranded.length,
      rows: stranded.map((row) => ({ ...row })) } });
  return stranded.length;
}

/** The same three tombstone facts the push worker's `parentIsTombstoned` reads, from this pass's snapshot. */
async function queuedParentIsTombstoned(store: Store, scope: SyncScope,
  byColp: ReadonlyMap<string, MappingInput>, tombstones: ReadonlySet<string>, parentId: string): Promise<boolean> {
  if (tombstones.has(parentId)) return true;
  const mapping = byColp.get(parentId);
  if (!mapping) return false;
  // Only `unmounted:` proves the remote node is gone; `recovery:`/`pending-`/
  // `sidecar:` mappings are virtual for other reasons and stay valid parents.
  if (isTombstonedMappingNativeId(mapping.nativeId)) return true;
  return await store.getLocalSyncExclusion(scope, mapping.nativeId) !== null;
}

async function provenKeepLocal(api: PullBookmarkApi, store: Store, scope: SyncScope,
  mapping: MappingInput): Promise<boolean> {
  const children = await lookupBookmarkChildren((id) => api.getChildren(id), mapping.nativeId);
  if (children.class !== 'present') return false;
  for (const child of children.nodes) {
    if (await store.getLocalSyncExclusion(scope, child.id)) return true;
    const childMapping = await store.getMappingByNativeId(scope, child.id);
    if (!childMapping) return true;
  }
  return children.nodes.length > 0 && mapping.nodeKind === 'folder';
}

async function persistKeepLocal(store: Store, scope: SyncScope, mapping: MappingInput): Promise<void> {
  const decisionId = remoteDeleteDecisionId(`repair:${mapping.colpId}`);
  await store.commitTombstoneMappingRepair(scope, { nativeId: mapping.nativeId, colpId: mapping.colpId, exclusion: {
    nativeId: mapping.nativeId, decisionId, rootNativeId: mapping.rootNativeId,
    generation: scope.generation, sourceKind: 'remote_delete', priorColpId: mapping.colpId,
  } });
}

async function dropGoneMapping(store: Store, scope: SyncScope, mapping: MappingInput): Promise<void> {
  await store.commitTombstoneMappingRepair(scope, mapping);
}
