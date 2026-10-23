/** Bounded single-process Plan and Approval stores with single-winner replay. */
import { types as nodeTypes } from 'node:util';
import type {
  McpApprovalStorePort,
  McpChangePlanClockPort,
  McpChangePlanStorePort,
  McpPlanCommitResult,
  McpStoredPlan,
} from './change-plan-types.js';
import { type McpAuthenticatedAuthorizationBinding } from './shared/authorization.js';

export type McpInMemoryStoreCapacity =
  | 'plans'
  | 'approvals'
  | 'commit_results'
  | 'inflight';

/** Stable, observable rejection when a bounded in-memory store is full. */
export class McpInMemoryStoreCapacityError extends Error {
  readonly code = 'in_memory_store_capacity_exceeded' as const;
  readonly store: McpInMemoryStoreCapacity;
  readonly capacity: number;

  constructor(store: McpInMemoryStoreCapacity, capacity: number) {
    super(`In-memory ${store} capacity of ${capacity} was reached.`);
    this.name = 'McpInMemoryStoreCapacityError';
    this.store = store;
    this.capacity = capacity;
  }
}

export const MCP_IN_MEMORY_PLAN_STORE_DEFAULT_MAX_PLANS = 1_000;

export const MCP_IN_MEMORY_APPROVAL_STORE_DEFAULT_MAX_APPROVALS = 1_000;

export const MCP_IN_MEMORY_APPROVAL_STORE_DEFAULT_MAX_COMMIT_RESULTS = 1_000;

export const MCP_IN_MEMORY_APPROVAL_STORE_DEFAULT_MAX_INFLIGHT = 100;

export const MCP_IN_MEMORY_APPROVAL_STORE_DEFAULT_IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1_000;

export interface McpInMemoryPlanStoreOptions {
  /** Defaults to the system clock. */
  readonly clock?: McpChangePlanClockPort;
  /** Defaults to MCP_IN_MEMORY_PLAN_STORE_DEFAULT_MAX_PLANS. */
  readonly maxPlans?: number;
}

export interface McpInMemoryPlanStoreCleanupResult {
  readonly plans: number;
}

export interface McpInMemoryPlanStoreStats {
  readonly plans: number;
}

export interface McpInMemoryPlanStore extends McpChangePlanStorePort {
  /** Deletes a Plan explicitly. */
  readonly deletePlan: (planId: string) => boolean;
  /** Removes Plans whose expiresAt instant has elapsed. */
  readonly cleanup: () => McpInMemoryPlanStoreCleanupResult;
  readonly stats: () => McpInMemoryPlanStoreStats;
}

export interface McpInMemoryApprovalStoreOptions {
  /** Defaults to the system clock. */
  readonly clock?: McpChangePlanClockPort;
  /** Active and consumed Approval capacity. */
  readonly maxApprovals?: number;
  /** Retained first-result capacity, including reservations for inflight commits. */
  readonly maxCommitResults?: number;
  /** Concurrent leader capacity. Inflight leaders are never expired automatically. */
  readonly maxInflight?: number;
  /**
   * Minimum first-result retention after finalize, in milliseconds. Defaults
   * to MCP_IN_MEMORY_APPROVAL_STORE_DEFAULT_IDEMPOTENCY_RETENTION_MS.
   */
  readonly idempotencyRetentionMs?: number;
}

export interface McpInMemoryApprovalStoreCleanupResult {
  readonly approvals: number;
  readonly commitResults: number;
  readonly inflight: number;
}

export interface McpInMemoryApprovalStoreStats {
  readonly approvals: number;
  readonly commitResults: number;
  readonly inflight: number;
}

export interface McpInMemoryApprovalStore extends McpApprovalStorePort {
  /**
   * Deletes an Approval explicitly. Returns false while its commit is in flight;
   * an explicit deletion also removes that Plan's retained idempotency results.
   */
  readonly deletePlan: (planId: string) => boolean;
  /** Removes results, then consumed Approvals, after idempotency retention. */
  readonly cleanup: () => McpInMemoryApprovalStoreCleanupResult;
  readonly stats: () => McpInMemoryApprovalStoreStats;
}

