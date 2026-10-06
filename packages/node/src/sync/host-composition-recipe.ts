/**
 * Official host composition recipe for COLP Sync (SYNC-0017).
 *
 * Builds **on top of** bare durable coordinators and the thin session-bound gates in
 * `composition.ts`. Does **not** embed Sequence inside Push (or the reverse) and does
 * **not** provide a dual-owner “sequenced push” facade.
 *
 * ## Required host order
 *
 * 1. Verify Session, then `createSyncHost({ owner, session })` from `./host.ts`
 * 2. Exclusive write owner: Sequence **or** Push (never both for one request boundary)
 * 3. Pull via `host.pull` (session-bound defaults)
 * 4. Typed-update Push preflight **must** call {@link mergeSyncTypedUpdate}
 *    (Base / Current / Incoming) before apply — use
 *    {@link createTypedUpdateMergePushPreflight} so hosts cannot skip the glue
 */

import { requirePromise } from './internal-guards.js';
import type { Operation } from '../types/index.js';
import { immutableJsonData } from '../shared/immutable-json.js';
import type {
  PurePushPreflight,
  PushConflictRecord,
  PushPreparedOperation,
  PushPreflightContext,
  PushTransactionOperation,
} from './push-transaction.js';
import {
  assertSyncTypedUpdateOperationPayload,
  type SyncTypedUpdateOperation,
} from './typed-operations.js';
import {
  applySyncTypedUpdatePatch,
  mergeSyncTypedUpdate,
  type SyncTypedMergeConflict,
  type SyncTypedMergeResult,
} from './typed-update-merge.js';

const TYPED_UPDATE_OPERATION_TYPES = Object.freeze([
  'update_collection_metadata',
  'update_node_content',
  'update_annotation',
  'update_attachment',
  'update_relation',
] as const);

export type SyncTypedUpdateOperationType = (typeof TYPED_UPDATE_OPERATION_TYPES)[number];

/**
 * Frozen checklist for production hosts. Complements
 * {@link SYNC_HOST_COMPOSITION_NOTES} with the merge-in-preflight obligation.
 */
export const SYNC_HOST_COMPOSITION_RECIPE = Object.freeze({
  sessionFirst:
    'Gate every mutating Sync path with verifySyncSessionContext / requireVerifiedSyncSession, then createSyncHost({ owner, session }). coordinateSessionBoundPush | coordinateSessionBoundPull | coordinateSessionBoundSequence remain the primitives the host wraps.',
  exclusiveWriteOwner:
    'Choose exactly one opId reservation owner per write path via createSyncHost({ owner: "sequence" }) OR createSyncHost({ owner: "push" }). Never nest coordinateSequenceOperation and coordinatePushTransaction; there is no dual-owner sequenced-push facade.',
  pullAfterSession:
    'Call host.pull or coordinateSessionBoundPull for Pull; Pull does not own opId reservation. Bare coordinateSyncPull is ./sync/unsafe only.',
  typedUpdateMergeInPreflight:
    'For typed update operations (update_*), Push preflight MUST call mergeSyncTypedUpdate({ base, current, incoming }) before apply. Prefer createTypedUpdateMergePushPreflight so the three-way merge cannot be skipped.',
  bareCoordinatorsRemainCompositionFree:
    'Bare coordinators live on ./sync/unsafe and stay composition-free; this recipe builds on createSyncHost and composition.ts session gates.',
  recommendedSessionBoundPushPath:
    'Session gate → createSyncHost({ owner: "push", session }).push which wraps coordinateSessionBoundPush(unitOfWork, request with session-bound batchId via bindSyncPushBatchId, createTypedUpdateMergePushPreflight({ loadCurrent, planMerged, planConflict, planOther })).',
  recommendedSessionBoundSequencePath:
    'Session gate → createSyncHost({ owner: "sequence", session }).sequence which wraps coordinateSessionBoundSequence as the sole write owner when lane continuity (sequence_gap / sequence_blocked) is required; do not also call Push for that boundary.',
  recommendedSessionBoundPullPath:
    'Session gate → host.pull / coordinateSessionBoundPull after verify; bind principal / collection / session / protocolVersion. Session-bound Pull defaults assertSnapshotUrlSafe to rejectPrivateOrLocalSnapshotUrl (hosts that fetch Snapshot URLs should keep or tighten this; bare coordinateSyncPull stays transport-only on ./sync/unsafe).',
  snapshotUrlHostPolicy:
    'Anyone who fetches expired-cursor Snapshot URLs owns SSRF policy. Prefer session-bound Pull defaults or pass assertSnapshotUrlSafe / withRecommendedSnapshotUrlHostPolicy. The built-in rejector is pure hostname/IP-literal only (no DNS); use allowlists for production fetchers.',
} as const);

