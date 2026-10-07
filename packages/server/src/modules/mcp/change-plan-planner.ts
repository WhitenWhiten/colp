import { canonicalMcpNodeCreatePayload, parseMcpNodeCreatePayload, requireMcpNodeCreatePlanVisibility } from './node-create-payload.js';
import { Phase4bMcpLowRiskNodeCreateError } from './node-create-contract.js';
import { MCP_OWN_DATA_DEFAULT_BUDGET, snapshotMcpOwnData as snapshotPhase4bData } from './own-data.js';
/**
 * MCP-W03 registered canonical operation planner.
 *
 * This module maps the frozen `nodes.create` and `nodes.set_visibility`
 * catalog inputs into typed COLP canonical operation objects, resolves risk,
 * scopes, base revisions, impact, and a fixed approval summary, and persists
 * durable ready/awaiting Plans through the W02 store port. It never executes
 * canonical writes and never lets model input enter SQL, Outbox, Audit, Tool
 * descriptions, or approval summaries.
 */
import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';

import {
  requireAuthenticatedWriteBinding,
  snapshotMcpAuthorizationBinding,
  type McpAuthenticatedAuthorizationBinding,
} from '@know-n/colp/mcp';
import { createValidatorRegistry, isHttpUrl } from '@know-n/colp/schema';
import type {
  ChangePlanImpact,
  ChangePlanOperation,
  NodeCreate,
  Operation,
  ScopeName,
  Visibility,
} from '@know-n/colp/types';
import {
  isPhase4bMcpCollectionVisibility,
  type Phase4bMcpCollectionVisibility,
} from './write-dependency-gate.js';

export type Phase4bMcpRiskLevel = 'low' | 'medium' | 'high';
export type Phase4bMcpPlanMode = 'ready' | 'awaiting_approval';
export type Phase4bMcpCatalogTool = 'nodes.create' | 'nodes.set_visibility';

export type Phase4bMcpNodeCreateOperation = Extract<Operation, { type: 'create_node' }>;
export type Phase4bMcpPlanOperation = ChangePlanOperation | Phase4bMcpNodeCreateOperation;

export interface Phase4bMcpNodeCreateCatalogInput {
  readonly tool: 'nodes.create';
  readonly collectionId: string;
  readonly parentId: string;
  readonly afterId?: string | null;
  readonly beforeId?: string | null;
  readonly node: Readonly<Record<string, unknown>>;
  readonly reason: string;
  readonly dryRun: true;
}

export interface Phase4bMcpNodeVisibilityCatalogInput {
  readonly tool: 'nodes.set_visibility';
  readonly collectionId: string;
  readonly nodeId: string;
  readonly visibility: Visibility;
  readonly baseRevision?: string;
  readonly reason: string;
  readonly dryRun: true;
}

export type Phase4bMcpCatalogInput =
  | Phase4bMcpNodeCreateCatalogInput
  | Phase4bMcpNodeVisibilityCatalogInput;

export type Phase4bMcpStoredPlan = Readonly<{
  readonly planId: string;
  readonly expiresAt: string;
  readonly risk: Phase4bMcpRiskLevel;
  readonly requiresApproval: boolean;
  readonly approvalMethod?: string;
  readonly approvalUri?: string;
  readonly summary: string;
  readonly impact: ChangePlanImpact;
  readonly requiredScopes: readonly ScopeName[];
  readonly baseRevisions: Readonly<Record<string, string>>;
  readonly operations: readonly Phase4bMcpPlanOperation[];
  readonly operationsDigest: string;
  readonly binding: McpAuthenticatedAuthorizationBinding;
  /** Untrusted model/user note. Never interpolate into approval summary text. */
  readonly untrustedNote: string;
  readonly createdAt: string;
  readonly status: 'pending';
}>;

export type Phase4bMcpPlanTarget =
  | {
      readonly kind: 'collection';
      readonly serverUuid: string;
      readonly collectionId: string;
    }
  | {
      readonly kind: 'node';
      readonly serverUuid: string;
      readonly collectionId: string;
      readonly nodeId: string;
    };

export interface Phase4bMcpPlannedChange {
  readonly planId: string;
  readonly expiresAt: string;
  readonly risk: Phase4bMcpRiskLevel;
  readonly requiresApproval: boolean;
  readonly mode: Phase4bMcpPlanMode;
  readonly approvalMethod?: string;
  readonly approvalUri?: string;
  readonly summary: string;
  readonly impact: ChangePlanImpact;
  readonly requiredScopes: readonly ScopeName[];
  readonly baseRevisions: Readonly<Record<string, string>>;
  readonly operationsDigest: string;
  readonly operations: readonly Phase4bMcpPlanOperation[];
  readonly status: 'pending';
  readonly target: Phase4bMcpPlanTarget;
}

export interface Phase4bMcpCreateBaseRevisions {
  readonly parentChildrenRevision: string;
  readonly collectionContentRevision: string;
  readonly collectionVisibility: Phase4bMcpCollectionVisibility;
}

export interface Phase4bMcpVisibilityBaseFacts {
  readonly resourceRevision: string;
  readonly policyRevision: string;
}

export interface Phase4bMcpAuthoritativeStatePort {
  readonly resolveCreateBaseRevisions: (
    input: Readonly<{ collectionId: string; parentId: string }>,
    binding: McpAuthenticatedAuthorizationBinding,
  ) => Phase4bMcpCreateBaseRevisions | PromiseLike<Phase4bMcpCreateBaseRevisions>;
  readonly resolveVisibilityFacts: (
    input: Readonly<{ collectionId: string; nodeId: string }>,
    binding: McpAuthenticatedAuthorizationBinding,
  ) => Phase4bMcpVisibilityBaseFacts | PromiseLike<Phase4bMcpVisibilityBaseFacts>;
}

export interface Phase4bMcpAuthorizationPolicyPort {
  readonly requiredScopesForOperation: (
    operation: Phase4bMcpPlanOperation,
    binding: McpAuthenticatedAuthorizationBinding,
  ) => readonly ScopeName[] | PromiseLike<readonly ScopeName[]>;
}

