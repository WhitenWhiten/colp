import { lookupBookmark, lookupBookmarkChildren, type BookmarkNode } from './bookmark-api-error.js';
import { NativeWriteNotStartedError, type NativeWriteCheck } from './native-call-result.js';
import { currentPullMapping } from './pull-mapping-view.js';
import { virtualNativeId } from './projection-native-occupancy.js';
import { SyncFailureError } from './sync-failure-class.js';
import type { PullApplierOptions, PullBookmarkApi } from './pull-applier-types.js';
import type { JsonObject, MappingInput, SyncScope, createSyncStateStore } from './sync-state-store.js';

export type NativeWriteBoundaryStore = Pick<ReturnType<typeof createSyncStateStore>,
  'getScope' | 'listMountBindings' | 'getMappingByColpId' | 'getMappingByNativeId'
  | 'getLocalSyncExclusion' | 'listPullEvents'>;

interface Input {
  readonly store: NativeWriteBoundaryStore; readonly scope: SyncScope; readonly api: PullBookmarkApi;
  readonly mapping: MappingInput;
  /** The native value the caller used to decide its write, before adapter admission. */
  readonly preimage: BookmarkNode;
  readonly parent?: true;
  readonly children?: readonly BookmarkNode[];
}

/** Carry the original decision through subscription/policy admission. The
 * callback never adopts a new native value as the preimage for an old write. */
export async function prepareNativeWriteCheck(input: Input): Promise<NativeWriteCheck> {
  const expectedNative = nativeIdentity(input.preimage);
  const expectedChildren = input.children && childIdentity(input.children);
  let before: Awaited<ReturnType<typeof boundary>>;
  try { before = await boundary(input); }
  catch (error) { throw new NativeWriteNotStartedError(error); }
  return async () => {
    const current = await boundary(input);
    if (current.identity !== before.identity) changed();
    const seen = new Set<string>(); let nativeId: string | undefined = input.mapping.nativeId;
    let reachedRoot = false;
    while (nativeId !== undefined) {
      if (seen.has(nativeId) || seen.size >= 256 || current.privateNativeIds.has(nativeId)) denied();
      seen.add(nativeId);
      if (await input.store.getLocalSyncExclusion(input.scope, nativeId)) denied();
      const node = await readNative(input.api, nativeId);
      if (node.unmodifiable || input.parent && nativeId === input.mapping.nativeId && node.url !== undefined) denied();
      if (nativeId === current.rootNativeId) reachedRoot = true;
      nativeId = node.parentId;
    }
    if (!reachedRoot) denied();
    // A mount/private/mapping change during native ancestry reads invalidates
    // this decision too. Missing private identity never means public ancestry.
    if ((await boundary(input)).identity !== before.identity) changed();
    if (expectedChildren !== undefined) {
      const children = await lookupBookmarkChildren(id => input.api.getChildren(id), input.mapping.nativeId);
      if (children.class === 'not_found') changed();
      if (children.class !== 'present') throw new Error(children.message);
      if (childIdentity(children.nodes) !== expectedChildren) changed();
    }
    if (nativeIdentity(await readNative(input.api, input.mapping.nativeId)) !== expectedNative) changed();
  };
}

/** Raw Chrome accepts callbacks in optional argument positions. Pass this
 * check only to an adapter that explicitly promises final-check support. */
export async function performCheckedNativeWrite<T>(api: PullBookmarkApi, check: NativeWriteCheck,
  write: (beforeNative?: NativeWriteCheck) => Promise<T>): Promise<T> {
  try { await check(); }
  catch (error) { throw new NativeWriteNotStartedError(error); }
  return write(api.nativeWriteChecks ? check : undefined);
}

/** Never erase an earlier native invocation or a partial delete ledger. Only
 * a new single update/move refused by the adapter is proven not to have started. */
export async function recordUnstartedPullRefusal(options: Pick<PullApplierOptions, 'store' | 'scope'>,
  entered: { readonly eventId?: unknown; readonly state?: unknown }, kind: string, error: unknown): Promise<void> {
  if (!(error instanceof NativeWriteNotStartedError) || !['node_content_updated', 'node_moved'].includes(kind)
      || !['staged', 'intent_prepared'].includes(String(entered.state))) return;
  const intent = await options.store.getApplyIntent(options.scope, `intent:${String(entered.eventId)}`);
  if (!intent || intent.apiResultEvidence || intent.nativeEventEvidence) return;
  if (kind === 'node_moved' && intent.anchors?.rangeAction !== 'native_move') return;
  await options.store.persistApplyIntentFacts(options.scope, intent.intentId, {
    nativeResult: 'not_started', replayState: 'not_started', state: 'intent_prepared', eventState: 'intent_prepared',
  });
}

