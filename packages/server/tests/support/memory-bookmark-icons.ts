/**
 * Shared in-memory bookmark icon lookup for collection node unit tests.
 */
import type {
  BookmarkIconRow,
  BookmarkIconWritePort,
} from '../../src/modules/collections/index.js';

export interface MemoryBookmarkIconFields {
  iconObjectIds: Map<string, string>;
  iconRows: Map<string, BookmarkIconRow>;
  iconLookupCalls: number;
}

export function createMemoryBookmarkIconFields(): MemoryBookmarkIconFields {
  return { iconObjectIds: new Map(), iconRows: new Map(), iconLookupCalls: 0 };
}

function snapshotRow(row: BookmarkIconRow): BookmarkIconRow {
  return {
    ...row,
    digestSha256: Buffer.from(row.digestSha256),
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

export function createMemoryBookmarkIcons(
  state: MemoryBookmarkIconFields & { now: Date },
  collectionId: string,
): BookmarkIconWritePort {
  return {
    async findObjectIdsByNodeIds(nodeIds: readonly string[]) {
      state.iconLookupCalls += 1;
      const result = new Map<string, string>();
      for (const id of nodeIds) {
        const objectId = state.iconObjectIds.get(id);
        if (objectId) result.set(id, objectId);
      }
      return result;
    },
    async findByNodeId(nodeId: string) {
      const row = state.iconRows.get(nodeId);
      if (row) return snapshotRow(row);
      const objectId = state.iconObjectIds.get(nodeId);
      if (!objectId) return null;
      return {
        nodeId,
        collectionId,
        objectId,
        contentType: 'image/png' as const,
        byteSize: 16,
        digestSha256: Buffer.alloc(32),
        createdAt: state.now,
        updatedAt: state.now,
      };
    },
    async upsert(row) {
      const conflicting = [...state.iconRows.values()].find(
        (existing) => existing.nodeId !== row.nodeId && existing.objectId === row.objectId,
      );
      if (conflicting) throw new Error('bookmark icon object id already exists');
      const existing = state.iconRows.get(row.nodeId);
      const stored = snapshotRow({
        ...row,
        createdAt: existing?.createdAt ?? row.createdAt,
      });
      state.iconRows.set(row.nodeId, stored);
      state.iconObjectIds.set(row.nodeId, row.objectId);
    },
    async deleteByNodeId(nodeId) {
      const row = await this.findByNodeId(nodeId);
      if (!row) return null;
      state.iconRows.delete(nodeId);
      state.iconObjectIds.delete(nodeId);
      return row;
    },
    async deleteByNodeIds(nodeIds) {
      for (const nodeId of nodeIds) {
        state.iconRows.delete(nodeId);
        state.iconObjectIds.delete(nodeId);
      }
    },
    async deleteByCollectionId(targetCollectionId) {
      for (const [nodeId, row] of state.iconRows) {
        if (row.collectionId !== targetCollectionId) continue;
        state.iconRows.delete(nodeId);
        state.iconObjectIds.delete(nodeId);
      }
      if (targetCollectionId === collectionId) {
        for (const nodeId of state.iconObjectIds.keys()) {
          if (!state.iconRows.has(nodeId)) state.iconObjectIds.delete(nodeId);
        }
      }
    },
  };
}
