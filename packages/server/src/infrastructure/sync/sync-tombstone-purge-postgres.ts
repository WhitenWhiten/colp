import { lockActiveSyncReplicasForCollection } from '../database/lock-order.js';
import { hasCompleteDeleteGroup } from './sync-delete-group-integrity.js';
import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { createUnitOfWork, type DatabaseTransaction } from '../database/unit-of-work.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { SYNC_PULL_STREAM_KIND_ORDER, type SyncPullTuple } from '../../modules/sync/index.js';
import type { ReplicaRetentionWindowPort } from './replica-lifecycle-postgres.js';

export type SyncTombstonePurgeFaultPhase = 'facts_loaded' | 'identity_watermarks'
  | 'payload_compacted' | 'effect_purged' | 'purge_state_advanced' | 'before_commit';

export interface SyncTombstonePurgeClaim {
  readonly collectionId: string;
  readonly leaseToken: string;
  readonly leaseGeneration: string;
}

export interface SyncTombstonePurgeResult {
  readonly collectionId: string | null;
  readonly purgedCount: number;
  readonly purgedThrough: SyncPullTuple;
  readonly hasMore: boolean;
}

export interface SyncTombstonePurgeCoordinatorOptions {
  readonly workerId: string;
  readonly batchSize: number;
  readonly leaseDurationMs: number;
  readonly faultInjector?: { afterPhase?(phase: SyncTombstonePurgeFaultPhase): Promise<void> };
}

export class SyncTombstonePurgeFenceLostError extends Error {
  constructor() { super('Sync Tombstone purge lease fence was lost.'); this.name = 'SyncTombstonePurgeFenceLostError'; }
}

interface PurgeStateRow {
  collection_id: string;
  purged_through_commit_ordinal: bigint | string;
  purged_through_stream_kind: number;
  purged_through_stable_id: string;
  state_revision: bigint | string;
  lease_token: string | null;
  lease_generation: bigint | string;
  lease_expires_at: Date | null;
}

interface TombstoneCandidate {
  collection_id: string;
  target_id: string;
  operation_id: string;
  delete_revision: string;
  delete_commit_ordinal: bigint | string;
  purge_after: Date;
  affected_count: number;
}

interface ActiveReplicaCheckpoint {
  checkpoint_commit_ordinal: bigint | string | null;
  checkpoint_stream_kind: number | null;
  checkpoint_stable_id: string | null;
}

const INITIAL = Object.freeze({ commitOrdinal: '0', streamKind: 'operation' as const, stableId: '' });
const INITIAL_TUPLE = Object.freeze({ commitOrdinal: '0', streamKind: 0 as const, stableId: '' });

export function createPostgresReplicaRetentionWindowPort(snapshotUrl: string): ReplicaRetentionWindowPort {
  if (typeof snapshotUrl !== 'string' || snapshotUrl.length < 1 || snapshotUrl.length > 2_048) {
    throw new TypeError('Replica retention Snapshot URL is invalid.');
  }
  return Object.freeze({
    async load(transaction: DatabaseTransaction, collectionId: string) {
      // The two boundaries are read independently. They are separate authorities
      // and either can be absent: `202607252400_sync_tombstone_purge` creates
      // purge authority with the Collection, and the archived history floor is
      // only materialized once a segment is archived. A joined read made the
      // floor invisible whenever authority was missing, and made a missing
      // authority row a TypeError -> 500 where every other reader of the same
      // table (sync-recovery-postgres `loadBoundary`,
      // sync-pull-cursor-codec-postgres `loadPurgeBoundary`,
      // sync-bootstrap-snapshot-postgres `initialPullCursor`) reads the INITIAL
      // boundary. A Collection restored without its triggers is the reachable
      // shape: it is exactly the state a Replica expiry must still survive.
      const purge = await transaction.selectFrom('sync_collection_purge_state').select([
        'purged_through_commit_ordinal', 'purged_through_stream_kind', 'purged_through_stable_id',
      ]).where('collection_id', '=', collectionId).executeTakeFirst();
      const floor = await transaction.selectFrom('sync_history_floors').select([
        'floor_commit_ordinal', 'floor_stream_kind', 'floor_stable_id',
      ]).where('collection_id', '=', collectionId).executeTakeFirst();
      if (floor !== undefined && (floor.floor_stream_kind !== 0 || floor.floor_stable_id === null)) {
        throw new TypeError('Sync history floor authority is invalid.');
      }
      const purgedTuple = purge === undefined ? INITIAL_TUPLE : Object.freeze({
        commitOrdinal: BigInt(purge.purged_through_commit_ordinal).toString(),
        streamKind: purge.purged_through_stream_kind === 0 ? 0 as const : 1 as const,
        stableId: purge.purged_through_stable_id,
      });
      const historyTuple = floor === undefined ? INITIAL_TUPLE : Object.freeze({
        commitOrdinal: BigInt(floor.floor_commit_ordinal).toString(),
        streamKind: 0 as const, stableId: floor.floor_stable_id!,
      });
      const earliestPull = Object.freeze({ cursor: null, commitOrdinal: historyTuple.commitOrdinal });
      const purgedThrough = Object.freeze({ cursor: null, commitOrdinal: purgedTuple.commitOrdinal });
      return Object.freeze({ collectionId, earliestPull, purgedThrough,
        earliestPullTuple: historyTuple, purgedThroughTuple: purgedTuple, snapshotUrl });
    },
  });
}

