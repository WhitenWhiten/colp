import { describe, expect, it } from 'vitest';

import {
  coordinateTombstonePurge,
  type DeletionWatermark,
  type TombstonePurgeTransaction,
  type TombstonePurgeUnitOfWork,
} from '../../src/sync/index.js';
import type { SyncTombstone } from '../../src/types/index.js';

const evidence = '[evidence:sync.tombstone-purge]';
const request = { collectionId: 'collection-1', targetId: 'node-root', serverUuid: 'server-lifetime-1' };
const members = ['node-root', 'node-child', 'annotation-1'];

function storedTombstone(): SyncTombstone {
  return {
    resourceType: 'node', targetId: 'node-root', collectionId: 'collection-1', scope: 'subtree',
    deletedAt: '2026-07-18T00:00:00Z', deleteRevision: 'revision-delete-1',
    operationId: 'operation-delete-1', deleteCursor: 'delete-cursor', affectedCount: members.length,
    purgeAfter: '2026-07-18T01:00:00Z',
  };
}

/** Minimal durable purge store; `batch` selects which Watermark ports exist. */
function purgeStore(batch: 'none' | 'both' | 'short-readback') {
  const state = {
    tombstone: storedTombstone() as SyncTombstone | undefined,
    boundary: { collectionId: 'collection-1', cursor: 'older', commitOrdinal: '2' as string },
    watermarks: new Map<string, DeletionWatermark>(),
  };
  const calls: string[] = [];
  const unitOfWork: TombstonePurgeUnitOfWork = {
    async execute(_collectionId, work) {
      const draft = structuredClone(state);
      const single: TombstonePurgeTransaction = {
        loadCandidate: async () => draft.tombstone && {
          tombstone: structuredClone(draft.tombstone),
          deleteCommitOrdinal: '10',
          deletedMembers: members.map(targetId => ({
            targetId, collectionId: 'collection-1', generation: `generation-${targetId}`,
          })),
        },
        readAuthoritativeTime: async () => '2026-07-18T02:00:00Z',
        listReplicaStates: async () => [],
        loadPurgeBoundary: async () => structuredClone(draft.boundary),
        advancePurgedThrough: async (boundary) => { draft.boundary = structuredClone(boundary) as typeof draft.boundary; },
        saveDeletionWatermark: async (watermark) => {
          calls.push('save:1');
          draft.watermarks.set(watermark.targetId, structuredClone(watermark));
        },
        loadDeletionWatermark: async (watermark) => {
          calls.push('load:1');
          return structuredClone(draft.watermarks.get(watermark.targetId));
        },
        deleteTombstone: async () => { draft.tombstone = undefined; },
        loadTombstone: async () => structuredClone(draft.tombstone),
      };
      const transaction: TombstonePurgeTransaction = batch === 'none' ? single : {
        ...single,
        saveDeletionWatermark: async () => { throw new Error('single save must not be used'); },
        loadDeletionWatermark: async () => { throw new Error('single load must not be used'); },
        saveDeletionWatermarks: async (watermarks) => {
          calls.push(`save:${watermarks.length}`);
          for (const watermark of watermarks) draft.watermarks.set(watermark.targetId, structuredClone(watermark));
        },
        loadDeletionWatermarks: async (watermarks) => {
          calls.push(`load:${watermarks.length}`);
          const loaded = watermarks.map(({ targetId }) => structuredClone(draft.watermarks.get(targetId)));
          return batch === 'short-readback' ? loaded.slice(1) : loaded;
        },
      };
      const result = await work(transaction);
      Object.assign(state, draft);
      return result;
    },
  };
  return { state, calls, unitOfWork };
}

describe(`Tombstone purge Watermark batching ${evidence}`, () => {
  it('saves and reads back every Watermark in one call each when both batch ports exist', async () => {
    const store = purgeStore('both');
    const result = await coordinateTombstonePurge(store.unitOfWork, request);
    expect(result.state === 'purged' && result.deletionWatermarks.map(({ targetId }) => targetId)).toEqual(members);
    expect(store.calls).toEqual(['save:3', 'load:3']);
    expect(store.state.tombstone).toBeUndefined();
    expect(store.state.watermarks.size).toBe(3);
  });

  it('falls back to one call per member without the batch ports', async () => {
    const store = purgeStore('none');
    await expect(coordinateTombstonePurge(store.unitOfWork, request)).resolves.toMatchObject({ state: 'purged' });
    expect(store.calls).toEqual(['save:1', 'save:1', 'save:1', 'load:1', 'load:1', 'load:1']);
  });

  it('rejects a batch read-back that does not answer every Watermark and commits nothing', async () => {
    const store = purgeStore('short-readback');
    await expect(coordinateTombstonePurge(store.unitOfWork, request)).rejects.toThrow('one entry per Watermark');
    expect(store.state.tombstone).toBeDefined();
    expect(store.state.watermarks.size).toBe(0);
  });
});
