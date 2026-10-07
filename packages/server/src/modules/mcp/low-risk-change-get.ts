/**
 * Low-risk MCP `changes.get`. Read-only lookup of the current account's
 * change plan, matching Product `GET /api/v1/mcp/approvals/:planId`
 * visibility. Host OAuth scope is `nodes:write`. This is not a high-risk
 * write and is not part of the W01 frozen write catalog.
 */
import { types as nodeTypes } from 'node:util';
import {
  requireAuthenticatedWriteBinding,
  snapshotMcpAuthorizationBinding,
  type McpAuthenticatedAuthorizationBinding,
  type McpStoredPlan,
} from '@know-n/colp/mcp';
import {
  PHASE4B_MCP_LOW_RISK_NODE_CREATE_SCOPE,
  Phase4bMcpLowRiskNodeCreateError,
  type Phase4bMcpLowRiskNodeCreateContext,
} from './low-risk-node-create.js';

export const PHASE4B_MCP_CHANGES_GET_TOOL_NAME = 'changes.get' as const;

export const PHASE4B_MCP_CHANGES_GET_UNKNOWN_MESSAGE = 'Unknown tool.' as const;

const PLAN_ID_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/u;
const INPUT_KEYS = Object.freeze(['planId'] as const);

const PLAN_STATUS_VALUES = Object.freeze([
  'pending',
  'approved',
  'committing',
  'consumed',
  'cancelled',
  'expired',
] as const);

const RISK_VALUES = Object.freeze(['low', 'medium', 'high'] as const);

const DECISION_VALUES = Object.freeze([
  'pending',
  'approved',
  'denied',
  'expired',
] as const);

export type Phase4bMcpChangeGetStatus = (typeof PLAN_STATUS_VALUES)[number];
export type Phase4bMcpChangeGetRisk = (typeof RISK_VALUES)[number];
export type Phase4bMcpChangeGetDecision = (typeof DECISION_VALUES)[number];

const opaqueIdProperty = Object.freeze({
  type: 'string',
  minLength: 1,
  maxLength: 128,
  pattern: '^[A-Za-z0-9._~-]+$',
} as const);

export const PHASE4B_MCP_CHANGES_GET_INPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    planId: opaqueIdProperty,
  }),
  required: Object.freeze(['planId']),
} as const);

const impactSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    collections: Object.freeze({ type: 'number' }),
    nodes: Object.freeze({ type: 'number' }),
    annotations: Object.freeze({ type: 'number' }),
    attachments: Object.freeze({ type: 'number' }),
    relations: Object.freeze({ type: 'number' }),
    privateFieldsExcluded: Object.freeze({
      type: 'array',
      items: Object.freeze({ type: 'string' }),
    }),
  }),
  required: Object.freeze([
    'collections',
    'nodes',
    'annotations',
    'attachments',
    'relations',
    'privateFieldsExcluded',
  ]),
} as const);

export const PHASE4B_MCP_CHANGES_GET_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    planId: Object.freeze({ type: 'string', minLength: 1 }),
    status: Object.freeze({ type: 'string', enum: PLAN_STATUS_VALUES }),
    risk: Object.freeze({ type: 'string', enum: RISK_VALUES }),
    requiresApproval: Object.freeze({ type: 'boolean' }),
    summary: Object.freeze({ type: 'string' }),
    expiresAt: Object.freeze({ type: 'string', minLength: 1 }),
    requiredScopes: Object.freeze({
      type: 'array',
      items: Object.freeze({ type: 'string' }),
    }),
    decision: Object.freeze({ type: 'string', enum: DECISION_VALUES }),
    createdAt: Object.freeze({ type: 'string', minLength: 1 }),
    impact: impactSchema,
    approvalUri: Object.freeze({ type: 'string', minLength: 1 }),
  }),
  required: Object.freeze([
    'planId',
    'status',
    'risk',
    'requiresApproval',
    'summary',
    'expiresAt',
    'requiredScopes',
    'decision',
    'createdAt',
    'impact',
  ]),
} as const);

export interface Phase4bMcpChangeGetImpact {
  readonly collections: number;
  readonly nodes: number;
  readonly annotations: number;
  readonly attachments: number;
  readonly relations: number;
  readonly privateFieldsExcluded: readonly string[];
}

export interface Phase4bMcpLowRiskChangeGetOutput {
  readonly planId: string;
  readonly status: Phase4bMcpChangeGetStatus;
  readonly risk: Phase4bMcpChangeGetRisk;
  readonly requiresApproval: boolean;
  readonly summary: string;
  readonly expiresAt: string;
  readonly requiredScopes: readonly string[];
  readonly decision: Phase4bMcpChangeGetDecision;
  readonly createdAt: string;
  readonly impact: Phase4bMcpChangeGetImpact;
  readonly approvalUri?: string;
}

export interface Phase4bMcpChangeGetPlanStore {
  readonly get: (
    planId: string,
  ) => McpStoredPlan | undefined | PromiseLike<McpStoredPlan | undefined>;
}

export interface Phase4bMcpLowRiskChangeGetServiceOptions {
  readonly planStore: Phase4bMcpChangeGetPlanStore;
}

export interface Phase4bMcpLowRiskChangeGetService {
  readonly execute: (
    input: Readonly<Record<string, unknown>>,
    context: Phase4bMcpLowRiskNodeCreateContext,
  ) => Promise<Phase4bMcpLowRiskChangeGetOutput>;
}

