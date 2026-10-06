import { requirePromise, nonEmptyString } from './internal-guards.js';
import type { SyncTombstone } from '../types/generated.js';
import { isRfc3339DateTime } from '../shared/date-time.js';
import type { ReplicaLifecycle } from './index.js';
import { immutableJsonData, immutableJsonSnapshot } from '../shared/immutable-json.js';
import { lifecycleOrdinal as canonicalOrdinal } from './replica-lifecycle-parsing.js';

export interface TombstonePurgeRequest {
  readonly collectionId: string;
  readonly targetId: string;
  /** Stable identity of the server lifetime that owns deletion watermarks. */
  readonly serverUuid: string;
}

export interface TombstoneDeletedMember {
  readonly targetId: string;
  readonly collectionId: string;
  readonly generation: string;
}

export interface TombstonePurgeCandidate {
  readonly tombstone: SyncTombstone;
  /** Durable commit order of the deletion event, not an opaque wire Cursor. */
  readonly deleteCommitOrdinal: string;
  readonly deletedMembers: readonly TombstoneDeletedMember[];
}

export interface TombstonePurgeReplicaState {
  readonly replicaId: string;
  readonly collectionId: string;
  readonly lifecycle: ReplicaLifecycle;
  readonly acknowledgedCommitOrdinal: string | null;
  readonly queuedOperationsReconciled: boolean;
}

export interface TombstonePurgeBoundary {
  readonly collectionId: string;
  readonly cursor: string | null;
  readonly commitOrdinal: string;
}

export interface DeletionWatermark {
  readonly serverUuid: string;
  readonly collectionId: string;
  readonly targetId: string;
  readonly generation: string;
}

export interface TombstonePurgeIdentity {
  readonly collectionId: string;
  readonly targetId: string;
  readonly deleteRevision: string;
  readonly operationId: string;
}

export interface TombstonePurgeTransaction {
  loadCandidate(request: TombstonePurgeRequest): Promise<TombstonePurgeCandidate | undefined>;
  readAuthoritativeTime(): Promise<string>;
  listReplicaStates(collectionId: string): Promise<readonly TombstonePurgeReplicaState[]>;
  loadPurgeBoundary(collectionId: string): Promise<TombstonePurgeBoundary>;
  advancePurgedThrough(boundary: TombstonePurgeBoundary): Promise<void>;
  /** Watermarks MUST remain durable for the complete lifetime of their serverUuid. */
  saveDeletionWatermark(watermark: DeletionWatermark): Promise<void>;
  deleteTombstone(identity: TombstonePurgeIdentity): Promise<void>;
  loadDeletionWatermark(watermark: DeletionWatermark): Promise<DeletionWatermark | undefined>;
  /**
   * Optional batch forms for subtree purges. When both are present the
   * coordinator saves and reads back every Watermark of a purge in one call
   * each instead of one call per deleted member. `loadDeletionWatermarks`
   * returns exactly one Watermark per requested one, in request order.
   */
  saveDeletionWatermarks?(watermarks: readonly DeletionWatermark[]): Promise<void>;
  loadDeletionWatermarks?(
    watermarks: readonly DeletionWatermark[],
  ): Promise<readonly (DeletionWatermark | undefined)[]>;
  loadTombstone(request: TombstonePurgeRequest): Promise<SyncTombstone | undefined>;
}

export interface TombstonePurgeUnitOfWork<
  Transaction extends TombstonePurgeTransaction = TombstonePurgeTransaction,
> {
  /**
   * The adapter MUST serialize callbacks for a Collection across processes, use one
   * durable transaction for every port above, and reject if commit outcome is unknown.
   */
  execute<Result>(
    collectionId: string,
    work: (transaction: Transaction) => Promise<Result>,
  ): Promise<Result>;
}

export type TombstonePurgeBlockedReason =
  | 'tombstone_not_found'
  | 'retention_not_elapsed'
  | 'active_replica_ack_missing'
  | 'active_replica_queue_unreconciled';

export type TombstonePurgeResult =
  | {
      readonly state: 'blocked';
      readonly reason: TombstonePurgeBlockedReason;
      readonly blockingReplicaIds: readonly string[];
    }
  | {
      readonly state: 'purged';
      readonly tombstone: SyncTombstone;
      readonly purgeBoundary: TombstonePurgeBoundary;
      readonly deletionWatermarks: readonly DeletionWatermark[];
    };

const lifecycleValues = new Set<unknown>(['active', 'expired', 'recovery_required', 'retired']);