/**
 * Documentation-only names of the two exclusive write paths and Pull.
 * Does not run coordinators or claim opIds.
 */
export const SYNC_HOST_RECOMMENDED_WRITE_PATHS = Object.freeze({
  sessionBoundPush: 'coordinateSessionBoundPush',
  sessionBoundSequence: 'coordinateSessionBoundSequence',
  sessionBoundPull: 'coordinateSessionBoundPull',
  exclusiveOwners: Object.freeze(['sequence', 'push'] as const),
} as const);

/** True when `type` is one of the five typed Sync update operation kinds. */
export function isSyncTypedUpdateOperationType(
  type: string,
): type is SyncTypedUpdateOperationType {
  return (TYPED_UPDATE_OPERATION_TYPES as readonly string[]).includes(type);
}

/** Narrows a canonical Operation to a typed update after type-tag check. */
export function isSyncTypedUpdateOperation(
  operation: Operation,
): operation is SyncTypedUpdateOperation {
  return isSyncTypedUpdateOperationType(operation.type);
}

/**
 * Context after a successful three-way merge. Hosts build an applied/rebased
 * (or host-chosen) {@link PushPreparedOperation} from `merged`.
 */
export type TypedUpdateMergeMergedPlanContext = {
  readonly item: PushTransactionOperation;
  readonly index: number;
  readonly operation: SyncTypedUpdateOperation;
  readonly base: Readonly<Record<string, unknown>>;
  readonly current: Readonly<Record<string, unknown>>;
  readonly incoming: Readonly<Record<string, unknown>>;
  /** Domain patch from {@link mergeSyncTypedUpdate}; apply onto current projection. */
  readonly merged: Readonly<Record<string, unknown>>;
  readonly mergeResult: Extract<SyncTypedMergeResult, { readonly status: 'merged' }>;
};

/**
 * Context when Base/Current/Incoming diverge. Hosts build a conflicted plan
 * (conflict records, allowed resolutions, etc.).
 */
export type TypedUpdateMergeConflictPlanContext = {
  readonly item: PushTransactionOperation;
  readonly index: number;
  readonly operation: SyncTypedUpdateOperation;
  readonly base: Readonly<Record<string, unknown>>;
  readonly current: Readonly<Record<string, unknown>>;
  readonly incoming: Readonly<Record<string, unknown>>;
  readonly conflicts: readonly SyncTypedMergeConflict[];
  readonly mergeResult: Extract<SyncTypedMergeResult, { readonly status: 'conflict' }>;
};

export type TypedUpdateMergePushPreflightHandlers<
  Transaction,
  Conflict extends PushConflictRecord,
  Audit,
  Outbox,