type InflightCommit = {
  readonly idempotencyKey: string;
  /** Resolves with firstResult on finalize, or null on abort (joiners re-compete). */
  readonly gate: Promise<McpPlanCommitResult | null>;
  readonly resolve: (value: McpPlanCommitResult | null) => void;
};

type InMemoryApproval = {
  readonly binding: McpAuthenticatedAuthorizationBinding;
  readonly operationsDigest: string;
  consumed: boolean;
  consumedAtMilliseconds: number | undefined;
};

type RetainedCommitResult = {
  readonly planId: string;
  readonly result: McpPlanCommitResult;
  readonly storedAtMilliseconds: number;
};

function inMemoryCommitResultKey(planId: string, idempotencyKey: string): string {
  return JSON.stringify([planId, idempotencyKey]);
}

/**
 * Bounded in-memory approval store for tests and single-process hosts.
 * Production hosts should replace this with durable begin/finalize storage.
 *
 * Consume happens only in finalizeCommit (after successful execute). abortCommit
 * releases the lock so a failed execute can be retried without re-approval.
 *
 * Single-flight: concurrent beginCommit with the same planId + idempotencyKey
 * joins the in-flight leader and returns already_consumed with firstResult
 * (executor runs once). Different keys while inflight lose with concurrent_lost.
 */
