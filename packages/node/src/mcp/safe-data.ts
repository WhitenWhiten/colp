import { types as nodeTypes } from 'node:util';

export interface McpWriteInputBudget {
  readonly maxDepth?: number;
  readonly maxNodes?: number;
  readonly maxBytes?: number;
  readonly maxOperations?: number;
}

export const DEFAULT_MCP_WRITE_INPUT_BUDGET: Required<McpWriteInputBudget> = Object.freeze({
  maxDepth: 32,
  maxNodes: 10_000,
  maxBytes: 1_048_576,
  maxOperations: 1_000,
});

export function resolveMcpWriteInputBudget(
  budget?: McpWriteInputBudget,
): Required<McpWriteInputBudget> {
  if (budget === undefined) return DEFAULT_MCP_WRITE_INPUT_BUDGET;
  if (typeof budget !== 'object' || budget === null || Array.isArray(budget) || nodeTypes.isProxy(budget)) {
    throw new TypeError('MCP write input budget must be an own-data object.');
  }
  const limits = Object.freeze({
    maxDepth: readBudgetLimit(budget, 'maxDepth'),
    maxNodes: readBudgetLimit(budget, 'maxNodes'),
    maxBytes: readBudgetLimit(budget, 'maxBytes'),
    maxOperations: readBudgetLimit(budget, 'maxOperations'),
  });
  if (!Number.isSafeInteger(limits.maxDepth) || limits.maxDepth < 0
    || !Number.isSafeInteger(limits.maxNodes) || limits.maxNodes < 1
    || !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1
    || !Number.isSafeInteger(limits.maxOperations) || limits.maxOperations < 1) {
    throw new TypeError('MCP write input budget must contain safe integer limits.');
  }
  return limits;
}

function readBudgetLimit(
  budget: McpWriteInputBudget,
  name: keyof McpWriteInputBudget,
): number {
  const descriptor = Object.getOwnPropertyDescriptor(budget, name);
  if (descriptor === undefined) return DEFAULT_MCP_WRITE_INPUT_BUDGET[name];
  if (!('value' in descriptor) || descriptor.value === undefined) {
    if ('value' in descriptor) return DEFAULT_MCP_WRITE_INPUT_BUDGET[name];
    throw new TypeError('MCP write input budget must use own data properties.');
  }
  return descriptor.value as number;
}

/** Copies untrusted values without invoking getters, inherited behavior, or toJSON hooks. */
export function snapshotMcpData(value: unknown, budget?: McpWriteInputBudget): unknown {
  const limits = resolveMcpWriteInputBudget(budget);
  const state: SnapshotState = { ancestors: new WeakSet<object>(), nodes: 0, bytes: 0 };
  return snapshotValue(value, state, limits, 0);
}

interface SnapshotState {
  readonly ancestors: WeakSet<object>;
  nodes: number;
  bytes: number;
}

function snapshotValue(
  value: unknown,
  state: SnapshotState,
  limits: Required<McpWriteInputBudget>,
  depth: number,
): unknown {
  if (depth > limits.maxDepth) throw new TypeError('MCP data exceeded snapshot depth budget.');
  state.nodes += 1;
  if (state.nodes > limits.maxNodes) throw new TypeError('MCP data exceeded snapshot node budget.');
  state.bytes += primitiveBytes(value);
  if (state.bytes > limits.maxBytes) throw new TypeError('MCP data exceeded snapshot byte budget.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('MCP data must contain finite numbers.');
    return value;
  }
  if (typeof value !== 'object') throw new TypeError('MCP data must contain only JSON data.');
  if (nodeTypes.isProxy(value)) throw new TypeError('MCP data must not contain Proxies.');

  const prototype = Object.getPrototypeOf(value);
  const isArray = Array.isArray(value);
  if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('MCP data must use ordinary data prototypes.');
  }
  if (state.ancestors.has(value)) throw new TypeError('MCP data must not contain cycles.');

  state.ancestors.add(value);
  try {
    return isArray
      ? snapshotArray(value as readonly unknown[], state, limits, depth)
      : snapshotObject(value, state, limits, depth);
  } finally {
    state.ancestors.delete(value);
  }
}

function snapshotArray(
  value: readonly unknown[],
  state: SnapshotState,
  limits: Required<McpWriteInputBudget>,
  depth: number,
): readonly unknown[] {
  if (state.nodes + value.length > limits.maxNodes) {
    throw new TypeError('MCP data exceeded snapshot node budget.');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === 'symbol')) throw new TypeError('MCP data must not contain symbols.');
  const dataKeys = keys.filter((key): key is string => typeof key === 'string' && key !== 'length');
  if (dataKeys.length !== value.length || dataKeys.some((key, index) => key !== String(index))) {
    throw new TypeError('MCP data arrays must be dense.');
  }

  const snapshot: unknown[] = [];
  for (const key of dataKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError('MCP data must contain only enumerable data properties.');
    }
    snapshot.push(snapshotValue(descriptor.value, state, limits, depth + 1));
  }
  return Object.freeze(snapshot);
}

function snapshotObject(
  value: object,
  state: SnapshotState,
  limits: Required<McpWriteInputBudget>,
  depth: number,
): Readonly<Record<string, unknown>> {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === 'symbol')) throw new TypeError('MCP data must not contain symbols.');
  if (state.nodes + keys.length > limits.maxNodes) {
    throw new TypeError('MCP data exceeded snapshot node budget.');
  }
  for (const key of keys as string[]) {
    state.bytes += key.length * 4;
    if (state.bytes > limits.maxBytes) {
      throw new TypeError('MCP data exceeded snapshot byte budget.');
    }
  }

  const snapshot: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError('MCP data must contain only enumerable data properties.');
    }
    Object.defineProperty(snapshot, key, {
      enumerable: true,
      configurable: false,
      writable: false,
      value: snapshotValue(descriptor.value, state, limits, depth + 1),
    });
  }
  return Object.freeze(snapshot);
}

function primitiveBytes(value: unknown): number {
  if (typeof value === 'string') return value.length * 4;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return 8;
  return 1;
}