export interface Phase4bMcpImpactPort {
  readonly assessImpact: (
    operations: readonly Phase4bMcpPlanOperation[],
  ) => ChangePlanImpact | PromiseLike<ChangePlanImpact>;
}

export interface Phase4bMcpPlanStorePort {
  readonly save: (plan: Phase4bMcpStoredPlan) => void | PromiseLike<void>;
  readonly get: (
    planId: string,
  ) => Phase4bMcpStoredPlan | undefined | PromiseLike<Phase4bMcpStoredPlan | undefined>;
}

export interface Phase4bMcpApprovalUriPolicyPort {
  readonly allow: (
    input: Readonly<{ purpose: 'approval'; origin: string }>,
  ) => boolean;
}

export interface Phase4bMcpClockPort {
  readonly now: () => Date;
}

export interface Phase4bMcpIdPort {
  readonly nextPlanId: () => string;
  readonly nextOperationId: () => string;
}

export interface Phase4bMcpWriteInputBudget {
  readonly maxDepth?: number;
  readonly maxNodes?: number;
  readonly maxBytes?: number;
  readonly maxOperations?: number;
}

export interface Phase4bMcpChangePlanPlannerOptions {
  readonly planStore: Phase4bMcpPlanStorePort;
  readonly authoritativeState: Phase4bMcpAuthoritativeStatePort;
  readonly authorizationPolicy: Phase4bMcpAuthorizationPolicyPort;
  readonly impact: Phase4bMcpImpactPort;
  readonly approvalBaseUri: string;
  readonly approvalUriPolicy: Phase4bMcpApprovalUriPolicyPort;
  readonly serverUuid: string;
  readonly clock?: Phase4bMcpClockPort;
  readonly ids?: Phase4bMcpIdPort;
  readonly planTtlMilliseconds?: number;
  readonly inputBudget?: Phase4bMcpWriteInputBudget;
}

export interface Phase4bMcpChangePlanPlanner {
  readonly plan: (
    input: unknown,
    binding: McpAuthenticatedAuthorizationBinding,
  ) => Promise<Phase4bMcpPlannedChange>;
}

export type Phase4bMcpChangePlanPlannerErrorCode =
  | 'invalid_catalog_input'
  | 'unknown_operation'
  | 'open_payload_rejected'
  | 'budget_exceeded'
  | 'stale_revision'
  | 'scope_invalid'
  | 'impact_invalid'
  | 'uri_rejected'
  | 'secret_marker_rejected'
  | 'authoritative_state_invalid';

export class Phase4bMcpChangePlanPlannerError extends Error {
  readonly code: Phase4bMcpChangePlanPlannerErrorCode;

  constructor(code: Phase4bMcpChangePlanPlannerErrorCode, message: string) {
    super(message);
    this.name = 'Phase4bMcpChangePlanPlannerError';
    this.code = code;
  }
}

export interface Phase4bMcpCanonicalDigestInput {
  readonly operations: readonly Phase4bMcpPlanOperation[];
  readonly binding: McpAuthenticatedAuthorizationBinding;
  readonly baseRevisions: Readonly<Record<string, string>>;
  readonly requiredScopes: readonly ScopeName[];
  readonly risk: Phase4bMcpRiskLevel;
  readonly impact: ChangePlanImpact;
}

const validators = createValidatorRegistry();

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const UNTRUSTED_NOTE_MAX_LENGTH = 1_000;
const CONTROL_CHARACTER_RE = /[\u0000-\u001F\u007F]/u;
const ID_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/u;
const SERVER_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CREATE_ALLOWED_KEYS = Object.freeze([
  'tool',
  'collectionId',
  'parentId',
  'afterId',
  'beforeId',
  'node',
  'reason',
  'dryRun',
]);
const VISIBILITY_ALLOWED_KEYS = Object.freeze([
  'tool',
  'collectionId',
  'nodeId',
  'visibility',
  'baseRevision',
  'reason',
  'dryRun',
]);
const SECRET_MARKERS = Object.freeze([
  'session',
  'sessionid',
  'mcpsessionid',
  'token',
  'secret',
  'password',
  'credential',
  'credentials',
  'authorization',
  'privatekey',
  'apikey',
]);
const RISK_RANK: Readonly<Record<Phase4bMcpRiskLevel, number>> = Object.freeze({
  low: 0,
  medium: 1,
  high: 2,
});

export interface Phase4bMcpOperationRiskFacts {
  readonly collectionVisibility?: Phase4bMcpCollectionVisibility;
}

export function aggregatePhase4bMcpRisk(
  operations: readonly Phase4bMcpPlanOperation[],
  facts: Phase4bMcpOperationRiskFacts = Object.freeze({}),
): Phase4bMcpRiskLevel {
  let level: Phase4bMcpRiskLevel = 'low';
  for (const operation of operations) {
    const operationRisk = phase4bMcpOperationRisk(operation, facts);
    if (RISK_RANK[operationRisk] > RISK_RANK[level]) level = operationRisk;
  }
  return level;
}

function phase4bMcpOperationRisk(
  operation: Phase4bMcpPlanOperation,
  facts: Phase4bMcpOperationRiskFacts,
): Phase4bMcpRiskLevel {
  if (operation.type === 'create_node') {
    return phase4bMcpCreateNodeRisk(operation, facts.collectionVisibility);
  }
  if (operation.type === 'set_visibility') return 'high';
  throw new Phase4bMcpChangePlanPlannerError(
    'unknown_operation',
    'MCP-W03 cannot aggregate an unregistered canonical operation.',
  );
}

function phase4bMcpCreateNodeRisk(
  _operation: Phase4bMcpNodeCreateOperation,
  _collectionVisibility: Phase4bMcpCollectionVisibility | undefined,
): Phase4bMcpRiskLevel {
  return 'low';
}

