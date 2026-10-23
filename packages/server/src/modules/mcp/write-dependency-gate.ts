/**
 * MCP-W01 Write dependency and threat gate.
 *
 * Write must not begin from package evidence alone. This host gate requires
 * the already-issued P4B-R14 `mcp-read` profile claims, a Read host proof that
 * names the real route/request-context/probe composition, and a Publisher
 * application + Canonical Mutation + UnitOfWork evidence triple. It then
 * validates the frozen minimal W01 catalog and MRTR contract with fail-closed
 * checks for prompt injection, secret reveal, risk downgrade, open payloads,
 * cross-binding/URI, and server-initiated request absence.
 *
 * This module implements no Plan persistence, Canonical write, Product
 * API/UI, or Profile claim (MCP-W02..W10 remain outside W01).
 */
import {
  PHASE4B_MCP_CONFIG_PROTOCOL_VERSION,
} from './config.js';

export type Phase4bMcpWriteRiskLevel = 'low' | 'medium' | 'high';

export type Phase4bMcpWriteOperationName =
  | 'nodes.create'
  | 'nodes.set_visibility'
  | 'changes.plan'
  | 'changes.commit'
  | 'changes.cancel';

export const PHASE4B_MCP_WRITE_OPERATION_NAMES: readonly Phase4bMcpWriteOperationName[] = Object.freeze([
  'nodes.create',
  'nodes.set_visibility',
  'changes.plan',
  'changes.commit',
  'changes.cancel',
]);

export const PHASE4B_MCP_WRITE_HIGH_RISK_OPERATIONS: readonly string[] = Object.freeze([
  'nodes.set_visibility',
]);

export const PHASE4B_MCP_COLLECTION_VISIBILITIES = Object.freeze([
  'private',
  'protected',
  'unlisted',
  'public',
] as const);

export type Phase4bMcpCollectionVisibility =
  (typeof PHASE4B_MCP_COLLECTION_VISIBILITIES)[number];

export function isPhase4bMcpCollectionVisibility(
  value: string,
): value is Phase4bMcpCollectionVisibility {
  return (PHASE4B_MCP_COLLECTION_VISIBILITIES as readonly string[]).includes(value);
}

export function isPhase4bMcpPublicCollectionVisibility(
  visibility: string,
): visibility is 'public' | 'unlisted' {
  return visibility === 'public' || visibility === 'unlisted';
}

export function phase4bMcpResolvedCreateVisibility(
  nodeVisibility: string | undefined,
  collectionVisibility: string,
): 'inherit' | 'protected' | 'private' {
  if (nodeVisibility === 'protected' || nodeVisibility === 'private') {
    return nodeVisibility;
  }
  if (isPhase4bMcpPublicCollectionVisibility(collectionVisibility)) {
    return 'private';
  }
  return 'inherit';
}

export interface Phase4bMcpWriteRiskContract {
  readonly level: Phase4bMcpWriteRiskLevel;
  readonly basis: string;
}

export interface Phase4bMcpWriteOperationContract {
  readonly name: Phase4bMcpWriteOperationName;
  readonly description: string;
  readonly scope: readonly string[];
  readonly targetUri: string;
  readonly risk: Phase4bMcpWriteRiskContract;
  readonly revision: string;
  readonly idempotency: string;
  readonly approval: string;
  readonly retry: string;
  readonly output: string;
  readonly rollback: string;
  readonly payloadShape: 'closed_typed_operation' | 'plan_control';
  readonly openPayload: false;
  readonly serverRequest: 'none';
  readonly inputRequests: Readonly<Record<string, never>>;
  readonly sameServerAuthority: true;
  readonly authenticatedOnly: true;
}

export const PHASE4B_MCP_WRITE_MRTR_CONTRACT = Object.freeze({
  protocolVersion: PHASE4B_MCP_CONFIG_PROTOCOL_VERSION,
  resultType: 'input_required',
  requestState: 'server_minted_bound_hmac',
  inputRequests: Object.freeze({} as Record<string, never>),
  inputResponses: 'structured_validation_only',
  retry: 'new_request_with_request_state',
  serverInitiatedRequests: 'none',
  elicitationId: 'forbidden',
  completionNotifications: 'forbidden',
} as const);