> = {
  /**
   * Load the server resource projection for three-way merge `current`.
   * Must return a plain data object (own enumerable string data properties).
   */
  readonly loadCurrent: (
    operation: SyncTypedUpdateOperation,
    item: PushTransactionOperation,
    index: number,
    evaluationContext?: PushPreflightContext,
  ) => Promise<Readonly<Record<string, unknown>>>;
  /**
   * Build the Push plan after a successful merge. The apply callback SHOULD
   * persist `merged` onto the loaded current projection (not raw incoming).
   */
  readonly planMerged: (
    context: TypedUpdateMergeMergedPlanContext,
    evaluationContext?: PushPreflightContext,
  ) => Promise<PushPreparedOperation<Transaction, Conflict, Audit, Outbox>>;
  /**
   * Build the Push plan when merge reports field conflicts.
   * Typically returns `status: 'conflicted'`.
   */
  readonly planConflict: (
    context: TypedUpdateMergeConflictPlanContext,
    evaluationContext?: PushPreflightContext,
  ) => Promise<PushPreparedOperation<Transaction, Conflict, Audit, Outbox>>;
  /**
   * Plan non-typed-update operations (create/delete/move/…). Required so the
   * preflight remains total for mixed batches.
   */
  readonly planOther: (
    item: PushTransactionOperation,
    index: number,
    evaluationContext?: PushPreflightContext,
  ) => Promise<PushPreparedOperation<Transaction, Conflict, Audit, Outbox>>;
};

/**
 * Builds a {@link PurePushPreflight} that **always** runs
 * {@link mergeSyncTypedUpdate} for typed update operations before the host
 * constructs an apply plan.
 *
 * Flow per batch item:
 * 1. Non-typed update → `planOther`
 * 2. Typed update → assert SYNC-0016 payload key-set, `loadCurrent`, then
 *    `mergeSyncTypedUpdate({ base, current, incoming })` where base/incoming
 *    come from `operation.payload`
 * 3. `status: 'merged'` → `planMerged` with the merged domain value
 * 4. `status: 'conflict'` → `planConflict` with field conflicts
 *
 * Fail-closed: missing/invalid base/value payload shapes throw `TypeError`.
 * The returned preflight does not commit state; durable writes stay in plan
 * apply/audit/outbox callbacks inside the Push UnitOfWork.
 * All callbacks receive the same immutable evaluation context when supplied,
 * including the previous receipt during deferred re-evaluation. The atomic
 * batch token retains its identity for request-local projection tracking.
 */
export function createTypedUpdateMergePushPreflight<
  Transaction,
  Conflict extends PushConflictRecord,
  Audit,
  Outbox,
