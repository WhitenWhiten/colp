import { requestValue } from './idb.js';
import { INDEXES } from './schema.js';
import { virtualPlaceholderNativeId } from './mapping-repository.js';
import type { UnknownRecord } from './types.js';

type PullMappingWrite = { readonly kind: 'delete'; readonly nativeId: string }
  | { readonly kind: 'put'; readonly mapping: UnknownRecord };

export async function planPullMappingWrites(mappings: IDBObjectStore, key: string,
  pageEvents: readonly UnknownRecord[], preservedMappings: ReadonlySet<string>): Promise<
    { readonly blocked: true; readonly writes: readonly never[] }
    | { readonly blocked: false; readonly writes: readonly PullMappingWrite[] }
  > {
  // Cache absence as well as ownership. A delete masks the durable pre-page
  // owner until a later event explicitly restores/rebinds it.
  const byColp = new Map<string, string | undefined>(); const byNative = new Map<string, string | undefined>();
  const writes: PullMappingWrite[] = [];
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
          && !existingColp.startsWith('pending-')) return { blocked: true, writes: [] };
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
  return { blocked: false, writes };
}
