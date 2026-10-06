/**
 * stateless, protocol-neutral MCP Tool execution ports and safe
 * schemas.
 *
 * The Tool gateway application core owns no instance state: every `callTool`
 * call re-accepts a frozen per-request trusted read context (see
 * `shared/resources.ts`), validates the Tool name, dispatches through an
 * own-data execution port, snapshots the result against the per-request
 * budget and hides application exceptions behind a generic secret-free error.
 * One frozen core serves concurrent requests; no hidden per-client instance
 * and no retained request context.
 *
 * The execution port and Tool definitions are deliberately protocol-neutral:
 * they carry no MCP Header, JSON-RPC, transport or protocol lifecycle types.
 */
import { types as nodeTypes } from 'node:util';

import type { McpToolInputSchema, McpToolOutputSchema } from '../tool-input.js';
import { McpToolInputError } from '../tool-input.js';
import { snapshotMcpData } from '../safe-data.js';
import type { McpResourceReadBudget } from './resources.js';
import {
  McpReadRequestAbortedError,
  McpReadRequestContextError,
  requireTrustedReadRequestContext,
  type McpTrustedReadRequestContext,
} from './resources.js';

/** Protocol-neutral Tool definition with a safe closed input schema. */
export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: McpToolInputSchema;
  readonly outputSchema?: McpToolOutputSchema;
}

/** Protocol-neutral read Tool result (structured content passthrough). */
export interface McpReadToolResult {
  readonly structuredContent?: unknown;
  readonly content?: unknown;
  readonly [field: string]: unknown;
}

export class McpUnknownToolError extends TypeError {
  readonly code = 'unknown_tool' as const;

  constructor() {
    super('Unknown MCP Tool.');
    this.name = 'McpUnknownToolError';
  }
}

export class McpInvalidToolNameError extends TypeError {
  readonly code = 'invalid_tool_name' as const;

  constructor() {
    super('Invalid MCP Tool name.');
    this.name = 'McpInvalidToolNameError';
  }
}

export class McpToolOutputUnavailableError extends Error {
  readonly code = 'tool_output_unavailable' as const;

  constructor() {
    super('MCP Tool output is unavailable.');
    this.name = 'McpToolOutputUnavailableError';
  }
}

/**
 * Host-supplied, protocol-neutral Tool execution port. The port validates its
 * own input schema, authorizes and projects; the core re-checks the request
 * context and abort signal, snapshots output and hides application failures.
 */
export interface McpToolExecutionPort {
  readonly invoke: (
    input: Readonly<Record<string, unknown>>,
    context: McpTrustedReadRequestContext,
  ) => unknown | PromiseLike<unknown>;
}

export interface McpToolRegistration {
  readonly definition: McpToolDefinition;
  readonly invoke: McpToolExecutionPort['invoke'];
}

export interface McpStatelessToolCoreOptions {
  readonly tools: readonly McpToolRegistration[];
}

export interface McpStatelessToolCore {
  readonly listTools: () => readonly McpToolDefinition[];
  readonly callTool: (
    context: McpTrustedReadRequestContext,
    name: string,
    input: unknown,
  ) => Promise<McpReadToolResult>;
}

const toolNamePattern = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)+$/u;

/**
 * Creates the reusable stateless Tool execution core. Immutable registrations
 * are validated once at factory time; every call re-accepts the current
 * trusted context and never retains request-scoped state.
 */
