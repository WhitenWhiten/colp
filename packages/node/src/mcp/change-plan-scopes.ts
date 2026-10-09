import { types as nodeTypes } from 'node:util';
import { createValidatorRegistry } from '../schema/index.js';
import type { ChangePlanOperation, ScopeName } from '../types/generated.js';
import { resolveMcpWriteInputBudget, snapshotMcpData, type McpWriteInputBudget } from './safe-data.js';
import { McpChangePlanError, type McpChangePlanAuthorizationPolicyPort } from './change-plan.js';
import type { McpAuthenticatedAuthorizationBinding } from './shared/authorization.js';

const validators = createValidatorRegistry();
type ResolvedAuthorizationPolicy = {
  readonly receiver: object;
  readonly requiredScopesForOperation: McpChangePlanAuthorizationPolicyPort['requiredScopesForOperation'];
};

export async function deriveRequiredScopes(
  operations: readonly ChangePlanOperation[],
  binding: McpAuthenticatedAuthorizationBinding,
  policy: ResolvedAuthorizationPolicy,
  inputBudget: Required<McpWriteInputBudget>,
): Promise<readonly ScopeName[]> {
  const required = new Set<ScopeName>();
  for (const operation of operations) {
    const canonicalScope = canonicalScopeForOperation(operation);
    if (canonicalScope !== undefined) required.add(canonicalScope);
    const policyCandidate = Reflect.apply(policy.requiredScopesForOperation, policy.receiver, [operation, binding]);
    const policyScopes = await resolvePolicyScopes(policyCandidate, operation.type, inputBudget);
    if (operation.type === 'sync_mirror' && policyScopes.length === 0) {
      throw new McpChangePlanError('invalid_plan_request', 'Authorization policy must return at least one Scope for sync_mirror.');
    }
    for (const scope of policyScopes) required.add(scope);
  }
  return Object.freeze([...required]);
}

export async function deriveMcpOperationRequiredScopes(
  operations: readonly ChangePlanOperation[],
  binding: McpAuthenticatedAuthorizationBinding,
  policy: McpChangePlanAuthorizationPolicyPort,
  inputBudget?: McpWriteInputBudget,
): Promise<readonly ScopeName[]> {
  if (typeof policy !== 'object' || policy === null || nodeTypes.isProxy(policy)) {
    throw new McpChangePlanError('invalid_plan_request', 'Authorization policy is invalid.');
  }
  const descriptor = Object.getOwnPropertyDescriptor(policy, 'requiredScopesForOperation');
  if (descriptor === undefined || !('value' in descriptor) || typeof descriptor.value !== 'function') {
    throw new McpChangePlanError('invalid_plan_request', 'Authorization policy must own requiredScopesForOperation.');
  }
  return deriveRequiredScopes(
    operations,
    binding,
    { receiver: policy, requiredScopesForOperation: descriptor.value },
    resolveMcpWriteInputBudget(inputBudget),
  );
}

async function resolvePolicyScopes(candidate: unknown, operationType: string, inputBudget: Required<McpWriteInputBudget>): Promise<readonly ScopeName[]> {
  if (candidate !== null && (typeof candidate === 'object' || typeof candidate === 'function')) {
    if (nodeTypes.isProxy(candidate)) throw invalidPolicyScopes(operationType);
    if (nodeTypes.isPromise(candidate)) {
      const settled = await new Promise<unknown>((resolve, reject) => Reflect.apply(Promise.prototype.then, candidate, [resolve, reject]));
      return readPolicyScopes(settled, operationType, inputBudget);
    }
  }
  return readPolicyScopes(candidate, operationType, inputBudget);
}

function canonicalScopeForOperation(operation: ChangePlanOperation): ScopeName | undefined {
  switch (operation.type) {
    case 'delete_collection': return 'collections:delete';
    case 'delete_subtree': return 'nodes:delete';
    case 'set_visibility':
    case 'set_access_policy': return 'access:write';
    case 'create_key':
    case 'rotate_key':
    case 'revoke_key': return 'keys:write';
    case 'set_rate_limit': return 'rate_limits:write';
    case 'publish_release': return 'release:publish';
    case 'sync_mirror': return undefined;
    default: throw new McpChangePlanError('invalid_plan_request', 'Unknown change Plan operation has no canonical authorization policy.');
  }
}

function readPolicyScopes(value: unknown, operationType: string, inputBudget: Required<McpWriteInputBudget>): readonly ScopeName[] {
  let snapshot: unknown;
  try { snapshot = snapshotMcpData(value, inputBudget); } catch { throw invalidPolicyScopes(operationType); }
  if (!Array.isArray(snapshot)) throw invalidPolicyScopes(operationType);
  const scopes: ScopeName[] = [];
  for (const valueScope of snapshot) {
    if (!validators.validate('scopeName', valueScope).valid) {
      throw new McpChangePlanError('invalid_plan_request', `Authorization policy for ${operationType} returned a non-canonical Scope.`);
    }
    scopes.push(valueScope as ScopeName);
  }
  return Object.freeze(scopes);
}

function invalidPolicyScopes(operationType: string): McpChangePlanError {
  return new McpChangePlanError('invalid_plan_request', `Authorization policy for ${operationType} must return a safe canonical Scope array.`);
}
