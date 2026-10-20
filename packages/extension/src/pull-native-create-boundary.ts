import { lookupBookmark, lookupBookmarkChildren, type BookmarkNode } from './bookmark-api-error.js';
import { NativeWriteNotStartedError } from './native-call-result.js';
import { currentPullMapping } from './pull-mapping-view.js';
import { performCheckedNativeWrite, prepareNativeWriteCheck, type NativeCreateParentProof,
  type NativeWriteBoundaryStore } from './pull-native-write-boundary.js';
import { SyncFailureError } from './sync-failure-class.js';
import type { PullBookmarkApi } from './pull-applier-types.js';
import type { MappingInput, SyncScope } from './sync-state-store.js';

interface Input {
  readonly store: NativeWriteBoundaryStore; readonly scope: SyncScope; readonly api: PullBookmarkApi;
  readonly parentColpId: string; readonly parent?: MappingInput;
  readonly details: Parameters<PullBookmarkApi['create']>[0];
  readonly placement?: { readonly afterId: string | null; readonly beforeId: string | null };
  readonly parentProof?: NativeCreateParentProof;
  readonly expectedBoundaryVersion?: string;
}

/** The create executor calls this only for a proven not-started attempt. Its
 * receipt/unknown classification remains ahead of every new native write. */
export async function createCheckedPullNative(input: Input) {
  let prepared: Awaited<ReturnType<typeof prepare>>;
  try { prepared = await prepare(input); }
  catch (error) { throw error instanceof NativeWriteNotStartedError ? error : new NativeWriteNotStartedError(error); }
  return performCheckedNativeWrite(input.api, prepared.check, beforeNative => input.api.create(prepared.details, beforeNative));
}

async function prepare(input: Input) {
  const current = await currentPullMapping(input.store, input.scope, input.parentColpId);
  const parent = input.parent ?? current;
  if (!parent || parent.colpId !== input.parentColpId) throw new SyncFailureError('need_authority');
  const parentId = input.details.parentId;
  if (!parentId) throw new SyncFailureError('need_authority');
  const bound = parent.nativeId !== parentId;
  const mapping = bound ? { ...parent, nativeId: parentId, rootNativeId: parentId } : parent;
  const preimage = await read(input.api, parentId);
  const children = await lookupBookmarkChildren(id => input.api.getChildren(id), parentId);
  if (children.class === 'not_found') throw new SyncFailureError('concurrent_local_mutation');
  if (children.class !== 'present') throw new Error(children.message);
  const anchors = await Promise.all([input.placement?.afterId, input.placement?.beforeId]
    .filter((id): id is string => typeof id === 'string').map(async colpId => {
      const mapping = await currentPullMapping(input.store, input.scope, colpId);
      if (!mapping) throw new SyncFailureError('anchor_mapping_missing');
      const native = await read(input.api, mapping.nativeId);
      if (native.parentId !== parentId || native.index === undefined
          || !children.nodes.some(row => row.id === native.id && row.index === native.index)) {
        throw new SyncFailureError('concurrent_local_mutation');
      }
      return { mapping, native };
    }));
  const anchor = anchors[0];
  const index = input.placement ? anchor ? anchor.native.index! + (input.placement.afterId ? 1 : 0) : 0 : input.details.index;
  if (input.details.index !== undefined && input.details.index !== index) throw new SyncFailureError('concurrent_local_mutation');
  const boundary = await prepareNativeWriteCheck({ ...input, mapping, preimage, children: children.nodes, parent: true,
    parentProof: input.parentProof ?? (bound || current?.nativeId.startsWith('recovery:') && current.nativeId !== parentId
      ? { kind: 'bound_root' } : undefined) });
  return { details: { ...input.details, ...(index === undefined ? {} : { index }) }, check: async () => {
    for (const anchor of anchors) {
      const current = await currentPullMapping(input.store, input.scope, anchor.mapping.colpId);
      if (!current || anchorIdentity(current) !== anchorIdentity(anchor.mapping)
          || nativeIdentity(await read(input.api, current.nativeId)) !== nativeIdentity(anchor.native)) {
        throw new SyncFailureError('concurrent_local_mutation');
      }
    }
    await boundary();
  } };
}

function anchorIdentity(row: MappingInput) {
  return JSON.stringify([row.colpId, row.nativeId, row.parentNativeId, row.rootNativeId, row.mountId, row.projection.revision]);
}
function nativeIdentity(row: BookmarkNode) { return JSON.stringify([row.id, row.parentId, row.index, row.title, row.url]); }
async function read(api: PullBookmarkApi, id: string): Promise<BookmarkNode> {
  const looked = await lookupBookmark(key => api.get(key), id);
  if (looked.class === 'not_found') throw new SyncFailureError('concurrent_local_mutation');
  if (looked.class !== 'present') throw new Error(looked.message);
  if (looked.nodes.length !== 1 || looked.nodes[0]?.id !== id) throw new SyncFailureError('need_authority');
  return looked.nodes[0];
}
