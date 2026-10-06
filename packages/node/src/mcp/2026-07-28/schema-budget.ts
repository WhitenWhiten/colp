/**
 * Schema 2020-12 budget guard for Modern Read Tool schemas.
 *
 * Tool `inputSchema` / `outputSchema` may legitimately carry `$ref`,
 * `$dynamicRef`, `$recursiveRef` and composition keywords
 * (`allOf`/`anyOf`/`oneOf`/`$defs`/`items`/`not`/`if`/`then`/`else`/...).
 * Before the Modern adapter emits a Tool, this guard walks the schema as
 * untrusted JSON own-data (no getters, no Proxies, no class prototypes, no
 * symbol keys, no cycles) and enforces bounded parse depth, node count,
 * reference count and byte count, rejecting `$ref` bombs and aliasing cycles
 * with {@link McpSchemaBudgetError}. `createMcp20260728ReadToolAdapter`
 * applies it at factory time so an over-budget schema can never reach a
 * Modern result; the emitted result itself is additionally snapshotted
 * against the per-request output budget by the adapter.
 */
import { types as nodeTypes } from 'node:util';

/** Per-schema 2020-12 budget for Modern Read Tool schemas. */
export interface McpSchemaBudget {
  readonly maxDepth?: number;
  readonly maxNodes?: number;
  readonly maxReferences?: number;
  readonly maxBytes?: number;
}

export const DEFAULT_MCP_SCHEMA_BUDGET: Required<McpSchemaBudget> = Object.freeze({
  maxDepth: 32,
  maxNodes: 10_000,
  maxReferences: 1_000,
  maxBytes: 1_048_576,
});

/** Resolves a schema budget against safe-integer defaults. */
export function resolveMcpSchemaBudget(budget?: McpSchemaBudget): Required<McpSchemaBudget> {
  if (budget === undefined) return DEFAULT_MCP_SCHEMA_BUDGET;
  if (typeof budget !== 'object' || budget === null || Array.isArray(budget) || nodeTypes.isProxy(budget)) {
    throw new TypeError('MCP schema budget must be an own-data object.');
  }
  const limits = Object.freeze({
    maxDepth: readLimit(budget, 'maxDepth', DEFAULT_MCP_SCHEMA_BUDGET.maxDepth),
    maxNodes: readLimit(budget, 'maxNodes', DEFAULT_MCP_SCHEMA_BUDGET.maxNodes),
    maxReferences: readLimit(budget, 'maxReferences', DEFAULT_MCP_SCHEMA_BUDGET.maxReferences),
    maxBytes: readLimit(budget, 'maxBytes', DEFAULT_MCP_SCHEMA_BUDGET.maxBytes),
  });
  if (!Number.isSafeInteger(limits.maxDepth) || limits.maxDepth < 0
    || !Number.isSafeInteger(limits.maxNodes) || limits.maxNodes < 1
    || !Number.isSafeInteger(limits.maxReferences) || limits.maxReferences < 1
    || !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1) {
    throw new TypeError('MCP schema budget must contain safe integer limits.');
  }
  return limits;
}

/** Fail-closed error when a Tool schema exceeds its budget or is malformed. */
export class McpSchemaBudgetError extends TypeError {
  readonly code = 'schema_budget_exceeded' as const;

  constructor(reason: string) {
    super(`MCP Tool schema ${reason}`);
    this.name = 'McpSchemaBudgetError';
  }
}

/** JSON Schema 2020-12 reference keywords counted by the budget guard. */
const REFERENCE_KEYWORDS: ReadonlySet<string> = new Set(['$ref', '$dynamicRef', '$recursiveRef']);

/**
 * Walks a Tool schema as untrusted JSON own-data within the configured
 * budget. Throws {@link McpSchemaBudgetError} on any violation; returns
 * `void` on success. Rejecting a schema is always fail-closed and never
 * leaks schema contents.
 */
export function assertMcpSchemaWithinBudget(schema: unknown, budget?: McpSchemaBudget): void {
  const limits = resolveMcpSchemaBudget(budget);
  walkSchema(schema, { ancestors: new WeakSet<object>(), nodes: 0, bytes: 0, references: 0 }, limits, 0);
}

