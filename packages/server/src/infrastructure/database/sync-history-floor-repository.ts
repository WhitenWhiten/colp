import { sql, type Kysely } from 'kysely';

import type { DatabaseSchema } from './runtime.js';
import { createUnitOfWork, type DatabaseTransaction } from './unit-of-work.js';

export interface SyncHistoryFloor {
  readonly collectionId: string;
  readonly position: Readonly<{
    readonly commitOrdinal: string;
    readonly streamKind: 'operation';
    readonly stableId: string;
  }>;
  readonly archiveSegmentId: string | null;
  readonly stateRevision: string;
  readonly advancedAt: Date | null;
  readonly materialized: boolean;
}

export interface AdvanceSyncHistoryFloorInput {
  readonly collectionId: string;
  readonly position: Readonly<{
    readonly commitOrdinal: string;
    readonly streamKind: 'operation';
    readonly stableId: string;
  }>;
  readonly archiveSegmentId: string;
  readonly expectedStateRevision: string;
}

export interface SyncHistoryFloorRepository {
  /** Missing rows are the protocol's implicit zero floor. */
  readonly read: (collectionId: string) => Promise<SyncHistoryFloor>;
  readonly materializeZero: (collectionId: string) => Promise<SyncHistoryFloor>;
  /** Advances authority only; it never mutates or deletes source history. */
  readonly advance: (input: AdvanceSyncHistoryFloorInput) => Promise<SyncHistoryFloor>;
}

export type SyncHistoryFloorRepositoryErrorCode =
  | 'regression'
  | 'cas_conflict'
  | 'active_replica_behind'
  | 'archive_not_verified'
  | 'binding_mismatch'
  | 'boundary_missing';

export class SyncHistoryFloorRepositoryError extends Error {
  constructor(
    readonly code: SyncHistoryFloorRepositoryErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'SyncHistoryFloorRepositoryError';
  }
}

interface FloorRow {
  collection_id: string;
  floor_commit_ordinal: string;
  floor_stream_kind: 0;
  floor_stable_id: string;
  archive_segment_id: string | null;
  state_revision: string;
  advanced_at: Date;
}

const ZERO_POSITION = Object.freeze({
  commitOrdinal: '0', streamKind: 'operation' as const, stableId: '',
});

export function createPostgresSyncHistoryFloorRepository(
  db: Kysely<DatabaseSchema>,
): SyncHistoryFloorRepository {
  async function read(collectionId: string): Promise<SyncHistoryFloor> {
    validateCollectionId(collectionId);
    const result = await selectFloor(db, collectionId);
    return result.rows[0] === undefined ? implicitZero(collectionId) : mapFloor(result.rows[0]);
  }

  async function materializeZero(collectionId: string): Promise<SyncHistoryFloor> {
    validateCollectionId(collectionId);
    try {
      return await createUnitOfWork(db).execute(async ({ transaction }) => {
        await transaction.insertInto('sync_history_floors').values({ collection_id: collectionId })
          .onConflict((conflict) => conflict.column('collection_id').doNothing()).execute();
        const result = await selectFloor(transaction, collectionId);
        const row = result.rows[0];
        if (row === undefined) throw bindingMismatch('Sync history floor collection does not exist.');
        return mapFloor(row);
      });
    } catch (error) {
      throw classifyError(error);
    }
  }

  return Object.freeze({
    read,
    materializeZero,
    async advance(input: AdvanceSyncHistoryFloorInput): Promise<SyncHistoryFloor> {
      validateAdvance(input);
      try {
        return await createUnitOfWork(db).execute(async ({ transaction }) => {
          // This is the global order for the rare authority advance: Replica table,
          // then floor row, archive row and operation row. Normal Replica writes take
          // ROW EXCLUSIVE and therefore finish before this transaction validates them.
          await sql`LOCK TABLE sync_replicas IN SHARE MODE`.execute(transaction);
          await transaction.insertInto('sync_history_floors').values({ collection_id: input.collectionId })
            .onConflict((conflict) => conflict.column('collection_id').doNothing()).execute();
          const result = await sql<FloorRow>`UPDATE sync_history_floors SET
              floor_commit_ordinal=${BigInt(input.position.commitOrdinal)},
              floor_stream_kind=0,
              floor_stable_id=${input.position.stableId},
              archive_segment_id=${input.archiveSegmentId}::uuid,
              state_revision=state_revision+1
            WHERE collection_id=${input.collectionId}
              AND state_revision=${BigInt(input.expectedStateRevision)}
            RETURNING collection_id,floor_commit_ordinal::text,floor_stream_kind,
              floor_stable_id,archive_segment_id::text,state_revision::text,advanced_at`
            .execute(transaction);
          const row = result.rows[0];
          if (row !== undefined) return mapFloor(row);

          const current = (await selectFloor(transaction, input.collectionId)).rows[0];
          if (current === undefined || current.state_revision !== input.expectedStateRevision) {
            throw new SyncHistoryFloorRepositoryError(
              'cas_conflict', 'Sync history floor revision changed concurrently.',
            );
          }
          if (comparePosition(input.position, current) <= 0) {
            throw new SyncHistoryFloorRepositoryError(
              'regression', 'Sync history floor must advance monotonically.',
            );
          }
          throw new SyncHistoryFloorRepositoryError(
            'cas_conflict', 'Sync history floor compare-and-set did not update its row.',
          );
        });
      } catch (error) {
        throw classifyError(error);
      }
    },
  });
}

