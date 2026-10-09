/**
 * MCP-0004: typed Change Plan, server-bound out-of-band Approval, and Commit
 * revalidation with compare-and-consume + idempotent single-winner semantics.
 *
 * Host owns durable plan/approval storage and the user-visible approval UI.
 * The model cannot mint approve booleans or hold approval secrets.
 */

import { createHash, randomUUID } from 'node:crypto';
import { types as nodeTypes } from 'node:util';

import { createValidatorRegistry } from '../schema/index.js';
import { encodePlainCanonicalJson } from '../shared/plain-canonical-json.js';
import type {
  ChangePlan,
  ChangePlanImpact,
  ChangePlanOperation,
  ChangePlanRequest,
  HttpUrl,
  OperationResult,
  ScopeName,
} from '../types/generated.js';
import {
  assessCanonicalOperations,
  type RiskLevel,
} from './risk-aggregation.js';
import {
  authorizeMcpHttpUri,
  resolveMcpHttpUriPolicy,
  type McpHttpUriPolicyPort,
  type ResolvedMcpHttpUriPolicy,
} from './http-uri-policy.js';
import { redactCommitStructuredContent } from './secret-redaction.js';
import { allowChangePlanAdmission, readChangePlanRateLimitPort } from './change-plan-rate-limit.js';
import {
  resolveMcpWriteInputBudget,
  snapshotMcpData,
  type McpWriteInputBudget,
} from './safe-data.js';
import { deriveRequiredScopes, deriveMcpOperationRequiredScopes } from './change-plan-scopes.js';
export { deriveMcpOperationRequiredScopes };
import {
  requireAuthenticatedWriteBinding,
  snapshotMcpAuthorizationBinding,
  type McpAuthenticatedAuthorizationBinding,
} from './shared/authorization.js';

const validators = createValidatorRegistry();
const NativePromise = Promise;
const nativePromisePrototype = Promise.prototype;
const nativePromiseThen = Promise.prototype.then;
const nativePromiseSpeciesGetter = Object.getOwnPropertyDescriptor(Promise, Symbol.species)?.get;

export type McpStoredPlan = {
  readonly planId: string;
  readonly expiresAt: string;
  readonly risk: RiskLevel;
  readonly requiresApproval: boolean;
  readonly approvalMethod?: string;
  readonly approvalUri?: string;
  readonly summary: string;
  readonly impact: ChangePlanImpact;
  readonly requiredScopes: readonly ScopeName[];
  readonly baseRevisions: Readonly<Record<string, string>>;
  readonly operations: readonly ChangePlanOperation[];
  readonly operationsDigest: string;
  readonly binding: McpAuthenticatedAuthorizationBinding;
  /** Untrusted model/user note. Never interpolate into approval summary text. */
  readonly untrustedNote: string;
  readonly createdAt: string;
  readonly status: 'pending' | 'approved' | 'committing' | 'consumed' | 'cancelled' | 'expired';
};

export type McpPlanCommitResult = {
  readonly planId: string;
  readonly committedAt: string;
  readonly operations: readonly OperationResult[];
};

export class McpChangePlanError extends Error {
  readonly code:
    | 'invalid_plan_request'
    | 'open_payload_rejected'
    | 'plan_not_found'
    | 'plan_binding_mismatch'
    | 'plan_expired'
    | 'plan_not_approved'
    | 'plan_already_consumed'
    | 'plan_cancelled'
    | 'digest_mismatch'
    | 'revision_drift'
    | 'scope_invalid'
    | 'impact_exceeded'
    | 'rate_limited'
    | 'approval_missing'
    | 'idempotency_conflict'
    | 'commit_failed';

  constructor(code: McpChangePlanError['code'], message: string) {
    super(message);
    this.name = 'McpChangePlanError';
    this.code = code;
  }
}

/** Host-owned durable plan store. */
export interface McpChangePlanStorePort {
  readonly save: (plan: McpStoredPlan) => void | PromiseLike<void>;
  readonly get: (planId: string) => McpStoredPlan | undefined | PromiseLike<McpStoredPlan | undefined>;
  readonly update: (plan: McpStoredPlan) => void | PromiseLike<void>;
}
/**
 * Host-owned approval store. Approval is server-bound: the model never supplies
 * an approve boolean or approval secret through Tool input.
 *
 * Commit uses a two-phase compare-and-consume so execute failures do not burn
 * approval without a stored firstResult (single-transaction + idempotent replay).
 */
export interface McpApprovalStorePort {
  /** Records out-of-band approval for the exact binding + digest. */
  readonly markApproved: (
    input: Readonly<{
      planId: string;
      binding: McpAuthenticatedAuthorizationBinding;
      operationsDigest: string;
    }>,
  ) => void | PromiseLike<void>;
  /**
   * Validate approval + acquire single-winner lock. Does not consume until
   * {@link finalizeCommit}. Same idempotency key returns the first result.
   */
  readonly beginCommit: (
    input: Readonly<{
      planId: string;
      binding: McpAuthenticatedAuthorizationBinding;
      operationsDigest: string;
      idempotencyKey: string;
    }>,
  ) => McpApprovalBeginResult | PromiseLike<McpApprovalBeginResult>;
  /**
   * After successful execute: consume approval and store the first commit result.
   */
  readonly finalizeCommit: (
    input: Readonly<{
      planId: string;
      idempotencyKey: string;
      result: McpPlanCommitResult;
    }>,
  ) => void | PromiseLike<void>;
  /**
   * After failed execute: release the lock without consuming approval so retry is possible.
   */
  readonly abortCommit: (
    input: Readonly<{
      planId: string;
      idempotencyKey: string;
    }>,
  ) => void | PromiseLike<void>;
}

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

export type McpApprovalBeginResult =
  | { readonly status: 'ready' }
  | { readonly status: 'already_consumed'; readonly firstResult: McpPlanCommitResult }
  | { readonly status: 'rejected'; readonly reason: 'missing' | 'binding_mismatch' | 'digest_mismatch' | 'concurrent_lost' | 'expired' };

export interface McpChangePlanImpactPort {
  readonly assessImpact: (
    operations: readonly ChangePlanOperation[],
  ) => ChangePlanImpact | PromiseLike<ChangePlanImpact>;
}

export type McpChangePlanRevisionMap = Readonly<Record<string, string>>;

/**
 * Authoritative host adapter for revision namespaces. The MCP layer does not
 * infer resource namespaces from operation fields: the resolver binds every
 * typed operation to the canonical revisions owned by the management API.
 */
export interface McpChangePlanRevisionPort<
  Transaction extends McpChangePlanCommitTransaction = McpChangePlanCommitTransaction,
> {
  readonly resolveBaseRevisions: (
    operation: ChangePlanOperation,
    binding: McpAuthenticatedAuthorizationBinding,
  ) => McpChangePlanRevisionMap | PromiseLike<McpChangePlanRevisionMap>;
  /**
   * Lock and read the authoritative revisions inside the supplied Commit
   * transaction. The lock/precondition must remain effective through execute;
   * a transaction-external read does not satisfy the Commit TOCTOU boundary.
   */
  readonly currentRevisions: (
    transaction: Transaction,
    baseRevisions: McpChangePlanRevisionMap,
    binding: McpAuthenticatedAuthorizationBinding,
  ) => McpChangePlanRevisionMap | PromiseLike<McpChangePlanRevisionMap>;
}

export interface McpChangePlanScopePort {
  readonly hasScopes: (
    requiredScopes: readonly ScopeName[],
    binding: McpAuthenticatedAuthorizationBinding,
  ) => boolean | PromiseLike<boolean>;
}

/**
 * Trusted host policy for scopes that cannot be derived solely from an
 * operation discriminant. For canonically mapped operations the result is
 * additive, allowing current resource state or deployment policy to require
 * stronger authorization. For `sync_mirror` it is the authoritative complete
 * scope set because the protocol does not define a fixed mapping.
 */
export interface McpChangePlanAuthorizationPolicyPort {
  readonly requiredScopesForOperation: (
    operation: ChangePlanOperation,
    binding: McpAuthenticatedAuthorizationBinding,
  ) => readonly ScopeName[] | Promise<readonly ScopeName[]>;
}

/**
 * Opaque transaction handle created and owned by the host commit coordinator.
 * Every commit participant receives the exact same handle so a host adapter can
 * bind all writes to one database transaction (or an equivalent durable unit).
 */
export type McpChangePlanCommitTransaction = object;

export interface McpChangePlanExecutorPort<
  Transaction extends McpChangePlanCommitTransaction = McpChangePlanCommitTransaction,
> {
  readonly execute: (
    transaction: Transaction,
    operations: readonly ChangePlanOperation[],
    binding: McpAuthenticatedAuthorizationBinding,
  ) => readonly OperationResult[] | Promise<readonly OperationResult[]>;
}