function rfc3339DateTime(value: unknown, label: string): string {
  const wire = nonEmptyString(value, label);
  if (!isRfc3339DateTime(wire)) {
    throw new TypeError(`${label} must be a valid RFC 3339 date-time.`);
  }
  return wire;
}

function exactDataObject(value: unknown, keys: ReadonlySet<string>, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must have a plain or null prototype.`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !keys.has(key)) {
      throw new TypeError(`${label} contains an unknown member.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`${label} members must be enumerable data properties.`);
    }
  }
  return value as Record<string, unknown>;
}

function mutableData<Value>(value: Value): Value {
  return structuredClone(value);
}

function immutableRequest(value: TombstonePurgeRequest): TombstonePurgeRequest {
  const candidate = exactDataObject(
    value,
    new Set(['collectionId', 'targetId', 'serverUuid']),
    'Tombstone purge request',
  );
  return Object.freeze({
    collectionId: nonEmptyString(candidate.collectionId, 'Tombstone purge collectionId'),
    targetId: nonEmptyString(candidate.targetId, 'Tombstone purge targetId'),
    serverUuid: nonEmptyString(candidate.serverUuid, 'Tombstone purge serverUuid'),
  });
}

function immutableTombstone(value: unknown, request: TombstonePurgeRequest): SyncTombstone {
  const candidate = exactDataObject(value, new Set([
    'resourceType', 'targetId', 'collectionId', 'scope', 'deletedAt', 'deletedBy',
    'deleteRevision', 'operationId', 'deleteCursor', 'affectedCount', 'purgeAfter',
  ]), 'Sync Tombstone');
  if (!new Set<unknown>(['collection', 'node', 'annotation', 'attachment', 'relation']).has(candidate.resourceType)) {
    throw new TypeError('Sync Tombstone resourceType is invalid.');
  }
  if (candidate.scope !== 'single' && candidate.scope !== 'subtree') {
    throw new TypeError('Sync Tombstone scope is invalid.');
  }
  const collectionId = nonEmptyString(candidate.collectionId, 'Sync Tombstone collectionId');
  const targetId = nonEmptyString(candidate.targetId, 'Sync Tombstone targetId');
  if (collectionId !== request.collectionId || targetId !== request.targetId) {
    throw new TypeError('Tombstone store returned a mismatched identity.');
  }
  if (!Number.isSafeInteger(candidate.affectedCount) || (candidate.affectedCount as number) < 1) {
    throw new TypeError('Sync Tombstone affectedCount must be a positive safe integer.');
  }
  return immutableJsonData({
    resourceType: candidate.resourceType,
    targetId,
    collectionId,
    scope: candidate.scope,
    deletedAt: rfc3339DateTime(candidate.deletedAt, 'Sync Tombstone deletedAt'),
    ...(candidate.deletedBy === undefined
      ? {}
      : { deletedBy: nonEmptyString(candidate.deletedBy, 'Sync Tombstone deletedBy') }),
    deleteRevision: nonEmptyString(candidate.deleteRevision, 'Sync Tombstone deleteRevision'),
    operationId: nonEmptyString(candidate.operationId, 'Sync Tombstone operationId'),
    deleteCursor: nonEmptyString(candidate.deleteCursor, 'Sync Tombstone deleteCursor'),
    affectedCount: candidate.affectedCount,
    purgeAfter: rfc3339DateTime(candidate.purgeAfter, 'Sync Tombstone purgeAfter'),
  }, 'Sync Tombstone') as SyncTombstone;
}