export function createMcpStatelessToolCore(
  options: McpStatelessToolCoreOptions,
): McpStatelessToolCore {
  if (arguments.length !== 1) throw configError();
  if (typeof options !== 'object' || options === null || nodeTypes.isProxy(options)) throw configError();
  const registrations = readToolRegistrations(options);
  const registry = new Map<string, { readonly invoke: McpToolExecutionPort['invoke']; readonly receiver: object }>();
  for (const registration of registrations) {
    if (registry.has(registration.definition.name)) throw configError();
    registry.set(registration.definition.name, {
      invoke: registration.invoke,
      receiver: registration.receiver,
    });
  }
  const definitions = Object.freeze(registrations.map((registration) => registration.definition));

  const listTools = (): readonly McpToolDefinition[] => definitions;

  const callTool = async (
    ...args: [context: unknown, name: unknown, input: unknown]
  ): Promise<McpReadToolResult> => {
    assertArgumentCount(args.length, 3);
    const context = requireTrustedReadRequestContext(args[0]);
    assertNotAborted(context.abortSignal);
    const name = readToolName(args[1]);
    const entry = registry.get(name);
    if (entry === undefined) throw new McpUnknownToolError();
    let raw: unknown;
    try {
      raw = await Reflect.apply(entry.invoke, entry.receiver, [args[2], context]);
    } catch (error) {
      classifyToolError(error);
    }
    assertNotAborted(context.abortSignal);
    const result = snapshotToolResult(raw, context.budget);
    assertNotAborted(context.abortSignal);
    return result;
  };

  return Object.freeze({ listTools, callTool });
}

function readToolRegistrations(options: McpStatelessToolCoreOptions): readonly {
  readonly definition: McpToolDefinition;
  readonly invoke: McpToolExecutionPort['invoke'];
  readonly receiver: object;
}[] {
  const raw = readOwnValue(options, 'tools', configError);
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype) throw configError();
  return raw.map((candidate) => {
    assertExactDataObject(candidate, ['definition', 'invoke'], [], configError);
    const definition = readOwnData(candidate as object, 'definition', configError);
    assertExactDataObject(definition, ['name', 'description', 'inputSchema'], ['outputSchema'], configError);
    const name = readOwnData(definition as object, 'name', configError);
    const description = readOwnData(definition as object, 'description', configError);
    const inputSchema = readOwnData(definition as object, 'inputSchema', configError);
    if (typeof name !== 'string' || name.length === 0 || name.length > 128) throw configError();
    if (!toolNamePattern.test(name)) throw configError();
    if (typeof description !== 'string' || description.length === 0) throw configError();
    if (typeof inputSchema !== 'object' || inputSchema === null || Array.isArray(inputSchema)) throw configError();
    const invoke = readOwnData(candidate as object, 'invoke', configError);
    if (typeof invoke !== 'function') throw configError();
    return Object.freeze({
      definition: definition as McpToolDefinition,
      invoke: invoke as McpToolExecutionPort['invoke'],
      receiver: candidate as object,
    });
  });
}

function readToolName(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 || !toolNamePattern.test(value)) {
    throw new McpInvalidToolNameError();
  }
  return value;
}

function snapshotToolResult(raw: unknown, budget: McpResourceReadBudget): McpReadToolResult {
  let snapshot: unknown;
  try {
    snapshot = snapshotMcpData(raw, budget);
  } catch {
    throw new McpToolOutputUnavailableError();
  }
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    throw new McpToolOutputUnavailableError();
  }
  return snapshot as McpReadToolResult;
}

function classifyToolError(error: unknown): never {
  if (
    error instanceof McpToolInputError
    || error instanceof McpToolOutputUnavailableError
    || error instanceof McpUnknownToolError
    || error instanceof McpInvalidToolNameError
  ) {
    throw error;
  }
  throw new McpToolOutputUnavailableError();
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new McpReadRequestAbortedError();
  }
}

function assertExactDataObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
  fail: () => Error = configError,
): asserts value is object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw fail();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw fail();
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string' || !allowed.has(key))) throw fail();
  if (required.some((key) => !keys.includes(key))) throw fail();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) throw fail();
  }
}

function readOwnValue(value: object, name: string, fail: () => Error): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor)) throw fail();
  return descriptor.value;
}

function readOwnData(value: object, name: string, fail: () => Error): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor === undefined || !('value' in descriptor)) throw fail();
  return descriptor.value;
}

function assertArgumentCount(actual: number, expected: number): void {
  if (actual !== expected) throw new TypeError('Invalid stateless MCP Tool core invocation.');
}

function configError(): TypeError {
  return new TypeError('Invalid stateless MCP Tool core configuration.');
}