export function nativeWritePreimage(node: BookmarkNode): JsonObject {
  return Object.fromEntries(['id', 'parentId', 'index', 'title', 'url', 'unmodifiable']
    .flatMap(key => node[key as keyof BookmarkNode] === undefined ? [] : [[key, node[key as keyof BookmarkNode]]])) as JsonObject;
}

export function storedNativeWritePreimage(value: unknown): BookmarkNode | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('id' in value)
      || typeof value.id !== 'string') return undefined;
  return value as BookmarkNode;
}

async function boundary(input: Input) {
  const { store, scope, mapping } = input;
  const [record, mounts, current, durable, occupied] = await Promise.all([
    store.getScope(scope), store.listMountBindings(scope), currentPullMapping(store, scope, mapping.colpId),
    store.getMappingByColpId(scope, mapping.colpId), store.getMappingByNativeId(scope, mapping.nativeId),
  ]);
  if (record?.lifecycle !== 'active' || record.rootStatus !== undefined
      && !['ready', 'nested_normalized'].includes(record.rootStatus) || virtualNativeId(mapping.nativeId)) denied();
  if (!current || mappingIdentity(current) !== mappingIdentity(mapping)) changed();
  if (occupied && occupied.colpId !== mapping.colpId) denied();
  const candidates = mounts.filter(mount => mapping.mountId ? mount.mountId === mapping.mountId
    : mount.nativeRootId === mapping.rootNativeId);
  const mount = candidates[0];
  if (mounts.length && (candidates.length !== 1 || mount?.status !== 'active' || !mount.remoteMountNodeId)) denied();
  const rootNativeId = mount?.nativeRootId ?? mapping.rootNativeId;
  if (!rootNativeId || virtualNativeId(rootNativeId) || !input.parent && mapping.nativeId === rootNativeId) denied();
  if (mount) {
    const root = await currentPullMapping(store, scope, mount.remoteMountNodeId!);
    if (!root || root.nativeId !== rootNativeId) denied();
  }
  const privateRoots = record.privateRoots ?? [];
  const privateMappings = await Promise.all(privateRoots.map(id => store.getMappingByColpId(scope, id)));
  if (privateMappings.some(row => !row || virtualNativeId(row.nativeId))) denied();
  const privateNativeIds = new Set(privateMappings.map(row => row!.nativeId));
  if (privateNativeIds.size !== privateRoots.length || privateRoots.includes(mapping.colpId)) denied();
  return { rootNativeId, privateNativeIds, identity: JSON.stringify([
    record.lifecycle, record.rootStatus, record.boundaryVersion, record.selectedRoots, privateRoots,
    privateMappings.map(row => [row!.colpId, row!.nativeId]), rootNativeId,
    mount ? [mount.mountId, mount.status, mount.remoteMountNodeId, mount.boundaryVersion] : null,
    mappingIdentity(current), durable && mappingIdentity(durable), occupied && mappingIdentity(occupied),
  ]) };
}

function mappingIdentity(row: MappingInput) {
  return JSON.stringify([row.colpId, row.nativeId, row.rootNativeId, row.mountId, row.parentNativeId, row.nodeKind,
    row.projection.revision, row.projection.digest, row.projection.childrenRevision, row.projection.contentDigest]);
}
function nativeIdentity(row: BookmarkNode) {
  return JSON.stringify([row.id, row.parentId, row.index, row.title, row.url, row.unmodifiable]);
}
function childIdentity(rows: readonly BookmarkNode[]) { return JSON.stringify(rows.map(row => [row.id, row.index])); }
async function readNative(api: Pick<PullBookmarkApi, 'get'>, id: string): Promise<BookmarkNode> {
  const looked = await lookupBookmark(key => api.get(key), id);
  if (looked.class === 'not_found') changed();
  if (looked.class !== 'present') throw new Error(looked.message);
  const node = looked.nodes[0];
  if (looked.nodes.length !== 1 || !node || node.id !== id) denied();
  return node;
}
function changed(): never { throw new SyncFailureError('concurrent_local_mutation'); }
function denied(): never { throw new SyncFailureError('need_authority'); }