export class PostgresSyncTombstonePurgeCoordinator {
  private readonly options: Required<SyncTombstonePurgeCoordinatorOptions>;

  constructor(private readonly db: Kysely<DatabaseSchema>, options: SyncTombstonePurgeCoordinatorOptions) {
    if (!options.workerId || options.workerId.length > 128 || !Number.isInteger(options.batchSize)
        || options.batchSize < 1 || options.batchSize > 20_000
        || !Number.isInteger(options.leaseDurationMs) || options.leaseDurationMs < 1) {
      throw new TypeError('Invalid Sync Tombstone purge coordinator options.');
    }
    this.options = { ...options, faultInjector: options.faultInjector ?? {} };
  }

  claimCollection(input: { readonly now?: Date } = {}): Promise<SyncTombstonePurgeClaim | null> {
    return createUnitOfWork(this.db).execute(async ({ transaction }) => {
      const now = await databaseNow(transaction, input.now);
      const candidate = await sql<{ collection_id: string }>`
        SELECT tombstone.collection_id
        FROM sync_node_tombstones AS tombstone
        LEFT JOIN sync_collection_purge_state AS state
          ON state.collection_id = tombstone.collection_id
        WHERE tombstone.payload_purged_at IS NULL
          AND (state.collection_id IS NULL OR state.lease_expires_at IS NULL OR state.lease_expires_at <= ${now})
        ORDER BY state.updated_at NULLS FIRST, tombstone.purge_after,
          tombstone.delete_commit_ordinal, tombstone.collection_id
        FOR UPDATE OF tombstone SKIP LOCKED LIMIT 1
      `.execute(transaction);
      const collectionId = candidate.rows[0]?.collection_id;
      if (!collectionId) return null;
      await transaction.insertInto('sync_collection_purge_state').values({ collection_id: collectionId })
        .onConflict((conflict) => conflict.column('collection_id').doNothing()).execute();
      const leaseToken = randomUUID();
      const claimed = await sql<PurgeStateRow>`
        UPDATE sync_collection_purge_state SET
          lease_owner=${this.options.workerId}, lease_token=${leaseToken},
          lease_generation=lease_generation+1,
          lease_expires_at=${now}::timestamptz
            + (${this.options.leaseDurationMs} * interval '1 millisecond'),
          attempt_count=attempt_count+1, last_attempt_at=${now}, updated_at=${now}
        WHERE collection_id=${collectionId}
          AND (lease_expires_at IS NULL OR lease_expires_at <= ${now})
        RETURNING *
      `.execute(transaction);
      const row = claimed.rows[0];
      return row ? Object.freeze({ collectionId, leaseToken,
        leaseGeneration: BigInt(row.lease_generation).toString() }) : null;
    });
  }

