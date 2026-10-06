import { types as nodeTypes } from 'node:util';
import type { McpAuthenticatedAuthorizationBinding } from './shared/authorization.js';
import type { ChangePlan } from '../types/generated.js';
import type { McpChangePlanCommitTransaction, McpChangePlanServiceOptions } from './change-plan.js';
import type { McpWriteInputBudget } from './safe-data.js';
import type { McpHttpUriPolicyPort } from './http-uri-policy.js';

/**
 * Composes the required change-plan options with revealUriForKey from the
 * gateway when the change-plan options do not provide their own builder.
 * The host must always provide an explicit rate-limit decision port.
 */
export function resolveChangePlanOptions<
  Transaction extends McpChangePlanCommitTransaction,
>(
  changePlan: McpChangePlanServiceOptions<Transaction>,
  revealUriForKey: ((keyId: string) => string) | undefined,
  inputBudget: Required<McpWriteInputBudget>,
): McpChangePlanServiceOptions<Transaction> {
  const configuredReveal = readOptionalOwnValue(changePlan, 'revealUriForKey') as
    | ((keyId: string) => string)
    | undefined;
  const reveal = configuredReveal ?? revealUriForKey;

  const base: McpChangePlanServiceOptions<Transaction> = {
    planStore: changePlan.planStore,
    approvalStore: changePlan.approvalStore,
    impact: changePlan.impact,
    revisions: changePlan.revisions,
    scopes: changePlan.scopes,
    authorizationPolicy: readOwnValue(
      changePlan,
      'authorizationPolicy',
    ) as McpChangePlanServiceOptions<Transaction>['authorizationPolicy'],
    commitCoordinator: changePlan.commitCoordinator,
    // Preserve only an own-data value. createChangePlanService applies its
    // fail-closed readPort validation to the port and its allow function.
    rateLimit: readOwnValue(
      changePlan,
      'rateLimit',
    ) as McpChangePlanServiceOptions<Transaction>['rateLimit'],
    approvalBaseUri: readOwnValue(changePlan, 'approvalBaseUri') as string,
    uriPolicy: readOwnValue(changePlan, 'uriPolicy') as McpHttpUriPolicyPort,
    inputBudget,
  };

  // Security policy is not optional once configured. Do not turn an accessor
  // or hidden property into an omitted verifier and silently weaken Commit.
  const digestVerifier = Object.getOwnPropertyDescriptor(changePlan, 'verifyStoredOperationsDigest');
  if (digestVerifier !== undefined) {
    if (!('value' in digestVerifier) || digestVerifier.enumerable !== true) {
      throw new TypeError('verifyStoredOperationsDigest must be an own enumerable data property.');
    }
    if (digestVerifier.value !== undefined) {
      (base as { verifyStoredOperationsDigest?: McpChangePlanServiceOptions['verifyStoredOperationsDigest'] })
        .verifyStoredOperationsDigest = digestVerifier.value as McpChangePlanServiceOptions['verifyStoredOperationsDigest'];
    }
  }

  if (changePlan.clock !== undefined) {
    (base as { clock?: McpChangePlanServiceOptions['clock'] }).clock = changePlan.clock;
  }
  if (changePlan.ids !== undefined) {
    (base as { ids?: McpChangePlanServiceOptions['ids'] }).ids = changePlan.ids;
  }
  if (changePlan.planTtlMilliseconds !== undefined) {
    (base as { planTtlMilliseconds?: number }).planTtlMilliseconds = changePlan.planTtlMilliseconds;
  }
  if (reveal !== undefined) {
    (base as { revealUriForKey?: (keyId: string) => string }).revealUriForKey = reveal;
  }
  return Object.freeze(base);
}


function readOwnValue(object: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, name);
  if (descriptor === undefined || !('value' in descriptor)) return undefined;
  return descriptor.value;
}

function readOptionalOwnValue(object: object, name: string): unknown {
  return readOwnValue(object, name);
}

/**
 * Optional host planner carried on the gateway's `changePlan` options. When
 * present, `changes.plan` is minted by it, so the stored operations digest is
 * produced by the same rules as the configured `verifyStoredOperationsDigest`.
 * Without it the generic operations-only digest is used, which a host with a
 * stronger verifier cannot Commit.
 */
export interface McpChangePlanHostPlannerOption {
  readonly planner?: {
    readonly plan: (
      request: unknown,
      binding: McpAuthenticatedAuthorizationBinding,
    ) => Promise<ChangePlan> | ChangePlan;
  };
}

export function readHostPlanner(
  changePlan: object,
): ((request: unknown, binding: McpAuthenticatedAuthorizationBinding) => Promise<ChangePlan>) | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(changePlan, 'planner');
  if (descriptor === undefined) return undefined;
  // Like the digest verifier, a configured planner must never degrade to the
  // generic one through an accessor or hidden property.
  if (!('value' in descriptor) || descriptor.enumerable !== true) {
    throw new TypeError('planner must be an own enumerable data property.');
  }
  const planner = descriptor.value as unknown;
  if (planner === undefined) return undefined;
  if (typeof planner !== 'object' || planner === null || nodeTypes.isProxy(planner)) {
    throw new TypeError('planner must be an object.');
  }
  const plan = Object.getOwnPropertyDescriptor(planner, 'plan');
  if (plan === undefined || !('value' in plan) || typeof plan.value !== 'function') {
    throw new TypeError('planner.plan must be an own data function.');
  }
  const planFunction = plan.value as (request: unknown, binding: McpAuthenticatedAuthorizationBinding) => unknown;
  return async (request, binding) => Reflect.apply(planFunction, planner, [request, binding]) as ChangePlan;
}