function immutableCandidate(value: unknown, request: TombstonePurgeRequest): TombstonePurgeCandidate {
  const candidate = exactDataObject(
    value,
    new Set(['tombstone', 'deleteCommitOrdinal', 'deletedMembers']),
    'Tombstone purge candidate',
  );
  const tombstone = immutableTombstone(candidate.tombstone, request);
  const deleteCommitOrdinal = canonicalOrdinal(
    candidate.deleteCommitOrdinal,
    'Tombstone deletion commitOrdinal',
  ).wire;
  if (!Array.isArray(candidate.deletedMembers)) {
    throw new TypeError('Tombstone deletedMembers must be an array.');
  }
  const seen = new Set<string>();
  const deletedMembers = candidate.deletedMembers.map((value, index) => {
    const member = exactDataObject(
      value,
      new Set(['targetId', 'collectionId', 'generation']),
      `Tombstone deleted member ${index}`,
    );
    const targetId = nonEmptyString(member.targetId, `Tombstone deleted member ${index} targetId`);
    const collectionId = nonEmptyString(
      member.collectionId,
      `Tombstone deleted member ${index} collectionId`,
    );
    if (collectionId !== request.collectionId) {
      throw new TypeError('Every Tombstone deleted member must belong to the candidate Collection.');
    }
    if (seen.has(targetId)) throw new TypeError('Tombstone deleted member IDs must be unique.');
    seen.add(targetId);
    return Object.freeze({
      targetId,
      collectionId,
      generation: nonEmptyString(member.generation, `Tombstone deleted member ${index} generation`),
    });
  });
  if (deletedMembers.length !== tombstone.affectedCount || !seen.has(tombstone.targetId)) {
    throw new TypeError('Tombstone deletedMembers must be the complete affected deletion set.');
  }
  if (tombstone.scope === 'single' && deletedMembers.length !== 1) {
    throw new TypeError('A single-resource Tombstone must contain exactly one deleted member.');
  }
  return Object.freeze({ tombstone, deleteCommitOrdinal, deletedMembers: Object.freeze(deletedMembers) });
}

function immutableReplicaStates(value: unknown, collectionId: string): readonly TombstonePurgeReplicaState[] {
  if (!Array.isArray(value)) throw new TypeError('Tombstone purge Replica states must be an array.');
  const seen = new Set<string>();
  return Object.freeze(value.map((entry, index) => {
    const state = exactDataObject(
      entry,
      new Set(['replicaId', 'collectionId', 'lifecycle', 'acknowledgedCommitOrdinal', 'queuedOperationsReconciled']),
      `Tombstone purge Replica state ${index}`,
    );
    const replicaId = nonEmptyString(state.replicaId, `Tombstone purge Replica ${index} replicaId`);
    if (seen.has(replicaId)) throw new TypeError('Tombstone purge Replica IDs must be unique.');
    seen.add(replicaId);
    if (state.collectionId !== collectionId) {
      throw new TypeError('Tombstone purge Replica state belongs to a different Collection.');
    }
    if (!lifecycleValues.has(state.lifecycle)) {
      throw new TypeError('Tombstone purge Replica lifecycle is invalid.');
    }
    if (typeof state.queuedOperationsReconciled !== 'boolean') {
      throw new TypeError('Tombstone purge Replica queue state must be boolean.');
    }
    const acknowledgedCommitOrdinal = state.acknowledgedCommitOrdinal === null
      ? null
      : canonicalOrdinal(state.acknowledgedCommitOrdinal, 'Replica acknowledged commitOrdinal').wire;
    return Object.freeze({
      replicaId,
      collectionId,
      lifecycle: state.lifecycle as ReplicaLifecycle,
      acknowledgedCommitOrdinal,
      queuedOperationsReconciled: state.queuedOperationsReconciled,
    });
  }));
}

function immutableBoundary(value: unknown, collectionId: string): TombstonePurgeBoundary {
  const boundary = exactDataObject(
    value,
    new Set(['collectionId', 'cursor', 'commitOrdinal']),
    'Tombstone purge boundary',
  );
  if (boundary.collectionId !== collectionId) {
    throw new TypeError('Tombstone purge boundary belongs to a different Collection.');
  }
  return Object.freeze({
    collectionId,
    cursor: boundary.cursor === null
      ? null
      : nonEmptyString(boundary.cursor, 'Tombstone purge boundary cursor'),
    commitOrdinal: canonicalOrdinal(boundary.commitOrdinal, 'Tombstone purge boundary commitOrdinal').wire,
  });
}

function authoritativeInstant(value: unknown, label: string): number {
  const wire = rfc3339DateTime(value, label);
  const instant = Date.parse(wire);
  if (!Number.isFinite(instant)) throw new TypeError(`${label} must be a representable date-time.`);
  return instant;
}

function sameWatermark(left: DeletionWatermark, right: DeletionWatermark): boolean {
  return left.serverUuid === right.serverUuid
    && left.collectionId === right.collectionId
    && left.targetId === right.targetId
    && left.generation === right.generation;
}

