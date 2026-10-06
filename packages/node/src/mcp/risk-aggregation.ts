/**
 * MCP-0003: nested / generic / batch operations are assessed at their highest
 * expanded leaf risk. Outer tool names cannot lower an inner high-risk op.
 */

import { createValidatorRegistry } from '../schema/index.js';
import type { ChangePlanOperation } from '../types/generated.js';
import {
  resolveMcpWriteInputBudget,
  snapshotMcpData,
  type McpWriteInputBudget,
} from './safe-data.js';

export type RiskLevel = 'low' | 'medium' | 'high';

export interface ExpandedOperationRisk {
  readonly type: string;
  readonly risk: RiskLevel;
  readonly path: string;
}

export interface ToolRiskAssessment {
  readonly level: RiskLevel;
  readonly affectedObjects: number;
  readonly requiresPlan: boolean;
  readonly expanded: readonly ExpandedOperationRisk[];
}

/**
 * Closed descriptor for host operations that do not map to a Change Plan
 * operation. Only a trusted tool adapter may produce this authorization input.
 */
export interface CanonicalOperationRiskDescriptor {
  readonly type: string;
  readonly risk: RiskLevel;
}

export type CanonicalRiskOperation = ChangePlanOperation | CanonicalOperationRiskDescriptor;

export class McpHighRiskRequiresPlanError extends Error {
  readonly code = 'high_risk_requires_plan' as const;
  readonly assessment: ToolRiskAssessment;

  constructor(assessment: ToolRiskAssessment) {
    super('High-risk MCP operations require changes.plan / changes.commit; one-shot calls are rejected.');
    this.name = 'McpHighRiskRequiresPlanError';
    this.assessment = assessment;
  }
}

export class McpRiskAggregationError extends TypeError {
  readonly code = 'invalid_risk_input' as const;

  constructor(message: string) {
    super(message);
    this.name = 'McpRiskAggregationError';
  }
}

/** Closed discriminator set from the canonical changePlanOperation union. */
const CANONICAL_PLAN_TYPE_RECORD = Object.freeze({
  delete_collection: true,
  delete_subtree: true,
  set_visibility: true,
  set_access_policy: true,
  create_key: true,
  rotate_key: true,
  revoke_key: true,
  set_rate_limit: true,
  publish_release: true,
  sync_mirror: true,
} satisfies Readonly<Record<ChangePlanOperation['type'], true>>);
const CANONICAL_PLAN_TYPES: ReadonlySet<string> = Object.freeze(
  new Set(Object.keys(CANONICAL_PLAN_TYPE_RECORD)),
);

/** Leaf plan-operation types that are always high risk. */
const ALWAYS_HIGH_PLAN_TYPES = Object.freeze(new Set(
  [...CANONICAL_PLAN_TYPES].filter((type) => type !== 'set_visibility'),
));

/** Tool names that are high risk even without nested expansion. */
const HIGH_RISK_TOOL_NAMES = Object.freeze(new Set([
  'collections.delete',
  'nodes.delete_subtree',
  'access.visibility',
  'access.set_policy',
  'keys.create',
  'keys.rotate',
  'keys.revoke',
  'rate_limits.set',
  'release.publish',
  'sync.mirror',
]));

const MEDIUM_TOOL_NAMES = Object.freeze(new Set([
  'nodes.move',
  'attachments.create',
  'attachments.update',
  'sync.push',
  'sync.resolve_conflict',
]));

const RISK_RANK: Readonly<Record<RiskLevel, number>> = Object.freeze({
  low: 0,
  medium: 1,
  high: 2,
});

const validators = createValidatorRegistry();

/**
 * Expands a tool call (or nested envelope) into leaf operation descriptors.
 * Always walks operations[], payload.operations (typed or untyped envelopes),
 * and generic batch arrays. Parent type risk is retained alongside nested leaves.
 */
export function expandOperations(
  input: unknown,
  path = '$',
  depth = 0,
  budget?: McpWriteInputBudget,
): readonly ExpandedOperationRisk[] {
  const limits = resolveRiskBudget(budget);
  if (input === undefined) {
    if (!Number.isSafeInteger(depth) || depth < 0 || depth > limits.maxDepth) {
      throw riskBudgetExceeded();
    }
    return Object.freeze([]);
  }
  const snapshot = snapshotRiskInput(input, limits);
  return expandSnapshotOperations(snapshot, path, depth, limits);
}

type ExpansionFrame = Readonly<{
  kind: 'visit';
  value: unknown;
  path: string;
  depth: number;
}> | Readonly<{
  kind: 'leaf';
  fields: Readonly<Record<string, unknown>>;
  type: string;
  path: string;
}>;