export function phase4bMcpPlanSummary(
  operations: readonly Phase4bMcpPlanOperation[],
  impact: ChangePlanImpact,
): string {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new Phase4bMcpChangePlanPlannerError(
      'invalid_catalog_input',
      'Plan summary requires at least one typed canonical operation.',
    );
  }
  const types = operations.map((operation) => operation.type).join(', ');
  return `Plan ${operations.length} canonical operation(s) [${types}]. Authoritative impact: `
    + `${impact.collections} collection(s), ${impact.nodes} node(s), `
    + `${impact.annotations} annotation(s), ${impact.attachments} attachment(s), `
    + `${impact.relations} relation(s).`;
}

export function computePhase4bMcpCanonicalDigest(
  input: Phase4bMcpCanonicalDigestInput,
): string {
  const snapshot = snapshotPhase4bData(input, MCP_OWN_DATA_DEFAULT_BUDGET) as Readonly<Record<string, unknown>>;
  const operations = Array.isArray(snapshot.operations)
    ? snapshot.operations.map(normalizeDigestOperation)
    : snapshot.operations;
  const canonicalInput = Object.freeze({
    ...snapshot,
    operations: Object.freeze(operations),
  });
  const canonical = canonicalJson(canonicalInput);
  if (canonical === undefined) {
    throw new Phase4bMcpChangePlanPlannerError(
      'invalid_catalog_input',
      'Canonical Plan facts are not deterministic JSON.',
    );
  }
  const digest = createHash('sha256').update(canonical, 'utf8').digest('base64url');
  return `sha-256:${digest}`;
}

function normalizeDigestOperation(operation: unknown): unknown {
  if (typeof operation !== 'object' || operation === null || Array.isArray(operation)) {
    return operation;
  }
  const record = operation as Readonly<Record<string, unknown>>;
  if (record.type !== 'create_node') return operation;
  const normalized: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== 'string') return operation;
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !('value' in descriptor)) return operation;
    if (key === 'opId' || key === 'replicaId' || key === 'sequence' || key === 'occurredAt') continue;
    normalized[key] = descriptor.value;
  }
  return Object.freeze(normalized);
}

export function createPhase4bMcpChangePlanPlanner(
  options: Phase4bMcpChangePlanPlannerOptions,
): Phase4bMcpChangePlanPlanner {
  if (typeof options !== 'object' || options === null || nodeTypes.isProxy(options)) {
    throw new TypeError('MCP-W03 planner options must be an own-data object.');
  }
  const optionsRecord = options as unknown as Readonly<Record<string, unknown>>;
  const planStore = (
    readRequiredPort(optionsRecord, 'planStore', ['save', 'get']) as unknown
  ) as Phase4bMcpPlanStorePort;
  const authoritativeState = (
    readRequiredPort(
    optionsRecord,
    'authoritativeState',
    ['resolveCreateBaseRevisions', 'resolveVisibilityFacts'],
  ) as unknown
  ) as Phase4bMcpAuthoritativeStatePort;
  const authorizationPolicy = (
    readRequiredPort(
    optionsRecord,
    'authorizationPolicy',
    ['requiredScopesForOperation'],
  ) as unknown
  ) as Phase4bMcpAuthorizationPolicyPort;
  const impact = (
    readRequiredPort(optionsRecord, 'impact', ['assessImpact']) as unknown
  ) as Phase4bMcpImpactPort;
  const approvalUriPolicy = (
    readRequiredPort(optionsRecord, 'approvalUriPolicy', ['allow']) as unknown
  ) as Phase4bMcpApprovalUriPolicyPort;
  const clock = resolveClock(optionsRecord);
  const ids = resolveIds(optionsRecord);
  const ttl = resolveTtl(optionsRecord);
  const budget = resolveBudget(optionsRecord);
  const serverUuid = readRequiredString(optionsRecord, 'serverUuid');
  if (!SERVER_UUID_PATTERN.test(serverUuid)) {
    throw new Phase4bMcpChangePlanPlannerError(
      'invalid_catalog_input',
      'MCP-W03 serverUuid must be a lowercase UUID.',
    );
  }
  const approvalBaseUri = resolveApprovalBaseUri(optionsRecord, approvalUriPolicy);

  return Object.freeze({
    async plan(
      request: unknown,
      binding: McpAuthenticatedAuthorizationBinding,
    ): Promise<Phase4bMcpPlannedChange> {
      const ownedBinding = requireAuthenticatedWriteBinding(
        snapshotMcpAuthorizationBinding(binding),
      );
      const snapshot = snapshotCatalogRequest(request, budget);
      assertNoSecretMarkers(snapshot);
      assertKnownKeys(
        snapshot,
        [...CREATE_ALLOWED_KEYS, ...VISIBILITY_ALLOWED_KEYS],
        'Catalog input contains unknown fields.',
      );
      const tool = readOwnRequiredString(snapshot, 'tool', 'catalog input');
      if (tool !== 'nodes.create' && tool !== 'nodes.set_visibility') {
        throw new Phase4bMcpChangePlanPlannerError(
          'unknown_operation',
          'Unknown MCP-W03 catalog operation.',
        );
      }
      if (readOwnRequiredValue(snapshot, 'dryRun', 'catalog input') !== true) {
        throw new Phase4bMcpChangePlanPlannerError(
          'invalid_catalog_input',
          'MCP-W03 Plan requires dryRun=true.',
        );
      }
      const reason = readOwnRequiredString(snapshot, 'reason', 'catalog input');
      if (
        reason.length > UNTRUSTED_NOTE_MAX_LENGTH
        || CONTROL_CHARACTER_RE.test(reason)
      ) {
        throw new Phase4bMcpChangePlanPlannerError(
          'invalid_catalog_input',
          'MCP-W03 untrusted note must be non-empty, at most 1000 code units, and free of control characters.',
        );
      }

      if (tool === 'nodes.create') {
        return planNodeCreate(
          snapshot,
          reason,
          ownedBinding,
          {
            planStore,
            authoritativeState,
            authorizationPolicy,
            impact,
            clock,
            ids,
            ttl,
            budget,
            serverUuid,
            approvalBaseUri,
            approvalUriPolicy,
          },
        );
      }
      return planNodeVisibility(
        snapshot,
        reason,
        ownedBinding,
        {
          planStore,
          authoritativeState,
          authorizationPolicy,
          impact,
          clock,
          ids,
          ttl,
          budget,
          serverUuid,
          approvalBaseUri,
          approvalUriPolicy,
        },
      );
    },
  });
}