function immutableWatermark(value: unknown, expected: DeletionWatermark): DeletionWatermark {
  const watermark = exactDataObject(
    value,
    new Set(['serverUuid', 'collectionId', 'targetId', 'generation']),
    'Deletion Watermark',
  );
  const normalized = Object.freeze({
    serverUuid: nonEmptyString(watermark.serverUuid, 'Deletion Watermark serverUuid'),
    collectionId: nonEmptyString(watermark.collectionId, 'Deletion Watermark collectionId'),
    targetId: nonEmptyString(watermark.targetId, 'Deletion Watermark targetId'),
    generation: nonEmptyString(watermark.generation, 'Deletion Watermark generation'),
  });
  if (!sameWatermark(normalized, expected)) {
    throw new TypeError('Deletion Watermark read-back does not match the persisted Watermark.');
  }
  return normalized;
}

function blocked(
  reason: TombstonePurgeBlockedReason,
  blockingReplicaIds: readonly string[] = [],
): TombstonePurgeResult {
  return immutableJsonSnapshot({ state: 'blocked', reason, blockingReplicaIds },
    'Blocked Tombstone purge result', { maxMembers: blockingReplicaIds.length + 4 });
}

/** Coordinates one durable, collection-serialized Tombstone purge transaction. */
export async function coordinateTombstonePurge<
  Transaction extends TombstonePurgeTransaction = TombstonePurgeTransaction,