function expandSnapshotOperations(
  input: unknown,
  path: string,
  depth: number,
  limits: Required<McpWriteInputBudget>,
): readonly ExpandedOperationRisk[] {
  if (!Number.isSafeInteger(depth) || depth < 0 || depth > limits.maxDepth) {
    throw riskBudgetExceeded();
  }

  const results: ExpandedOperationRisk[] = [];
  const stack: ExpansionFrame[] = [{ kind: 'visit', value: input, path, depth }];
  let visited = 0;

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.kind === 'leaf') {
      if (results.length >= limits.maxOperations) throw riskBudgetExceeded();
      results.push(Object.freeze({
        type: frame.type,
        risk: assessLeafTypeRisk(frame.type, frame.fields),
        path: frame.path,
      }));
      continue;
    }

    visited += 1;
    if (visited > limits.maxNodes || frame.depth > limits.maxDepth) throw riskBudgetExceeded();
    if (typeof frame.value !== 'object' || frame.value === null || Array.isArray(frame.value)) continue;

    const own = frame.value as Readonly<Record<string, unknown>>;
    const typeValue = own.type;
    if (typeof typeValue === 'string' && typeValue.length > 0) {
      stack.push({ kind: 'leaf', fields: own, type: typeValue, path: frame.path });
    }

    const children: Array<Readonly<{ value: unknown; path: string }>> = [];
    appendArrayChildren(children, own.operations, `${frame.path}.operations`);

    const payload = own.payload;
    if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
      const payloadOwn = payload as Readonly<Record<string, unknown>>;
      appendArrayChildren(children, payloadOwn.operations, `${frame.path}.payload.operations`);
      for (const key of ['items', 'batch', 'changes'] as const) {
        appendArrayChildren(children, payloadOwn[key], `${frame.path}.payload.${key}`);
      }
    }
    for (const key of ['items', 'batch', 'changes'] as const) {
      appendArrayChildren(children, own[key], `${frame.path}.${key}`);
    }

    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index]!;
      stack.push({
        kind: 'visit',
        value: child.value,
        path: child.path,
        depth: frame.depth + 1,
      });
    }
  }

  return Object.freeze(results);
}

function appendArrayChildren(
  children: Array<Readonly<{ value: unknown; path: string }>>,
  candidate: unknown,
  path: string,
): void {
  if (!Array.isArray(candidate)) return;
  for (let index = 0; index < candidate.length; index += 1) {
    children.push({ value: candidate[index], path: `${path}[${index}]` });
  }
}

/** Assesses one leaf plan-operation or tool-type name. */
export function assessLeafTypeRisk(
  type: string,
  fields: Readonly<Record<string, unknown>> = Object.freeze({}),
): RiskLevel {
  if (typeof type !== 'string' || type.length === 0) {
    throw new McpRiskAggregationError('Operation type must be a non-empty string.');
  }

  if (ALWAYS_HIGH_PLAN_TYPES.has(type) || HIGH_RISK_TOOL_NAMES.has(type)) {
    return 'high';
  }

  if (type === 'set_visibility') {
    const input = fields.input;
    if (typeof input === 'object' && input !== null) {
      const visibility = readOwnDataObject(input).visibility;
      if (visibility === 'public' || visibility === 'unlisted') return 'high';
    }
    return 'medium';
  }

  if (type === 'access.visibility') {
    const visibility = fields.visibility ?? (
      typeof fields.input === 'object' && fields.input !== null
        ? readOwnDataObject(fields.input).visibility
        : undefined
    );
    if (visibility === 'public' || visibility === 'unlisted') return 'high';
    return 'medium';
  }

  if (MEDIUM_TOOL_NAMES.has(type)) return 'medium';
  if (type.endsWith('.delete') || type.includes('delete')) return 'high';
  return 'low';
}

export function aggregateHighestRisk(levels: readonly RiskLevel[]): RiskLevel {
  let highest: RiskLevel = 'low';
  for (const level of levels) {
    if (RISK_RANK[level] > RISK_RANK[highest]) highest = level;
  }
  return highest;
}

/**
 * Validates and assesses adapter-produced canonical operations without looking
 * through arbitrary envelope properties. This is the authorization-grade risk
 * API used by executable write paths.
 */
export function assessCanonicalOperations(
  operations: unknown,
  budget?: McpWriteInputBudget,
): ToolRiskAssessment {
  const limits = resolveRiskBudget(budget);
  const snapshot = snapshotRiskInput(operations, limits);
  if (!Array.isArray(snapshot)) {
    throw new McpRiskAggregationError('Canonical operations must be a JSON array.');
  }
  if (snapshot.length === 0) {
    throw new McpRiskAggregationError('Canonical operations must not be empty for a write tool.');
  }
  if (snapshot.length > limits.maxOperations) throw riskBudgetExceeded();

  const expanded: ExpandedOperationRisk[] = [];
  for (let index = 0; index < snapshot.length; index += 1) {
    const candidate = snapshot[index];
    const path = `$[${index}]`;
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      throw invalidCanonicalOperation(index);
    }

    const operationValidation = validators.validate('changePlanOperation', candidate);
    if (operationValidation.valid) {
      const operation = candidate as unknown as ChangePlanOperation;
      expanded.push(Object.freeze({
        type: operation.type,
        risk: assessLeafTypeRisk(
          operation.type,
          operation as unknown as Readonly<Record<string, unknown>>,
        ),
        path,
      }));
      continue;
    }

    const descriptor = candidate as Readonly<Record<string, unknown>>;
    const keys = Object.keys(descriptor).sort();
    if (
      keys.length !== 2
      || keys[0] !== 'risk'
      || keys[1] !== 'type'
      || typeof descriptor.type !== 'string'
      || descriptor.type.length === 0
      || CANONICAL_PLAN_TYPES.has(descriptor.type)
      || (descriptor.risk !== 'low' && descriptor.risk !== 'medium' && descriptor.risk !== 'high')
    ) {
      throw invalidCanonicalOperation(index);
    }

    expanded.push(Object.freeze({
      type: descriptor.type,
      risk: descriptor.risk,
      path,
    }));
  }

  const level = aggregateHighestRisk(expanded.map((item) => item.risk));
  return Object.freeze({
    level,
    affectedObjects: expanded.length,
    requiresPlan: level === 'high',
    expanded: Object.freeze(expanded),
  });
}

