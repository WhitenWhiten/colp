/**
 * MCP-0025 nodes.search, MCP-0026 policy approval, and MCP-0027
 * nodes.delete_subtree threshold. Input and output shapes are the canonical
 * protocol definitions; this module does not copy them.
 */

import { types as nodeTypes } from 'node:util';

import { DEFAULT_MCP_WRITE_INPUT_BUDGET } from './safe-data.js';
import { createCanonicalMcpSchemaReference } from './schema-ref.js';
import {
  createMcpToolInputValidator,
  createMcpToolOutputValidator,
  type McpToolInputValidator,
  type McpToolOutputValidator,
} from './tool-input.js';
import type { McpToolDefinition } from './shared/tools.js';

export const DEFAULT_MCP_DELETE_SUBTREE_THRESHOLD = 20;

export type McpPlanApprovedBy = 'user' | 'policy';

export type McpAgentApprovalPolicy = 'manual' | 'trusted';

/** Host options for nodes.move / nodes.delete_subtree planning. */
export interface McpNodeWriteToolOptions {
  /**
   * Host-configured subtree size at or below which `nodes.delete_subtree` is
   * medium risk. Above it the operation is high risk. Default 20.
   */
  readonly deleteSubtreeThreshold?: number;
  /** Owner approval policy. Only `trusted` may record `approvedBy: "policy"`. */
  readonly approvalPolicy?: McpAgentApprovalPolicy;
}

export interface ResolvedMcpNodeWriteToolOptions {
  readonly deleteSubtreeThreshold: number;
  readonly approvalPolicy: McpAgentApprovalPolicy;
}

export class McpPolicyApprovalError extends TypeError {
  readonly code = 'policy_approval_forbidden' as const;

  constructor(message = 'Operations that expose or purge data must not be policy-approved.') {
    super(message);
    this.name = 'McpPolicyApprovalError';
  }
}

const PURGE_OPERATION_TYPES: ReadonlySet<string> = new Set([
  'delete_collection',
  'collections.delete',
  'empty_trash',
  'trash.empty',
  'purge_tombstones',
  'tombstones.purge',
]);

const EXPOSE_OPERATION_TYPES: ReadonlySet<string> = new Set([
  'set_visibility',
  'access.visibility',
]);

export const nodesSearchInputSchema = createCanonicalMcpSchemaReference('nodesSearchInput');
export const nodesSearchOutputSchema = createCanonicalMcpSchemaReference('nodesSearchResult');
export const nodesMoveInputSchema = createCanonicalMcpSchemaReference('nodesMoveInput');
export const nodesDeleteSubtreeInputSchema = createCanonicalMcpSchemaReference('nodesDeleteSubtreeInput');

export const validateNodesSearchInput: McpToolInputValidator = createMcpToolInputValidator(nodesSearchInputSchema);
export const validateNodesSearchOutput: McpToolOutputValidator = createMcpToolOutputValidator(nodesSearchOutputSchema);
export const validateNodesMoveInput: McpToolInputValidator = createMcpToolInputValidator(nodesMoveInputSchema);
export const validateNodesDeleteSubtreeInput: McpToolInputValidator = createMcpToolInputValidator(
  nodesDeleteSubtreeInputSchema,
);

export const nodesSearchToolDefinition = Object.freeze({
  name: 'nodes.search',
  description: 'Search node URLs, titles, and tags. Optional tool, risk none, scope nodes:read. '
    + 'Searching annotations also requires annotations:read.',
  inputSchema: nodesSearchInputSchema,
  outputSchema: nodesSearchOutputSchema,
  requiredScopes: Object.freeze(['nodes:read']),
  risk: 'none',
} as const satisfies McpToolDefinition & { readonly risk: 'none' });

export function resolveNodeWriteToolOptions(
  options?: McpNodeWriteToolOptions,
): ResolvedMcpNodeWriteToolOptions {
  if (options === undefined) {
    return Object.freeze({
      deleteSubtreeThreshold: DEFAULT_MCP_DELETE_SUBTREE_THRESHOLD,
      approvalPolicy: 'manual',
    });
  }
  assertPlainOptions(options);
  const threshold = readThreshold(options);
  const approvalPolicy = readApprovalPolicy(options);
  return Object.freeze({ deleteSubtreeThreshold: threshold, approvalPolicy });
}

/**
 * Risk of one host-counted `nodes.delete_subtree`. The count is the host's
 * authoritative member size, not a model-supplied field. At or below the
 * threshold the risk is medium; above it the risk is high.
 */