export interface McpChangePlanCommitPlanStorePort<
  Transaction extends McpChangePlanCommitTransaction = McpChangePlanCommitTransaction,
> {
  /** Lock and re-read the authoritative Plan inside the commit transaction. */
  readonly lock: (
    transaction: Transaction,
    planId: string,
  ) => McpStoredPlan | undefined | PromiseLike<McpStoredPlan | undefined>;
  readonly update: (
    transaction: Transaction,
    plan: McpStoredPlan,
  ) => void | PromiseLike<void>;
}

export interface McpChangePlanCommitApprovalStorePort<
  Transaction extends McpChangePlanCommitTransaction = McpChangePlanCommitTransaction,
> {
  /** Stage out-of-band Approval in the same transaction as the Plan transition. */
  readonly markApproved: (
    transaction: Transaction,
    input: Readonly<{
      planId: string;
      binding: McpAuthenticatedAuthorizationBinding;
      operationsDigest: string;
    }>,
  ) => void | PromiseLike<void>;
  /**
   * Atomically return the durable first result for this Plan + idempotency key,
   * or claim the right to perform the first execution. The caller validates
   * the locked Plan identity and binding before entering this operation.
   *
   * `operationsDigest` is the digest persisted on that locked Plan. It binds
   * the out-of-band approval; it is not a client-supplied Commit digest.
   * `already_consumed` MUST be resolved without consulting mutable scope,
   * revision, impact, or rate-limit state. A `ready` claim and its eventual
   * first result MUST participate in the supplied transaction.
   */
  readonly beginCommit: (
    transaction: Transaction,
    input: Readonly<{
      planId: string;
      binding: McpAuthenticatedAuthorizationBinding;
      operationsDigest: string;
      idempotencyKey: string;
    }>,
  ) => McpApprovalBeginResult | PromiseLike<McpApprovalBeginResult>;
  readonly finalizeCommit: (
    transaction: Transaction,
    input: Readonly<{
      planId: string;
      idempotencyKey: string;
      result: McpPlanCommitResult;
    }>,
  ) => void | PromiseLike<void>;
}

export type McpChangePlanCommitBeginContext = Readonly<{
  planId: string;
  idempotencyKey: string;
  binding: McpAuthenticatedAuthorizationBinding;
}>;

export type McpChangePlanCancelBeginContext = Readonly<{
  planId: string;
  binding: McpAuthenticatedAuthorizationBinding;
}>;

export type McpChangePlanApprovalBeginContext = Readonly<{
  planId: string;
  binding: McpAuthenticatedAuthorizationBinding;
  approval: true;
}>;

/**
 * Approval, Commit, and Cancel enter through the same host coordinator so all
 * three operations contend for the same per-Plan lock and transaction boundary.
 * Commit carries an idempotency key, Approval carries `approval: true`, and
 * Cancel carries neither discriminator.
 */
export type McpChangePlanTransactionBeginContext =
  | McpChangePlanCommitBeginContext
  | McpChangePlanApprovalBeginContext
  | McpChangePlanCancelBeginContext;

/**
 * Host-provided atomic Change Plan transaction boundary.
 *
 * `currentRevisions` and `executor` MUST participate in the same atomic
 * resource as the Plan and Approval ports. The revision adapter must retain
 * its resource locks or the executor must atomically compare every operation's
 * base revision. A remote/non-transactional executor cannot be adapted by
 * merely wrapping it in these callbacks: such hosts need a durable
 * coordinator/outbox plus a downstream idempotency contract instead.
 *
 * Calls for Approval, Commit, and Cancel MUST acquire the same per-Plan lock.
 * Plan and Approval updates are transaction-local: rollback must restore the
 * pre-transaction state rather than exposing a partial state transition.
 *
 * `release` MUST release transaction resources and any single-flight lock,
 * including after commit or rollback failure.
 */
export interface McpChangePlanCommitCoordinatorPort<
  Transaction extends McpChangePlanCommitTransaction = McpChangePlanCommitTransaction,
> {
  readonly begin: (
    context: McpChangePlanTransactionBeginContext,
  ) => Transaction | PromiseLike<Transaction>;
  readonly planStore: McpChangePlanCommitPlanStorePort<Transaction>;
  readonly approvalStore: McpChangePlanCommitApprovalStorePort<Transaction>;
  readonly executor: McpChangePlanExecutorPort<Transaction>;
  readonly commit: (
    transaction: Transaction,
  ) => void | PromiseLike<void>;
  readonly rollback: (
    transaction: Transaction,
    cause: unknown,
  ) => void | PromiseLike<void>;
  readonly release: (
    transaction: Transaction,
  ) => void | PromiseLike<void>;
}

/**
 * Required host-owned rate-limit decision revalidated at Commit (docs/05 §13.3).
 * A deployment without a rate-limit policy must still inject an explicit,
 * auditable decision port; the library never supplies an allow-all default.
 */
export interface McpChangePlanRateLimitPort {
  readonly allowPlan?: (input: Readonly<{ binding: McpAuthenticatedAuthorizationBinding }>) => boolean | PromiseLike<boolean>;
  readonly allow: (input: Readonly<{ planId: string; binding: McpAuthenticatedAuthorizationBinding }>) => boolean | PromiseLike<boolean>;
}

/**
 * Optional host-owned digest verifier for Plans persisted by a host planner.
 *
 * COLP's default Commit verifier recomputes the digest from the Plan
 * operations. A host that intentionally binds a stronger Plan digest (for
 * example one that also covers binding, revisions, scopes, risk and impact)
 * can provide this port so Commit revalidates that exact persisted digest
 * inside the same transaction. When omitted, the default operations digest
 * semantics remain unchanged.
 */
export interface McpChangePlanStoredDigestPort {
  readonly verify: (plan: McpStoredPlan) => boolean | PromiseLike<boolean>;
}

export interface McpChangePlanClockPort {
  readonly now: () => Date;
}

export interface McpChangePlanIdPort {
  readonly nextPlanId: () => string;
}

export interface McpChangePlanServiceOptions<
  Transaction extends McpChangePlanCommitTransaction = McpChangePlanCommitTransaction,
> {
  readonly planStore: McpChangePlanStorePort;
  readonly approvalStore: McpApprovalStorePort;
  readonly impact: McpChangePlanImpactPort;
  readonly revisions: McpChangePlanRevisionPort<Transaction>;
  readonly scopes: McpChangePlanScopePort;
  readonly authorizationPolicy: McpChangePlanAuthorizationPolicyPort;
  readonly commitCoordinator: McpChangePlanCommitCoordinatorPort<Transaction>;
  readonly rateLimit: McpChangePlanRateLimitPort;
  /** Optional host-owned digest verifier for host-persisted Plans. */
  readonly verifyStoredOperationsDigest?: McpChangePlanStoredDigestPort;
  readonly approvalBaseUri: string;
  /** Required deployment decision for every model-visible approval/reveal URI. */
  readonly uriPolicy: McpHttpUriPolicyPort;
  readonly clock?: McpChangePlanClockPort;
  readonly ids?: McpChangePlanIdPort;
  readonly planTtlMilliseconds?: number;
  /** Aggregate cap on concurrent plan admission/assessment work. */
  readonly maxConcurrentPlans?: number;
  /** Required when a Plan contains create_key or rotate_key. */
  readonly revealUriForKey?: (keyId: string) => string;
  /** Shared MCP write-input budget when this service is used without the gateway. */
  readonly inputBudget?: McpWriteInputBudget;
}

export interface McpChangePlanService {
  readonly plan: (
    request: unknown,
    binding: McpAuthenticatedAuthorizationBinding,
    /** Gateway-supplied scopes for pre-plan admission; omitted for host-only callers. */
    authorizedScopes?: readonly string[],
  ) => Promise<ChangePlan>;
  /**
   * Host-only approval entry. Must never be exposed as a model-callable Tool.
   */
  readonly recordOutOfBandApproval: (
    planId: string,
    binding: McpAuthenticatedAuthorizationBinding,
  ) => Promise<void>;
  readonly commit: (
    planId: string,
    binding: McpAuthenticatedAuthorizationBinding,
    idempotencyKey: string,
  ) => Promise<McpPlanCommitResult>;
  readonly cancel: (
    planId: string,
    binding: McpAuthenticatedAuthorizationBinding,
  ) => Promise<Readonly<{ planId: string; status: 'cancelled' }>>;
}
const DEFAULT_TTL_MS = 15 * 60 * 1000;
export const MCP_CHANGE_PLAN_DEFAULT_MAX_CONCURRENT_PLANS = 128 as const;
export const MCP_CHANGE_PLAN_UNTRUSTED_NOTE_MAX_LENGTH = 1000;
const untrustedNoteControlCharacter = /[\u0000-\u001F\u007F]/u;
export function createChangePlanService<
  Transaction extends McpChangePlanCommitTransaction,
