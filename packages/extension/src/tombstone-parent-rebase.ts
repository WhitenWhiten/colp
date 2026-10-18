/**
 * S6/SR-07: an already queued `create_node` whose wire parent is gone must be
 * re-anchored before its first upload. The server refuses a create under a
 * tombstoned parent with `invalid_document`/`resource_not_found` and both are
 * `retryable:false` (`packages/node/src/shared/problems.ts`), so the row would be
 * uploaded and refused as a single-operation failure instead of being placed.
 *
 * The anchor semantics are the ones the pull recovery path already uses
 * (`planCreated`/`resolveMount`/`mayMutateNative` in `pull-mount-apply.ts` and
 * `scope-transition.ts`): the recovered folder the remote-delete recovery
 * materializes for kept-local survivors first, then the node of a writable,
 * active mount. Every candidate is a real server-side node id, so a virtual,
 * unmounted, pending or recovery-placeholder parent can neither be chosen as an
 * anchor nor be mistaken for a tombstone.
 */
import { setAsideDeletedSaveParent } from './create-placement-rebase.js';
import { UNMOUNTED_PREFIX } from './pull-mount-apply.js';
import { isWritableActiveScope } from './scope-transition.js';
import type { PlacementRefreshOutcome } from './durable-sync-engine-types.js';
import type {
  JsonObject, MountBindingRecord, QueueOperation, SyncScope, createSyncStateStore,
} from './sync-state-store.js';

type Store = Pick<ReturnType<typeof createSyncStateStore>,
  'getRemoteObservation' | 'getMappingByColpId' | 'getLocalSyncExclusion' | 'listMountBindings' | 'listMappings'
  | 'settleClaimedPush' | 'putScopeDiagnostic' | 'rebaseClaimedPush' | 'listBookmarkEvents'
  | 'getMappingByNativeId' | 'getScope' | 'registerScope' | 'getEngineState' | 'transitionEngine' | 'setAsideClaimedPush'>;

export interface TombstonedCreateRebaseInput {
  readonly store: Store; readonly scope: SyncScope; readonly queue: QueueOperation;
  readonly ownerId: string; readonly fence: number;
  /** Pull/mapping refresh before a retried row is re-anchored; lost-response retries keep `attempt`. */
  readonly refreshPlacement?: (() => Promise<PlacementRefreshOutcome | void>) | undefined;
  readonly digestJson: (value: unknown) => string;
}

/**
 * `create_node` carries no comparable base revision on the wire: the COLP
 * operation schema requires `baseRevision: null` for every create operation
 * (`packages/node/src/schema/generated/collection-protocol.schema.json`, `$defs.operation`
 * allOf variant 1 — the `syncPush` route validates against it at
 * `packages/server/src/transport/colp-sync/sync-push-routes.ts`), and the server's
 * create evaluator reads only `parentId`/`afterId`/`beforeId`. The rebase therefore
 * rewrites the placement (and drops anchors that do not belong to the new parent)
 * and leaves both base-revision fields untouched; a non-null value would fail
 * request validation before the create is ever evaluated.
 *
 * Returns the row to upload — rewritten or byte-identical — or `'terminal'` when
 * the row was settled as rejected because no legal anchor exists.
 */
export async function rebaseTombstonedCreate(input: TombstonedCreateRebaseInput):
Promise<QueueOperation | 'terminal' | 'recovery'> {
  const { store, scope, queue, ownerId, fence } = input;
  const nested = queue.payload.payload;
  if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return queue;
  const inner = nested as JsonObject;
  const parentId = inner.parentId;
  if (typeof parentId !== 'string') return queue;
  // A retried row may hold placement facts older than the tombstone: refresh
  // the local mirror first, exactly like the retried move path does.
  if (queue.retry.attempt > 0 && await input.refreshPlacement?.() === 'recovery') return 'recovery';
  if (!await parentIsTombstoned(store, scope, parentId)) return queue;
  if (await setAsideDeletedSaveParent({ store, scope, queue, ownerId, fence })) return 'terminal';
  const anchor = await createRebaseAnchor(store, scope, parentId);
  if (!anchor) {
    await store.settleClaimedPush(scope, queue.sequence, ownerId, fence,
      { outcome: 'rejected', recovery: { code: 'tombstoned_parent_no_anchor' } });
    await store.putScopeDiagnostic(scope, { kind: 'tombstoned_parent_rebase',
      code: 'tombstoned_parent_no_anchor', details: { opId: queue.opId, parentId } });
    return 'terminal';
  }
  // Anchors authored under the dead parent are not valid in the new one; the
  // same helper the move rebase uses keeps only anchors that live there.
  const nextInner: JsonObject = { ...(await retainValidPlacementAnchors(store, scope, inner, anchor)), parentId: anchor };
  const payload = { ...queue.payload, payload: nextInner };
  return store.rebaseClaimedPush(scope, queue.sequence, ownerId, fence, {
    payload, digest: `sha256:${input.digestJson(payload)}`,
    idempotencyKey: `${queue.opId}.rebase.${queue.retry.attempt}`, baseRevision: queue.baseRevision,
  });
}

