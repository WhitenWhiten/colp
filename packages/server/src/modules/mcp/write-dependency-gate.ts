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
  PHASE4B_MCP_CONFIG_ENDPOINT_PATH,
  PHASE4B_MCP_CONFIG_PROTOCOL_VERSION,
} from './config.js';
import {
  PHASE4B_MCP_READ_REQUIRED_PROBE_FAMILY_IDS,
  assertPhase4bMcpReadProfileClaims,
  type Phase4bMcpReadProfileClaims,
} from './read-profile-claim-gate.js';

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

export const PHASE4B_MCP_WRITE_TOOL_NAMES = PHASE4B_MCP_WRITE_OPERATION_NAMES;

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

/**
 * inherit on a public/unlisted Collection would make the Node as visible as
 * the Collection. MCP create auto-applies `private` instead of requiring Plan.
 */
export function phase4bMcpInheritCreateRequiresApproval(
  nodeVisibility: string,
  collectionVisibility: string,
): boolean {
  return nodeVisibility === 'inherit'
    && isPhase4bMcpPublicCollectionVisibility(collectionVisibility);
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

export const PHASE4B_MCP_READ_HOST_ROUTE_PROOF = 'src/transport/mcp/mcp-read-routes.ts' as const;
export const PHASE4B_MCP_READ_HOST_REQUEST_CONTEXT_PROOF =
  'src/modules/mcp/request-context.ts' as const;
export const PHASE4B_MCP_READ_HOST_PROBE_PROOF =
  'docs/evidence/phase4b-mcp-read-acceptance-2026-08-05.md' as const;

export const PHASE4B_MCP_WRITE_PUBLISHER_APPLICATION_PROOF =
  'src/modules/publisher/application/canonical-mutation-harness.ts' as const;
export const PHASE4B_MCP_WRITE_CANONICAL_MUTATION_APPLICATION_PROOF =
  'src/modules/collections/application/canonical-mutation.ts' as const;
export const PHASE4B_MCP_WRITE_UNIT_OF_WORK_PROOF =
  'src/infrastructure/publisher/canonical-unit-of-work.ts' as const;

const PHASE4B_MCP_READ_HOST_ROUTE_REGISTER_NAME = 'registerMcpReadRoutes' as const;
const PHASE4B_MCP_READ_HOST_REQUEST_CONTEXT_CREATE_NAME =
  'createPhase4bMcpRequestContext' as const;
const PHASE4B_MCP_WRITE_PUBLISHER_EXECUTE_NAME = 'executePublisherCanonicalMutation' as const;
const PHASE4B_MCP_WRITE_CANONICAL_MUTATION_EXECUTE_NAME =
  'createCanonicalMutationApplication' as const;
const PHASE4B_MCP_WRITE_UNIT_OF_WORK_EXECUTE_NAME =
  'createPostgresPublisherCanonicalMutationUnitOfWork' as const;

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
const CONTRACT_EXPECTED_KEYS = Object.freeze([
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
const PROMPT_INJECTION_MARKERS = Object.freeze([
  'ignore previous',
  'ignore all',
  'disregard',
  'system prompt',
  'system:',
  'now act as',
  'you are now',
  'forget instructions',
]);
const SECRET_FIELD_MARKERS = Object.freeze([
  'secret',
  'token',
  'password',
  'credential',
  'authorization',
  'privatekey',
  'apikey',
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const issuedReadHostEvidence = new WeakSet<object>();
const issuedPublisherEvidence = new WeakSet<object>();

export interface Phase4bMcpWriteReadHostRouteEvidence {
  readonly proof: typeof PHASE4B_MCP_READ_HOST_ROUTE_PROOF;
  readonly endpointPath: typeof PHASE4B_MCP_CONFIG_ENDPOINT_PATH;
  readonly register: unknown;
}

export interface Phase4bMcpWriteReadHostRequestContextEvidence {
  readonly proof: typeof PHASE4B_MCP_READ_HOST_REQUEST_CONTEXT_PROOF;
  readonly create: unknown;
}

export interface Phase4bMcpWriteReadHostProbeEvidence {
  readonly proof: typeof PHASE4B_MCP_READ_HOST_PROBE_PROOF;
  readonly familyIds: typeof PHASE4B_MCP_READ_REQUIRED_PROBE_FAMILY_IDS;
  readonly evidenceDoc: string;
}

export interface Phase4bMcpWriteReadHostEvidence {
  readonly proof: 'known.phase4b.mcp-write.read-host.v1';
  readonly serverUuid: string;
  readonly route: Phase4bMcpWriteReadHostRouteEvidence;
  readonly requestContext: Phase4bMcpWriteReadHostRequestContextEvidence;
  readonly probe: Phase4bMcpWriteReadHostProbeEvidence;
  readonly packageProfiles?: readonly string[];
}

export interface Phase4bMcpWritePublisherApplicationEvidence {
  readonly proof: 'known.phase4b.mcp-write.publisher.v1';
  readonly publisher: {
    readonly proof: typeof PHASE4B_MCP_WRITE_PUBLISHER_APPLICATION_PROOF;
    readonly execute: unknown;
  };
  readonly canonicalMutation: {
    readonly proof: typeof PHASE4B_MCP_WRITE_CANONICAL_MUTATION_APPLICATION_PROOF;
    readonly execute: unknown;
  };
  readonly unitOfWork: {
    readonly proof: typeof PHASE4B_MCP_WRITE_UNIT_OF_WORK_PROOF;
    readonly execute: unknown;
  };
}

export interface Phase4bMcpWriteDependencyGate {
  readonly accepted: true;
  readonly protocolVersion: typeof PHASE4B_MCP_CONFIG_PROTOCOL_VERSION;
  readonly readClaims: Phase4bMcpReadProfileClaims;
  readonly readHostEvidence: Phase4bMcpWriteReadHostEvidence;
  readonly publisherEvidence: Phase4bMcpWritePublisherApplicationEvidence;
  readonly packageProfiles?: readonly string[];
  readonly catalog: readonly Phase4bMcpWriteOperationContract[];
  readonly mrtr: typeof PHASE4B_MCP_WRITE_MRTR_CONTRACT;
  readonly riskApprovalRollback: typeof PHASE4B_MCP_WRITE_RISK_APPROVAL_ROLLBACK_CONTRACT;
  readonly threatContract: typeof PHASE4B_MCP_WRITE_THREAT_CONTRACT;
}

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

/**
 * Creates issued Read-host evidence. The proof labels bind the evidence to the
 * committed production route/request-context/probe source and acceptance doc;
 * the gate still additionally requires active R14 claims.
 */
export function createPhase4bMcpWriteReadHostEvidence(
  input: unknown,
): Phase4bMcpWriteReadHostEvidence {
  const options = readInputObject(input, 'MCP Write Read host evidence');
  const serverUuid = readOwnRequiredString(options, 'serverUuid', 'MCP Write Read host evidence');
  if (!UUID_RE.test(serverUuid)) {
    throw new TypeError('MCP Write Read host serverUuid must be a lowercase UUID.');
  }
  const route = readOwnRequiredObject(options, 'route', 'MCP Write Read host evidence');
  const routeProof = readOwnRequiredString(
    route,
    'proof',
    'MCP Write Read host route evidence',
  ) as typeof PHASE4B_MCP_READ_HOST_ROUTE_PROOF;
  if (routeProof !== PHASE4B_MCP_READ_HOST_ROUTE_PROOF) {
    throw new TypeError('MCP Write Read host route proof must reference the production Read route.');
  }
  if (readOwnRequiredString(route, 'endpointPath', 'MCP Write Read host route evidence')
    !== PHASE4B_MCP_CONFIG_ENDPOINT_PATH) {
    throw new TypeError('MCP Write Read host route must stay on the frozen MCP endpoint.');
  }
  assertExpectedFunction(
    readOwnRequiredValue(route, 'register', 'MCP Write Read host route evidence'),
    PHASE4B_MCP_READ_HOST_ROUTE_REGISTER_NAME,
    'MCP Write Read host route evidence requires the production registerMcpReadRoutes function.',
  );

  const requestContext = readOwnRequiredObject(
    options,
    'requestContext',
    'MCP Write Read host evidence',
  );
  if (readOwnRequiredString(
    requestContext,
    'proof',
    'MCP Write Read host request-context evidence',
  ) !== PHASE4B_MCP_READ_HOST_REQUEST_CONTEXT_PROOF) {
    throw new TypeError('MCP Write Read host request-context proof must reference the production context module.');
  }
  assertExpectedFunction(
    readOwnRequiredValue(
      requestContext,
      'create',
      'MCP Write Read host request-context evidence',
    ),
    PHASE4B_MCP_READ_HOST_REQUEST_CONTEXT_CREATE_NAME,
    'MCP Write Read host request-context evidence requires the production createPhase4bMcpRequestContext function.',
  );

  const probe = readOwnRequiredObject(options, 'probe', 'MCP Write Read host evidence');
  if (readOwnRequiredString(probe, 'proof', 'MCP Write Read host probe evidence')
    !== PHASE4B_MCP_READ_HOST_PROBE_PROOF) {
    throw new TypeError('MCP Write Read host probe proof must reference the R14 acceptance document.');
  }
  const familyIds = readOwnRequiredValue(
    probe,
    'familyIds',
    'MCP Write Read host probe evidence',
  ) as typeof PHASE4B_MCP_READ_REQUIRED_PROBE_FAMILY_IDS;
  if (!arraysEqual(familyIds, PHASE4B_MCP_READ_REQUIRED_PROBE_FAMILY_IDS)) {
    throw new TypeError('MCP Write Read host probe evidence must carry the exact R14 probe family ids.');
  }
  const evidenceDoc = readOwnRequiredString(
    probe,
    'evidenceDoc',
    'MCP Write Read host probe evidence',
  );
  if (evidenceDoc.length === 0) {
    throw new TypeError('MCP Write Read host probe evidenceDoc must be non-empty.');
  }

  const packageProfiles = readOptionalStringArray(
    options,
    'packageProfiles',
    'MCP Write Read host evidence',
  );
  const evidence = deepFreeze({
    proof: 'known.phase4b.mcp-write.read-host.v1' as const,
    serverUuid,
    route: deepFreeze({
      proof: routeProof,
      endpointPath: PHASE4B_MCP_CONFIG_ENDPOINT_PATH,
      register: readOwnRequiredValue(route, 'register', 'MCP Write Read host route evidence'),
    }),
    requestContext: deepFreeze({
      proof: PHASE4B_MCP_READ_HOST_REQUEST_CONTEXT_PROOF,
      create: readOwnRequiredValue(
        requestContext,
        'create',
        'MCP Write Read host request-context evidence',
      ),
    }),
    probe: deepFreeze({
      proof: PHASE4B_MCP_READ_HOST_PROBE_PROOF,
      familyIds,
      evidenceDoc,
    }),
    ...(packageProfiles === undefined ? {} : { packageProfiles }),
  });
  issuedReadHostEvidence.add(evidence);
  return evidence;
}

/**
 * Creates issued Publisher/Canonical/UoW evidence. All three application
 * surfaces must be present as own execute functions because W01 proves the
 * write dependency closure, not a static package claim.
 */
export function createPhase4bMcpWritePublisherApplicationEvidence(
  input: unknown,
): Phase4bMcpWritePublisherApplicationEvidence {
  const options = readInputObject(input, 'MCP Write Publisher evidence');
  const publisher = readOwnRequiredObject(options, 'publisher', 'MCP Write Publisher evidence');
  assertOwnedPort(publisher, 'publisher', PHASE4B_MCP_WRITE_PUBLISHER_APPLICATION_PROOF);
  const canonicalMutation = readOwnRequiredObject(
    options,
    'canonicalMutation',
    'MCP Write Publisher evidence',
  );
  assertOwnedPort(
    canonicalMutation,
    'canonicalMutation',
    PHASE4B_MCP_WRITE_CANONICAL_MUTATION_APPLICATION_PROOF,
  );
  const unitOfWork = readOwnRequiredObject(options, 'unitOfWork', 'MCP Write Publisher evidence');
  assertOwnedPort(unitOfWork, 'unitOfWork', PHASE4B_MCP_WRITE_UNIT_OF_WORK_PROOF);

  const evidence = deepFreeze({
    proof: 'known.phase4b.mcp-write.publisher.v1' as const,
    publisher: deepFreeze({
      proof: PHASE4B_MCP_WRITE_PUBLISHER_APPLICATION_PROOF,
      execute: readOwnRequiredValue(publisher, 'execute', 'publisher port'),
    }),
    canonicalMutation: deepFreeze({
      proof: PHASE4B_MCP_WRITE_CANONICAL_MUTATION_APPLICATION_PROOF,
      execute: readOwnRequiredValue(canonicalMutation, 'execute', 'canonicalMutation port'),
    }),
    unitOfWork: deepFreeze({
      proof: PHASE4B_MCP_WRITE_UNIT_OF_WORK_PROOF,
      execute: readOwnRequiredValue(unitOfWork, 'execute', 'unitOfWork port'),
    }),
  });
  issuedPublisherEvidence.add(evidence);
  return evidence;
}

export function assertPhase4bMcpWriteReadHostEvidence(
  value: Phase4bMcpWriteReadHostEvidence,
): asserts value is Phase4bMcpWriteReadHostEvidence {
  if (!issuedReadHostEvidence.has(value)) {
    throw new TypeError('MCP Write Read host evidence must be issued by this module.');
  }
}

export function assertPhase4bMcpWritePublisherApplicationEvidence(
  value: Phase4bMcpWritePublisherApplicationEvidence,
): asserts value is Phase4bMcpWritePublisherApplicationEvidence {
  if (!issuedPublisherEvidence.has(value)) {
    throw new TypeError('MCP Write Publisher evidence must be issued by this module.');
  }
}

/**
 * Validates one W01 operation catalog. The catalog is closed: unknown,
 * duplicate, high-risk-downgraded, open, secret-bearing, prompt-injectable,
 * cross-bound, or server-request-bearing contracts fail closed.
 */
export function validatePhase4bMcpWriteCatalog(
  value: unknown,
  options: { readonly serverUuid: string },
): readonly Phase4bMcpWriteOperationContract[] {
  const serverUuid = readRequiredOptions(options, 'serverUuid');
  if (!UUID_RE.test(serverUuid)) {
    throw new TypeError('MCP Write catalog validation requires a lowercase serverUuid.');
  }
  if (!Array.isArray(value)) {
    throw new TypeError('MCP Write catalog must be an array.');
  }
  if (value.length !== PHASE4B_MCP_WRITE_OPERATION_NAMES.length) {
    throw new TypeError('MCP Write catalog must contain exactly the planned W01 operations.');
  }

  const names = new Set<string>();
  const outputs = new Set<string>();
  const signatures = new Set<string>();
  const contracts: Phase4bMcpWriteOperationContract[] = [];
  for (const candidate of value) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      throw new TypeError('MCP Write catalog operation must be a plain object.');
    }
    const operation = candidate as Readonly<Record<string, unknown>>;
    const name = readOwnRequiredString(operation, 'name', 'MCP Write operation');
    if (!(PHASE4B_MCP_WRITE_OPERATION_NAMES as readonly string[]).includes(name)) {
      throw new TypeError(`MCP Write catalog contains unknown or unregistered operation ${name}.`);
    }
    if (names.has(name)) {
      throw new TypeError(`MCP Write catalog repeats operation ${name}.`);
    }
    names.add(name);

    assertPromptInjectionSafe(operation);
    assertSecretRevealSafe(operation);
    assertRiskContract(operation, name);
    assertPayloadContract(operation);
    assertServerRequestAbsent(operation);
    assertUriAndBindingContract(operation, name, serverUuid);
    assertClosedContractKeys(operation);

    const contract = readOperationContract(operation, name);
    const signature = JSON.stringify([
      contract.scope,
      contract.risk,
      contract.revision,
      contract.idempotency,
      contract.approval,
      contract.retry,
      contract.output,
    ]);
    if (signatures.has(signature)) {
      throw new TypeError('MCP Write catalog operation contracts must be unique.');
    }
    if (outputs.has(contract.output)) {
      throw new TypeError('MCP Write catalog operation output contracts must be unique.');
    }
    signatures.add(signature);
    outputs.add(contract.output);
    contracts.push(deepFreeze(contract));
  }

  const actualNames = [...names].sort();
  const expectedNames = [...PHASE4B_MCP_WRITE_OPERATION_NAMES].sort();
  if (actualNames.join('\0') !== expectedNames.join('\0')) {
    throw new TypeError('MCP Write catalog must contain exactly the planned W01 operation set.');
  }
  return Object.freeze(contracts);
}

export function createPhase4bMcpWriteDependencyGate(
  input: unknown,
): Phase4bMcpWriteDependencyGate {
  const options = readInputObject(input, 'MCP Write dependency gate');
  const readClaims = readOwnRequiredValue(
    options,
    'readClaims',
    'MCP Write dependency gate',
  ) as Phase4bMcpReadProfileClaims;
  if (typeof readClaims !== 'object' || readClaims === null || Array.isArray(readClaims)) {
    throw new TypeError('MCP Write dependency gate requires active issued R14 readClaims; package profiles alone are insufficient.');
  }
  assertPhase4bMcpReadProfileClaims(readClaims);
  const readHostEvidence = readOwnRequiredValue(
    options,
    'readHostEvidence',
    'MCP Write dependency gate',
  ) as Phase4bMcpWriteReadHostEvidence;
  if (typeof readHostEvidence !== 'object' || readHostEvidence === null || Array.isArray(readHostEvidence)) {
    throw new TypeError('MCP Write dependency gate requires issued Read host evidence.');
  }
  assertPhase4bMcpWriteReadHostEvidence(readHostEvidence);
  const publisherEvidence = readOwnRequiredValue(
    options,
    'publisherEvidence',
    'MCP Write dependency gate',
  ) as Phase4bMcpWritePublisherApplicationEvidence;
  if (typeof publisherEvidence !== 'object' || publisherEvidence === null || Array.isArray(publisherEvidence)) {
    throw new TypeError('MCP Write dependency gate requires issued Publisher application evidence.');
  }
  assertPhase4bMcpWritePublisherApplicationEvidence(publisherEvidence);
  const packageProfiles = readOptionalStringArray(
    options,
    'packageProfiles',
    'MCP Write dependency gate',
  );
  const catalog = validatePhase4bMcpWriteCatalog(PHASE4B_MCP_WRITE_CATALOG, {
    serverUuid: readHostEvidence.serverUuid,
  });
  return deepFreeze({
    accepted: true,
    protocolVersion: PHASE4B_MCP_CONFIG_PROTOCOL_VERSION,
    readClaims,
    readHostEvidence,
    publisherEvidence,
    ...(packageProfiles === undefined ? {} : { packageProfiles }),
    catalog,
    mrtr: PHASE4B_MCP_WRITE_MRTR_CONTRACT,
    riskApprovalRollback: PHASE4B_MCP_WRITE_RISK_APPROVAL_ROLLBACK_CONTRACT,
    threatContract: PHASE4B_MCP_WRITE_THREAT_CONTRACT,
  });
}

function assertOwnedPort(
  port: Readonly<Record<string, unknown>>,
  label: string,
  expectedProof: string,
): void {
  if (readOwnRequiredString(port, 'proof', `${label} port`) !== expectedProof) {
    throw new TypeError(`${label} port proof does not match the committed W01 dependency surface.`);
  }
  const execute = readOwnRequiredValue(port, 'execute', `${label} port`);
  const expectedName = expectedProof === PHASE4B_MCP_WRITE_PUBLISHER_APPLICATION_PROOF
    ? PHASE4B_MCP_WRITE_PUBLISHER_EXECUTE_NAME
    : expectedProof === PHASE4B_MCP_WRITE_CANONICAL_MUTATION_APPLICATION_PROOF
      ? PHASE4B_MCP_WRITE_CANONICAL_MUTATION_EXECUTE_NAME
      : PHASE4B_MCP_WRITE_UNIT_OF_WORK_EXECUTE_NAME;
  assertExpectedFunction(
    execute,
    expectedName,
    `${label} port must own the committed production execute function.`,
  );
}

function assertExpectedFunction(
  value: unknown,
  expectedName: string,
  message: string,
): void {
  if (typeof value !== 'function' || value.name !== expectedName) {
    throw new TypeError(message);
  }
}

function assertPromptInjectionSafe(operation: Readonly<Record<string, unknown>>): void {
  const description = readOwnRequiredString(operation, 'description', 'MCP Write operation');
  const lower = description.toLowerCase();
  if (PROMPT_INJECTION_MARKERS.some((marker) => lower.includes(marker))) {
    throw new TypeError('MCP Write operation description must not carry untrusted prompt-injection content.');
  }
}

function assertSecretRevealSafe(operation: Readonly<Record<string, unknown>>): void {
  const fields = [
    readOwnRequiredString(operation, 'output', 'MCP Write operation'),
    readOwnRequiredString(operation, 'description', 'MCP Write operation'),
  ];
  if (fields.some((field) => SECRET_FIELD_MARKERS.some((marker) => field.toLowerCase().includes(marker)))) {
    throw new TypeError('MCP Write operation output/description must not reveal secret, credential, or token material.');
  }
}

function assertRiskContract(
  operation: Readonly<Record<string, unknown>>,
  name: string,
): void {
  const risk = readOwnRequiredObject(operation, 'risk', 'MCP Write operation');
  const level = readOwnRequiredString(risk, 'level', 'MCP Write operation risk');
  if (level !== 'low' && level !== 'medium' && level !== 'high') {
    throw new TypeError('MCP Write operation risk level must be low, medium, or high.');
  }
  const basis = readOwnRequiredString(risk, 'basis', 'MCP Write operation risk');
  if (basis.length === 0) {
    throw new TypeError('MCP Write operation risk basis must be non-empty.');
  }
  if ((PHASE4B_MCP_WRITE_HIGH_RISK_OPERATIONS as readonly string[]).includes(name)
    && level !== 'high') {
    throw new TypeError('MCP Write high-risk operation cannot be declared low or medium risk.');
  }
}

function assertPayloadContract(operation: Readonly<Record<string, unknown>>): void {
  const shape = readOwnRequiredString(operation, 'payloadShape', 'MCP Write operation');
  if (shape !== 'closed_typed_operation' && shape !== 'plan_control') {
    throw new TypeError('MCP Write open payload shapes are rejected; use a closed typed operation or plan control.');
  }
  if (readOwnRequiredValue(operation, 'openPayload', 'MCP Write operation') !== false) {
    throw new TypeError('MCP Write operation must set openPayload=false.');
  }
}

function assertServerRequestAbsent(operation: Readonly<Record<string, unknown>>): void {
  const serverRequest = readOwnRequiredString(operation, 'serverRequest', 'MCP Write operation');
  if (serverRequest !== 'none') {
    throw new TypeError('MCP Write server-initiated requests are forbidden; MRTR uses client retry only.');
  }
  if (Object.hasOwn(operation, 'elicitationId') || Object.hasOwn(operation, 'completionNotifications')) {
    throw new TypeError('MCP Write elicitation/completion server channels are forbidden.');
  }
  const inputRequests = readOwnRequiredValue(operation, 'inputRequests', 'MCP Write operation');
  if (typeof inputRequests !== 'object' || inputRequests === null || Array.isArray(inputRequests)
    || Object.keys(inputRequests as Readonly<Record<string, unknown>>).length !== 0) {
    throw new TypeError('MCP Write operation must keep inputRequests empty; no server-issued elicitation requests.');
  }
}

function assertUriAndBindingContract(
  operation: Readonly<Record<string, unknown>>,
  name: string,
  serverUuid: string,
): void {
  const targetUri = readOwnRequiredString(operation, 'targetUri', 'MCP Write operation');
  const planControl = name === 'changes.plan' || name === 'changes.commit' || name === 'changes.cancel';
  if (planControl) {
    if (targetUri !== PLAN_CONTROL_TARGET_URI) {
      throw new TypeError('MCP Write plan-control operation must not target a resource URI.');
    }
  } else if (targetUri !== NODE_TARGET_URI_TEMPLATE
    && targetUri !== NODE_TARGET_URI_TEMPLATE.replace('{serverUuid}', serverUuid)) {
    throw new TypeError('MCP Write node operation must bind a same-server colp:// Node URI template.');
  }
  if (readOwnRequiredValue(operation, 'sameServerAuthority', 'MCP Write operation') !== true
    || readOwnRequiredValue(operation, 'authenticatedOnly', 'MCP Write operation') !== true) {
    throw new TypeError('MCP Write operation must require authenticated same-server authority binding.');
  }
}

function assertClosedContractKeys(operation: Readonly<Record<string, unknown>>): void {
  const keys = Object.keys(operation).sort();
  const expected = [...CONTRACT_EXPECTED_KEYS].sort();
  if (keys.join('\0') !== expected.join('\0')) {
    throw new TypeError('MCP Write operation contract fields are incomplete or unknown.');
  }
}

function readOperationContract(
  operation: Readonly<Record<string, unknown>>,
  name: string,
): Phase4bMcpWriteOperationContract {
  const scope = readOwnRequiredValue(operation, 'scope', 'MCP Write operation');
  if (!Array.isArray(scope) || scope.length === 0 || scope.some((entry) => typeof entry !== 'string'
    || (entry as string).length === 0)) {
    throw new TypeError('MCP Write operation scope must be a non-empty string array.');
  }
  const inputRequests = readOwnRequiredValue(operation, 'inputRequests', 'MCP Write operation');
  return {
    name: name as Phase4bMcpWriteOperationName,
    description: readOwnRequiredString(operation, 'description', 'MCP Write operation'),
    scope: Object.freeze([...scope]) as readonly string[],
    targetUri: readOwnRequiredString(operation, 'targetUri', 'MCP Write operation'),
    risk: Object.freeze({
      level: readOwnRequiredString(
        readOwnRequiredObject(operation, 'risk', 'MCP Write operation'),
        'level',
        'MCP Write operation risk',
      ) as Phase4bMcpWriteRiskLevel,
      basis: readOwnRequiredString(
        readOwnRequiredObject(operation, 'risk', 'MCP Write operation'),
        'basis',
        'MCP Write operation risk',
      ),
    }),
    revision: readOwnRequiredString(operation, 'revision', 'MCP Write operation'),
    idempotency: readOwnRequiredString(operation, 'idempotency', 'MCP Write operation'),
    approval: readOwnRequiredString(operation, 'approval', 'MCP Write operation'),
    retry: readOwnRequiredString(operation, 'retry', 'MCP Write operation'),
    output: readOwnRequiredString(operation, 'output', 'MCP Write operation'),
    rollback: readOwnRequiredString(operation, 'rollback', 'MCP Write operation'),
    payloadShape: readOwnRequiredString(
      operation,
      'payloadShape',
      'MCP Write operation',
    ) as Phase4bMcpWriteOperationContract['payloadShape'],
    openPayload: false,
    serverRequest: 'none',
    inputRequests: inputRequests as Readonly<Record<string, never>>,
    sameServerAuthority: true,
    authenticatedOnly: true,
  };
}

function readRequiredOptions(
  options: Readonly<{ serverUuid?: unknown }>,
  name: 'serverUuid',
): string {
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('MCP Write catalog validation options are required.');
  }
  const descriptor = Object.getOwnPropertyDescriptor(options, name);
  if (descriptor === undefined || !('value' in descriptor) || typeof descriptor.value !== 'string') {
    throw new TypeError(`MCP Write catalog validation requires ${name}.`);
  }
  return descriptor.value;
}

function readInputObject(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function readOwnRequiredObject(
  value: Readonly<Record<string, unknown>>,
  name: string,
  label: string,
): Readonly<Record<string, unknown>> {
  const candidate = readOwnRequiredValue(value, name, label);
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw new TypeError(`${label}.${name} must be an object.`);
  }
  return candidate as Readonly<Record<string, unknown>>;
}

function readOwnRequiredString(
  value: Readonly<Record<string, unknown>>,
  name: string,
  label: string,
): string {
  const candidate = readOwnRequiredValue(value, name, label);
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new TypeError(`${label}.${name} must be a non-empty string.`);
  }
  return candidate;
}

function readOwnRequiredValue(
  value: Readonly<Record<string, unknown>>,
  name: string,
  label: string,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor === undefined || !('value' in descriptor)) {
    throw new TypeError(`${label} requires own data property ${name}.`);
  }
  return descriptor.value;
}

function readOptionalStringArray(
  value: Readonly<Record<string, unknown>>,
  name: string,
  label: string,
): readonly string[] | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor === undefined || !('value' in descriptor)) return undefined;
  const candidate = descriptor.value;
  if (!Array.isArray(candidate) || candidate.some((entry) => typeof entry !== 'string'
    || (entry as string).length === 0)) {
    throw new TypeError(`${label}.${name} must be a non-empty string array when present.`);
  }
  return Object.freeze([...candidate]) as readonly string[];
}

function arraysEqual(left: unknown, right: readonly string[]): boolean {
  if (!Array.isArray(left)) return false;
  return left.length === right.length
    && left.every((entry, index) => entry === right[index]);
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
