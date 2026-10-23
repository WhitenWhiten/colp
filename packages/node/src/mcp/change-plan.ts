/** Coordinates admission, out-of-band approval, commit and cancellation through host ports. */
import { runChangePlanTransaction } from './change-plan-transaction.js';
import { randomUUID } from 'node:crypto';
import type {
  ChangePlan,
  ChangePlanImpact,
  ChangePlanOperation,
  HttpUrl,
  ScopeName,
} from '../types/generated.js';
import {
  assertKeyRevealCapability,
  buildSummary,
  computeOperationsDigest,
  impactExceeds,
  resolveBaseRevisions,
  resolveImpact,
  resolveOperationResults,
  resolveRevisionMap,
  revisionsMatch,
  validatePlanRequest,
} from './change-plan-input.js';
import { readServiceOptions, redactStoredCommitResult } from './change-plan-options.js';
import { allowChangePlanAdmission } from './change-plan-rate-limit.js';
import { deriveMcpOperationRequiredScopes, deriveRequiredScopes } from './change-plan-scopes.js';
import {
  assertApprovablePlanState,
  assertApprovalReady,
  assertBindingMatch,
  assertCancellablePlanState,
  assertCommitPlanState,
  assertPlanIdentity,
  joinApprovalUri,
  loadLockedPlan,
  readBinding,
} from './change-plan-state.js';
import type {
  McpChangePlanApprovalBeginContext,
  McpChangePlanCancelBeginContext,
  McpChangePlanCommitBeginContext,
  McpChangePlanCommitTransaction,
  McpChangePlanService,
  McpChangePlanServiceOptions,
  McpPlanCommitResult,
  McpStoredPlan,
} from './change-plan-types.js';
import { MCP_CHANGE_PLAN_DEFAULT_MAX_CONCURRENT_PLANS, McpChangePlanError } from './change-plan-types.js';
import { assessCanonicalOperations, type RiskLevel } from './risk-aggregation.js';
import { snapshotMcpData } from './safe-data.js';
import { type McpAuthenticatedAuthorizationBinding } from './shared/authorization.js';
export { computeOperationsDigest } from './change-plan-input.js';
export * from './change-plan-memory.js';
export * from './change-plan-types.js';

export { deriveMcpOperationRequiredScopes };

const DEFAULT_TTL_MS = 15 * 60 * 1000;

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
    await runChangePlanTransaction(ports.commitCoordinator, beginContext, 'Approval', async transaction => {
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
    });
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
    const result = await runChangePlanTransaction(ports.commitCoordinator, beginContext, 'Commit', async transaction => {
      let result: McpPlanCommitResult | undefined;
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
      return result;
    });
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
    const result = await runChangePlanTransaction(ports.commitCoordinator, beginContext, 'Cancel', async transaction => {
      let result: Readonly<{ planId: string; status: 'cancelled' }> | undefined;
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
      return result;
    });
    if (result === undefined) {
      throw new McpChangePlanError('commit_failed', 'Cancel completed without a durable result.');
    }
    return result;
  };

  return Object.freeze({ plan, recordOutOfBandApproval, commit, cancel });
}