function selectFloor(executor: Kysely<DatabaseSchema> | DatabaseTransaction, collectionId: string) {
  return sql<FloorRow>`SELECT collection_id,floor_commit_ordinal::text,floor_stream_kind,
      floor_stable_id,archive_segment_id::text,state_revision::text,advanced_at
    FROM sync_history_floors WHERE collection_id=${collectionId}`.execute(executor);
}

function implicitZero(collectionId: string): SyncHistoryFloor {
  return Object.freeze({ collectionId, position: ZERO_POSITION, archiveSegmentId: null,
    stateRevision: '0', advancedAt: null, materialized: false });
}

function mapFloor(row: FloorRow): SyncHistoryFloor {
  if (row.floor_stream_kind !== 0) throw bindingMismatch('Stored Sync history floor is not an operation tuple.');
  return Object.freeze({
    collectionId: row.collection_id,
    position: Object.freeze({ commitOrdinal: BigInt(row.floor_commit_ordinal).toString(),
      streamKind: 'operation' as const, stableId: row.floor_stable_id }),
    archiveSegmentId: row.archive_segment_id,
    stateRevision: BigInt(row.state_revision).toString(),
    advancedAt: row.advanced_at,
    materialized: true,
  });
}

function validateCollectionId(value: string): void {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512) {
    throw bindingMismatch('Sync history floor collection ID is invalid.');
  }
}

function validateAdvance(input: AdvanceSyncHistoryFloorInput): void {
  validateCollectionId(input.collectionId);
  if (input.position.streamKind !== 'operation'
      || !/^[1-9][0-9]*$/u.test(input.position.commitOrdinal)
      || input.position.stableId.length < 1 || input.position.stableId.length > 512
      || input.archiveSegmentId.length < 1
      || !/^(0|[1-9][0-9]*)$/u.test(input.expectedStateRevision)) {
    throw bindingMismatch('Sync history floor V1 requires a valid operation tuple and archive binding.');
  }
}

function comparePosition(position: AdvanceSyncHistoryFloorInput['position'], row: FloorRow): number {
  const ordinal = BigInt(position.commitOrdinal);
  const currentOrdinal = BigInt(row.floor_commit_ordinal);
  if (ordinal !== currentOrdinal) return ordinal > currentOrdinal ? 1 : -1;
  return position.stableId === row.floor_stable_id ? 0 : position.stableId > row.floor_stable_id ? 1 : -1;
}

function bindingMismatch(message: string, cause?: unknown): SyncHistoryFloorRepositoryError {
  return new SyncHistoryFloorRepositoryError('binding_mismatch', message, cause);
}

function classifyError(error: unknown): SyncHistoryFloorRepositoryError {
  if (error instanceof SyncHistoryFloorRepositoryError) return error;
  const constraint = typeof error === 'object' && error !== null
    ? (error as { constraint?: unknown }).constraint : undefined;
  const mapping: Readonly<Record<string, SyncHistoryFloorRepositoryErrorCode>> = Object.freeze({
    sync_history_floors_transition_guard: 'regression',
    sync_history_floors_active_replica_behind: 'active_replica_behind',
    sync_history_floors_archive_not_verified: 'archive_not_verified',
    sync_history_floors_binding_mismatch: 'binding_mismatch',
    sync_history_floors_boundary_missing: 'boundary_missing',
  });
  const code = typeof constraint === 'string' ? mapping[constraint] : undefined;
  return new SyncHistoryFloorRepositoryError(code ?? 'binding_mismatch',
    code === undefined ? 'Sync history floor authority rejected the request.'
      : `Sync history floor advance failed: ${code}.`, error);
}