export function createPhase4bMcpLowRiskChangeGetService(
  options: Phase4bMcpLowRiskChangeGetServiceOptions,
): Phase4bMcpLowRiskChangeGetService {
  if (typeof options !== 'object' || options === null || nodeTypes.isProxy(options)) {
    throw new TypeError('MCP changes.get options must be an own-data object.');
  }
  const planStore = readRequiredPlanStore(options);
  return Object.freeze({
    execute: async (
      input: Readonly<Record<string, unknown>>,
      context: Phase4bMcpLowRiskNodeCreateContext,
    ) => {
      const binding = requireAuthenticatedWriteBinding(
        snapshotMcpAuthorizationBinding(context.binding),
      );
      assertWriteScope(context.scope);
      const planId = parsePlanId(input);
      const plan = await settle(planStore.get(planId));
      if (plan === undefined || !isVisible(plan, binding)) {
        throw unknownPlan();
      }
      return projectChangeGetView(plan);
    },
  });
}

function isVisible(
  plan: McpStoredPlan,
  binding: McpAuthenticatedAuthorizationBinding,
): boolean {
  return plan.binding.principalId === binding.principalId
    && plan.binding.securityEpoch === binding.securityEpoch;
}

function projectChangeGetView(plan: McpStoredPlan): Phase4bMcpLowRiskChangeGetOutput {
  const view: {
    planId: string;
    status: Phase4bMcpChangeGetStatus;
    risk: Phase4bMcpChangeGetRisk;
    requiresApproval: boolean;
    summary: string;
    expiresAt: string;
    requiredScopes: readonly string[];
    decision: Phase4bMcpChangeGetDecision;
    createdAt: string;
    impact: Phase4bMcpChangeGetImpact;
    approvalUri?: string;
  } = {
    planId: plan.planId,
    status: plan.status,
    risk: plan.risk,
    requiresApproval: plan.requiresApproval,
    summary: plan.summary,
    expiresAt: plan.expiresAt,
    requiredScopes: Object.freeze([...plan.requiredScopes]) as readonly string[],
    decision: decisionState(plan.status),
    createdAt: plan.createdAt,
    impact: toImpact(plan),
  };
  if (plan.approvalUri !== undefined) {
    view.approvalUri = plan.approvalUri;
  }
  return Object.freeze(view);
}

function toImpact(plan: McpStoredPlan): Phase4bMcpChangeGetImpact {
  const impact = plan.impact as unknown as Readonly<Record<string, unknown>>;
  return Object.freeze({
    collections: readCount(impact.collections),
    nodes: readCount(impact.nodes),
    annotations: readCount(impact.annotations),
    attachments: readCount(impact.attachments),
    relations: readCount(impact.relations),
    privateFieldsExcluded: Object.freeze(
      Array.isArray(impact.privateFieldsExcluded)
        ? impact.privateFieldsExcluded.filter((value): value is string => typeof value === 'string')
        : [],
    ),
  });
}

function readCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function decisionState(status: McpStoredPlan['status']): Phase4bMcpChangeGetDecision {
  if (status === 'pending') return 'pending';
  if (status === 'approved' || status === 'committing' || status === 'consumed') return 'approved';
  if (status === 'cancelled') return 'denied';
  return 'expired';
}

function parsePlanId(input: Readonly<Record<string, unknown>>): string {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'invalid_catalog_input',
      'changes.get input must be an object.',
    );
  }
  const keys = Reflect.ownKeys(input).filter((key): key is string => typeof key === 'string');
  if (keys.some((key) => !(INPUT_KEYS as readonly string[]).includes(key))) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'invalid_catalog_input',
      'changes.get input contains unknown fields.',
    );
  }
  const planId = input.planId;
  if (typeof planId !== 'string' || planId.length === 0) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'invalid_catalog_input',
      'changes.get planId must be a non-empty string.',
    );
  }
  if (!PLAN_ID_PATTERN.test(planId)) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'invalid_catalog_input',
      'changes.get planId must be a canonical opaque id.',
    );
  }
  return planId;
}

function assertWriteScope(scope: readonly string[]): void {
  if (
    !Array.isArray(scope)
    || scope.some((entry) => typeof entry !== 'string' || entry.length === 0)
    || !scope.includes(PHASE4B_MCP_LOW_RISK_NODE_CREATE_SCOPE)
  ) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'scope_invalid',
      PHASE4B_MCP_CHANGES_GET_UNKNOWN_MESSAGE,
    );
  }
}

function unknownPlan(): Phase4bMcpLowRiskNodeCreateError {
  return new Phase4bMcpLowRiskNodeCreateError(
    'policy_denied',
    PHASE4B_MCP_CHANGES_GET_UNKNOWN_MESSAGE,
  );
}

function readRequiredPlanStore(
  options: Phase4bMcpLowRiskChangeGetServiceOptions,
): Phase4bMcpChangeGetPlanStore {
  const descriptor = Object.getOwnPropertyDescriptor(options, 'planStore');
  if (
    descriptor === undefined
    || !('value' in descriptor)
    || typeof descriptor.value !== 'object'
    || descriptor.value === null
    || nodeTypes.isProxy(descriptor.value)
  ) {
    throw new TypeError('MCP changes.get requires an own-data planStore.');
  }
  const planStore = descriptor.value as Phase4bMcpChangeGetPlanStore;
  const get = Object.getOwnPropertyDescriptor(planStore, 'get');
  if (get === undefined || !('value' in get) || typeof get.value !== 'function') {
    throw new TypeError('MCP changes.get planStore.get must be an own-data function.');
  }
  return planStore;
}

function settle<Value>(value: Value | PromiseLike<Value>): Promise<Value> {
  return Promise.resolve(value);
}