export function createInMemoryApprovalStore(
  options?: McpInMemoryApprovalStoreOptions,
): McpInMemoryApprovalStore {
  const resolved = resolveInMemoryApprovalStoreOptions(options);
  const approvals = new Map<string, InMemoryApproval>();
  const commitResults = new Map<string, RetainedCommitResult>();
  const inflight = new Map<string, InflightCommit>();

  const cleanupAt = (nowMilliseconds: number): McpInMemoryApprovalStoreCleanupResult => {
    let removedCommitResults = 0;
    const retainedPlanIds = new Set<string>();
    for (const [key, retained] of commitResults) {
      if (
        nowMilliseconds - retained.storedAtMilliseconds
        >= resolved.idempotencyRetentionMs
      ) {
        commitResults.delete(key);
        removedCommitResults += 1;
      } else {
        retainedPlanIds.add(retained.planId);
      }
    }

    let removedApprovals = 0;
    for (const [planId, approval] of approvals) {
      if (
        approval.consumed
        && approval.consumedAtMilliseconds !== undefined
        && nowMilliseconds - approval.consumedAtMilliseconds
        >= resolved.idempotencyRetentionMs
        && !retainedPlanIds.has(planId)
        && !inflight.has(planId)
      ) {
        approvals.delete(planId);
        removedApprovals += 1;
      }
    }

    return Object.freeze({
      approvals: removedApprovals,
      commitResults: removedCommitResults,
      inflight: 0,
    });
  };

  const cleanup = (): McpInMemoryApprovalStoreCleanupResult => cleanupAt(
    readInMemoryClock(resolved.clock),
  );

  const markApproved: McpApprovalStorePort['markApproved'] = (input) => {
    cleanup();
    if (!approvals.has(input.planId) && approvals.size >= resolved.maxApprovals) {
      throw new McpInMemoryStoreCapacityError('approvals', resolved.maxApprovals);
    }
    approvals.set(input.planId, {
      binding: input.binding,
      operationsDigest: input.operationsDigest,
      consumed: false,
      consumedAtMilliseconds: undefined,
    });
  };

  const beginCommit: McpApprovalStorePort['beginCommit'] = async (input) => {
    cleanup();
    const replayKey = inMemoryCommitResultKey(input.planId, input.idempotencyKey);

    // Fast path: firstResult already stored (idempotent replay).
    const prior = commitResults.get(replayKey);
    if (prior !== undefined) {
      return Object.freeze({ status: 'already_consumed' as const, firstResult: prior.result });
    }

    const approval = approvals.get(input.planId);
    if (approval === undefined) {
      return Object.freeze({ status: 'rejected' as const, reason: 'missing' as const });
    }
    if (
      approval.binding.kind !== input.binding.kind
      || approval.binding.principalId !== input.binding.principalId
      || approval.binding.clientId !== input.binding.clientId
      || approval.binding.credentialBindingId !== input.binding.credentialBindingId
      || approval.binding.resourceAudience !== input.binding.resourceAudience
      || approval.binding.securityEpoch !== input.binding.securityEpoch
    ) {
      return Object.freeze({ status: 'rejected' as const, reason: 'binding_mismatch' as const });
    }
    if (approval.operationsDigest !== input.operationsDigest) {
      return Object.freeze({ status: 'rejected' as const, reason: 'digest_mismatch' as const });
    }
    if (approval.consumed) {
      // Consumed without this idempotency key's firstResult → concurrent loser.
      return Object.freeze({ status: 'rejected' as const, reason: 'concurrent_lost' as const });
    }

    const existing = inflight.get(input.planId);
    if (existing !== undefined) {
      if (existing.idempotencyKey !== input.idempotencyKey) {
        return Object.freeze({ status: 'rejected' as const, reason: 'concurrent_lost' as const });
      }
      // Same key: single-flight join — do not start a second execute.
      const joined = await existing.gate;
      if (joined !== null) {
        return Object.freeze({ status: 'already_consumed' as const, firstResult: joined });
      }
      // Leader aborted without storing a result — re-compete for the lock.
      return beginCommit(input);
    }

    if (inflight.size >= resolved.maxInflight) {
      throw new McpInMemoryStoreCapacityError('inflight', resolved.maxInflight);
    }
    // Reserve result capacity before execution. A successful execute must never
    // discover only at finalize time that its first result cannot be retained.
    if (commitResults.size + inflight.size >= resolved.maxCommitResults) {
      throw new McpInMemoryStoreCapacityError(
        'commit_results',
        resolved.maxCommitResults,
      );
    }

    // Claim single-winner leadership (sync claim; no await between check and set).
    let resolve!: (value: McpPlanCommitResult | null) => void;
    const gate = new Promise<McpPlanCommitResult | null>((r) => {
      resolve = r;
    });
    inflight.set(input.planId, Object.freeze({
      idempotencyKey: input.idempotencyKey,
      gate,
      resolve,
    }));
    return Object.freeze({ status: 'ready' as const });
  };

  const finalizeCommit: McpApprovalStorePort['finalizeCommit'] = (input) => {
    const held = inflight.get(input.planId);
    const ownsInflight = held?.idempotencyKey === input.idempotencyKey;
    let firstResult: McpPlanCommitResult | null = null;
    try {
      const nowMilliseconds = readInMemoryClock(resolved.clock);
      cleanupAt(nowMilliseconds);
      const replayKey = inMemoryCommitResultKey(input.planId, input.idempotencyKey);
      const prior = commitResults.get(replayKey);
      if (
        prior === undefined
        && !ownsInflight
        && commitResults.size + inflight.size >= resolved.maxCommitResults
      ) {
        throw new McpInMemoryStoreCapacityError(
          'commit_results',
          resolved.maxCommitResults,
        );
      }

      if (prior === undefined) {
        // Store firstResult before consuming approval or releasing waiters.
        commitResults.set(replayKey, Object.freeze({
          planId: input.planId,
          result: input.result,
          storedAtMilliseconds: nowMilliseconds,
        }));
        firstResult = input.result;
      } else {
        firstResult = prior.result;
      }

      const approval = approvals.get(input.planId);
      if (approval !== undefined) {
        approval.consumed = true;
        approval.consumedAtMilliseconds = nowMilliseconds;
      }
    } finally {
      if (ownsInflight && held !== undefined) {
        inflight.delete(input.planId);
        // null lets joiners re-compete when finalization failed before storage.
        held.resolve(firstResult);
      }
    }
  };

  const abortCommit: McpApprovalStorePort['abortCommit'] = (input) => {
    const held = inflight.get(input.planId);
    if (held !== undefined && held.idempotencyKey === input.idempotencyKey) {
      inflight.delete(input.planId);
      // null signals joiners that no firstResult exists; they may re-compete.
      held.resolve(null);
    }
  };

  const deletePlan = (planId: string): boolean => {
    cleanup();
    if (inflight.has(planId)) return false;
    let deleted = approvals.delete(planId);
    for (const [key, retained] of commitResults) {
      if (retained.planId === planId) {
        commitResults.delete(key);
        deleted = true;
      }
    }
    return deleted;
  };
  const stats = (): McpInMemoryApprovalStoreStats => Object.freeze({
    approvals: approvals.size,
    commitResults: commitResults.size,
    inflight: inflight.size,
  });

  return Object.freeze({
    markApproved,
    beginCommit,
    finalizeCommit,
    abortCommit,
    deletePlan,
    cleanup,
    stats,
  });
}

