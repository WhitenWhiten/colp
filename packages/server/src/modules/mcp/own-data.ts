import { types as nodeTypes } from 'node:util';

export interface McpOwnDataBudget {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxBytes: number;
}

/**
 * Single authority for the default MCP write input budget.
 *
 * The W03 planner and the W04 low-risk node-create service must resolve the
 * same default limits; both import this frozen object instead of keeping
 * structurally identical private copies.
 */
export const MCP_OWN_DATA_DEFAULT_BUDGET = Object.freeze({
  maxDepth: 32,
  maxNodes: 10_000,
  maxBytes: 1_048_576,
  maxOperations: 1_000,
} as const);

export function snapshotMcpOwnData(
  value: unknown,
  budget: McpOwnDataBudget,
): unknown {
  const state = { ancestors: new WeakSet<object>(), nodes: 0, bytes: 0 };
  return snapshotValue(value, state, budget, 0);
}

interface SnapshotState {
  readonly ancestors: WeakSet<object>;
  nodes: number;
  bytes: number;
}

function snapshotValue(
  value: unknown,
  state: SnapshotState,
  budget: McpOwnDataBudget,
  depth: number,
): unknown {
  if (depth > budget.maxDepth) throw new TypeError('depth');
  state.nodes += 1;
  if (state.nodes > budget.maxNodes) throw new TypeError('nodes');
  state.bytes += primitiveBytes(value);
  if (state.bytes > budget.maxBytes) throw new TypeError('bytes');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('number');
    return value;
  }
  if (typeof value !== 'object' || nodeTypes.isProxy(value)) {
    throw new TypeError('object');
  }
  const prototype = Object.getPrototypeOf(value);
  const isArray = Array.isArray(value);
  if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('prototype');
  }
  if (state.ancestors.has(value)) throw new TypeError('cycle');
  state.ancestors.add(value);
  try {
    if (isArray) return snapshotArray(value as readonly unknown[], state, budget, depth);
    return snapshotObject(value, state, budget, depth);
  } finally {
    state.ancestors.delete(value);
  }
}

function snapshotArray(
  value: readonly unknown[],
  state: SnapshotState,
  budget: McpOwnDataBudget,
  depth: number,
): readonly unknown[] {
  if (state.nodes + value.length > budget.maxNodes) throw new TypeError('nodes');
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === 'symbol')) throw new TypeError('symbol');
  const dataKeys = keys.filter((key): key is string => typeof key === 'string' && key !== 'length');
  if (dataKeys.length !== value.length || dataKeys.some((key, index) => key !== String(index))) {
    throw new TypeError('dense');
  }
  const snapshot: unknown[] = [];
  for (const key of dataKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError('enumerable');
    }
    snapshot.push(snapshotValue(descriptor.value, state, budget, depth + 1));
  }
  return Object.freeze(snapshot);
}

function snapshotObject(
  value: object,
  state: SnapshotState,
  budget: McpOwnDataBudget,
  depth: number,
): Readonly<Record<string, unknown>> {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === 'symbol')) throw new TypeError('symbol');
  const stringKeys = keys as string[];
  if (state.nodes + stringKeys.length > budget.maxNodes) throw new TypeError('nodes');
  for (const key of stringKeys) {
    state.bytes += key.length * 4;
    if (state.bytes > budget.maxBytes) throw new TypeError('bytes');
  }
  const snapshot: Record<string, unknown> = {};
  for (const key of stringKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError('enumerable');
    }
    Object.defineProperty(snapshot, key, {
      enumerable: true,
      configurable: false,
      writable: false,
      value: snapshotValue(descriptor.value, state, budget, depth + 1),
    });
  }
  return Object.freeze(snapshot);
}

function primitiveBytes(value: unknown): number {
  if (typeof value === 'string') return value.length * 4;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return 8;
  return 1;
}
