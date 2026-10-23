/** Public Change Plan values and host transaction/authorization contracts. */
import type {
  ChangePlan,
  ChangePlanImpact,
  ChangePlanOperation,
  OperationResult,
  ScopeName,
} from '../types/generated.js';
import { type McpHttpUriPolicyPort } from './http-uri-policy.js';
import { type RiskLevel } from './risk-aggregation.js';
import { type McpWriteInputBudget } from './safe-data.js';
import { type McpAuthenticatedAuthorizationBinding } from './shared/authorization.js';

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

export const MCP_CHANGE_PLAN_DEFAULT_MAX_CONCURRENT_PLANS = 128 as const;

export const MCP_CHANGE_PLAN_UNTRUSTED_NOTE_MAX_LENGTH = 1000;