>(
  options: McpChangePlanServiceOptions<Transaction>,
): McpChangePlanService {
  const ports = readServiceOptions(options);
  const clock = ports.clock ?? { now: () => new Date() };
  const ids = ports.ids ?? { nextPlanId: () => `plan_${randomUUID().replace(/-/gu, '')}` };
  const ttl = ports.planTtlMilliseconds ?? DEFAULT_TTL_MS;
  const inputBudget = ports.inputBudget;
  const maxConcurrentPlans = ports.maxConcurrentPlans ?? MCP_CHANGE_PLAN_DEFAULT_MAX_CONCURRENT_PLANS;
  let activePlans = 0;
  const plan = async (
    request: unknown,
    binding: McpAuthenticatedAuthorizationBinding,
    authorizedScopes?: readonly string[],
  ): Promise<ChangePlan> => {
    if (activePlans >= maxConcurrentPlans) {
      throw new McpChangePlanError('rate_limited', 'Change plan aggregate admission limit reached.');
    }
    activePlans += 1;
    try {
      const ownedBinding = readBinding(binding);
      if (await allowChangePlanAdmission(ports.rateLimit, ownedBinding) !== true) throw new McpChangePlanError('rate_limited', 'Rate limit does not allow plan assessment.');
    const typedRequest = validatePlanRequest(request, inputBudget);
    const operations = typedRequest.operations;
    assertKeyRevealCapability(operations, ports.revealUriForKey);
    const assessment = assessCanonicalOperations(operations, inputBudget);
    const risk = assessment.level === 'low' ? 'high' : assessment.level;
    const requiredScopes = await deriveRequiredScopes(operations, ownedBinding, ports.authorizationPolicy, inputBudget);
    if (authorizedScopes !== undefined) {
      if (!Array.isArray(authorizedScopes) || authorizedScopes.some((scope) => typeof scope !== 'string')) {
        throw new McpChangePlanError('scope_invalid', 'The request authorization scope set is invalid.');
      }
      const granted = new Set(authorizedScopes);
      if (!requiredScopes.every((scope) => granted.has(scope))) {
        throw new McpChangePlanError('scope_invalid', 'The request does not hold the operation-specific scopes required to assess this Plan.');
      }
    }
    const impactCandidate = Reflect.apply(ports.impact.assessImpact, ports.impact.receiver, [
      Object.freeze([...operations]),
    ]);
    const frozenImpact = await resolveImpact(impactCandidate, 'plan', inputBudget);
    const operationsDigest = computeOperationsDigest(operations);
    const baseRevisions = await resolveBaseRevisions(
      operations,
      ownedBinding,
      ports.revisions,
      inputBudget,
    );
    const planId = ids.nextPlanId();
    if (typeof planId !== 'string' || planId.length === 0) {
      throw new McpChangePlanError('invalid_plan_request', 'Plan id generator returned an empty id.');
    }
    const now = clock.now();
    const expiresAt = new Date(now.getTime() + ttl).toISOString();
    const requiresApproval = risk === 'high' || risk === 'medium';
    const summary = buildSummary(operations, frozenImpact);
    const frozenBaseRevisions = Object.freeze({ ...baseRevisions });
    const frozenOperations = Object.freeze(
      operations.map((op) => snapshotMcpData(op, inputBudget) as ChangePlanOperation),
    );
    const storedBase = {
      planId,
      expiresAt,
      risk: risk as RiskLevel,
      requiresApproval,
      summary,
      impact: frozenImpact,
      requiredScopes,
      baseRevisions: frozenBaseRevisions,
      operations: frozenOperations,
      operationsDigest,
      binding: ownedBinding,
      untrustedNote: typedRequest.reason,
      createdAt: now.toISOString(),
      status: 'pending' as const,
    };
    const stored: McpStoredPlan = requiresApproval
      ? Object.freeze({
        ...storedBase,
        approvalMethod: 'out_of_band',
        approvalUri: joinApprovalUri(ports.approvalBaseUri, planId, ports.uriPolicy),
      })
      : Object.freeze(storedBase);
    await Reflect.apply(ports.planStore.save, ports.planStore.receiver, [stored]);
    const result = {
      planId: stored.planId,
      expiresAt: stored.expiresAt,
      risk: stored.risk,
      requiresApproval: stored.requiresApproval,
      summary: stored.summary,
      impact: stored.impact as ChangePlanImpact,
      requiredScopes: [...stored.requiredScopes] as ScopeName[],
      baseRevisions: { ...stored.baseRevisions },
      ...(stored.approvalMethod !== undefined
        ? {
          approvalMethod: stored.approvalMethod,
          approvalUri: stored.approvalUri as HttpUrl,
        }
        : {}),
    };
      return snapshotMcpData(result, inputBudget) as ChangePlan;
    } finally {
      activePlans -= 1;
    }
  };
  const recordOutOfBandApproval = async (
    planId: string,
    binding: McpAuthenticatedAuthorizationBinding,
  ): Promise<void> => {
    if (typeof planId !== 'string' || planId.length === 0) {
      throw new McpChangePlanError('plan_not_found', 'planId must be a non-empty string.');
    }
    const ownedBinding = readBinding(binding);
    const beginContext: McpChangePlanApprovalBeginContext = Object.freeze({
      planId,
      binding: ownedBinding,
      approval: true,
    });
    let transaction: Transaction | undefined;
    let failure: unknown;
    try {
      transaction = await Reflect.apply(
        ports.commitCoordinator.begin,
        ports.commitCoordinator.receiver,
        [beginContext],
      );
      assertCommitTransaction(transaction);

      const stored = await loadLockedPlan(ports.commitCoordinator.planStore, transaction, planId);
      assertPlanIdentity(stored, planId);
      assertBindingMatch(stored, ownedBinding);
      assertApprovablePlanState(stored, clock.now());

      await Reflect.apply(
        ports.commitCoordinator.approvalStore.markApproved,
        ports.commitCoordinator.approvalStore.receiver,
        [
          transaction,
          Object.freeze({
            planId: stored.planId,
            binding: ownedBinding,
            operationsDigest: stored.operationsDigest,
          }),
        ],
      );

      const approved: McpStoredPlan = Object.freeze({
        ...stored,
        status: 'approved' as const,
      });
      await Reflect.apply(
        ports.commitCoordinator.planStore.update,
        ports.commitCoordinator.planStore.receiver,
        [transaction, approved],
      );

      await Reflect.apply(
        ports.commitCoordinator.commit,
        ports.commitCoordinator.receiver,
        [transaction],
      );
    } catch (cause) {
      failure = cause;
      if (transaction !== undefined) {
        try {
          await Reflect.apply(
            ports.commitCoordinator.rollback,
            ports.commitCoordinator.receiver,
            [transaction, cause],
          );
        } catch {
          failure = new McpChangePlanError(
            'commit_failed',
            'Approval rollback failed; transaction outcome is not reported as successful.',
          );
        }
      }
    } finally {
      if (transaction !== undefined) {
        try {
          await Reflect.apply(
            ports.commitCoordinator.release,
            ports.commitCoordinator.receiver,
            [transaction],
          );
        } catch {
          failure = new McpChangePlanError(
            'commit_failed',
            'Approval transaction release failed; the request failed closed.',
          );
        }
      }
    }

    if (failure !== undefined) throw normalizeCommitFailure(failure);
  };

  const commit = async (
    planId: string,
    binding: McpAuthenticatedAuthorizationBinding,
    idempotencyKey: string,
  ): Promise<McpPlanCommitResult> => {
    if (typeof planId !== 'string' || planId.length === 0) {
      throw new McpChangePlanError('plan_not_found', 'planId must be a non-empty string.');
    }
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
      throw new McpChangePlanError('idempotency_conflict', 'Commit requires a non-empty Idempotency Key.');
    }

    const ownedBinding = readBinding(binding);
    const beginContext: McpChangePlanCommitBeginContext = Object.freeze({
      planId,
      idempotencyKey,
      binding: ownedBinding,
    });
    let transaction: Transaction | undefined;
    let result: McpPlanCommitResult | undefined;
    let failure: unknown;

    try {
      transaction = await Reflect.apply(
        ports.commitCoordinator.begin,
        ports.commitCoordinator.receiver,
        [beginContext],
      );
      assertCommitTransaction(transaction);

      const stored = await loadLockedPlan(ports.commitCoordinator.planStore, transaction, planId);
      assertPlanIdentity(stored, planId);
      assertBindingMatch(stored, ownedBinding);

      // The transaction-bound replay-or-claim happens before mutable
      // revalidation. Commit has no client-supplied digest: the digest below is
      // the one bound to the authoritative locked Plan and its approval.
      const claim = await Reflect.apply(
        ports.commitCoordinator.approvalStore.beginCommit,
        ports.commitCoordinator.approvalStore.receiver,
        [
          transaction,
          Object.freeze({
            planId: stored.planId,
            binding: ownedBinding,
            operationsDigest: stored.operationsDigest,
            idempotencyKey,
          }),
        ],
      );

      if (claim.status === 'already_consumed' && claim.firstResult !== undefined) {
        // The first result was already redacted before finalizeCommit. Snapshot
        // it again defensively, but do not consult the current reveal builder or
        // any mutable revalidation port while serving an idempotent replay.
        result = redactStoredCommitResult(
          claim.firstResult,
          undefined,
          undefined,
          inputBudget,
        ) as McpPlanCommitResult;
      } else {
        assertApprovalReady(claim);
        assertCommitPlanState(stored, clock.now());

        const committing: McpStoredPlan = Object.freeze({
          ...stored,
          status: 'committing' as const,
        });
        await Reflect.apply(
          ports.commitCoordinator.planStore.update,
          ports.commitCoordinator.planStore.receiver,
          [transaction, committing],
        );

        const scopesOk = await Reflect.apply(ports.scopes.hasScopes, ports.scopes.receiver, [
          Object.freeze([...stored.requiredScopes]),
          ownedBinding,
        ]);
        if (scopesOk !== true) {
          throw new McpChangePlanError('scope_invalid', 'Required scopes are no longer valid for this commit.');
        }

        const currentCandidate = Reflect.apply(
          ports.revisions.currentRevisions,
          ports.revisions.receiver,
          [transaction, Object.freeze({ ...stored.baseRevisions }), ownedBinding],
        );
        const current = await resolveRevisionMap(currentCandidate, 'commit', inputBudget);
        if (!revisionsMatch(stored.baseRevisions, current)) {
          throw new McpChangePlanError('revision_drift', 'Base revisions have changed; create a new plan.');
        }

        const liveImpactCandidate = Reflect.apply(ports.impact.assessImpact, ports.impact.receiver, [
          Object.freeze([...stored.operations]),
        ]);
        const liveImpact = await resolveImpact(liveImpactCandidate, 'commit', inputBudget);
        if (impactExceeds(stored.impact, liveImpact)) {
          throw new McpChangePlanError('impact_exceeded', 'Operation impact exceeds the approved plan.');
        }

        const liveDigest = computeOperationsDigest(stored.operations);
        let digestOk: unknown;
        if (ports.verifyStoredOperationsDigest !== undefined) {
          digestOk = await Reflect.apply(
            ports.verifyStoredOperationsDigest.verify,
            ports.verifyStoredOperationsDigest.receiver,
            [stored],
          );
        } else {
          digestOk = liveDigest === stored.operationsDigest;
        }
        if (digestOk !== true) {
          throw new McpChangePlanError('digest_mismatch', 'Canonical operations digest mismatch.');
        }

        const rateOk = await Reflect.apply(ports.rateLimit.allow, ports.rateLimit.receiver, [
          Object.freeze({ planId: stored.planId, binding: ownedBinding }),
        ]);
        if (rateOk !== true) {
          throw new McpChangePlanError('rate_limited', 'Rate limit does not allow this commit.');
        }

        const operationResultsCandidate = Reflect.apply(
          ports.commitCoordinator.executor.execute,
          ports.commitCoordinator.executor.receiver,
          [transaction, Object.freeze([...stored.operations]), ownedBinding],
        );
        const operationResults = await resolveOperationResults(operationResultsCandidate, inputBudget);
        const rawResult = Object.freeze({
          planId: stored.planId,
          committedAt: clock.now().toISOString(),
          operations: operationResults,
        });
        result = redactStoredCommitResult(
          rawResult,
          ports.revealUriForKey,
          ports.uriPolicyPort,
          inputBudget,
        ) as McpPlanCommitResult;

        await Reflect.apply(
          ports.commitCoordinator.approvalStore.finalizeCommit,
          ports.commitCoordinator.approvalStore.receiver,
          [
            transaction,
            Object.freeze({ planId: stored.planId, idempotencyKey, result }),
          ],
        );

        const consumed: McpStoredPlan = Object.freeze({
          ...committing,
          status: 'consumed' as const,
        });
        await Reflect.apply(
          ports.commitCoordinator.planStore.update,
          ports.commitCoordinator.planStore.receiver,
          [transaction, consumed],
        );
      }

      await Reflect.apply(
        ports.commitCoordinator.commit,
        ports.commitCoordinator.receiver,
        [transaction],
      );
    } catch (cause) {
      failure = cause;
      if (transaction !== undefined) {
        try {
          await Reflect.apply(
            ports.commitCoordinator.rollback,
            ports.commitCoordinator.receiver,
            [transaction, cause],
          );
        } catch {
          failure = new McpChangePlanError(
            'commit_failed',
            'Commit rollback failed; transaction outcome is not reported as successful.',
          );
        }
      }
    } finally {
      if (transaction !== undefined) {
        try {
          await Reflect.apply(
            ports.commitCoordinator.release,
            ports.commitCoordinator.receiver,
            [transaction],
          );
        } catch {
          failure = new McpChangePlanError(
            'commit_failed',
            'Commit transaction release failed; the request failed closed.',
          );
        }
      }
    }

    if (failure !== undefined) throw normalizeCommitFailure(failure);
    if (result === undefined) {
      throw new McpChangePlanError('commit_failed', 'Commit completed without a durable result.');
    }
    return result;
  };

  const cancel = async (
    planId: string,
    binding: McpAuthenticatedAuthorizationBinding,
  ): Promise<Readonly<{ planId: string; status: 'cancelled' }>> => {
    if (typeof planId !== 'string' || planId.length === 0) {
      throw new McpChangePlanError('plan_not_found', 'planId must be a non-empty string.');
    }
    const ownedBinding = readBinding(binding);
    const beginContext: McpChangePlanCancelBeginContext = Object.freeze({
      planId,
      binding: ownedBinding,
    });
    let transaction: Transaction | undefined;
    let result: Readonly<{ planId: string; status: 'cancelled' }> | undefined;
    let failure: unknown;

    try {
      transaction = await Reflect.apply(
        ports.commitCoordinator.begin,
        ports.commitCoordinator.receiver,
        [beginContext],
      );
      assertCommitTransaction(transaction);

      const stored = await loadLockedPlan(ports.commitCoordinator.planStore, transaction, planId);
      assertBindingMatch(stored, ownedBinding);
      assertCancellablePlanState(stored, clock.now());

      if (stored.status !== 'cancelled') {
        const cancelled: McpStoredPlan = Object.freeze({
          ...stored,
          status: 'cancelled' as const,
        });
        await Reflect.apply(
          ports.commitCoordinator.planStore.update,
          ports.commitCoordinator.planStore.receiver,
          [transaction, cancelled],
        );
      }
      result = Object.freeze({ planId: stored.planId, status: 'cancelled' as const });

      await Reflect.apply(
        ports.commitCoordinator.commit,
        ports.commitCoordinator.receiver,
        [transaction],
      );
    } catch (cause) {
      failure = cause;
      if (transaction !== undefined) {
        try {
          await Reflect.apply(
            ports.commitCoordinator.rollback,
            ports.commitCoordinator.receiver,
            [transaction, cause],
          );
        } catch {
          failure = new McpChangePlanError(
            'commit_failed',
            'Cancel rollback failed; transaction outcome is not reported as successful.',
          );
        }
      }
    } finally {
      if (transaction !== undefined) {
        try {
          await Reflect.apply(
            ports.commitCoordinator.release,
            ports.commitCoordinator.receiver,
            [transaction],
          );
        } catch {
          failure = new McpChangePlanError(
            'commit_failed',
            'Cancel transaction release failed; the request failed closed.',
          );
        }
      }
    }

    if (failure !== undefined) throw normalizeCommitFailure(failure);
    if (result === undefined) {
      throw new McpChangePlanError('commit_failed', 'Cancel completed without a durable result.');
    }
    return result;
  };

  return Object.freeze({ plan, recordOutOfBandApproval, commit, cancel });
}

