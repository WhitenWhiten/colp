import type { JsonObject } from '../../modules/collections/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';

const MAX_TOMBSTONE_PAYLOAD_BYTES = 131_072;
const MAX_TOMBSTONE_PAYLOAD_DEPTH = 64;
const MAX_TOMBSTONE_PAYLOAD_MEMBERS = 20_000;
/** One tombstone append persists bounded INSERT batches (same transaction), never a statement sized by the whole subtree. */
export const MAX_TOMBSTONE_INSERT_BATCH = 512;
/**
 * Explicit total-member ceiling for one tombstone append. Matches the recursive
 * delete planner hard ceiling (100,000) so every subtree the planner accepts
 * remains deletable; larger trees fail in the planner before any tombstone write.
 */
export const MAX_TOMBSTONE_APPEND_MEMBERS = 100_000;

export interface SyncNodeTombstoneMember {
  readonly targetId: string;
  readonly kind: 'folder' | 'bookmark' | 'separator';
  readonly deleteRevision: string;
  readonly extensions: JsonObject;
}

export interface AppendSyncNodeTombstonesInput {
  readonly collectionId: string;
  readonly rootTargetId: string;
  readonly operationId: string;
  readonly scope: 'single' | 'subtree';
  readonly deleteCommitOrdinal: bigint;
  readonly deleteCursor: string;
  readonly deletedAt: Date;
  readonly purgeAfter: Date;
  readonly members: readonly SyncNodeTombstoneMember[];
}

export class SyncNodeTombstonePersistenceError extends Error {
  constructor(public readonly code: 'payload_too_large' | 'integrity_failure') {
    super(`Sync Node Tombstone persistence failed: ${code}`);
    this.name = 'SyncNodeTombstonePersistenceError';
  }
}

export interface PostgresSyncNodeTombstonePort {
  append(input: AppendSyncNodeTombstonesInput): Promise<void>;
}

export function createPostgresSyncNodeTombstonePort(
  transaction: DatabaseTransaction,
): PostgresSyncNodeTombstonePort {
  return Object.freeze({
    async append(input: AppendSyncNodeTombstonesInput) {
      if (input.members.length < 1 || input.members.length > MAX_TOMBSTONE_APPEND_MEMBERS
          || input.deleteCommitOrdinal < 1n || input.purgeAfter.getTime() < input.deletedAt.getTime()) {
        throw new SyncNodeTombstonePersistenceError('integrity_failure');
      }
      // SYNC-R04: the single-payload budget is a per-member contract, never a
      // subtree aggregate. Each member is validated and persisted independently
      // in bounded INSERT batches inside the caller's transaction, so any tree
      // the recursive delete planner accepts stays deletable and a failure in a
      // later batch rolls the whole append back with the delete (no half-delete).
      const seen = new Set<string>();
      for (let offset = 0; offset < input.members.length; offset += MAX_TOMBSTONE_INSERT_BATCH) {
        const values = input.members.slice(offset, offset + MAX_TOMBSTONE_INSERT_BATCH).map((member) => {
          if (seen.has(member.targetId)) throw new SyncNodeTombstonePersistenceError('integrity_failure');
          seen.add(member.targetId);
          const payload = {
            resourceType: 'node',
            targetId: member.targetId,
            collectionId: input.collectionId,
            rootTargetId: input.rootTargetId,
            kind: member.kind,
            scope: input.scope,
            deleteRevision: member.deleteRevision,
            operationId: input.operationId,
            deleteCommitOrdinal: input.deleteCommitOrdinal.toString(),
            affectedCount: input.members.length,
            extensions: member.extensions,
          } satisfies JsonObject;
          assertTombstoneBudget(payload);
          return {
            collection_id: input.collectionId,
            target_id: member.targetId,
            root_target_id: input.rootTargetId,
            operation_id: input.operationId,
            scope: input.scope,
            delete_revision: member.deleteRevision,
            delete_commit_ordinal: input.deleteCommitOrdinal,
            delete_cursor: input.deleteCursor,
            deleted_at: input.deletedAt,
            purge_after: input.purgeAfter,
            affected_count: input.members.length,
            payload_json: payload as Record<string, unknown>,
          };
        });
        await transaction.insertInto('sync_node_tombstones').values(values).execute();
      }
    },
  });
}

function assertTombstoneBudget(value: unknown): void {
  let encoded: string;
  try {
    const candidate = JSON.stringify(value);
    if (candidate === undefined) throw new TypeError('Tombstone payload is not JSON');
    encoded = candidate;
  } catch {
    throw new SyncNodeTombstonePersistenceError('integrity_failure');
  }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_TOMBSTONE_PAYLOAD_BYTES) {
    throw new SyncNodeTombstonePersistenceError('payload_too_large');
  }
  let members = 0;
  const visit = (candidate: unknown, depth: number): void => {
    if (depth > MAX_TOMBSTONE_PAYLOAD_DEPTH) {
      throw new SyncNodeTombstonePersistenceError('payload_too_large');
    }
    if (Array.isArray(candidate)) {
      members += candidate.length;
      for (const item of candidate) visit(item, depth + 1);
    } else if (candidate !== null && typeof candidate === 'object') {
      const entries = Object.entries(candidate as Record<string, unknown>);
      members += entries.length;
      for (const [, item] of entries) visit(item, depth + 1);
    }
    if (members > MAX_TOMBSTONE_PAYLOAD_MEMBERS) {
      throw new SyncNodeTombstonePersistenceError('payload_too_large');
    }
  };
  visit(value, 1);
}