type PlannerDependencies = Readonly<{
  planStore: Phase4bMcpPlanStorePort;
  authoritativeState: Phase4bMcpAuthoritativeStatePort;
  authorizationPolicy: Phase4bMcpAuthorizationPolicyPort;
  impact: Phase4bMcpImpactPort;
  clock: Phase4bMcpClockPort;
  ids: Phase4bMcpIdPort;
  ttl: number;
  budget: Required<Phase4bMcpWriteInputBudget>;
  serverUuid: string;
  approvalBaseUri: string;
  approvalUriPolicy: Phase4bMcpApprovalUriPolicyPort;
}>;

async function planNodeCreate(
  snapshot: Readonly<Record<string, unknown>>,
  reason: string,
  binding: McpAuthenticatedAuthorizationBinding,
  deps: PlannerDependencies,
): Promise<Phase4bMcpPlannedChange> {
  assertOnlyKeys(
    snapshot,
    CREATE_ALLOWED_KEYS,
    'nodes.create catalog input contains unknown fields.',
  );
  const collectionId = readOwnRequiredString(snapshot, 'collectionId', 'nodes.create');
  const parentId = readOwnRequiredString(snapshot, 'parentId', 'nodes.create');
  assertOpaqueId(collectionId, 'collectionId');
  assertOpaqueId(parentId, 'parentId');
  const afterId = readOptionalOpaqueId(snapshot, 'afterId', 'nodes.create');
  const beforeId = readOptionalOpaqueId(snapshot, 'beforeId', 'nodes.create');
  const rawNode = readOwnRequiredObject(snapshot, 'node', 'nodes.create');
  const node = canonicalNodeCreate(rawNode);

  const revisions = await resolveCreateRevisions(
    deps.authoritativeState,
    { collectionId, parentId },
    binding,
    deps.budget,
  );
  const now = readClock(deps.clock);
  const operation: Phase4bMcpNodeCreateOperation = Object.freeze({
    opId: deps.ids.nextOperationId(),
    replicaId: binding.clientId,
    sequence: 1,
    type: 'create_node',
    occurredAt: now.toISOString(),
    collectionId,
    baseRevision: null,
    payload: Object.freeze({
      parentId,
      afterId: afterId ?? null,
      beforeId: beforeId ?? null,
      node,
    }),
  });
  const operations = Object.freeze([operation]);
  const baseRevisions = Object.freeze({
    [`children.${parentId}`]: revisions.parentChildrenRevision,
    [`content.${collectionId}`]: revisions.collectionContentRevision,
  });
  const requiredScopes = await resolveRequiredScopes(
    operation,
    Object.freeze(['nodes:write'] as readonly ScopeName[]),
    deps.authorizationPolicy,
    binding,
    deps.budget,
  );
  const impact = await resolveImpact(deps.impact, operations, deps.budget);
  const stored = buildStoredPlan({
    operations,
    binding,
    baseRevisions,
    requiredScopes,
    impact,
    reason,
    deps,
    now,
    collectionVisibility: revisions.collectionVisibility,
  });
  await resolvePlanStoreSave(deps.planStore, stored);
  return toPlannedChange(stored, Object.freeze({
    kind: 'collection',
    serverUuid: deps.serverUuid,
    collectionId,
  }));
}

async function planNodeVisibility(
  snapshot: Readonly<Record<string, unknown>>,
  reason: string,
  binding: McpAuthenticatedAuthorizationBinding,
  deps: PlannerDependencies,
): Promise<Phase4bMcpPlannedChange> {
  assertOnlyKeys(
    snapshot,
    VISIBILITY_ALLOWED_KEYS,
    'nodes.set_visibility catalog input contains unknown fields.',
  );
  const collectionId = readOwnRequiredString(
    snapshot,
    'collectionId',
    'nodes.set_visibility',
  );
  const nodeId = readOwnRequiredString(snapshot, 'nodeId', 'nodes.set_visibility');
  const visibility = readOwnRequiredString(snapshot, 'visibility', 'nodes.set_visibility');
  assertOpaqueId(collectionId, 'collectionId');
  assertOpaqueId(nodeId, 'nodeId');
  if (!['protected', 'private'].includes(visibility)) {
    throw new Phase4bMcpChangePlanPlannerError(
      'invalid_catalog_input',
      'nodes.set_visibility visibility must be protected or private.',
    );
  }
  const baseRevision = readOptionalOpaqueId(snapshot, 'baseRevision', 'nodes.set_visibility');
  const facts = await resolveVisibilityFacts(
    deps.authoritativeState,
    { collectionId, nodeId },
    binding,
    deps.budget,
  );
  if (baseRevision !== undefined && baseRevision !== facts.resourceRevision) {
    throw new Phase4bMcpChangePlanPlannerError(
      'stale_revision',
      'nodes.set_visibility base revision is stale; re-read the authoritative node before planning.',
    );
  }

  const now = readClock(deps.clock);
  const operation: ChangePlanOperation = Object.freeze({
    type: 'set_visibility',
    collectionId,
    baseRevision: facts.resourceRevision,
    input: Object.freeze({ visibility: visibility as Visibility }),
  });
  const operations = Object.freeze([operation]);
  const baseRevisions = Object.freeze({
    [`node.${nodeId}`]: facts.resourceRevision,
    [`policy.${collectionId}`]: facts.policyRevision,
  });
  const requiredScopes = await resolveRequiredScopes(
    operation,
    Object.freeze(['access:write'] as readonly ScopeName[]),
    deps.authorizationPolicy,
    binding,
    deps.budget,
  );
  const impact = await resolveImpact(deps.impact, operations, deps.budget);
  const stored = buildStoredPlan({
    operations,
    binding,
    baseRevisions,
    requiredScopes,
    impact,
    reason,
    deps,
    now,
  });
  await resolvePlanStoreSave(deps.planStore, stored);
  return toPlannedChange(stored, Object.freeze({
    kind: 'node',
    serverUuid: deps.serverUuid,
    collectionId,
    nodeId,
  }));
}