export function computeOperationsDigest(operations: readonly unknown[]): string {
  const canonical = encodePlainCanonicalJson(operations);
  if (canonical === undefined) {
    throw new McpChangePlanError('invalid_plan_request', 'Operations are not JSON-canonicalizable.');
  }
  return `sha-256:${createHash('sha256').update(canonical).digest('base64url')}`;
}

async function deriveRequiredScopes(
  operations: readonly ChangePlanOperation[],
  binding: McpAuthenticatedAuthorizationBinding,
  policy: ResolvedServiceOptions<McpChangePlanCommitTransaction>['authorizationPolicy'],
  inputBudget: Required<McpWriteInputBudget>,
): Promise<readonly ScopeName[]> {
  const required = new Set<ScopeName>();

  for (const operation of operations) {
    const canonicalScope = canonicalScopeForOperation(operation);
    if (canonicalScope !== undefined) required.add(canonicalScope);

    const policyCandidate = Reflect.apply(
      policy.requiredScopesForOperation,
      policy.receiver,
      [operation, binding],
    );
    const policyScopes = await resolvePolicyScopes(policyCandidate, operation.type, inputBudget);
    if (operation.type === 'sync_mirror' && policyScopes.length === 0) {
      throw new McpChangePlanError(
        'invalid_plan_request',
        'Authorization policy must return at least one Scope for sync_mirror.',
      );
    }
    for (const scope of policyScopes) required.add(scope);
  }

  return Object.freeze([...required]);
}