interface SchemaWalkState {
  readonly ancestors: WeakSet<object>;
  nodes: number;
  bytes: number;
  references: number;
}

function walkSchema(
  value: unknown,
  state: SchemaWalkState,
  limits: Required<McpSchemaBudget>,
  depth: number,
): void {
  if (depth > limits.maxDepth) throw new McpSchemaBudgetError('exceeded the schema depth budget.');
  state.nodes += 1;
  if (state.nodes > limits.maxNodes) throw new McpSchemaBudgetError('exceeded the schema node budget.');
  state.bytes += primitiveBytes(value);
  if (state.bytes > limits.maxBytes) throw new McpSchemaBudgetError('exceeded the schema byte budget.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new McpSchemaBudgetError('must contain only finite numbers.');
    return;
  }
  if (typeof value !== 'object') throw new McpSchemaBudgetError('must contain only JSON data.');
  if (nodeTypes.isProxy(value)) throw new McpSchemaBudgetError('must not contain Proxies.');

  const prototype = Object.getPrototypeOf(value);
  const isArray = Array.isArray(value);
  if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    throw new McpSchemaBudgetError('must use ordinary data prototypes.');
  }
  if (state.ancestors.has(value)) throw new McpSchemaBudgetError('must not contain cycles.');
  state.ancestors.add(value);
  try {
    if (isArray) {
      walkSchemaArray(value as readonly unknown[], state, limits, depth);
    } else {
      walkSchemaObject(value, state, limits, depth);
    }
  } finally {
    state.ancestors.delete(value);
  }
}

function walkSchemaArray(
  value: readonly unknown[],
  state: SchemaWalkState,
  limits: Required<McpSchemaBudget>,
  depth: number,
): void {
  if (state.nodes + value.length > limits.maxNodes) {
    throw new McpSchemaBudgetError('exceeded the schema node budget.');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === 'symbol')) throw new McpSchemaBudgetError('must not contain symbols.');
  const dataKeys = keys.filter((key): key is string => typeof key === 'string' && key !== 'length');
  if (dataKeys.length !== value.length || dataKeys.some((key, index) => key !== String(index))) {
    throw new McpSchemaBudgetError('arrays must be dense.');
  }
  for (const key of dataKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
      throw new McpSchemaBudgetError('must contain only enumerable data properties.');
    }
    walkSchema(descriptor.value, state, limits, depth + 1);
  }
}

function walkSchemaObject(
  value: object,
  state: SchemaWalkState,
  limits: Required<McpSchemaBudget>,
  depth: number,
): void {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === 'symbol')) throw new McpSchemaBudgetError('must not contain symbols.');
  if (state.nodes + keys.length > limits.maxNodes) {
    throw new McpSchemaBudgetError('exceeded the schema node budget.');
  }
  for (const key of keys as string[]) {
    state.bytes += key.length * 4;
    if (state.bytes > limits.maxBytes) throw new McpSchemaBudgetError('exceeded the schema byte budget.');
  }
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
      throw new McpSchemaBudgetError('must contain only enumerable data properties.');
    }
    if (REFERENCE_KEYWORDS.has(key) && typeof descriptor.value === 'string') {
      state.references += 1;
      if (state.references > limits.maxReferences) {
        throw new McpSchemaBudgetError('exceeded the schema reference budget.');
      }
    }
    walkSchema(descriptor.value, state, limits, depth + 1);
  }
}

function readLimit(budget: McpSchemaBudget, name: keyof McpSchemaBudget, fallback: number): number {
  const descriptor = Object.getOwnPropertyDescriptor(budget, name);
  if (descriptor === undefined) return fallback;
  if (!('value' in descriptor)) {
    throw new TypeError('MCP schema budget must use own data properties.');
  }
  if (descriptor.value === undefined) return fallback;
  return descriptor.value as number;
}

function primitiveBytes(value: unknown): number {
  if (typeof value === 'string') return value.length * 4;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return 8;
  return 1;
}