function buildStoredPlan(input: Readonly<{
  operations: readonly Phase4bMcpPlanOperation[];
  binding: McpAuthenticatedAuthorizationBinding;
  baseRevisions: Readonly<Record<string, string>>;
  requiredScopes: readonly ScopeName[];
  impact: ChangePlanImpact;
  reason: string;
  deps: PlannerDependencies;
  now: Date;
  collectionVisibility?: Phase4bMcpCollectionVisibility;
}>): Phase4bMcpStoredPlan {
  if (input.operations.length > input.deps.budget.maxOperations) {
    throw new Phase4bMcpChangePlanPlannerError(
      'budget_exceeded',
      'MCP-W03 catalog input exceeded the configured operation budget.',
    );
  }
  const risk = aggregatePhase4bMcpRisk(
    input.operations,
    input.collectionVisibility === undefined
      ? Object.freeze({})
      : Object.freeze({ collectionVisibility: input.collectionVisibility }),
  );
  const requiresApproval = risk === 'high' || risk === 'medium';
  const summary = phase4bMcpPlanSummary(input.operations, input.impact);
  const operationsDigest = computePhase4bMcpCanonicalDigest({
    operations: input.operations,
    binding: input.binding,
    baseRevisions: input.baseRevisions,
    requiredScopes: input.requiredScopes,
    risk,
    impact: input.impact,
  });
  const planId = input.deps.ids.nextPlanId();
  if (typeof planId !== 'string' || planId.length === 0 || planId.length > 256) {
    throw new Phase4bMcpChangePlanPlannerError(
      'invalid_catalog_input',
      'MCP-W03 plan id generator returned an invalid id.',
    );
  }
  const createdAt = input.now.toISOString();
  const expiresAt = new Date(input.now.getTime() + input.deps.ttl).toISOString();
  const base: Phase4bMcpStoredPlan = Object.freeze({
    planId,
    expiresAt,
    risk,
    requiresApproval,
    summary,
    impact: input.impact,
    requiredScopes: input.requiredScopes,
    baseRevisions: input.baseRevisions,
    operations: input.operations,
    operationsDigest,
    binding: input.binding,
    untrustedNote: input.reason,
    createdAt,
    status: 'pending',
  });
  if (!requiresApproval) return base;
  const approvalUri = buildApprovalUri(
    input.deps.approvalBaseUri,
    planId,
    input.deps.approvalUriPolicy,
  );
  return Object.freeze({
    ...base,
    approvalMethod: 'out_of_band',
    approvalUri,
  });
}

function toPlannedChange(
  stored: Phase4bMcpStoredPlan,
  target: Phase4bMcpPlanTarget,
): Phase4bMcpPlannedChange {
  return Object.freeze({
    planId: stored.planId,
    expiresAt: stored.expiresAt,
    risk: stored.risk,
    requiresApproval: stored.requiresApproval,
    mode: stored.requiresApproval ? 'awaiting_approval' : 'ready',
    ...(stored.approvalMethod !== undefined
      ? { approvalMethod: stored.approvalMethod, approvalUri: stored.approvalUri }
      : {}),
    summary: stored.summary,
    impact: stored.impact,
    requiredScopes: stored.requiredScopes,
    baseRevisions: stored.baseRevisions,
    operationsDigest: stored.operationsDigest,
    operations: stored.operations,
    status: stored.status,
    target,
  });
}

const AUTHORITATIVE_STATE_UNAVAILABLE =
  'MCP-W03 could not resolve authoritative state for planning.';

async function settleAuthoritativeState<Value>(
  candidate: Value | PromiseLike<Value>,
): Promise<Value> {
  try {
    return await settle(candidate);
  } catch (error) {
    if (error instanceof Phase4bMcpChangePlanPlannerError) throw error;
    throw new Phase4bMcpChangePlanPlannerError(
      'authoritative_state_invalid',
      AUTHORITATIVE_STATE_UNAVAILABLE,
    );
  }
}

async function resolveCreateRevisions(
  port: Phase4bMcpAuthoritativeStatePort,
  input: Readonly<{ collectionId: string; parentId: string }>,
  binding: McpAuthenticatedAuthorizationBinding,
  budget: Required<Phase4bMcpWriteInputBudget>,
): Promise<Phase4bMcpCreateBaseRevisions> {
  const candidate = await settleAuthoritativeState(
    port.resolveCreateBaseRevisions(input, binding),
  );
  let snapshot: unknown;
  try {
    snapshot = snapshotPhase4bData(candidate, budget);
  } catch {
    throw new Phase4bMcpChangePlanPlannerError(
      'authoritative_state_invalid',
      'Create revision resolver returned data outside the MCP-W03 budget.',
    );
  }
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    throw new Phase4bMcpChangePlanPlannerError(
      'authoritative_state_invalid',
      'Create revision resolver returned an invalid object.',
    );
  }
  const record = snapshot as Readonly<Record<string, unknown>>;
  const parentChildrenRevision = readOwnRequiredString(
    record,
    'parentChildrenRevision',
    'create revision resolver',
  );
  const collectionContentRevision = readOwnRequiredString(
    record,
    'collectionContentRevision',
    'create revision resolver',
  );
  assertRevisionToken(parentChildrenRevision, 'parentChildrenRevision');
  assertRevisionToken(collectionContentRevision, 'collectionContentRevision');
  const collectionVisibility = readOwnRequiredString(
    record,
    'collectionVisibility',
    'create revision resolver',
  );
  if (!isPhase4bMcpCollectionVisibility(collectionVisibility)) {
    throw new Phase4bMcpChangePlanPlannerError(
      'authoritative_state_invalid',
      'Create revision resolver returned an invalid object.',
    );
  }
  return Object.freeze({
    parentChildrenRevision,
    collectionContentRevision,
    collectionVisibility,
  });
}