async function resolvePolicyScopes(
  candidate: unknown,
  operationType: string,
  inputBudget: Required<McpWriteInputBudget>,
): Promise<readonly ScopeName[]> {
  if (candidate !== null && (typeof candidate === 'object' || typeof candidate === 'function')) {
    if (nodeTypes.isProxy(candidate)) {
      throw invalidPolicyScopes(operationType);
    }
    if (nodeTypes.isPromise(candidate)) {
      const settled = await new Promise<unknown>((resolve, reject) => {
        Reflect.apply(Promise.prototype.then, candidate, [resolve, reject]);
      });
      return readPolicyScopes(settled, operationType, inputBudget);
    }
  }
  return readPolicyScopes(candidate, operationType, inputBudget);
}

function canonicalScopeForOperation(operation: ChangePlanOperation): ScopeName | undefined {
  switch (operation.type) {
    case 'delete_collection':
      return 'collections:delete';
    case 'delete_subtree':
      return 'nodes:delete';
    case 'set_visibility':
    case 'set_access_policy':
      return 'access:write';
    case 'create_key':
    case 'rotate_key':
    case 'revoke_key':
      return 'keys:write';
    case 'set_rate_limit':
      return 'rate_limits:write';
    case 'publish_release':
      return 'release:publish';
    case 'sync_mirror':
      return undefined;
    default:
      throw new McpChangePlanError(
        'invalid_plan_request',
        'Unknown change Plan operation has no canonical authorization policy.',
      );
  }
}

function readPolicyScopes(
  value: unknown,
  operationType: string,
  inputBudget: Required<McpWriteInputBudget>,
): readonly ScopeName[] {
  let snapshot: unknown;
  try {
    snapshot = snapshotMcpData(value, inputBudget);
  } catch {
    throw invalidPolicyScopes(operationType);
  }
  if (!Array.isArray(snapshot)) throw invalidPolicyScopes(operationType);

  const scopes: ScopeName[] = [];
  for (const valueScope of snapshot) {
    if (!validators.validate('scopeName', valueScope).valid) {
      throw new McpChangePlanError(
        'invalid_plan_request',
        `Authorization policy for ${operationType} returned a non-canonical Scope.`,
      );
    }
    scopes.push(valueScope as ScopeName);
  }
  return Object.freeze(scopes);
}

function invalidPolicyScopes(operationType: string): McpChangePlanError {
  return new McpChangePlanError(
    'invalid_plan_request',
    `Authorization policy for ${operationType} must return a safe canonical Scope array.`,
  );
}

function validatePlanRequest(
  request: unknown,
  inputBudget: Required<McpWriteInputBudget>,
): ChangePlanRequest {
  let snapshot: unknown;
  try {
    snapshot = snapshotMcpData(request, inputBudget);
  } catch {
    throw new McpChangePlanError(
      'invalid_plan_request',
      'Change plan request exceeds the configured JSON resource budget.',
    );
  }
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    throw new McpChangePlanError('invalid_plan_request', 'Change plan request must be an object.');
  }

  // Reject open payload guessing: operations must be typed discriminant unions.
  const opsDescriptor = Object.getOwnPropertyDescriptor(snapshot, 'operations');
  if (opsDescriptor === undefined || !('value' in opsDescriptor) || !Array.isArray(opsDescriptor.value)) {
    throw new McpChangePlanError('invalid_plan_request', 'Change plan request requires operations[].');
  }
  if (opsDescriptor.value.length > inputBudget.maxOperations) {
    throw new McpChangePlanError('invalid_plan_request', 'Change plan request exceeds the operation budget.');
  }
  for (const operation of opsDescriptor.value as unknown[]) {
    if (typeof operation !== 'object' || operation === null || Array.isArray(operation)) {
      throw new McpChangePlanError('invalid_plan_request', 'Each operation must be a typed object.');
    }
    if (Object.prototype.hasOwnProperty.call(operation, 'payload')) {
      throw new McpChangePlanError(
        'open_payload_rejected',
        'Open payload operations are rejected; use typed changePlanOperation discriminants.',
      );
    }
    const typeDescriptor = Object.getOwnPropertyDescriptor(operation, 'type');
    if (
      typeDescriptor === undefined
      || !('value' in typeDescriptor)
      || typeof typeDescriptor.value !== 'string'
    ) {
      throw new McpChangePlanError('invalid_plan_request', 'Each operation requires a type discriminant.');
    }
  }

  const reasonDescriptor = Object.getOwnPropertyDescriptor(snapshot, 'reason');
  if (reasonDescriptor === undefined
    || !('value' in reasonDescriptor)
    || typeof reasonDescriptor.value !== 'string'
    || reasonDescriptor.value.length > MCP_CHANGE_PLAN_UNTRUSTED_NOTE_MAX_LENGTH
    || untrustedNoteControlCharacter.test(reasonDescriptor.value)) {
    throw new McpChangePlanError(
      'invalid_plan_request',
      'Change plan reason is an untrusted note and must not contain control characters or exceed 1000 characters.',
    );
  }

  const structural = validators.validate('changePlanRequest', snapshot);
  if (!structural.valid) {
    throw new McpChangePlanError(
      'invalid_plan_request',
      'Change plan request failed changePlanRequest schema validation.',
    );
  }

  return snapshot as ChangePlanRequest;
}

function assertKeyRevealCapability(
  operations: readonly ChangePlanOperation[],
  revealUriForKey: ((keyId: string) => string) | undefined,
): void {
  if (revealUriForKey !== undefined) return;
  if (operations.some(({ type }) => type === 'create_key' || type === 'rotate_key')) {
    throw new McpChangePlanError(
      'invalid_plan_request',
      'create_key and rotate_key Plans require a host-owned revealUriForKey boundary.',
    );
  }
}

async function resolveBaseRevisions<
  Transaction extends McpChangePlanCommitTransaction,
>(
  operations: readonly ChangePlanOperation[],
  binding: McpAuthenticatedAuthorizationBinding,
  port: ResolvedServiceOptions<Transaction>['revisions'],
  inputBudget: Required<McpWriteInputBudget>,
): Promise<McpChangePlanRevisionMap> {
  const revisions = new Map<string, string>();
  for (const operation of operations) {
    const candidate = Reflect.apply(port.resolveBaseRevisions, port.receiver, [operation, binding]);
    const resolved = await resolveRevisionMap(candidate, 'plan', inputBudget);
    assertOperationRevisionCoverage(operation, resolved);

    for (const [namespace, revision] of Object.entries(resolved)) {
      const prior = revisions.get(namespace);
      if (prior !== undefined && prior !== revision) {
        throw new McpChangePlanError(
          'invalid_plan_request',
          `Revision resolver returned conflicting values for namespace ${namespace}.`,
        );
      }
      revisions.set(namespace, revision);
    }
  }
  return Object.freeze(Object.fromEntries(revisions));
}

async function resolveRevisionMap(
  candidate: unknown,
  phase: 'plan' | 'commit',
  inputBudget: Required<McpWriteInputBudget>,
): Promise<McpChangePlanRevisionMap> {
  if (candidate !== null && (typeof candidate === 'object' || typeof candidate === 'function')) {
    if (nodeTypes.isProxy(candidate)) throw invalidRevisionMap(phase);
    if (nodeTypes.isPromise(candidate)) {
      const settled = await new Promise<unknown>((resolve, reject) => {
        Reflect.apply(Promise.prototype.then, candidate, [resolve, reject]);
      });
      return readRevisionMap(settled, phase, inputBudget);
    }
  }
  return readRevisionMap(candidate, phase, inputBudget);
}

function readRevisionMap(
  value: unknown,
  phase: 'plan' | 'commit',
  inputBudget: Required<McpWriteInputBudget>,
): McpChangePlanRevisionMap {
  let snapshot: unknown;
  try {
    snapshot = snapshotMcpData(value, inputBudget);
  } catch {
    throw invalidRevisionMap(phase);
  }
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    throw invalidRevisionMap(phase);
  }

  const entries: [string, string][] = [];
  for (const [namespace, revision] of Object.entries(snapshot)) {
    // baseRevisions is a resource-keyed map: the protocol constrains values,
    // not property names, to opaqueId. Namespace syntax remains host-owned.
    if (typeof revision !== 'string'
      || !validators.validate('opaqueId', revision).valid) {
      throw invalidRevisionMap(phase);
    }
    entries.push([namespace, revision]);
  }
  return Object.freeze(Object.fromEntries(entries));
}

