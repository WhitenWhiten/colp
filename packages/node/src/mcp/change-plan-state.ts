/** Checks plan identity, binding and lifecycle transitions under the host transaction. */
import type { HttpUrl } from '../types/generated.js';
import type {
  McpApprovalBeginResult,
  McpChangePlanCommitPlanStorePort,
  McpChangePlanCommitTransaction,
  McpStoredPlan,
} from './change-plan-types.js';
import { McpChangePlanError } from './change-plan-types.js';
import { authorizeMcpHttpUri, type ResolvedMcpHttpUriPolicy } from './http-uri-policy.js';
import {
  requireAuthenticatedWriteBinding,
  snapshotMcpAuthorizationBinding,
  type McpAuthenticatedAuthorizationBinding,
} from './shared/authorization.js';

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

export function assertApprovablePlanState(plan: McpStoredPlan, now: Date): void {
  assertNotTerminal(plan);
  if (plan.status === 'expired' || isExpired(plan, now)) {
    throw new McpChangePlanError('plan_expired', 'Plan has expired; create a new plan.');
  }
  if (plan.status !== 'pending') {
    throw new McpChangePlanError('commit_failed', 'Only a pending Plan can be approved.');
  }
}

export function assertCommitPlanState(plan: McpStoredPlan, now: Date): void {
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

export function assertCancellablePlanState(plan: McpStoredPlan, now: Date): void {
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

export function assertApprovalReady(result: McpApprovalBeginResult): asserts result is { readonly status: 'ready' } {
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

export function assertBindingMatch(plan: McpStoredPlan, binding: McpAuthenticatedAuthorizationBinding): void {
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

export function assertPlanIdentity(plan: McpStoredPlan, requestedPlanId: string): void {
  if (plan.planId !== requestedPlanId) {
    throw new McpChangePlanError(
      'commit_failed',
      'Commit coordinator returned a Plan that does not match the requested planId.',
    );
  }
}

export async function loadLockedPlan<
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

export function assertCommitTransaction(
  transaction: McpChangePlanCommitTransaction,
): asserts transaction is McpChangePlanCommitTransaction {
  if ((typeof transaction !== 'object' && typeof transaction !== 'function') || transaction === null) {
    throw new McpChangePlanError('commit_failed', 'Commit coordinator returned an invalid transaction handle.');
  }
}

export function normalizeCommitFailure(cause: unknown): McpChangePlanError {
  if (cause instanceof McpChangePlanError) return cause;
  return new McpChangePlanError(
    'commit_failed',
    'Commit transaction failed; no successful outcome is reported.',
  );
}

export function joinApprovalUri(
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

export function readBinding(binding: McpAuthenticatedAuthorizationBinding): McpAuthenticatedAuthorizationBinding {
  try {
    return requireAuthenticatedWriteBinding(snapshotMcpAuthorizationBinding(binding));
  } catch (cause) {
    throw new McpChangePlanError(
      'plan_binding_mismatch',
      'Plan requires an authenticated authorization binding (principal/client/credential/audience/security epoch).',
    );
  }
}
