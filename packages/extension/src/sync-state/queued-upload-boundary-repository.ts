import { boundedString } from './codec.js';
import { requestValue, scopeRowsRange, transactionDone } from './idb.js';
import { INDEXES, STORES } from './schema.js';
import { scopeKey, validateScope, validateScopeRecord } from './scope-key.js';
import { validateMappingRecord } from './mapping-repository.js';
import { validateBootstrapRun, validateMountBinding, validateScopePreview } from './mount-repository.js';
import { validateBookmarkEventRecord } from './bookmark-event-validation.js';
import { validateLocalSyncExclusion } from './remote-delete-repository.js';
import { loadAttentionPages } from './attention-pages.js';
import { readScopeCommandRecord } from './scope-command-evidence.js';
import type { JsonObject, QueueOperation, SyncScope } from './types.js';
import type { SyncStoreRuntime } from './runtime.js';

/** One coherent read per dispatch phase. This is a short-lived proof input,
 * never an authority cache; callers must compare a fresh read before sending. */
export function createQueuedUploadBoundaryRepository(ctx: SyncStoreRuntime) {
  async function readQueuedUploadBoundaryFacts(scope: SyncScope, queues: readonly QueueOperation[]) {
    const key = scopeKey(validateScope(scope));
    const opIds = [...new Set(queues.map(row => boundedString(row.opId, 'opId')))];
    const tx = (await ctx.open()).transaction([STORES.scopes, STORES.mounts, STORES.bootstrapRuns,
      STORES.previews, STORES.mappings, STORES.bookmarkEvents, STORES.localSyncExclusions,
      STORES.scopeCommandPlans, STORES.metadata, STORES.diagnostics], 'readonly');
    const done = transactionDone(tx);
    try {
      const [rawScope, rawMounts, rawRuns, rawExclusions] = await Promise.all([
        requestValue(tx.objectStore(STORES.scopes).get(key)),
        requestValue(tx.objectStore(STORES.mounts).getAll(scopeRowsRange(key))),
        requestValue(tx.objectStore(STORES.bootstrapRuns).getAll(scopeRowsRange(key))),
        requestValue(tx.objectStore(STORES.localSyncExclusions).getAll(scopeRowsRange(key))),
      ]);
      const recorded = rawScope ? validateScopeRecord(rawScope, ctx.maxRecordBytes) : null;
      const mounts = rawMounts.map(row => validateMountBinding(key, row, ctx.maxRecordBytes));
      const runs = await Promise.all(rawRuns.map(async value => {
        const row = validateBootstrapRun(key, value, ctx.maxRecordBytes);
        return { ...row, ...(row.attention ? { attention: await loadAttentionPages(tx, key, row.attention) } : {}) };
      }));
      const latest = [...runs].sort((a, b) => b.updatedAt - a.updatedAt)[0];
      const ids = new Set([...(recorded?.privateRoots ?? []), ...(mounts.length ? [] : recorded?.selectedRoots ?? [])]);
      for (const row of queues) {
        const inner = row.payload.payload as JsonObject | undefined;
        for (const id of [`pending-${row.opId}`, row.payload.targetId, inner?.parentId, inner?.newParentId]) {
          if (typeof id === 'string') ids.add(boundedString(id, 'colpId'));
        }
      }
      const [mappings, events, commands, rawPreview] = await Promise.all([
        Promise.all([...ids].map(async colpId => {
          const raw = await requestValue(tx.objectStore(STORES.mappings).index(INDEXES.mappingByColpId).get([key, colpId]));
          return { colpId, mapping: raw ? validateMappingRecord(key, raw, ctx.maxRecordBytes) : null };
        })),
        Promise.all(opIds.map(async opId => {
          const [original, linked] = await Promise.all([
            requestValue(tx.objectStore(STORES.bookmarkEvents).get([key, opId])),
            requestValue(tx.objectStore(STORES.bookmarkEvents).index(INDEXES.eventByOperationOrdinal)
              .getAll(IDBKeyRange.bound([key, opId], [key, opId, []]))),
          ]);
          return { opId, original: original ? validateBookmarkEventRecord(original, ctx.maxRecordBytes) : null,
            linked: linked.map(value => validateBookmarkEventRecord(value, ctx.maxRecordBytes)) };
        })),
        Promise.all(mounts.map(async mount => {
          const commandId = `rejoin:${mount.mountId}`;
          const raw = await requestValue(tx.objectStore(STORES.scopeCommandPlans).get([key, commandId]));
          return { commandId, plan: raw ? await readScopeCommandRecord(tx, key, raw, ctx.maxRecordBytes) : null };
        })),
        latest?.previewId ? requestValue(tx.objectStore(STORES.previews).get([key, latest.previewId])) : undefined,
      ]);
      return { recorded, mounts, runs, mappings, events, commands,
        preview: rawPreview ? validateScopePreview(key, rawPreview, ctx.maxRecordBytes) : null,
        exclusions: rawExclusions.map(row => validateLocalSyncExclusion(key, row, ctx.maxRecordBytes)) };
    } finally { await done; }
  }
  return { readQueuedUploadBoundaryFacts };
}

export type QueuedUploadBoundaryFacts = Awaited<ReturnType<ReturnType<typeof createQueuedUploadBoundaryRepository>['readQueuedUploadBoundaryFacts']>>;
