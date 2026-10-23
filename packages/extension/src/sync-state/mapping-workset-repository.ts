import { boundedString } from './codec.js';
import { requestValue, transactionDone } from './idb.js';
import { INDEXES, STORES } from './schema.js';
import { scopeKey, validateScope } from './scope-key.js';
import type { SyncStoreRuntime } from './runtime.js';
import type { MappingInput, SyncScope } from './types.js';

export function createMappingWorksetRepository(ctx: SyncStoreRuntime,
  validate: (key: string, value: unknown, maxBytes: number) => MappingInput) {
  async function hasMappingSibling(input: SyncScope, parentNativeId: string, nativeId: string): Promise<boolean> {
    const key = scopeKey(validateScope(input)); boundedString(parentNativeId, 'parentNativeId'); boundedString(nativeId, 'nativeId');
    const db = await ctx.open(); const tx = db.transaction(STORES.mappings, 'readonly'); const completion = transactionDone(tx);
    const values = await requestValue<MappingInput[]>(tx.objectStore(STORES.mappings).index(INDEXES.mappingByNativeParent)
      .getAll(IDBKeyRange.bound([key, parentNativeId], [key, parentNativeId, []]), 2));
    await completion; return values.some(value => value.nativeId !== nativeId);
  }

  /** Both identities matter while a local move has an optimistic native parent. */
  async function listMappingSubtree(input: SyncScope, nativeId: string): Promise<MappingInput[]> {
    const key = scopeKey(validateScope(input)); boundedString(nativeId, 'nativeId');
    const db = await ctx.open(); const tx = db.transaction(STORES.mappings, 'readonly'); const completion = transactionDone(tx);
    const store = tx.objectStore(STORES.mappings); const found = new Map<string, MappingInput>();
    const root = await requestValue<MappingInput | undefined>(store.get([key, nativeId]));
    const pending = [{ nativeId, ...(root ? { colpId: root.colpId } : {}) }];
    if (root) found.set(root.nativeId, validate(key, root, ctx.maxRecordBytes));
    const visited = new Set<string>();
    for (let offset = 0; offset < pending.length; offset++) {
      const parent = pending[offset]!; if (visited.has(parent.nativeId)) continue; visited.add(parent.nativeId);
      const read = (index: string, id: string) => requestValue<MappingInput[]>(store.index(index)
        .getAll(IDBKeyRange.bound([key, id], [key, id, []])));
      const children = await Promise.all([read(INDEXES.mappingByNativeParent, parent.nativeId),
        ...(parent.colpId ? [read(INDEXES.mappingByColpParent, parent.colpId)] : [])]);
      for (const child of children.flat()) {
        if (found.has(child.nativeId)) continue;
        const row = validate(key, child, ctx.maxRecordBytes); found.set(row.nativeId, row); pending.push(row);
      }
    }
    await completion; return [...found.values()];
  }

  /** One index count instead of a whole-library read when the caller only asks whether such a mapping exists. */
  async function hasMappingNativePrefix(input: SyncScope, prefix: string): Promise<boolean> {
    const key = scopeKey(validateScope(input)); boundedString(prefix, 'prefix');
    const db = await ctx.open(); const tx = db.transaction(STORES.mappings, 'readonly'); const completion = transactionDone(tx);
    const count = await requestValue<number>(tx.objectStore(STORES.mappings).index(INDEXES.mappingByNativeId)
      .count(IDBKeyRange.bound([key, prefix], [key, `${prefix}\uffff`])));
    await completion; return count > 0;
  }
  return { hasMappingSibling, listMappingSubtree, hasMappingNativePrefix };
}