async function resolveVisibilityFacts(
  port: Phase4bMcpAuthoritativeStatePort,
  input: Readonly<{ collectionId: string; nodeId: string }>,
  binding: McpAuthenticatedAuthorizationBinding,
  budget: Required<Phase4bMcpWriteInputBudget>,
): Promise<Phase4bMcpVisibilityBaseFacts> {
  const candidate = await settleAuthoritativeState(
    port.resolveVisibilityFacts(input, binding),
  );
  let snapshot: unknown;
  try {
    snapshot = snapshotPhase4bData(candidate, budget);
  } catch {
    throw new Phase4bMcpChangePlanPlannerError(
      'authoritative_state_invalid',
      'Visibility fact resolver returned data outside the MCP-W03 budget.',
    );
  }
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    throw new Phase4bMcpChangePlanPlannerError(
      'authoritative_state_invalid',
      'Visibility fact resolver returned an invalid object.',
    );
  }
  const record = snapshot as Readonly<Record<string, unknown>>;
  const resourceRevision = readOwnRequiredString(
    record,
    'resourceRevision',
    'visibility fact resolver',
  );
  const policyRevision = readOwnRequiredString(
    record,
    'policyRevision',
    'visibility fact resolver',
  );
  assertRevisionToken(resourceRevision, 'resourceRevision');
  assertRevisionToken(policyRevision, 'policyRevision');
  return Object.freeze({ resourceRevision, policyRevision });
}

async function resolveRequiredScopes(
  operation: Phase4bMcpPlanOperation,
  catalogScopes: readonly ScopeName[],
  policy: Phase4bMcpAuthorizationPolicyPort,
  binding: McpAuthenticatedAuthorizationBinding,
  budget: Required<Phase4bMcpWriteInputBudget>,
): Promise<readonly ScopeName[]> {
  const candidate = await settle(policy.requiredScopesForOperation(operation, binding));
  let snapshot: unknown;
  try {
    snapshot = snapshotPhase4bData(candidate, budget);
  } catch {
    throw new Phase4bMcpChangePlanPlannerError(
      'scope_invalid',
      'Authorization policy returned data outside the MCP-W03 budget.',
    );
  }
  if (!Array.isArray(snapshot)) {
    throw new Phase4bMcpChangePlanPlannerError(
      'scope_invalid',
      'Authorization policy must return a ScopeName array.',
    );
  }
  const scopes = new Set<ScopeName>(catalogScopes);
  for (const scope of snapshot) {
    if (!validators.validate('scopeName', scope).valid) {
      throw new Phase4bMcpChangePlanPlannerError(
        'scope_invalid',
        'Authorization policy returned a non-canonical Scope.',
      );
    }
    scopes.add(scope as ScopeName);
  }
  return Object.freeze([...scopes].sort());
}

async function resolveImpact(
  port: Phase4bMcpImpactPort,
  operations: readonly Phase4bMcpPlanOperation[],
  budget: Required<Phase4bMcpWriteInputBudget>,
): Promise<ChangePlanImpact> {
  const candidate = await settle(port.assessImpact(operations));
  let snapshot: unknown;
  try {
    snapshot = snapshotPhase4bData(candidate, budget);
  } catch {
    throw new Phase4bMcpChangePlanPlannerError(
      'impact_invalid',
      'Impact port returned data outside the MCP-W03 budget.',
    );
  }
  if (!validators.validate('changePlanImpact', snapshot).valid) {
    throw new Phase4bMcpChangePlanPlannerError(
      'impact_invalid',
      'Impact port returned an invalid canonical changePlanImpact.',
    );
  }
  return snapshot as ChangePlanImpact;
}

async function resolvePlanStoreSave(
  port: Phase4bMcpPlanStorePort,
  plan: Phase4bMcpStoredPlan,
): Promise<void> {
  await settle(port.save(plan));
}

function snapshotCatalogRequest(
  value: unknown,
  budget: Required<Phase4bMcpWriteInputBudget>,
): Readonly<Record<string, unknown>> {
  let snapshot: unknown;
  try {
    snapshot = snapshotPhase4bData(value, budget);
  } catch {
    throw new Phase4bMcpChangePlanPlannerError(
      'budget_exceeded',
      'MCP-W03 catalog input exceeded the configured resource budget.',
    );
  }
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    throw new Phase4bMcpChangePlanPlannerError(
      'invalid_catalog_input',
      'MCP-W03 catalog input must be a plain object.',
    );
  }
  return snapshot as Readonly<Record<string, unknown>>;
}

function assertNoSecretMarkers(
  value: unknown,
  path = '$',
  seen = new WeakSet<object>(),
): void {
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        assertNoSecretMarkers(value[index], `${path}[${index}]`, seen);
      }
      return;
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') continue;
      const normalized = key.replace(/[-_]/gu, '').toLowerCase();
      if (SECRET_MARKERS.some((marker) => normalized.includes(marker))) {
        throw new Phase4bMcpChangePlanPlannerError(
          'secret_marker_rejected',
          `MCP-W03 catalog input rejected secret/session field ${path}.${key}.`,
        );
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor !== undefined && 'value' in descriptor) {
        assertNoSecretMarkers(descriptor.value, `${path}.${key}`, seen);
      }
    }
  } finally {
    seen.delete(value);
  }
}

function assertOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  message: string,
): void {
  const keys = Reflect.ownKeys(value).filter((key): key is string => typeof key === 'string');
  if (keys.length !== allowed.length || keys.some((key) => !allowed.includes(key))) {
    throw new Phase4bMcpChangePlanPlannerError('open_payload_rejected', message);
  }
}

function assertKnownKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  message: string,
): void {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'string' && !allowed.includes(key)) {
      throw new Phase4bMcpChangePlanPlannerError('open_payload_rejected', message);
    }
  }
}

function assertOpaqueId(value: string, label: string): void {
  if (!ID_PATTERN.test(value)) {
    throw new Phase4bMcpChangePlanPlannerError(
      'invalid_catalog_input',
      `${label} must be a canonical opaque id.`,
    );
  }
}

function assertRevisionToken(value: string, label: string): void {
  if (!ID_PATTERN.test(value)) {
    throw new Phase4bMcpChangePlanPlannerError(
      'authoritative_state_invalid',
      `${label} must be a canonical revision token.`,
    );
  }
}