export const PHASE4B_MCP_WRITE_RISK_APPROVAL_ROLLBACK_CONTRACT = Object.freeze({
  risk: 'aggregate_highest_expanded_operation_risk',
  approval: 'one_time_reauthenticated_out_of_band_user_decision',
  rollback: 'same_transaction_rollback_no_partial_consume',
  revision: 'transaction_bound_revalidation',
  retry: 'request_state_and_idempotency_replay',
} as const);

export const PHASE4B_MCP_WRITE_THREAT_CONTRACT = Object.freeze({
  promptInjection: 'fixed_trusted_descriptions_and_structured_results',
  secretReveal: 'no_secret_fields_or_plaintext_credentials', // secret-scan: allow 'no_secret_fields_or_plaintext_credentials' (threat-contract label, not a credential)
  riskDowngrade: 'catalog_and_runtime_risk_fail_closed',
  openPayload: 'closed_typed_operation_schemas_only',
  crossBindingUri: 'same_server_authority_authenticated_scope_binding',
  serverInitiatedRequests: 'absent',
  approval: 'out_of_band_reauthenticated_user_decision',
  rollback: 'transactional_rollback_no_partial_consume',
} as const);

const NODE_TARGET_URI_TEMPLATE = 'colp://{serverUuid}/collections/{collectionId}/nodes/{nodeId}';
const PLAN_CONTROL_TARGET_URI = 'none' as const;
Object.freeze([
  'approval',
  'authenticatedOnly',
  'description',
  'idempotency',
  'inputRequests',
  'name',
  'openPayload',
  'output',
  'payloadShape',
  'retry',
  'revision',
  'risk',
  'rollback',
  'sameServerAuthority',
  'scope',
  'serverRequest',
  'targetUri',
]);
Object.freeze([
  'ignore previous',
  'ignore all',
  'disregard',
  'system prompt',
  'system:',
  'now act as',
  'you are now',
  'forget instructions',
]);
Object.freeze([
  'secret',
  'token',
  'password',
  'credential',
  'authorization',
  'privatekey',
  'apikey',
]);

new WeakSet<object>();
new WeakSet<object>();

const NODE_CREATE_CONTRACT = Object.freeze({
  name: 'nodes.create',
  description:
    'Create one Canonical Node in an authenticated, same-server Collection scope. inherit visibility on a public or unlisted Collection is stored as private.',
  scope: Object.freeze(['nodes:write']),
  targetUri: NODE_TARGET_URI_TEMPLATE,
  risk: Object.freeze({
    level: 'low',
    basis: 'canonical_node_create_runtime_gated_by_collection_visibility',
  }),
  revision: 'parent_children_revision_and_collection_content_revision',
  idempotency: 'operation_digest_with_publisher_idempotency',
  approval: 'none_public_or_unlisted_inherit_stored_as_private',
  retry: 'same_idempotency_key_or_operation_digest',
  output: 'known.mcp.write.nodes.create.output.v1',
  rollback: 'transactional_rollback_on_error',
  payloadShape: 'closed_typed_operation',
  openPayload: false,
  serverRequest: 'none',
  inputRequests: Object.freeze({} as Record<string, never>),
  sameServerAuthority: true,
  authenticatedOnly: true,
} as const satisfies Phase4bMcpWriteOperationContract);