function invalidRevisionMap(phase: 'plan' | 'commit'): McpChangePlanError {
  return new McpChangePlanError(
    phase === 'plan' ? 'invalid_plan_request' : 'commit_failed',
    `Revision resolver returned an invalid canonical namespace map during ${phase}.`,
  );
}

async function resolveOperationResults(
  candidate: unknown,
  inputBudget: Required<McpWriteInputBudget>,
): Promise<readonly OperationResult[]> {
  if (candidate !== null && (typeof candidate === 'object' || typeof candidate === 'function')) {
    if (nodeTypes.isProxy(candidate)) throw invalidOperationResults();
    if (nodeTypes.isPromise(candidate)) {
      let settled: unknown;
      try {
        assertUnmodifiedNativePromise(candidate);
        settled = await new NativePromise<unknown>((resolve, reject) => {
          Reflect.apply(nativePromiseThen, candidate, [resolve, reject]);
        });
      } catch {
        throw invalidOperationResults();
      }
      return readOperationResults(settled, inputBudget);
    }
  }
  return readOperationResults(candidate, inputBudget);
}

function assertUnmodifiedNativePromise(candidate: object): void {
  if (Object.getOwnPropertyDescriptor(candidate, 'constructor') !== undefined
    || Object.getPrototypeOf(candidate) !== nativePromisePrototype) {
    throw invalidOperationResults();
  }

  const thenDescriptor = Object.getOwnPropertyDescriptor(nativePromisePrototype, 'then');
  const constructorDescriptor = Object.getOwnPropertyDescriptor(nativePromisePrototype, 'constructor');
  const speciesDescriptor = Object.getOwnPropertyDescriptor(NativePromise, Symbol.species);
  if (thenDescriptor === undefined
    || !('value' in thenDescriptor)
    || thenDescriptor.value !== nativePromiseThen
    || constructorDescriptor === undefined
    || !('value' in constructorDescriptor)
    || constructorDescriptor.value !== NativePromise
    || speciesDescriptor === undefined
    || !('get' in speciesDescriptor)
    || speciesDescriptor.get !== nativePromiseSpeciesGetter) {
    throw invalidOperationResults();
  }
}

function readOperationResults(
  value: unknown,
  inputBudget: Required<McpWriteInputBudget>,
): readonly OperationResult[] {
  let snapshot: unknown;
  try {
    snapshot = snapshotMcpData(value, inputBudget);
  } catch {
    throw invalidOperationResults();
  }
  if (!Array.isArray(snapshot)) throw invalidOperationResults();
  if (snapshot.length > inputBudget.maxOperations) throw invalidOperationResults();

  for (const operationResult of snapshot) {
    if (!validators.validate('operationResult', operationResult).valid) {
      throw invalidOperationResults();
    }
  }
  return snapshot as readonly OperationResult[];
}

function invalidOperationResults(): McpChangePlanError {
  return new McpChangePlanError(
    'commit_failed',
    'Executor returned an invalid canonical Operation result array.',
  );
}

function assertOperationRevisionCoverage(
  operation: ChangePlanOperation,
  resolved: McpChangePlanRevisionMap,
): void {
  if (!('baseRevision' in operation)) return;

  const entries = Object.entries(resolved);
  if (!entries.some(([, revision]) => revision === operation.baseRevision)) {
    throw new McpChangePlanError(
      'invalid_plan_request',
      `Revision resolver omitted the declared base revision for ${operation.type}.`,
    );
  }

  if (operation.type === 'set_visibility' || operation.type === 'set_access_policy') {
    if (resolved[operation.collectionId] === operation.baseRevision) {
      throw new McpChangePlanError(
        'invalid_plan_request',
        `Revision resolver must not alias the ${operation.type} access revision as the bare collection revision.`,
      );
    }
  }
}

function buildSummary(
  operations: readonly ChangePlanOperation[],
  impact: ChangePlanImpact,
): string {
  const types = operations.map((op) => op.type).join(', ');
  return `Plan ${operations.length} canonical operation(s) [${types}]. Authoritative impact: `
    + `${impact.collections} collection(s), ${impact.nodes} node(s), `
    + `${impact.annotations} annotation(s), ${impact.attachments} attachment(s), `
    + `${impact.relations} relation(s).`;
}

function freezeImpact(
  impact: unknown,
  inputBudget: Required<McpWriteInputBudget>,
): ChangePlanImpact {
  const snapshot = snapshotMcpData(impact, inputBudget);
  if (!validators.validate('changePlanImpact', snapshot).valid) {
    throw new TypeError('Impact is not a canonical changePlanImpact.');
  }
  const canonical = snapshot as ChangePlanImpact;
  return Object.freeze({
    collections: canonical.collections,
    nodes: canonical.nodes,
    annotations: canonical.annotations,
    attachments: canonical.attachments,
    relations: canonical.relations,
    privateFieldsExcluded: [...canonical.privateFieldsExcluded],
  });
}

async function resolveImpact(
  candidate: unknown,
  phase: 'plan' | 'commit',
  inputBudget: Required<McpWriteInputBudget>,
): Promise<ChangePlanImpact> {
  try {
    if (candidate !== null && (typeof candidate === 'object' || typeof candidate === 'function')) {
      if (nodeTypes.isProxy(candidate)) throw new TypeError('Proxy impact');
      if (nodeTypes.isPromise(candidate)) {
        assertUnmodifiedNativePromise(candidate);
        const settled = await new NativePromise<unknown>((resolve, reject) => {
          Reflect.apply(nativePromiseThen, candidate, [resolve, reject]);
        });
        return freezeImpact(settled, inputBudget);
      }
    }
    return freezeImpact(candidate, inputBudget);
  } catch {
    throw new McpChangePlanError(
      phase === 'plan' ? 'invalid_plan_request' : 'commit_failed',
      `Impact port returned an invalid canonical result during ${phase}.`,
    );
  }
}

function impactExceeds(planned: ChangePlanImpact, live: ChangePlanImpact): boolean {
  // `privateFieldsExcluded` is a protection set, not an ordinary count.  A
  // live assessment that omits any field excluded by the approved plan would
  // expose more private data even when all numeric counters are unchanged.
  const liveExcluded = new Set(live.privateFieldsExcluded);
  return (
    live.collections > planned.collections
    || live.nodes > planned.nodes
    || live.annotations > planned.annotations
    || live.attachments > planned.attachments
    || live.relations > planned.relations
    || planned.privateFieldsExcluded.some((field) => !liveExcluded.has(field))
  );
}

function revisionsMatch(
  expected: Readonly<Record<string, string>>,
  actual: Readonly<Record<string, string>>,
): boolean {
  const expectedKeys = Object.keys(expected);
  if (Object.keys(actual).length !== expectedKeys.length) return false;
  for (const key of expectedKeys) {
    if (actual[key] !== expected[key]) return false;
  }
  return true;
}

function isExpired(plan: McpStoredPlan, now: Date): boolean {
  return Date.parse(plan.expiresAt) <= now.getTime();
}

function assertNotTerminal(plan: McpStoredPlan): void {
  if (plan.status === 'consumed' || plan.status === 'committing') {
    throw new McpChangePlanError('plan_already_consumed', 'Plan was already consumed.');
  }
  if (plan.status === 'cancelled') {
    throw new McpChangePlanError('plan_cancelled', 'Plan was cancelled.');
  }
}

function assertApprovablePlanState(plan: McpStoredPlan, now: Date): void {
  assertNotTerminal(plan);
  if (plan.status === 'expired' || isExpired(plan, now)) {
    throw new McpChangePlanError('plan_expired', 'Plan has expired; create a new plan.');
  }
  if (plan.status !== 'pending') {
    throw new McpChangePlanError('commit_failed', 'Only a pending Plan can be approved.');
  }
}

function assertCommitPlanState(plan: McpStoredPlan, now: Date): void {
  assertNotTerminal(plan);
  if (isExpired(plan, now)) {
    throw new McpChangePlanError('plan_expired', 'Plan has expired; create a new plan.');
  }
  if (plan.status === 'approved') return;
  // FIX-M-016: low-risk ready Plans (requiresApproval=false, still pending)
  // claim directly under binding/receipt/row lock; only approval-required
  // Plans must reach `approved` before commit.
  if (plan.status === 'pending' && plan.requiresApproval === false) return;
  throw new McpChangePlanError('plan_not_approved', 'Plan is not approved for commit.');
}

