import { requestValue } from './idb.js';
import { INDEXES } from './schema.js';
import { virtualPlaceholderNativeId } from './mapping-repository.js';
import type { UnknownRecord } from './types.js';

type PullMappingWrite = { readonly kind: 'delete'; readonly nativeId: string }
  | { readonly kind: 'put'; readonly mapping: UnknownRecord };

export async function planPullMappingWrites(mappings: IDBObjectStore, key: string,
  pageEvents: readonly UnknownRecord[], preservedMappings: ReadonlySet<string>, mounts: IDBObjectStore): Promise<
    { readonly blocked: true; readonly writes: readonly never[] }
    | { readonly blocked: false; readonly writes: readonly PullMappingWrite[];
      readonly rootRebindings: ReadonlyMap<string, string> }
  > {
  // Cache absence as well as ownership. A delete masks the durable pre-page
  // owner until a later event explicitly restores/rebinds it.
  const byColp = new Map<string, string | undefined>(); const byNative = new Map<string, string | undefined>();
  const writes: PullMappingWrite[] = [];
  const rootRebindings = new Map<string, string>();
  const ownerNative = async (colpId: string) => {
    if (byColp.has(colpId)) return byColp.get(colpId);
    const row = await requestValue(mappings.index(INDEXES.mappingByColpId).get([key, colpId])) as
      { readonly nativeId: string } | undefined;
    return row?.nativeId;
  };
  const nativeColp = async (nativeId: string) => {
    if (byNative.has(nativeId)) return byNative.get(nativeId);
    const row = await requestValue(mappings.get([key, nativeId])) as { readonly colpId: string } | undefined;
    return row?.colpId;
  };
  const remove = async (nativeId: string) => {
    const colpId = await nativeColp(nativeId);
    if (colpId && await ownerNative(colpId) === nativeId) byColp.set(colpId, undefined);
    byNative.set(nativeId, undefined); writes.push({ kind: 'delete', nativeId });
  };
  for (const event of pageEvents) {
    for (const nativeId of (event.pendingDeleteNativeIds as string[] | undefined) ?? []) {
      await remove(nativeId);
    }
    const exit = event.pendingRangeExit as { readonly unbindNativeIds?: string[] } | undefined;
    for (const nativeId of exit?.unbindNativeIds ?? []) await remove(nativeId);
    for (const mapping of (event.pendingMappings as UnknownRecord[] | undefined) ?? []) {
      if (preservedMappings.has(String(mapping.nativeId))) continue;
      const nativeId = String(mapping.nativeId); const colpId = String(mapping.colpId);
      const owner = await ownerNative(colpId); const existingColp = await nativeColp(nativeId);
      if (existingColp && existingColp !== colpId && !virtualPlaceholderNativeId(nativeId)
          && !existingColp.startsWith('pending-')) {
        if (!await isConfirmedLocalRoot(mappings, mounts, key, mapping, existingColp)) return { blocked: true, writes: [] };
        rootRebindings.set(existingColp, colpId);
      }
      if (!owner || owner === nativeId) {
        if (existingColp && existingColp !== colpId) byColp.set(existingColp, undefined);
        writes.push({ kind: 'put', mapping }); byColp.set(colpId, nativeId); byNative.set(nativeId, colpId); continue;
      }
      if (virtualPlaceholderNativeId(owner) && !virtualPlaceholderNativeId(nativeId)) {
        await remove(owner); writes.push({ kind: 'put', mapping });
        byColp.set(colpId, nativeId); byNative.set(nativeId, colpId); continue;
      }
      if (virtualPlaceholderNativeId(nativeId) && !virtualPlaceholderNativeId(owner)) continue;
      if (virtualPlaceholderNativeId(owner) && virtualPlaceholderNativeId(nativeId)) {
        await remove(owner); writes.push({ kind: 'put', mapping });
        byColp.set(colpId, nativeId); byNative.set(nativeId, colpId); continue;
      }
      return { blocked: true, writes: [] };
    }
  }
  return { blocked: false, writes, rootRebindings };
}

/** configureBrowserRoots reserves a local UUID before the mount's create receipt. */
async function isConfirmedLocalRoot(mappings: IDBObjectStore, mounts: IDBObjectStore, key: string,
  incoming: UnknownRecord, existingColpId: string): Promise<boolean> {
  if (incoming.nodeKind !== 'folder' || typeof incoming.mountId !== 'string') return false;
  const local = await requestValue(mappings.get([key, String(incoming.nativeId)])) as {
    readonly colpId?: string; readonly rootNativeId?: string;
    readonly projection?: { readonly revision?: string; readonly digest?: string };
  } | undefined;
  if (local?.colpId !== existingColpId || local.rootNativeId !== incoming.nativeId
      || local.projection?.revision !== 'local-root' || local.projection.digest !== 'sha256:local-root') return false;
  const mount = await requestValue(mounts.get([key, incoming.mountId])) as {
    readonly nativeRootId?: string; readonly remoteMountNodeId?: string; readonly status?: string;
  } | undefined;
  return mount?.status === 'active' && mount.nativeRootId === incoming.nativeId
    && mount.remoteMountNodeId === incoming.colpId;
}