/** Authorization gate for an already canonicalized one-shot operation list. */
export function assertOneShotCanonicalOperationsAllowed(
  operations: unknown,
  budget?: McpWriteInputBudget,
): ToolRiskAssessment {
  const assessment = assessCanonicalOperations(operations, budget);
  if (assessment.requiresPlan) {
    throw new McpHighRiskRequiresPlanError(assessment);
  }
  return assessment;
}

/**
 * Heuristic diagnostic assessment for a tool call. This legacy API guesses
 * common carrier names and MUST NOT be used as an execution authorization gate.
 */
export function assessToolCallRisk(
  toolName: string,
  input: unknown = undefined,
  budget?: McpWriteInputBudget,
): ToolRiskAssessment {
  if (typeof toolName !== 'string' || toolName.length === 0) {
    throw new McpRiskAggregationError('Tool name must be a non-empty string.');
  }

  const limits = resolveRiskBudget(budget);
  const inputSnapshot = input === undefined ? undefined : snapshotRiskInput(input, limits);
  const expanded: ExpandedOperationRisk[] = [];

  // Outer tool itself may be high-risk (e.g. keys.create) even with empty input.
  expanded.push(Object.freeze({
    type: toolName,
    risk: assessLeafTypeRisk(toolName, typeof inputSnapshot === 'object' && inputSnapshot !== null
      && !Array.isArray(inputSnapshot)
      ? inputSnapshot as Readonly<Record<string, unknown>>
      : Object.freeze({})),
    path: '$.tool',
  }));

  if (inputSnapshot !== undefined) {
    const nested = expandSnapshotOperations(inputSnapshot, '$.input', 0, limits);
    for (const operation of nested) {
      if (expanded.length >= limits.maxOperations) throw riskBudgetExceeded();
      expanded.push(operation);
    }
  }

  // Deduplicate by path+type while preserving order.
  const seen = new Set<string>();
  const unique: ExpandedOperationRisk[] = [];
  for (const item of expanded) {
    const key = `${item.path}|${item.type}|${item.risk}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }

  const level = aggregateHighestRisk(unique.map((item) => item.risk));
  const requiresPlan = level === 'high';
  const affectedObjects = unique.length;

  return Object.freeze({
    level,
    affectedObjects,
    requiresPlan,
    expanded: Object.freeze(unique),
  });
}

/**
 * Legacy heuristic gate retained for compatibility with non-gateway callers.
 * Executable write gateways must use assertOneShotCanonicalOperationsAllowed.
 */
export function assertOneShotToolAllowed(
  toolName: string,
  input: unknown = undefined,
  budget?: McpWriteInputBudget,
): ToolRiskAssessment {
  // Plan/Commit/Cancel tools are the control plane, not one-shot mutations.
  if (
    toolName === 'changes.plan'
    || toolName === 'changes.commit'
    || toolName === 'changes.cancel'
  ) {
    return Object.freeze({
      level: 'low' as const,
      affectedObjects: 0,
      requiresPlan: false,
      expanded: Object.freeze([]),
    });
  }

  const assessment = assessToolCallRisk(toolName, input, budget);
  if (assessment.requiresPlan) {
    throw new McpHighRiskRequiresPlanError(assessment);
  }
  return assessment;
}

function resolveRiskBudget(budget?: McpWriteInputBudget): Required<McpWriteInputBudget> {
  try {
    return resolveMcpWriteInputBudget(budget);
  } catch {
    throw riskBudgetExceeded();
  }
}

function snapshotRiskInput(
  value: unknown,
  limits: Required<McpWriteInputBudget>,
): unknown {
  try {
    return snapshotMcpData(value, limits);
  } catch {
    throw riskBudgetExceeded();
  }
}

function riskBudgetExceeded(): McpRiskAggregationError {
  return new McpRiskAggregationError('MCP risk input exceeded the configured resource budget.');
}

function readOwnDataObject(value: object): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) continue;
    result[key] = descriptor.value;
  }
  return result;
}

function invalidCanonicalOperation(index: number): McpRiskAggregationError {
  return new McpRiskAggregationError(
    `Canonical operation at index ${index} must be a changePlanOperation or a closed { type, risk } descriptor.`,
  );
}