function assertCancellablePlanState(plan: McpStoredPlan, now: Date): void {
  if (plan.status === 'committing' || plan.status === 'consumed') {
    throw new McpChangePlanError(
      'plan_already_consumed',
      'Plans that are committing or consumed cannot be cancelled.',
    );
  }
  if (plan.status === 'cancelled') return;
  if (plan.status === 'expired' || isExpired(plan, now)) {
    throw new McpChangePlanError('plan_expired', 'Expired plans cannot be cancelled.');
  }
  if (plan.status !== 'pending' && plan.status !== 'approved') {
    throw new McpChangePlanError('commit_failed', 'Plan is not in a cancellable state.');
  }
}

function assertApprovalReady(result: McpApprovalBeginResult): asserts result is { readonly status: 'ready' } {
  if (result.status === 'rejected') {
    if (result.reason === 'missing') {
      throw new McpChangePlanError('approval_missing', 'Out-of-band approval is required before commit.');
    }
    if (result.reason === 'binding_mismatch') {
      throw new McpChangePlanError('plan_binding_mismatch', 'Approval binding does not match commit principal.');
    }
    if (result.reason === 'digest_mismatch') {
      throw new McpChangePlanError('digest_mismatch', 'Approval digest does not match plan operations.');
    }
    if (result.reason === 'expired') {
      throw new McpChangePlanError('plan_expired', 'Plan has expired; create a new plan.');
    }
    throw new McpChangePlanError('plan_already_consumed', 'Concurrent commit lost the single-winner race.');
  }
  if (result.status !== 'ready') {
    throw new McpChangePlanError('commit_failed', 'Approval begin-commit failed closed.');
  }
}

function assertBindingMatch(plan: McpStoredPlan, binding: McpAuthenticatedAuthorizationBinding): void {
  const stored = plan.binding;
  if (
    stored.kind !== binding.kind
    || stored.principalId !== binding.principalId
    || stored.clientId !== binding.clientId
    || stored.credentialBindingId !== binding.credentialBindingId
    || stored.resourceAudience !== binding.resourceAudience
    || stored.securityEpoch !== binding.securityEpoch
  ) {
    throw new McpChangePlanError(
      'plan_binding_mismatch',
      'Plan is bound to a different principal, client, credential, audience, or security epoch.',
    );
  }
}

function assertPlanIdentity(plan: McpStoredPlan, requestedPlanId: string): void {
  if (plan.planId !== requestedPlanId) {
    throw new McpChangePlanError(
      'commit_failed',
      'Commit coordinator returned a Plan that does not match the requested planId.',
    );
  }
}

async function loadPlan(
  store: { receiver: object; get: McpChangePlanStorePort['get'] },
  planId: string,
): Promise<McpStoredPlan> {
  if (typeof planId !== 'string' || planId.length === 0) {
    throw new McpChangePlanError('plan_not_found', 'planId must be a non-empty string.');
  }
  const plan = await Reflect.apply(store.get, store.receiver, [planId]);
  if (plan === undefined || plan === null) {
    throw new McpChangePlanError('plan_not_found', `Plan ${planId} was not found.`);
  }
  return plan;
}

async function loadLockedPlan<
  Transaction extends McpChangePlanCommitTransaction,
>(
  store: {
    receiver: object;
    lock: McpChangePlanCommitPlanStorePort<Transaction>['lock'];
  },
  transaction: Transaction,
  planId: string,
): Promise<McpStoredPlan> {
  const plan = await Reflect.apply(store.lock, store.receiver, [transaction, planId]);
  if (plan === undefined || plan === null) {
    throw new McpChangePlanError('plan_not_found', `Plan ${planId} was not found.`);
  }
  return plan;
}

function assertCommitTransaction(
  transaction: McpChangePlanCommitTransaction,
): asserts transaction is McpChangePlanCommitTransaction {
  if ((typeof transaction !== 'object' && typeof transaction !== 'function') || transaction === null) {
    throw new McpChangePlanError('commit_failed', 'Commit coordinator returned an invalid transaction handle.');
  }
}

function normalizeCommitFailure(cause: unknown): McpChangePlanError {
  if (cause instanceof McpChangePlanError) return cause;
  return new McpChangePlanError(
    'commit_failed',
    'Commit transaction failed; no successful outcome is reported.',
  );
}

function joinApprovalUri(
  base: HttpUrl,
  planId: string,
  policy: ResolvedMcpHttpUriPolicy,
): HttpUrl {
  const parsed = new URL(base);
  const basePath = parsed.pathname.endsWith('/') ? parsed.pathname : `${parsed.pathname}/`;
  parsed.pathname = `${basePath}${encodeURIComponent(planId)}`;
  parsed.search = '';
  parsed.hash = '';
  if (!parsed.pathname.startsWith(basePath) || parsed.pathname === basePath) {
    throw new McpChangePlanError(
      'invalid_plan_request',
      'Plan id cannot be represented as one safe approval URI path segment.',
    );
  }
  return authorizeMcpHttpUri(parsed.href, 'approval', policy);
}

function readBinding(binding: McpAuthenticatedAuthorizationBinding): McpAuthenticatedAuthorizationBinding {
  try {
    return requireAuthenticatedWriteBinding(snapshotMcpAuthorizationBinding(binding));
  } catch (cause) {
    throw new McpChangePlanError(
      'plan_binding_mismatch',
      'Plan requires an authenticated authorization binding (principal/client/credential/audience/security epoch).',
    );
  }
}

function readOwnString(object: object, name: string): string | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(object, name);
  if (descriptor === undefined || !('value' in descriptor) || typeof descriptor.value !== 'string') {
    return undefined;
  }
  return descriptor.value.length > 0 ? descriptor.value : undefined;
}

type ResolvedServiceOptions<
  Transaction extends McpChangePlanCommitTransaction,
> = {
  readonly planStore: {
    receiver: object;
    save: McpChangePlanStorePort['save'];
    get: McpChangePlanStorePort['get'];
    update: McpChangePlanStorePort['update'];
  };
  readonly approvalStore: {
    receiver: object;
    markApproved: McpApprovalStorePort['markApproved'];
    beginCommit: McpApprovalStorePort['beginCommit'];
    finalizeCommit: McpApprovalStorePort['finalizeCommit'];
    abortCommit: McpApprovalStorePort['abortCommit'];
  };
  readonly impact: { receiver: object; assessImpact: McpChangePlanImpactPort['assessImpact'] };
  readonly revisions: {
    receiver: object;
    resolveBaseRevisions: McpChangePlanRevisionPort['resolveBaseRevisions'];
    currentRevisions: McpChangePlanRevisionPort<Transaction>['currentRevisions'];
  };
  readonly scopes: { receiver: object; hasScopes: McpChangePlanScopePort['hasScopes'] };
  readonly authorizationPolicy: {
    receiver: object;
    requiredScopesForOperation: McpChangePlanAuthorizationPolicyPort['requiredScopesForOperation'];
  };
  readonly commitCoordinator: {
    receiver: object;
    begin: McpChangePlanCommitCoordinatorPort<Transaction>['begin'];
    commit: McpChangePlanCommitCoordinatorPort<Transaction>['commit'];
    rollback: McpChangePlanCommitCoordinatorPort<Transaction>['rollback'];
    release: McpChangePlanCommitCoordinatorPort<Transaction>['release'];
    planStore: {
      receiver: object;
      lock: McpChangePlanCommitPlanStorePort<Transaction>['lock'];
      update: McpChangePlanCommitPlanStorePort<Transaction>['update'];
    };
    approvalStore: {
      receiver: object;
      markApproved: McpChangePlanCommitApprovalStorePort<Transaction>['markApproved'];
      beginCommit: McpChangePlanCommitApprovalStorePort<Transaction>['beginCommit'];
      finalizeCommit: McpChangePlanCommitApprovalStorePort<Transaction>['finalizeCommit'];
    };
    executor: { receiver: object; execute: McpChangePlanExecutorPort<Transaction>['execute'] };
  };
  readonly rateLimit: { receiver: object; allow: McpChangePlanRateLimitPort['allow']; allowPlan?: McpChangePlanRateLimitPort['allowPlan'] };
  readonly verifyStoredOperationsDigest?: {
    receiver: object;
    verify: McpChangePlanStoredDigestPort['verify'];
  };
  readonly approvalBaseUri: HttpUrl;
  readonly uriPolicy: ResolvedMcpHttpUriPolicy;
  readonly uriPolicyPort: McpHttpUriPolicyPort;
  readonly clock?: McpChangePlanClockPort;
  readonly ids?: McpChangePlanIdPort;
  readonly planTtlMilliseconds?: number;
  readonly maxConcurrentPlans: number;
  readonly revealUriForKey?: (keyId: string) => string;
  readonly inputBudget: Required<McpWriteInputBudget>;
};