/**
 * Bounded in-memory plan store for tests and single-process hosts. Durable
 * multi-process hosts should provide their own McpChangePlanStorePort.
 */
export function createInMemoryPlanStore(
  options?: McpInMemoryPlanStoreOptions,
): McpInMemoryPlanStore {
  const resolved = resolveInMemoryPlanStoreOptions(options);
  const plans = new Map<string, McpStoredPlan>();

  const cleanupAt = (nowMilliseconds: number): McpInMemoryPlanStoreCleanupResult => {
    let removed = 0;
    for (const [planId, plan] of plans) {
      if (readPlanExpiry(plan) <= nowMilliseconds) {
        plans.delete(planId);
        removed += 1;
      }
    }
    return Object.freeze({ plans: removed });
  };
  const cleanup = (): McpInMemoryPlanStoreCleanupResult => cleanupAt(
    readInMemoryClock(resolved.clock),
  );

  const put = (plan: McpStoredPlan): void => {
    readPlanExpiry(plan);
    if (!plans.has(plan.planId) && plans.size >= resolved.maxPlans) {
      cleanup();
      if (plans.size >= resolved.maxPlans) {
        throw new McpInMemoryStoreCapacityError('plans', resolved.maxPlans);
      }
    }
    plans.set(plan.planId, plan);
  };
  const save: McpChangePlanStorePort['save'] = (plan) => {
    put(plan);
  };
  const get: McpChangePlanStorePort['get'] = (planId) => plans.get(planId);
  const update: McpChangePlanStorePort['update'] = (plan) => {
    put(plan);
  };
  const deletePlan = (planId: string): boolean => plans.delete(planId);
  const stats = (): McpInMemoryPlanStoreStats => Object.freeze({ plans: plans.size });
  return Object.freeze({ save, get, update, deletePlan, cleanup, stats });
}

type ResolvedInMemoryPlanStoreOptions = {
  readonly clock: McpChangePlanClockPort;
  readonly maxPlans: number;
};

type ResolvedInMemoryApprovalStoreOptions = {
  readonly clock: McpChangePlanClockPort;
  readonly maxApprovals: number;
  readonly maxCommitResults: number;
  readonly maxInflight: number;
  readonly idempotencyRetentionMs: number;
};

function resolveInMemoryPlanStoreOptions(
  options: McpInMemoryPlanStoreOptions | undefined,
): ResolvedInMemoryPlanStoreOptions {
  const value = readInMemoryStoreOptions(options, 'createInMemoryPlanStore');
  return Object.freeze({
    clock: readInMemoryStoreClock(value),
    maxPlans: readInMemoryStoreInteger(
      value,
      'maxPlans',
      MCP_IN_MEMORY_PLAN_STORE_DEFAULT_MAX_PLANS,
      false,
    ),
  });
}

