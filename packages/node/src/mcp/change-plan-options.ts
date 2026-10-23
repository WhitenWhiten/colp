/** Captures host capabilities and validates the service composition boundary. */
import { types as nodeTypes } from 'node:util';
import type { HttpUrl } from '../types/generated.js';
import { readChangePlanRateLimitPort } from './change-plan-rate-limit.js';
import type {
  McpApprovalStorePort,
  McpChangePlanAuthorizationPolicyPort,
  McpChangePlanClockPort,
  McpChangePlanCommitApprovalStorePort,
  McpChangePlanCommitCoordinatorPort,
  McpChangePlanCommitPlanStorePort,
  McpChangePlanCommitTransaction,
  McpChangePlanExecutorPort,
  McpChangePlanIdPort,
  McpChangePlanImpactPort,
  McpChangePlanRateLimitPort,
  McpChangePlanRevisionPort,
  McpChangePlanScopePort,
  McpChangePlanServiceOptions,
  McpChangePlanStoredDigestPort,
  McpChangePlanStorePort,
  McpPlanCommitResult,
} from './change-plan-types.js';
import { MCP_CHANGE_PLAN_DEFAULT_MAX_CONCURRENT_PLANS } from './change-plan-types.js';
import {
  authorizeMcpHttpUri,
  resolveMcpHttpUriPolicy,
  type McpHttpUriPolicyPort,
  type ResolvedMcpHttpUriPolicy,
} from './http-uri-policy.js';
import { resolveMcpWriteInputBudget, snapshotMcpData, type McpWriteInputBudget } from './safe-data.js';
import { redactCommitStructuredContent } from './secret-redaction.js';

function readOwnString(object: object, name: string): string | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(object, name);
  if (descriptor === undefined || !('value' in descriptor) || typeof descriptor.value !== 'string') {
    return undefined;
  }
  return descriptor.value.length > 0 ? descriptor.value : undefined;
}

export type ResolvedServiceOptions<
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

export function readServiceOptions<
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

export function redactStoredCommitResult(
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
): { receiver: object;[method: string]: unknown } {
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
  const result: { receiver: object;[method: string]: unknown } = { receiver: port };
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