function readOptionalOpaqueId(
  value: Readonly<Record<string, unknown>>,
  key: string,
  label: string,
): string | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor) || (descriptor.value !== null && typeof descriptor.value !== 'string')) {
    throw new Phase4bMcpChangePlanPlannerError(
      'invalid_catalog_input',
      `${label}.${key} must be a string or null.`,
    );
  }
  if (descriptor.value === null) return undefined;
  assertOpaqueId(descriptor.value, `${label}.${key}`);
  return descriptor.value;
}

function readOwnRequiredString(
  value: Readonly<Record<string, unknown>>,
  key: string,
  label: string,
): string {
  const candidate = readOwnRequiredValue(value, key, label);
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new Phase4bMcpChangePlanPlannerError(
      'invalid_catalog_input',
      `${label}.${key} must be a non-empty string.`,
    );
  }
  return candidate;
}

function readOwnRequiredObject(
  value: Readonly<Record<string, unknown>>,
  key: string,
  label: string,
): Readonly<Record<string, unknown>> {
  const candidate = readOwnRequiredValue(value, key, label);
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw new Phase4bMcpChangePlanPlannerError(
      'invalid_catalog_input',
      `${label}.${key} must be an object.`,
    );
  }
  return candidate as Readonly<Record<string, unknown>>;
}

function canonicalNodeCreate(value: Readonly<Record<string, unknown>>): NodeCreate {
  try {
    const node = canonicalMcpNodeCreatePayload(
      requireMcpNodeCreatePlanVisibility(parseMcpNodeCreatePayload(value)),
    );
    const validation = validators.validate('nodeCreate', node);
    if (!validation.valid) throw new TypeError('Invalid canonical nodeCreate payload.');
    return node;
  } catch (error) {
    throw new Phase4bMcpChangePlanPlannerError(
      error instanceof Phase4bMcpLowRiskNodeCreateError && error.code === 'open_payload_rejected'
        ? 'open_payload_rejected' : 'invalid_catalog_input',
      'nodes.create node payload failed canonical nodeCreate validation.',
    );
  }
}

function readOwnRequiredValue(
  value: Readonly<Record<string, unknown>>,
  key: string,
  label: string,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !('value' in descriptor)) {
    throw new Phase4bMcpChangePlanPlannerError(
      'invalid_catalog_input',
      `${label} requires own data property ${key}.`,
    );
  }
  return descriptor.value;
}

function resolveApprovalBaseUri(
  options: Readonly<Record<string, unknown>>,
  policy: Phase4bMcpApprovalUriPolicyPort,
): string {
  const base = readOwnRequiredString(options, 'approvalBaseUri', 'planner options');
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    throw new Phase4bMcpChangePlanPlannerError(
      'uri_rejected',
      'Approval base URI must be parseable.',
    );
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.search !== ''
    || parsed.hash !== ''
    || !isHttpUrl(parsed.href)
  ) {
    throw new Phase4bMcpChangePlanPlannerError(
      'uri_rejected',
      'Approval base URI must use HTTP(S) without userinfo, query, or fragment.',
    );
  }
  assertApprovalOriginAllowed(policy, parsed.origin);
  return parsed.origin + parsed.pathname.replace(/\/$/u, '');
}