function readServiceOptions<
  Transaction extends McpChangePlanCommitTransaction,
>(options: McpChangePlanServiceOptions<Transaction>): ResolvedServiceOptions<Transaction> {
  if (typeof options !== 'object' || options === null || nodeTypes.isProxy(options)) {
    throw new TypeError('createChangePlanService requires an options object.');
  }

  const approvalBaseUriCandidate = readOwnString(options, 'approvalBaseUri');
  if (approvalBaseUriCandidate === undefined) {
    throw new TypeError('createChangePlanService requires approvalBaseUri.');
  }
  const uriPolicyDescriptor = Object.getOwnPropertyDescriptor(options, 'uriPolicy');
  if (uriPolicyDescriptor === undefined || !('value' in uriPolicyDescriptor)) {
    throw new TypeError('createChangePlanService requires an own-data uriPolicy port.');
  }
  const uriPolicyPort = uriPolicyDescriptor.value as McpHttpUriPolicyPort;
  const uriPolicy = resolveMcpHttpUriPolicy(uriPolicyPort);
  const approvalBaseUri = authorizeMcpHttpUri(
    approvalBaseUriCandidate,
    'approval',
    uriPolicy,
  );
  const approvalBase = new URL(approvalBaseUri);
  if (approvalBase.search !== '' || approvalBase.hash !== '') {
    throw new TypeError('approvalBaseUri must not contain a query or fragment.');
  }

  const resolved: ResolvedServiceOptions<Transaction> = {
    planStore: readPort(options, 'planStore', ['save', 'get', 'update']) as ResolvedServiceOptions<Transaction>['planStore'],
    approvalStore: readPort(options, 'approvalStore', [
      'markApproved',
      'beginCommit',
      'finalizeCommit',
      'abortCommit',
    ]) as ResolvedServiceOptions<Transaction>['approvalStore'],
    impact: readPort(options, 'impact', ['assessImpact']) as ResolvedServiceOptions<Transaction>['impact'],
    revisions: readPort(options, 'revisions', ['resolveBaseRevisions', 'currentRevisions']) as
      ResolvedServiceOptions<Transaction>['revisions'],
    scopes: readPort(options, 'scopes', ['hasScopes']) as ResolvedServiceOptions<Transaction>['scopes'],
    authorizationPolicy: readPort(options, 'authorizationPolicy', ['requiredScopesForOperation']) as
      ResolvedServiceOptions<Transaction>['authorizationPolicy'],
    commitCoordinator: readCommitCoordinator<Transaction>(options),
    rateLimit: readChangePlanRateLimitPort(options, readPort),
    approvalBaseUri,
    uriPolicy,
    uriPolicyPort,
    inputBudget: resolveMcpWriteInputBudget(readOptionalInputBudget(options)),
    maxConcurrentPlans: readOptionalPositiveInteger(options, 'maxConcurrentPlans', MCP_CHANGE_PLAN_DEFAULT_MAX_CONCURRENT_PLANS),
  };

  const verifyStoredOperationsDigest = readOptionalPort(options, 'verifyStoredOperationsDigest');
  if (verifyStoredOperationsDigest !== undefined) {
    (resolved as { verifyStoredOperationsDigest?: ResolvedServiceOptions<Transaction>['verifyStoredOperationsDigest'] })
      .verifyStoredOperationsDigest = readPort(
        { verifyStoredOperationsDigest },
        'verifyStoredOperationsDigest',
        ['verify'],
      ) as ResolvedServiceOptions<Transaction>['verifyStoredOperationsDigest'];
  }
  const clock = readOptionalPort(options, 'clock') as McpChangePlanClockPort | undefined;
  if (clock !== undefined) (resolved as { clock?: McpChangePlanClockPort }).clock = clock;
  const ids = readOptionalPort(options, 'ids') as McpChangePlanIdPort | undefined;
  if (ids !== undefined) (resolved as { ids?: McpChangePlanIdPort }).ids = ids;
  const planTtlMilliseconds = readOptionalNumber(options, 'planTtlMilliseconds');
  if (planTtlMilliseconds !== undefined) {
    (resolved as { planTtlMilliseconds?: number }).planTtlMilliseconds = planTtlMilliseconds;
  }
  const revealUriForKey = readOptionalRevealUriForKey(options);
  if (revealUriForKey !== undefined) {
    (resolved as { revealUriForKey?: (keyId: string) => string }).revealUriForKey = revealUriForKey;
  }
  return Object.freeze(resolved);
}

function readCommitCoordinator<
  Transaction extends McpChangePlanCommitTransaction,
>(options: object): ResolvedServiceOptions<Transaction>['commitCoordinator'] {
  const coordinator = readPort(options, 'commitCoordinator', [
    'begin',
    'commit',
    'rollback',
    'release',
  ]);
  return Object.freeze({
    ...coordinator,
    planStore: readPort(coordinator.receiver, 'planStore', ['lock', 'update']) as
      ResolvedServiceOptions<Transaction>['commitCoordinator']['planStore'],
    approvalStore: readPort(coordinator.receiver, 'approvalStore', [
      'markApproved',
      'beginCommit',
      'finalizeCommit',
    ]) as ResolvedServiceOptions<Transaction>['commitCoordinator']['approvalStore'],
    executor: readPort(coordinator.receiver, 'executor', ['execute']) as
      ResolvedServiceOptions<Transaction>['commitCoordinator']['executor'],
  }) as ResolvedServiceOptions<Transaction>['commitCoordinator'];
}

function redactStoredCommitResult(
  result: McpPlanCommitResult,
  revealUriForKey?: (keyId: string) => string,
  uriPolicy?: McpHttpUriPolicyPort,
  inputBudget?: McpWriteInputBudget,
): McpPlanCommitResult {
  const redacted = redactCommitStructuredContent(
    result,
    revealUriForKey !== undefined && uriPolicy !== undefined
      ? { revealUriForKey, uriPolicy }
      : undefined,
  );
  return snapshotMcpData(redacted, inputBudget) as McpPlanCommitResult;
}

function readOptionalRevealUriForKey(
  options: object,
): ((keyId: string) => string) | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(options, 'revealUriForKey');
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor)
    || typeof descriptor.value !== 'function'
    || nodeTypes.isProxy(descriptor.value)) {
    throw new TypeError('revealUriForKey must be a function when provided.');
  }
  return descriptor.value as (keyId: string) => string;
}

function readOptionalInputBudget(options: object): McpWriteInputBudget | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(options, 'inputBudget');
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor)
    || typeof descriptor.value !== 'object'
    || descriptor.value === null
    || nodeTypes.isProxy(descriptor.value)) {
    throw new TypeError('inputBudget must be an own-data object when provided.');
  }
  return descriptor.value as McpWriteInputBudget;
}

function readPort(
  options: object,
  name: string,
  methods: readonly string[],
): { receiver: object; [method: string]: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(options, name);
  if (
    descriptor === undefined
    || !('value' in descriptor)
    || typeof descriptor.value !== 'object'
    || descriptor.value === null
    || nodeTypes.isProxy(descriptor.value)
  ) {
    throw new TypeError(`createChangePlanService requires an own-data ${name} port.`);
  }
  const port = descriptor.value as object;
  const result: { receiver: object; [method: string]: unknown } = { receiver: port };
  for (const method of methods) {
    const methodDescriptor = Object.getOwnPropertyDescriptor(port, method);
    if (
      methodDescriptor === undefined
      || !('value' in methodDescriptor)
      || typeof methodDescriptor.value !== 'function'
      || nodeTypes.isProxy(methodDescriptor.value)
    ) {
      throw new TypeError(
        `The ${name} port must own ${method} as a data function `
          + '(class prototype methods are rejected; bind or wrap as an own property).',
      );
    }
    result[method] = methodDescriptor.value;
  }
  return result;
}

function readOptionalPort(options: object, name: string): undefined | never {
  const descriptor = Object.getOwnPropertyDescriptor(options, name);
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor)) {
    throw new TypeError(`${name} must be an own data property when provided.`);
  }
  return descriptor.value as never;
}

function readOptionalPositiveInteger(options: object, name: string, fallback: number): number {
  const descriptor = Object.getOwnPropertyDescriptor(options, name);
  if (descriptor === undefined) return fallback;
  if (!('value' in descriptor) || typeof descriptor.value !== 'number' || !Number.isSafeInteger(descriptor.value) || descriptor.value < 1) {
    throw new TypeError(`${name} must be a positive safe integer when provided.`);
  }
  return descriptor.value;
}

function readOptionalNumber(options: object, name: string): number | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(options, name);
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor) || typeof descriptor.value !== 'number' || !Number.isFinite(descriptor.value)) {
    throw new TypeError(`${name} must be a finite number when provided.`);
  }
  return descriptor.value;
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
