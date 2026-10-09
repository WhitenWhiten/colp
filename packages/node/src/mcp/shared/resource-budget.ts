import { types as nodeTypes } from 'node:util';
import type { McpResourceReadBudget } from './resources.js';

interface AggregateResourceBudgetState {
  readonly ancestors: WeakSet<object>;
  nodes: number;
  bytes: number;
}

/** Bounded preflight walk used only to account the whole Resource result. */
export function chargeAggregateResourceBytes(
  value: unknown,
  budget: Required<McpResourceReadBudget>,
  resourceError: () => Error,
): void {
  const state: AggregateResourceBudgetState = { ancestors: new WeakSet<object>(), nodes: 0, bytes: 0 };
  walkAggregateResourceValue(value, state, budget, 0, resourceError);
}

function walkAggregateResourceValue(
  value: unknown,
  state: AggregateResourceBudgetState,
  budget: Required<McpResourceReadBudget>,
  depth: number,
  resourceError: () => Error,
): void {
  if (depth > budget.maxDepth) throw resourceError();
  state.nodes += 1;
  if (state.nodes > budget.maxNodes) throw resourceError();
  if (typeof value === 'string') {
    if (value.length > budget.maxBytes) throw resourceError();
    state.bytes += Buffer.byteLength(value, 'utf8');
  } else if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    state.bytes += 8;
  } else if (typeof value === 'object') {
    if (nodeTypes.isProxy(value) || state.ancestors.has(value)) throw resourceError();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null && prototype !== Array.prototype) {
      throw resourceError();
    }
    state.ancestors.add(value);
    try {
      const keys = Reflect.ownKeys(value);
      if (keys.some((key) => typeof key === 'symbol')) throw resourceError();
      for (const key of keys) {
        if (key === 'length' && Array.isArray(value)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
          throw resourceError();
        }
        state.bytes += Buffer.byteLength(key as string, 'utf8') + 1;
        walkAggregateResourceValue(descriptor.value, state, budget, depth + 1, resourceError);
      }
    } finally {
      state.ancestors.delete(value);
    }
  } else {
    throw resourceError();
  }
  if (state.bytes > budget.maxBytes) throw resourceError();
}

const MCP_RESOURCE_URI_MAX_BYTES = 16 * 1024;

export function assertResourceUriBudget(uri: string, resourceError: () => Error): void {
  if (uri.length > MCP_RESOURCE_URI_MAX_BYTES || Buffer.byteLength(uri, 'utf8') > MCP_RESOURCE_URI_MAX_BYTES) {
    throw resourceError();
  }
}

/** Generic secret-free failure for Resource projection requests. */
export class McpResourceRequestError extends Error {
  readonly code = 'resource_request_failed' as const;

  constructor() {
    super('MCP Resource request could not be completed.');
    this.name = 'McpResourceRequestError';
  }
}