  purgeClaim(claim: SyncTombstonePurgeClaim, input: { readonly now?: Date } = {}) {
    return createUnitOfWork(this.db).execute(async ({ transaction }) => {
      const now = await databaseNow(transaction, input.now);
      await lockActiveSyncReplicasForCollection(transaction, claim.collectionId);
      await transaction.selectFrom('collections').select('id').where('id', '=', claim.collectionId)
        .forUpdate().executeTakeFirstOrThrow();
      const stateResult = await sql<PurgeStateRow>`SELECT * FROM sync_collection_purge_state
        WHERE collection_id=${claim.collectionId} FOR UPDATE`.execute(transaction);
      const state = stateResult.rows[0];
      if (!state || state.lease_token !== claim.leaseToken
          || BigInt(state.lease_generation).toString() !== claim.leaseGeneration
          || !(state.lease_expires_at instanceof Date) || state.lease_expires_at <= now) {
        throw new SyncTombstonePurgeFenceLostError();
      }

      const firstResult = await sql<TombstoneCandidate>`SELECT collection_id,target_id,operation_id,
          delete_revision,delete_commit_ordinal,purge_after,affected_count
        FROM sync_node_tombstones
        WHERE collection_id=${claim.collectionId} AND payload_purged_at IS NULL
        ORDER BY delete_commit_ordinal,operation_id,target_id LIMIT 1 FOR UPDATE`.execute(transaction);
      const first = firstResult.rows[0];
      const currentBoundary = tupleFromState(state);
      if (!first || first.purge_after > now) {
        return this.finishEmpty(transaction, state, claim, now, currentBoundary, first !== undefined);
      }

      const groupResult = await sql<TombstoneCandidate>`SELECT collection_id,target_id,operation_id,
          delete_revision,delete_commit_ordinal,purge_after,affected_count
        FROM sync_node_tombstones WHERE collection_id=${claim.collectionId}
          AND operation_id=${first.operation_id} AND payload_purged_at IS NULL
        ORDER BY target_id FOR UPDATE`.execute(transaction);
      const group = groupResult.rows;
      if (group.length < 1 || !await hasCompleteDeleteGroup(transaction, claim.collectionId, first.operation_id, first.affected_count)
          || group.length > this.options.batchSize
          || group.some((row) => row.purge_after > now
            || BigInt(row.delete_commit_ordinal) !== BigInt(first.delete_commit_ordinal))) {
        return this.finishEmpty(transaction, state, claim, now, currentBoundary, true);
      }
      const active = await sql<ActiveReplicaCheckpoint>`
        SELECT checkpoint_commit_ordinal,checkpoint_stream_kind,checkpoint_stable_id
        FROM sync_replicas AS replica
        WHERE replica.collection_id=${claim.collectionId} AND replica.status='active'
        ORDER BY replica.replica_id FOR SHARE OF replica`.execute(transaction);
      await this.options.faultInjector.afterPhase?.('facts_loaded');
      const deleteTuple = [BigInt(first.delete_commit_ordinal), SYNC_PULL_STREAM_KIND_ORDER.operation,
        first.operation_id] as const;
      // Unified protocol (FIX-M-010): successfully processing the delete event itself is
      // sufficient, so a checkpoint exactly on the delete tuple passes; only checkpoints
      // strictly behind the delete tuple (or absent) block the purge.
      const blocked = active.rows.some((row) => row.checkpoint_commit_ordinal === null
        || row.checkpoint_stream_kind === null || row.checkpoint_stable_id === null
        || BigInt(row.checkpoint_commit_ordinal) < deleteTuple[0]
        || (BigInt(row.checkpoint_commit_ordinal) === deleteTuple[0]
          && (row.checkpoint_stream_kind < deleteTuple[1]
            || (row.checkpoint_stream_kind === deleteTuple[1]
              && row.checkpoint_stable_id < deleteTuple[2]))));
      if (blocked) {
        return this.finishEmpty(transaction, state, claim, now, currentBoundary, true);
      }

      const nextRevision = BigInt(state.state_revision) + 1n;
      if (BigInt(first.delete_commit_ordinal) < BigInt(state.purged_through_commit_ordinal)
          || (BigInt(first.delete_commit_ordinal) === BigInt(state.purged_through_commit_ordinal)
            && first.operation_id <= state.purged_through_stable_id)) {
        throw new TypeError('Stored purge boundary would regress.');
      }
      await transaction.insertInto('sync_purged_node_id_watermarks').values(group.map((row) => ({
        collection_id: claim.collectionId, target_id: row.target_id,
        delete_commit_ordinal: BigInt(row.delete_commit_ordinal), delete_revision: row.delete_revision,
        delete_operation_id: row.operation_id, purge_state_revision: nextRevision, purged_at: now,
      }))).execute();
      await this.options.faultInjector.afterPhase?.('identity_watermarks');
      const compacted = await sql`UPDATE sync_node_tombstones SET
          payload_json=jsonb_set(payload_json,'{extensions}','{}'::jsonb,true),
          payload_purged_at=${now}, purge_state_revision=${nextRevision}
        WHERE collection_id=${claim.collectionId} AND operation_id=${first.operation_id}
          AND payload_purged_at IS NULL`.execute(transaction);
      if (Number(compacted.numAffectedRows ?? 0) !== group.length) throw new SyncTombstonePurgeFenceLostError();
      await this.options.faultInjector.afterPhase?.('payload_compacted');
      await sql`select set_config('known.sync_authority', 'server', true),
        set_config('known.sync_effect_purge', 'server', true)`.execute(transaction);
      await sql`DELETE FROM sync_operation_effect_pages page USING sync_operation_effects effect
        WHERE page.effect_id=effect.effect_id AND effect.collection_id=${claim.collectionId}
          AND effect.commit_ordinal <= ${BigInt(first.delete_commit_ordinal)}`.execute(transaction);
      await sql`DELETE FROM sync_operation_effects
        WHERE collection_id=${claim.collectionId}
          AND commit_ordinal <= ${BigInt(first.delete_commit_ordinal)}`.execute(transaction);
      await this.options.faultInjector.afterPhase?.('effect_purged');

      const boundary: SyncPullTuple = Object.freeze({ commitOrdinal: BigInt(first.delete_commit_ordinal).toString(),
        streamKind: 'operation', stableId: first.operation_id });
      const advanced = await sql`UPDATE sync_collection_purge_state SET
          purged_through_commit_ordinal=${BigInt(boundary.commitOrdinal)},
          purged_through_stream_kind=${SYNC_PULL_STREAM_KIND_ORDER.operation},
          purged_through_stable_id=${boundary.stableId}, state_revision=${nextRevision},
          lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,last_completed_at=${now},updated_at=${now}
        WHERE collection_id=${claim.collectionId} AND lease_token=${claim.leaseToken}
          AND lease_generation=${BigInt(claim.leaseGeneration)} AND lease_expires_at > ${now}`.execute(transaction);
      if (Number(advanced.numAffectedRows ?? 0) !== 1) throw new SyncTombstonePurgeFenceLostError();
      await this.options.faultInjector.afterPhase?.('purge_state_advanced');
      const more = await hasMore(transaction, claim.collectionId);
      await this.options.faultInjector.afterPhase?.('before_commit');
      return Object.freeze({ collectionId: claim.collectionId, purgedCount: group.length,
        purgedThrough: boundary, hasMore: more });
    });
  }