export function classifyDeleteSubtreeRisk(
  affectedCount: number,
  options?: McpNodeWriteToolOptions,
): 'medium' | 'high' {
  if (!Number.isSafeInteger(affectedCount) || affectedCount < 1) {
    throw new TypeError('nodes.delete_subtree affectedCount must be a positive safe integer.');
  }
  const threshold = resolveNodeWriteToolOptions(options).deleteSubtreeThreshold;
  return affectedCount > threshold ? 'high' : 'medium';
}

/**
 * Records owner-policy approval. Refuses expose (`set_visibility` to public
 * or unlisted, including an unknown visibility) and purge (delete a
 * collection, empty trash, or purge tombstones).
 */
export function approveByPolicy(
  operations: readonly unknown[],
  options?: McpNodeWriteToolOptions,
): { readonly approvedBy: 'policy' } {
  const resolved = resolveNodeWriteToolOptions(options);
  if (resolved.approvalPolicy !== 'trusted') {
    throw new McpPolicyApprovalError('Policy approval requires an owner-configured trusted approval policy.');
  }
  const typed = readOperations(operations);
  if (typed.some((operation) => operationExposesData(operation) || operationPurgesData(operation))) {
    throw new McpPolicyApprovalError();
  }
  return Object.freeze({ approvedBy: 'policy' as const });
}

function operationExposesData(operation: Readonly<Record<string, unknown>>): boolean {
  if (typeof operation.type !== 'string' || !EXPOSE_OPERATION_TYPES.has(operation.type)) return false;
  const visibility = visibilityOf(operation);
  return visibility !== 'protected' && visibility !== 'private';
}

function operationPurgesData(operation: Readonly<Record<string, unknown>>): boolean {
  return typeof operation.type === 'string' && PURGE_OPERATION_TYPES.has(operation.type);
}

function visibilityOf(operation: Readonly<Record<string, unknown>>): unknown {
  if (typeof operation.visibility === 'string') return operation.visibility;
  const input = operation.input;
  if (typeof input !== 'object' || input === null || Array.isArray(input) || nodeTypes.isProxy(input)) {
    return undefined;
  }
  const visibility = readOwnData(input).visibility;
  return typeof visibility === 'string' ? visibility : undefined;
}

function readOperations(operations: readonly unknown[]): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(operations)) {
    throw new TypeError('Policy approval requires an operations array.');
  }
  if (operations.length === 0 || operations.length > DEFAULT_MCP_WRITE_INPUT_BUDGET.maxOperations) {
    throw new TypeError('Policy approval requires a non-empty operations array within the write budget.');
  }
  return operations.map((operation, index) => {
    if (typeof operation !== 'object' || operation === null || Array.isArray(operation) || nodeTypes.isProxy(operation)) {
      throw new TypeError(`Operation at index ${index} must be a plain object.`);
    }
    const own = readOwnData(operation);
    if (typeof own.type !== 'string' || own.type.length === 0) {
      throw new TypeError(`Operation at index ${index} requires a type.`);
    }
    return own;
  });
}

function assertPlainOptions(options: McpNodeWriteToolOptions): void {
  if (typeof options !== 'object' || options === null || Array.isArray(options) || nodeTypes.isProxy(options)) {
    throw new TypeError('Node write tool options must be a plain object.');
  }
  for (const key of Reflect.ownKeys(options)) {
    if (key !== 'deleteSubtreeThreshold' && key !== 'approvalPolicy') {
      throw new TypeError('Node write tool options contain an unknown property.');
    }
  }
}

function readThreshold(options: object): number {
  const value = readOptionalOwnData(options, 'deleteSubtreeThreshold');
  if (value === undefined) return DEFAULT_MCP_DELETE_SUBTREE_THRESHOLD;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError('deleteSubtreeThreshold must be a non-negative safe integer.');
  }
  return value as number;
}

function readApprovalPolicy(options: object): McpAgentApprovalPolicy {
  const value = readOptionalOwnData(options, 'approvalPolicy');
  if (value === undefined) return 'manual';
  if (value !== 'manual' && value !== 'trusted') {
    throw new TypeError('approvalPolicy must be "manual" or "trusted".');
  }
  return value;
}

function readOptionalOwnData(object: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, name);
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor) || descriptor.enumerable !== true) {
    throw new TypeError(`${name} must be an own enumerable data property.`);
  }
  return descriptor.value;
}

function readOwnData(value: object): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) continue;
    result[key] = descriptor.value;
  }
  return result;
}