>(
  handlers: TypedUpdateMergePushPreflightHandlers<Transaction, Conflict, Audit, Outbox>,
): PurePushPreflight<Transaction, Conflict, Audit, Outbox> {
  assertHandlers(handlers);
  // Request-local virtual state: only applied/rebased typed patches are predictable.
  const batches = new WeakMap<object, Map<string, Readonly<Record<string, unknown>> | null>>();

  return async function typedUpdateMergePushPreflight(
    item: PushTransactionOperation,
    index: number,
    context?: PushPreflightContext,
  ): Promise<PushPreparedOperation<Transaction, Conflict, Audit, Outbox>> {
    if (!Number.isSafeInteger(index) || index < 0) {
      throw new TypeError('Push preflight index must be a non-negative safe integer.');
    }

    const evaluationArgs: [] | [PushPreflightContext] = context === undefined ? [] : [Object.freeze({
      ...(context.previousDeferredReceipt === undefined ? {} : {
        previousDeferredReceipt: immutableJsonData(context.previousDeferredReceipt, 'Previous deferred receipt'),
      }),
      ...(context.atomicBatch === undefined ? {} : { atomicBatch: context.atomicBatch }),
    })];

    const operation = item.operation;
    let projections: Map<string, Readonly<Record<string, unknown>> | null> | undefined;
    if (context?.atomicBatch !== undefined) {
      projections = batches.get(context.atomicBatch);
      if (projections === undefined) {
        projections = new Map();
        batches.set(context.atomicBatch, projections);
      }
    }
    // Creates have no server-assigned target yet. Their operation identity must
    // not alias another create or an existing target with the same opaque ID.
    const target = operation.targetId === undefined
      ? JSON.stringify(['new', operation.collectionId, operation.opId])
      : JSON.stringify(['existing', operation.collectionId, operation.targetId]);
    const projected = projections?.get(target);
    if (projected === null || (projected !== undefined && !isSyncTypedUpdateOperation(operation))) {
      throw new TypeError('Atomic mixed operations on the same target require a host-provided projected preflight.');
    }
    if (!isSyncTypedUpdateOperation(operation)) {
      projections?.set(target, null);
      return handlers.planOther(item, index, ...evaluationArgs);
    }

    assertSyncTypedUpdateOperationPayload(operation);
    const { base, incoming } = extractTypedUpdateBaseAndIncoming(operation);
    const loaded = await requirePromise(
      handlers.loadCurrent(operation, item, index, ...evaluationArgs),
      'Typed update loadCurrent',
    );
    assertPlainMergeProjection(loaded, 'current');
    const current = immutableJsonData(projected ?? loaded, 'Typed update current projection');

    const mergeResult = mergeSyncTypedUpdate({ base, current, incoming });

    if (mergeResult.status === 'conflict') {
      return handlers.planConflict(
        Object.freeze({
          item,
          index,
          operation,
          base,
          current,
          incoming,
          conflicts: mergeResult.conflicts,
          mergeResult,
        }),
        ...evaluationArgs,
      );
    }

    const plan = await handlers.planMerged(
      Object.freeze({
        item,
        index,
        operation,
        base,
        current,
        incoming,
        merged: mergeResult.value,
        mergeResult,
      }),
      ...evaluationArgs,
    );
    if (plan.status === 'applied' || plan.status === 'rebased') {
      projections?.set(target, applySyncTypedUpdatePatch(current, mergeResult.value));
    }
    return plan;
  };
}

function assertHandlers(handlers: {
  readonly loadCurrent?: unknown;
  readonly planMerged?: unknown;
  readonly planConflict?: unknown;
  readonly planOther?: unknown;
}): void {
  if (typeof handlers !== 'object' || handlers === null || Array.isArray(handlers)) {
    throw new TypeError('Typed update merge push preflight handlers must be a plain object.');
  }
  if (typeof handlers.loadCurrent !== 'function') {
    throw new TypeError('Typed update merge push preflight loadCurrent must be a function.');
  }
  if (typeof handlers.planMerged !== 'function') {
    throw new TypeError('Typed update merge push preflight planMerged must be a function.');
  }
  if (typeof handlers.planConflict !== 'function') {
    throw new TypeError('Typed update merge push preflight planConflict must be a function.');
  }
  if (typeof handlers.planOther !== 'function') {
    throw new TypeError('Typed update merge push preflight planOther must be a function.');
  }
}

function extractTypedUpdateBaseAndIncoming(operation: SyncTypedUpdateOperation): {
  readonly base: Readonly<Record<string, unknown>>;
  readonly incoming: Readonly<Record<string, unknown>>;
} {
  // assertSyncTypedUpdateOperationPayload already proved payload is a strict
  // data object whose base/value members are plain merge projections.
  const payload = operation.payload as {
    readonly base: Readonly<Record<string, unknown>>;
    readonly value: Readonly<Record<string, unknown>>;
  };
  return Object.freeze({ base: payload.base, incoming: payload.value });
}

function assertPlainMergeProjection(
  candidate: unknown,
  label: string,
): asserts candidate is Readonly<Record<string, unknown>> {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw new TypeError(`Typed update merge ${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(candidate);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`Typed update merge ${label} must have a plain or null prototype.`);
  }
  for (const key of Reflect.ownKeys(candidate)) {
    if (typeof key !== 'string') {
      throw new TypeError(`Typed update merge ${label} must not have symbol keys.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(
        `Typed update merge ${label} members must be own enumerable data properties.`,
      );
    }
  }
}