  async runBatch(input: { readonly now?: Date } = {}): Promise<SyncTombstonePurgeResult> {
    const claim = await this.claimCollection(input);
    if (!claim) return Object.freeze({ collectionId: null, purgedCount: 0,
      purgedThrough: INITIAL, hasMore: false });
    return this.purgeClaim(claim, input);
  }

  private async finishEmpty(transaction: DatabaseTransaction, state: PurgeStateRow,
    claim: SyncTombstonePurgeClaim, now: Date, boundary: SyncPullTuple, more: boolean) {
    const released = await sql`UPDATE sync_collection_purge_state SET lease_owner=NULL,lease_token=NULL,
        lease_expires_at=NULL,last_completed_at=${now},updated_at=${now}
      WHERE collection_id=${claim.collectionId} AND lease_token=${claim.leaseToken}
        AND lease_generation=${BigInt(claim.leaseGeneration)} AND lease_expires_at > ${now}`.execute(transaction);
    if (Number(released.numAffectedRows ?? 0) !== 1) throw new SyncTombstonePurgeFenceLostError();
    return Object.freeze({ collectionId: state.collection_id, purgedCount: 0,
      purgedThrough: boundary, hasMore: more });
  }
}

async function databaseNow(transaction: DatabaseTransaction, override?: Date): Promise<Date> {
  const result = override
    ? await sql<{ now: Date }>`SELECT ${override}::timestamptz AS now`.execute(transaction)
    : await sql<{ now: Date }>`SELECT current_timestamp AS now`.execute(transaction);
  const now = result.rows[0]?.now;
  if (!(now instanceof Date)) throw new TypeError('PostgreSQL did not return an authoritative timestamp.');
  return now;
}

function tupleFromState(state: PurgeStateRow): SyncPullTuple {
  return Object.freeze({ commitOrdinal: BigInt(state.purged_through_commit_ordinal).toString(),
    streamKind: state.purged_through_stream_kind === 0 ? 'operation' : 'conflict',
    stableId: state.purged_through_stable_id });
}

async function hasMore(transaction: DatabaseTransaction, collectionId: string): Promise<boolean> {
  const result = await sql<{ more: boolean }>`SELECT EXISTS (SELECT 1 FROM sync_node_tombstones
    WHERE collection_id=${collectionId} AND payload_purged_at IS NULL) AS more`.execute(transaction);
  return result.rows[0]?.more === true;
}

export interface SyncTombstonePurgeJobOptions {
  readonly intervalMs: number;
  readonly onStart?: () => void;
  readonly onResult?: (result: SyncTombstonePurgeResult) => void;
  readonly onError?: (error: unknown) => void;
}

export class SyncTombstonePurgeJob {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  constructor(private readonly coordinator: PostgresSyncTombstonePurgeCoordinator,
    private readonly options: SyncTombstonePurgeJobOptions) {
    if (!Number.isInteger(options.intervalMs) || options.intervalMs < 1) throw new TypeError('Invalid purge interval.');
  }
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.options.intervalMs);
    this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      this.options.onStart?.();
      const result = await this.coordinator.runBatch();
      this.options.onResult?.(result);
    }
    catch (error) { this.options.onError?.(error); }
    finally { this.running = false; }
  }
}