const SET_VISIBILITY_CONTRACT = Object.freeze({
  name: 'nodes.set_visibility',
  description: 'Change one Canonical Node visibility to protected or private after plan approval.',
  scope: Object.freeze(['access:write']),
  targetUri: NODE_TARGET_URI_TEMPLATE,
  risk: Object.freeze({
    level: 'high',
    basis: 'protected_or_private_visibility_requires_plan_approval',
  }),
  revision: 'resource_revision_and_policy_revision',
  idempotency: 'plan_digest_and_request_state',
  approval: 'out_of_band_required',
  retry: 'new_request_with_request_state_after_approval',
  output: 'known.mcp.write.nodes.set_visibility.output.v1',
  rollback: 'transactional_rollback_on_error',
  payloadShape: 'closed_typed_operation',
  openPayload: false,
  serverRequest: 'none',
  inputRequests: Object.freeze({} as Record<string, never>),
  sameServerAuthority: true,
  authenticatedOnly: true,
} as const satisfies Phase4bMcpWriteOperationContract);

const CHANGES_PLAN_CONTRACT = Object.freeze({
  name: 'changes.plan',
  description: 'Create a pending high-risk Change Plan. dryRun must be true and stores a real plan; apply with changes.commit after approval.',
  scope: Object.freeze(['nodes:write', 'access:write']),
  targetUri: PLAN_CONTROL_TARGET_URI,
  risk: Object.freeze({
    level: 'low',
    basis: 'plan_creation_control_plane',
  }),
  revision: 'plan_base_revisions',
  idempotency: 'request_state_digest',
  approval: 'none_for_plan_creation',
  retry: 'new_request_with_request_state_for_plan',
  output: 'known.mcp.write.changes.plan.output.v1',
  rollback: 'no_resource_effect',
  payloadShape: 'plan_control',
  openPayload: false,
  serverRequest: 'none',
  inputRequests: Object.freeze({} as Record<string, never>),
  sameServerAuthority: true,
  authenticatedOnly: true,
} as const satisfies Phase4bMcpWriteOperationContract);

const CHANGES_COMMIT_CONTRACT = Object.freeze({
  name: 'changes.commit',
  description: 'Commit an approved Change Plan after revalidating binding, digest, revision, scope, and impact.',
  scope: Object.freeze(['nodes:write', 'access:write', 'changes:commit']),
  targetUri: PLAN_CONTROL_TARGET_URI,
  risk: Object.freeze({
    level: 'low',
    basis: 'commit_revalidates_plan_approval_and_digest',
  }),
  revision: 'plan_commit_revisions',
  idempotency: 'request_state_and_idempotency_key',
  approval: 'revalidates_out_of_band_approval',
  retry: 'new_request_with_request_state_for_commit',
  output: 'known.mcp.write.changes.commit.output.v1',
  rollback: 'transactional_rollback_on_error',
  payloadShape: 'plan_control',
  openPayload: false,
  serverRequest: 'none',
  inputRequests: Object.freeze({} as Record<string, never>),
  sameServerAuthority: true,
  authenticatedOnly: true,
} as const satisfies Phase4bMcpWriteOperationContract);

const CHANGES_CANCEL_CONTRACT = Object.freeze({
  name: 'changes.cancel',
  description: 'Cancel a pending Change Plan bound to the current authenticated request state.',
  scope: Object.freeze(['changes:cancel']),
  targetUri: PLAN_CONTROL_TARGET_URI,
  risk: Object.freeze({
    level: 'low',
    basis: 'cancel_control_plane',
  }),
  revision: 'plan_cancel_status',
  idempotency: 'request_state',
  approval: 'none',
  retry: 'new_request_with_request_state_for_cancel',
  output: 'known.mcp.write.changes.cancel.output.v1',
  rollback: 'no_resource_effect',
  payloadShape: 'plan_control',
  openPayload: false,
  serverRequest: 'none',
  inputRequests: Object.freeze({} as Record<string, never>),
  sameServerAuthority: true,
  authenticatedOnly: true,
} as const satisfies Phase4bMcpWriteOperationContract);

export const PHASE4B_MCP_WRITE_CATALOG: readonly Phase4bMcpWriteOperationContract[] = Object.freeze([
  NODE_CREATE_CONTRACT,
  SET_VISIBILITY_CONTRACT,
  CHANGES_PLAN_CONTRACT,
  CHANGES_COMMIT_CONTRACT,
  CHANGES_CANCEL_CONTRACT,
]);
