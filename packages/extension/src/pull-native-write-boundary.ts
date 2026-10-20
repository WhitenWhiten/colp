import { lookupBookmark, lookupBookmarkChildren, type BookmarkNode } from './bookmark-api-error.js';
import { NativeWriteNotStartedError, type NativeWriteCheck } from './native-call-result.js';
import { currentPullMapping } from './pull-mapping-view.js';
import { virtualNativeId } from './projection-native-occupancy.js';
import { SyncFailureError } from './sync-failure-class.js';
import type { PullApplierOptions, PullBookmarkApi } from './pull-applier-types.js';
import type { JsonObject, MappingInput, SyncScope, createSyncStateStore } from './sync-state-store.js';
import type { LocalSyncExclusionRecord } from './sync-state/remote-delete-repository.js';

export type NativeWriteBoundaryStore = Pick<ReturnType<typeof createSyncStateStore>,
  'getScope' | 'listMountBindings' | 'getMappingByColpId' | 'getMappingByNativeId'
  | 'getLocalSyncExclusion' | 'listPullEvents'>
  & Partial<Pick<ReturnType<typeof createSyncStateStore>, 'getApplyIntent'>>;

export type NativeCreateParentProof = { readonly kind: 'bound_root' } | {
  readonly kind: 'create_receipt'; readonly eventId: string; readonly intentId: string; readonly commandId: string;
};

interface Input {
  readonly store: NativeWriteBoundaryStore; readonly scope: SyncScope; readonly api: PullBookmarkApi;
  readonly mapping: MappingInput;
  /** The native value the caller used to decide its write, before adapter admission. */
  readonly preimage: BookmarkNode;
  readonly parent?: true;
  readonly children?: readonly BookmarkNode[];
  /** A new materialized parent is not published until its whole Pull event commits. */
  readonly parentProof?: NativeCreateParentProof;
  readonly expectedBoundaryVersion?: string;
  /** Only the delete owner may prove that an existing Snapshot hold is now
   * covered by the user's exact, still-current explicit delete decision. */
  readonly canDeleteExcluded?: (exclusion: LocalSyncExclusionRecord) => Promise<boolean>;
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
      const exclusion = await input.store.getLocalSyncExclusion(input.scope, nativeId);
      if (exclusion && !await input.canDeleteExcluded?.(exclusion)) denied();
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

/** The event's entry state, not its per-member native result, distinguishes a
 * new admission refusal from an older invocation or a partial delete ledger. */
export async function recordUnstartedPullRefusal(options: Pick<PullApplierOptions, 'store' | 'scope'>,
  entered: { readonly eventId?: unknown; readonly state?: unknown }, kind: string, error: unknown): Promise<void> {
  if (!(error instanceof NativeWriteNotStartedError)
      || !['node_content_updated', 'node_moved', 'node_deleted', 'subtree_deleted'].includes(kind)
      || !['staged', 'intent_prepared'].includes(String(entered.state))) return;
  const intent = await options.store.getApplyIntent(options.scope, `intent:${String(entered.eventId)}`);
  if (!intent || intent.apiResultEvidence || intent.nativeEventEvidence) return;
  if (kind === 'node_moved' && intent.anchors?.rangeAction !== 'native_move') return;
  if ((kind === 'node_deleted' || kind === 'subtree_deleted') && !allDeletesUnstarted(intent.anchors)) return;
  await options.store.persistApplyIntentFacts(options.scope, intent.intentId, {
    nativeResult: 'not_started', replayState: 'not_started', state: 'intent_prepared', eventState: 'intent_prepared', apiPhase: 'intent_prepared',
  });
}

function allDeletesUnstarted(anchors: JsonObject | undefined): boolean {
  const members = anchors?.deleteMemberSet, results = anchors?.deleteMemberResults;
  if (!Array.isArray(members) || !members.length || !results || typeof results !== 'object'
      || Array.isArray(results)) return false;
  const colpIds = new Set<string>(), nativeIds = new Set<string>();
  for (const member of members) {
    if (!member || typeof member !== 'object' || Array.isArray(member)
        || typeof member.colpId !== 'string' || typeof member.nativeId !== 'string'
        || colpIds.has(member.colpId) || nativeIds.has(member.nativeId)
        || results[member.colpId] !== 'not_started') return false;
    colpIds.add(member.colpId); nativeIds.add(member.nativeId);
  }
  return true;
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
  if (occupied && occupied.colpId !== mapping.colpId) denied();
  const candidates = mounts.filter(mount => mapping.mountId ? mount.mountId === mapping.mountId
    : mount.nativeRootId === mapping.rootNativeId);
  const mount = candidates[0];
  if (mounts.length && (candidates.length !== 1 || mount?.status !== 'active' || !mount.remoteMountNodeId)) denied();
  if (input.expectedBoundaryVersion !== undefined && mount?.boundaryVersion !== input.expectedBoundaryVersion) denied();
  const rootNativeId = mount?.nativeRootId ?? mapping.rootNativeId;
  if (!rootNativeId || virtualNativeId(rootNativeId) || !input.parent && mapping.nativeId === rootNativeId) denied();
  let proofIdentity: string | undefined;
  if (input.parentProof) {
    if (!input.parent) denied();
    if (input.parentProof.kind === 'bound_root') {
      if (!mount || mount.remoteMountNodeId !== mapping.colpId || mapping.nativeId !== rootNativeId
          || !current?.nativeId.startsWith('recovery:')
          || mappingIdentity({ ...current, nativeId: rootNativeId, rootNativeId }) !== mappingIdentity(mapping)) denied();
    } else {
      const proof = input.parentProof, receipt = await store.getApplyIntent?.(scope, proof.intentId);
      const rootReceipt = proof.intentId === `intent:${proof.eventId}`;
      if (!receipt || proof.intentId !== (rootReceipt ? `intent:${proof.eventId}` : `intent:${proof.eventId}:range:${mapping.colpId}`)
          || receipt.generation !== scope.generation || receipt.colpId !== mapping.colpId
          || receipt.commandId !== proof.commandId || receipt.liveWorkKind !== 'create'
          || receipt.substep !== (rootReceipt ? 'create' : 'range-materialize')
          || receipt.nativeParentId !== mapping.parentNativeId || receipt.nativeResult !== 'applied_with_evidence'
          || receipt.apiResultEvidence?.nativeId !== mapping.nativeId
          || receipt.nativeResultConfirmation?.kind !== 'api_return'
          || receipt.nativeResultConfirmation.nativeId !== mapping.nativeId) denied();
      proofIdentity = JSON.stringify([receipt.intentId, receipt.generation, receipt.commandId, receipt.colpId,
        receipt.nativeParentId, receipt.nativeResult, receipt.apiResultEvidence, receipt.nativeResultConfirmation]);
    }
  } else if (!current || mappingIdentity(current) !== mappingIdentity(mapping)) changed();
  if (mount) {
    const root = await currentPullMapping(store, scope, mount.remoteMountNodeId!);
    if (!root || root.nativeId !== rootNativeId
        && !(input.parentProof?.kind === 'bound_root' && root.colpId === mapping.colpId)) denied();
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
    current && mappingIdentity(current), durable && mappingIdentity(durable), occupied && mappingIdentity(occupied), proofIdentity,
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