function buildApprovalUri(
  base: string,
  planId: string,
  policy: Phase4bMcpApprovalUriPolicyPort,
): string {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/$/u, '')}/${encodeURIComponent(planId)}`;
  url.search = '';
  url.hash = '';
  const candidate = url.href;
  if (!isHttpUrl(candidate)) {
    throw new Phase4bMcpChangePlanPlannerError(
      'uri_rejected',
      'Approval URI failed canonical HTTP(S) validation.',
    );
  }
  assertApprovalOriginAllowed(policy, url.origin);
  return candidate;
}

function assertApprovalOriginAllowed(
  policy: Phase4bMcpApprovalUriPolicyPort,
  origin: string,
): void {
  const decision = Object.freeze({ purpose: 'approval' as const, origin });
  let allowed: unknown;
  try {
    allowed = policy.allow(decision);
  } catch {
    throw new Phase4bMcpChangePlanPlannerError(
      'uri_rejected',
      'Approval URI policy rejected the origin.',
    );
  }
  if (allowed !== true) {
    throw new Phase4bMcpChangePlanPlannerError(
      'uri_rejected',
      'Approval URI policy rejected the origin.',
    );
  }
}

function resolveClock(options: Readonly<Record<string, unknown>>): Phase4bMcpClockPort {
  const descriptor = Object.getOwnPropertyDescriptor(options, 'clock');
  if (descriptor === undefined || !('value' in descriptor)) {
    return Object.freeze({ now: () => new Date() });
  }
  const port = descriptor.value;
  if (typeof port !== 'object' || port === null || nodeTypes.isProxy(port)) {
    throw new TypeError('MCP-W03 clock must be an own-data port when provided.');
  }
  const nowDescriptor = Object.getOwnPropertyDescriptor(port, 'now');
  if (
    nowDescriptor === undefined
    || !('value' in nowDescriptor)
    || typeof nowDescriptor.value !== 'function'
    || nodeTypes.isProxy(nowDescriptor.value)
  ) {
    throw new TypeError('MCP-W03 clock.now must be an own-data function.');
  }
  return Object.freeze({
    now: () => Reflect.apply(nowDescriptor.value, port, []) as Date,
  });
}

function resolveIds(options: Readonly<Record<string, unknown>>): Phase4bMcpIdPort {
  const descriptor = Object.getOwnPropertyDescriptor(options, 'ids');
  if (descriptor === undefined || !('value' in descriptor)) {
    return Object.freeze({
      nextPlanId: () => `plan_${randomToken()}`,
      nextOperationId: () => `op_${randomToken()}`,
    });
  }
  const port = descriptor.value;
  if (typeof port !== 'object' || port === null || nodeTypes.isProxy(port)) {
    throw new TypeError('MCP-W03 ids must be an own-data port when provided.');
  }
  for (const name of ['nextPlanId', 'nextOperationId'] as const) {
    const methodDescriptor = Object.getOwnPropertyDescriptor(port, name);
    if (
      methodDescriptor === undefined
      || !('value' in methodDescriptor)
      || typeof methodDescriptor.value !== 'function'
      || nodeTypes.isProxy(methodDescriptor.value)
    ) {
      throw new TypeError(`MCP-W03 ids.${name} must be an own-data function.`);
    }
  }
  return Object.freeze({
    nextPlanId: () => Reflect.apply(
      (Object.getOwnPropertyDescriptor(port, 'nextPlanId') as PropertyDescriptor).value,
      port,
      [],
    ) as string,
    nextOperationId: () => Reflect.apply(
      (Object.getOwnPropertyDescriptor(port, 'nextOperationId') as PropertyDescriptor).value,
      port,
      [],
    ) as string,
  });
}

function resolveTtl(options: Readonly<Record<string, unknown>>): number {
  const descriptor = Object.getOwnPropertyDescriptor(options, 'planTtlMilliseconds');
  if (descriptor === undefined || !('value' in descriptor)) return DEFAULT_TTL_MS;
  const value = descriptor.value;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('MCP-W03 planTtlMilliseconds must be a positive safe integer.');
  }
  return value;
}

function resolveBudget(options: Readonly<Record<string, unknown>>): Required<Phase4bMcpWriteInputBudget> {
  const descriptor = Object.getOwnPropertyDescriptor(options, 'inputBudget');
  if (descriptor === undefined || !('value' in descriptor)) return MCP_OWN_DATA_DEFAULT_BUDGET;
  const candidate = descriptor.value;
  if (
    typeof candidate !== 'object'
    || candidate === null
    || Array.isArray(candidate)
    || nodeTypes.isProxy(candidate)
  ) {
    throw new TypeError('MCP-W03 inputBudget must be an own-data object.');
  }
  const resolved = {
    maxDepth: readBudgetLimit(candidate, 'maxDepth', MCP_OWN_DATA_DEFAULT_BUDGET.maxDepth),
    maxNodes: readBudgetLimit(candidate, 'maxNodes', MCP_OWN_DATA_DEFAULT_BUDGET.maxNodes),
    maxBytes: readBudgetLimit(candidate, 'maxBytes', MCP_OWN_DATA_DEFAULT_BUDGET.maxBytes),
    maxOperations: readBudgetLimit(candidate, 'maxOperations', MCP_OWN_DATA_DEFAULT_BUDGET.maxOperations),
  };
  if (
    !Number.isSafeInteger(resolved.maxDepth) || resolved.maxDepth < 0
    || !Number.isSafeInteger(resolved.maxNodes) || resolved.maxNodes < 1
    || !Number.isSafeInteger(resolved.maxBytes) || resolved.maxBytes < 1
    || !Number.isSafeInteger(resolved.maxOperations) || resolved.maxOperations < 1
  ) {
    throw new TypeError('MCP-W03 inputBudget contains invalid limits.');
  }
  return Object.freeze(resolved);
}

function readBudgetLimit(
  value: object,
  name: string,
  defaultValue: number,
): number {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor === undefined || !('value' in descriptor)) return defaultValue;
  return descriptor.value as number;
}

function readRequiredPort(
  options: Readonly<Record<string, unknown>>,
  name: string,
  methods: readonly string[],
): Readonly<Record<string, unknown>> {
  const descriptor = Object.getOwnPropertyDescriptor(options, name);
  if (
    descriptor === undefined
    || !('value' in descriptor)
    || typeof descriptor.value !== 'object'
    || descriptor.value === null
    || nodeTypes.isProxy(descriptor.value)
  ) {
    throw new TypeError(`MCP-W03 requires an own-data ${name} port.`);
  }
  const port = descriptor.value as Readonly<Record<string, unknown>>;
  for (const method of methods) {
    const methodDescriptor = Object.getOwnPropertyDescriptor(port, method);
    if (
      methodDescriptor === undefined
      || !('value' in methodDescriptor)
      || typeof methodDescriptor.value !== 'function'
      || nodeTypes.isProxy(methodDescriptor.value)
    ) {
      throw new TypeError(`MCP-W03 ${name}.${method} must be an own-data function.`);
    }
  }
  return port;
}

function readRequiredString(
  options: Readonly<Record<string, unknown>>,
  name: string,
): string {
  const descriptor = Object.getOwnPropertyDescriptor(options, name);
  if (descriptor === undefined || !('value' in descriptor) || typeof descriptor.value !== 'string') {
    throw new TypeError(`MCP-W03 requires string option ${name}.`);
  }
  return descriptor.value;
}

function readClock(clock: Phase4bMcpClockPort): Date {
  const now = clock.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Phase4bMcpChangePlanPlannerError(
      'authoritative_state_invalid',
      'MCP-W03 clock must return a valid Date.',
    );
  }
  return now;
}

async function settle<Value>(candidate: Value | PromiseLike<Value>): Promise<Value> {
  if (candidate !== null && typeof candidate === 'object' && 'then' in candidate) {
    return await candidate;
  }
  return candidate;
}

function randomToken(): string {
  const bytes = new Uint8Array(16);
  const crypto = globalThis.crypto;
  if (crypto !== undefined && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    let seed = Date.now() & 0xffffffff;
    for (let index = 0; index < bytes.length; index += 1) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      bytes[index] = seed & 0xff;
    }
  }
  return Buffer.from(bytes).toString('hex');
}

function canonicalJson(value: unknown): string | undefined {
  const normalized = normalizeCanonical(value);
  if (normalized === undefined) return undefined;
  try {
    return JSON.stringify(normalized) ?? undefined;
  } catch {
    return undefined;
  }
}

function normalizeCanonical(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      return undefined;
    }
    return value;
  }
  if (typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const item of value) {
      const normalized = normalizeCanonical(item);
      if (normalized === undefined) return undefined;
      result.push(normalized);
    }
    return result;
  }
  const entries: Array<readonly [string, unknown]> = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) return undefined;
    const normalized = normalizeCanonical(descriptor.value);
    if (normalized === undefined) return undefined;
    entries.push(Object.freeze([key, normalized] as const));
  }
  entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return Object.fromEntries(entries);
}