/** Keep only sibling anchors that still belong to the selected destination. */
export async function retainValidPlacementAnchors(
  store: Pick<Store, 'getMappingByColpId'>,
  scope: SyncScope,
  inner: JsonObject,
  destinationId: string | undefined,
): Promise<JsonObject> {
  const next: Record<string, unknown> = { ...inner };
  for (const key of ['afterId', 'beforeId'] as const) {
    const id = next[key];
    if (id === undefined) continue;
    if (typeof id !== 'string') { delete next[key]; continue; }
    const mapped = await store.getMappingByColpId(scope, id);
    if (!destinationId || mapped?.parentColpId !== destinationId) delete next[key];
  }
  return next as JsonObject;
}

/**
 * The three durable facts that make a parent unwritable for a new child: a
 * remote tombstone observation, a mapping moved to `unmounted:<colpId>` (the
 * remote node is gone while the local copy was kept), or a local sync exclusion
 * on that mapping's native id. They are the same facts
 * `tombstone-mapping-repair` reconciles, so no network call is needed.
 *
 * The native-id fact is deliberately *narrower* than `isNonChromeNativeId`:
 * that helper (via `virtualNativeId`) also classifies `recovery:` placeholders,
 * `sidecar:` mappings and `pending-` identities as virtual, and none of them
 * proves the remote parent is gone. Treating them as tombstones would re-anchor
 * or reject perfectly valid creates — e.g. a child of a mount bound during
 * bootstrap, whose mapping is still `recovery:mount-bar`.
 */
export async function parentIsTombstoned(store: Store, scope: SyncScope, colpId: string): Promise<boolean> {
  if ((await store.getRemoteObservation(scope, colpId))?.kind === 'tombstone') return true;
  const mapping = await store.getMappingByColpId(scope, colpId);
  if (!mapping) return false;
  if (isTombstonedMappingNativeId(mapping.nativeId)) return true;
  return await store.getLocalSyncExclusion(scope, mapping.nativeId) !== null;
}

/** `unmounted:<colpId>` is what the remote-delete path leaves for a kept-local copy. */
export function isTombstonedMappingNativeId(nativeId: string) {
  return nativeId.startsWith(UNMOUNTED_PREFIX);
}

/**
 * Legal re-anchor targets in recovery order. A recovered folder of the mount
 * that owns the kept-local parent wins, then any other recovered folder, then
 * the node of a writable active mount. `remoteMountNodeId` and a recovered
 * folder's `colpId` are real server nodes, so this can never return a
 * virtual/unmounted/recovery parent.
 */
export async function createRebaseAnchor(store: Store, scope: SyncScope, parentId: string): Promise<string | null> {
  const [mounts, mappings, parent] = await Promise.all([
    store.listMountBindings(scope), store.listMappings(scope), store.getMappingByColpId(scope, parentId),
  ]);
  // Only a writable active mount can host a new child root: pending, detached and
  // identity-unknown mounts follow `mayMutateNative`/`resolveMount` and are not
  // anchors. A pending mount that resolves during bootstrap becomes active
  // (`persistMountBinding`), so the row behind it is drained, never rewritten.
  const activeMounts = mounts.filter(isWritableMount);
  const recovered = mappings.filter((row) => row.projection.content?.folderRole === 'recovered'
    && isResolvedNativeId(row.nativeId) && !isProvisionalColpId(row.colpId)
    && activeMounts.some((mount) => mount.nativeRootId === row.rootNativeId));
  const sameMount = parent?.rootNativeId === undefined ? []
    : recovered.filter((row) => row.rootNativeId === parent.rootNativeId);
  const ordered = [...sameMount, ...recovered.filter((row) => !sameMount.includes(row))]
    .map((row) => row.colpId)
    .concat(activeMounts.flatMap((mount) => (mount.remoteMountNodeId === null ? [] : [mount.remoteMountNodeId])));
  for (const candidate of ordered) {
    if (candidate.length === 0) continue;
    if (!await parentIsTombstoned(store, scope, candidate)) return candidate;
  }
  return null;
}

function isWritableMount(mount: MountBindingRecord) {
  return mount.remoteMountNodeId !== null && mount.remoteMountNodeId.length > 0
    && isWritableActiveScope({ status: mount.status, identityKnown: true,
      rejoinInFlight: mount.status === 'pending' });
}

/** A mapping native id that can back a real server-side anchor node. */
function isResolvedNativeId(nativeId: string) {
  return !nativeId.startsWith('sidecar:') && !isTombstonedMappingNativeId(nativeId)
    && !nativeId.startsWith('pending-') && !nativeId.startsWith('recovery:');
}
function isProvisionalColpId(colpId: string) {
  return colpId.startsWith('pending-') || colpId.startsWith('local-') || colpId.startsWith('inbox-');
}