>(
  unitOfWork: TombstonePurgeUnitOfWork<Transaction>,
  candidateRequest: TombstonePurgeRequest,
): Promise<TombstonePurgeResult> {
  const request = immutableRequest(candidateRequest);
  let callbackInvocations = 0;
  let callbackResult: TombstonePurgeResult | undefined;
  const outcome = await requirePromise(unitOfWork.execute(request.collectionId, async (transaction) => {
    callbackInvocations += 1;
    if (callbackInvocations !== 1) {
      throw new TypeError('Tombstone purge UnitOfWork must invoke its callback exactly once.');
    }
    if (typeof transaction !== 'object' || transaction === null) {
      throw new TypeError('Tombstone purge UnitOfWork must provide a transaction object.');
    }

    const candidateRaw = await requirePromise(
      transaction.loadCandidate(mutableData(request)),
      'Tombstone purge candidate load',
    );
    if (candidateRaw === undefined) {
      callbackResult = blocked('tombstone_not_found');
      return callbackResult;
    }
    const candidate = immutableCandidate(candidateRaw, request);
    const nowRaw = await requirePromise(
      transaction.readAuthoritativeTime(),
      'Tombstone purge authoritative time read',
    );
    const now = authoritativeInstant(nowRaw, 'Tombstone purge authoritative time');
    const replicaStates = immutableReplicaStates(await requirePromise(
      transaction.listReplicaStates(request.collectionId),
      'Tombstone purge Replica-state load',
    ), request.collectionId);
    const currentBoundary = immutableBoundary(await requirePromise(
      transaction.loadPurgeBoundary(request.collectionId),
      'Tombstone purge boundary load',
    ), request.collectionId);

    if (now < authoritativeInstant(candidate.tombstone.purgeAfter, 'Sync Tombstone purgeAfter')) {
      callbackResult = blocked('retention_not_elapsed');
      return callbackResult;
    }
    const deletionOrder = canonicalOrdinal(candidate.deleteCommitOrdinal, 'Tombstone deletion commitOrdinal').order;
    const activeStates = replicaStates.filter(({ lifecycle }) => lifecycle === 'active');
    const missingAcks = activeStates.filter(({ acknowledgedCommitOrdinal }) => (
      acknowledgedCommitOrdinal === null
      || canonicalOrdinal(acknowledgedCommitOrdinal, 'Replica acknowledged commitOrdinal').order < deletionOrder
    )).map(({ replicaId }) => replicaId).sort();
    if (missingAcks.length > 0) {
      callbackResult = blocked('active_replica_ack_missing', missingAcks);
      return callbackResult;
    }
    const unreconciled = activeStates.filter(({ queuedOperationsReconciled }) => (
      !queuedOperationsReconciled
    )).map(({ replicaId }) => replicaId).sort();
    if (unreconciled.length > 0) {
      callbackResult = blocked('active_replica_queue_unreconciled', unreconciled);
      return callbackResult;
    }

    const currentBoundaryOrder = canonicalOrdinal(
      currentBoundary.commitOrdinal,
      'Tombstone purge boundary commitOrdinal',
    ).order;
    if (currentBoundaryOrder === deletionOrder && currentBoundary.cursor !== candidate.tombstone.deleteCursor) {
      throw new TypeError('Tombstone deletion Cursor conflicts with the purge boundary at the same ordinal.');
    }
    const desiredBoundary = currentBoundaryOrder >= deletionOrder
      ? currentBoundary
      : Object.freeze({
          collectionId: request.collectionId,
          cursor: candidate.tombstone.deleteCursor,
          commitOrdinal: candidate.deleteCommitOrdinal,
        });
    await requirePromise(
      transaction.advancePurgedThrough(mutableData(desiredBoundary)),
      'Tombstone purge boundary advance',
    );

    const watermarks = Object.freeze(candidate.deletedMembers.map((member) => Object.freeze({
      serverUuid: request.serverUuid,
      collectionId: request.collectionId,
      targetId: member.targetId,
      generation: member.generation,
    })));
    const batched = typeof transaction.saveDeletionWatermarks === 'function'
      && typeof transaction.loadDeletionWatermarks === 'function';
    if (batched) {
      await requirePromise(
        transaction.saveDeletionWatermarks!(mutableData(watermarks)),
        'Deletion Watermark batch save',
      );
    } else {
      for (const watermark of watermarks) {
        await requirePromise(
          transaction.saveDeletionWatermark(mutableData(watermark)),
          'Deletion Watermark save',
        );
      }
    }
    const identity = Object.freeze({
      collectionId: request.collectionId,
      targetId: request.targetId,
      deleteRevision: candidate.tombstone.deleteRevision,
      operationId: candidate.tombstone.operationId,
    });
    await requirePromise(transaction.deleteTombstone(mutableData(identity)), 'Tombstone delete');

    const persistedBoundary = immutableBoundary(await requirePromise(
      transaction.loadPurgeBoundary(request.collectionId),
      'Tombstone purge boundary read-back',
    ), request.collectionId);
    const persistedOrder = canonicalOrdinal(
      persistedBoundary.commitOrdinal,
      'Persisted Tombstone purge boundary commitOrdinal',
    ).order;
    if (
      persistedOrder < deletionOrder
      || persistedOrder < currentBoundaryOrder
      || (persistedOrder === deletionOrder && persistedBoundary.cursor !== candidate.tombstone.deleteCursor)
    ) {
      throw new TypeError('Tombstone purge boundary did not advance monotonically through the deletion.');
    }
    const persistedWatermarks: DeletionWatermark[] = [];
    let reloadedWatermarks: readonly (DeletionWatermark | undefined)[];
    if (batched) {
      reloadedWatermarks = await requirePromise(
        transaction.loadDeletionWatermarks!(mutableData(watermarks)),
        'Deletion Watermark batch read-back',
      );
      if (!Array.isArray(reloadedWatermarks) || reloadedWatermarks.length !== watermarks.length) {
        throw new TypeError('Deletion Watermark batch read-back must return one entry per Watermark.');
      }
    } else {
      const sequential: (DeletionWatermark | undefined)[] = [];
      for (const watermark of watermarks) {
        sequential.push(await requirePromise(
          transaction.loadDeletionWatermark(mutableData(watermark)),
          'Deletion Watermark read-back',
        ));
      }
      reloadedWatermarks = sequential;
    }
    watermarks.forEach((watermark, index) => {
      const reloaded = reloadedWatermarks[index];
      if (reloaded === undefined) throw new TypeError('Deletion Watermark was not durable after save.');
      persistedWatermarks.push(immutableWatermark(reloaded, watermark));
    });
    const remaining = await requirePromise(
      transaction.loadTombstone(mutableData(request)),
      'Tombstone absence read-back',
    );
    if (remaining !== undefined) {
      immutableTombstone(remaining, request);
      throw new TypeError('Tombstone remained present after physical deletion.');
    }
    callbackResult = immutableJsonSnapshot({
      state: 'purged',
      tombstone: candidate.tombstone,
      purgeBoundary: persistedBoundary,
      deletionWatermarks: persistedWatermarks,
    } as const, 'Tombstone purge result', { maxMembers: persistedWatermarks.length * 5 + 32 });
    return callbackResult;
  }), 'Tombstone purge UnitOfWork execute');

  if (callbackInvocations !== 1 || callbackResult === undefined) {
    throw new TypeError('Tombstone purge UnitOfWork must invoke its callback exactly once.');
  }
  if (outcome !== callbackResult) {
    throw new TypeError('Tombstone purge UnitOfWork returned a forged transaction callback result.');
  }
  // Every field was validated and frozen inside the transaction, and identity
  // above proves this is that exact result. Re-cloning after commit imposes a
  // second aggregate limit that can report failure after a successful purge.
  return callbackResult;
}