function resolveInMemoryApprovalStoreOptions(
  options: McpInMemoryApprovalStoreOptions | undefined,
): ResolvedInMemoryApprovalStoreOptions {
  const value = readInMemoryStoreOptions(options, 'createInMemoryApprovalStore');
  return Object.freeze({
    clock: readInMemoryStoreClock(value),
    maxApprovals: readInMemoryStoreInteger(
      value,
      'maxApprovals',
      MCP_IN_MEMORY_APPROVAL_STORE_DEFAULT_MAX_APPROVALS,
      false,
    ),
    maxCommitResults: readInMemoryStoreInteger(
      value,
      'maxCommitResults',
      MCP_IN_MEMORY_APPROVAL_STORE_DEFAULT_MAX_COMMIT_RESULTS,
      false,
    ),
    maxInflight: readInMemoryStoreInteger(
      value,
      'maxInflight',
      MCP_IN_MEMORY_APPROVAL_STORE_DEFAULT_MAX_INFLIGHT,
      false,
    ),
    idempotencyRetentionMs: readInMemoryStoreInteger(
      value,
      'idempotencyRetentionMs',
      MCP_IN_MEMORY_APPROVAL_STORE_DEFAULT_IDEMPOTENCY_RETENTION_MS,
      true,
    ),
  });
}

function readInMemoryStoreOptions(
  options: object | undefined,
  factoryName: string,
): object {
  if (options === undefined) return Object.freeze({});
  if (typeof options !== 'object' || options === null || nodeTypes.isProxy(options)) {
    throw new TypeError(`${factoryName} options must be an object.`);
  }
  return options;
}

function readInMemoryStoreClock(options: object): McpChangePlanClockPort {
  const descriptor = Object.getOwnPropertyDescriptor(options, 'clock');
  if (descriptor === undefined) return Object.freeze({ now: () => new Date() });
  if (
    !('value' in descriptor)
    || typeof descriptor.value !== 'object'
    || descriptor.value === null
    || nodeTypes.isProxy(descriptor.value)
  ) {
    throw new TypeError('clock must be an own-data object when provided.');
  }
  const nowDescriptor = Object.getOwnPropertyDescriptor(descriptor.value, 'now');
  if (
    nowDescriptor === undefined
    || !('value' in nowDescriptor)
    || typeof nowDescriptor.value !== 'function'
    || nodeTypes.isProxy(nowDescriptor.value)
  ) {
    throw new TypeError('clock.now must be an own-data function.');
  }
  return Object.freeze({
    now: () => Reflect.apply(nowDescriptor.value, descriptor.value, []) as Date,
  });
}

function readInMemoryStoreInteger(
  options: object,
  name: string,
  defaultValue: number,
  allowZero: boolean,
): number {
  const descriptor = Object.getOwnPropertyDescriptor(options, name);
  if (descriptor === undefined) return defaultValue;
  if (
    !('value' in descriptor)
    || !Number.isSafeInteger(descriptor.value)
    || (allowZero ? descriptor.value < 0 : descriptor.value <= 0)
  ) {
    throw new RangeError(
      `${name} must be ${allowZero ? 'a non-negative' : 'a positive'} safe integer.`,
    );
  }
  return descriptor.value as number;
}

function readInMemoryClock(clock: McpChangePlanClockPort): number {
  const now = clock.now();
  if (!(now instanceof Date)) {
    throw new TypeError('clock.now must return a Date.');
  }
  const milliseconds = Date.prototype.getTime.call(now);
  if (!Number.isFinite(milliseconds)) {
    throw new RangeError('clock.now returned an invalid Date.');
  }
  return milliseconds;
}

function readPlanExpiry(plan: McpStoredPlan): number {
  const expiresAt = Date.parse(plan.expiresAt);
  if (!Number.isFinite(expiresAt)) {
    throw new TypeError('Plan expiresAt must be a representable date-time.');
  }
  return expiresAt;
}
