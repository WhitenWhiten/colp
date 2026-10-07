/**
 * Modern MCP `2026-07-28` read-only Tool adapters.
 *
 * Thin adapter layer over the protocol-neutral stateless Tool core
 * (`src/mcp/shared/tools.ts`). The factory validates every registered Tool
 * schema against the Schema 2020-12 budget guard
 * (`src/mcp/2026-07-28/schema-budget.ts`), builds the Modern Tool shape and
 * validates it against the pinned SDK `ToolSchema`; `tools/list` is
 * deterministically ordered by registered name and `tools/call` validates
 * wire arguments against the Tool's inputSchema before dispatching.
 *
 * Results are always `complete`, carry
 * `io.modelcontextprotocol/serverInfo`, and only `tools/list` (cacheable)
 * stamps `ttlMs`/`cacheScope`. Unknown tools and invalid arguments map to a
 * stable `invalid_params` (-32602) error consistent with
 * `normalizeMcp20260728Error`; aborts surface as
 * `McpReadRequestAbortedError`; structured content carrying a raw secret
 * marker is withheld (`Mcp20260728ReadToolSecretMarkerError`) so the Read
 * side never leaks credentials.
 */
import { types as nodeTypes } from 'node:util';

import { snapshotMcpData } from '../safe-data.js';
import type { McpToolInputSchema, McpToolOutputSchema, McpToolInputValidator } from '../tool-input.js';
import {
  McpToolInputError,
  createMcpToolOutputValidator,
  createMcpToolInputValidator,
  type McpToolOutputValidator,
} from '../tool-input.js';
import { containsRawSecretMarker } from '../shared/authorization.js';
import { McpReadRequestAbortedError } from '../shared/resources.js';
import {
  McpInvalidToolNameError,
  McpUnknownToolError,
  McpToolScopeDeniedError,
  type McpReadToolResult,
  type McpStatelessToolCore,
} from '../shared/tools.js';
import {
  CallToolResultSchema,
  ImplementationSchema,
  ListToolsResultSchema,
  ToolSchema,
} from '../../shared/mcp-sdk-boundary.js';
import {
  Mcp20260728RequestError,
  requireMcp20260728RequestContext,
  type Mcp20260728RequestContext,
} from './request-context.js';
import {
  createMcp20260728Result,
  type Mcp20260728CacheMetadata,
  type Mcp20260728Result,
  type Mcp20260728ServerInfo,
} from './results.js';
import {
  DEFAULT_MCP_SCHEMA_BUDGET,
  assertMcpSchemaWithinBudget,
  resolveMcpSchemaBudget,
  type McpSchemaBudget,
} from './schema-budget.js';

/** Fail-closed withholding when Read Tool output carries a raw secret marker. */
export class Mcp20260728ReadToolSecretMarkerError extends Error {
  readonly code = 'secret_marker_detected' as const;

  constructor() {
    super('MCP Read Tool output carries a raw secret marker and was withheld.');
    this.name = 'Mcp20260728ReadToolSecretMarkerError';
  }
}

export interface Mcp20260728ReadToolAdapterOptions {
  /** Shared stateless Tool core (listTools / callTool). */
  readonly toolCore: McpStatelessToolCore;
  readonly serverInfo: Mcp20260728ServerInfo;
  /** Schema 2020-12 budget guard applied to every Tool input/output schema. */
  readonly schemaBudget?: McpSchemaBudget;
  /** Accurate cache metadata for the cacheable `tools/list` method (default 0/private). */
  readonly cache?: Readonly<Partial<Record<'tools/list', Mcp20260728CacheMetadata>>>;
}

export interface Mcp20260728ReadToolAdapter {
  readonly listTools: (
    context: Mcp20260728RequestContext,
    input?: unknown,
  ) => Promise<Mcp20260728Result>;
  readonly callTool: (
    context: Mcp20260728RequestContext,
    input?: unknown,
  ) => Promise<Mcp20260728Result>;
}

interface McpSchemaValidator {
  readonly safeParse: (value: unknown) => { readonly success: boolean };
}

const TOOL_RESULT_SCHEMAS: Readonly<Record<'tools/list' | 'tools/call', McpSchemaValidator>> =
  Object.freeze({
    'tools/list': ListToolsResultSchema,
    'tools/call': CallToolResultSchema,
  });

interface ToolEntry {
  readonly name: string;
  readonly modern: Readonly<Record<string, unknown>>;
  readonly validateInput: McpToolInputValidator;
  readonly requiredScopes: readonly string[];
  readonly validateOutput?: McpToolOutputValidator;
}

/**
 * Creates the reusable Modern Read Tool adapter. Validates host options
 * (fail-closed `TypeError` on malformed configuration or over-budget /
 * non-emittable Tool schemas) and returns one frozen instance that safely
 * serves concurrent requests.
 */
export function createMcp20260728ReadToolAdapter(
  options: Mcp20260728ReadToolAdapterOptions,
): Mcp20260728ReadToolAdapter {
  if (arguments.length !== 1) throw configError();
  if (typeof options !== 'object' || options === null || nodeTypes.isProxy(options)) throw configError();
  const toolCore = readToolCore(options);
  const serverInfo = readServerInfo(options);
  const schemaBudget = resolveSchemaBudget(options);
  const cache = readCache(options);

  const entries = readToolEntries(toolCore, schemaBudget);
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const sortedModern = Object.freeze(entries.map((entry) => entry.modern));
  const registry = new Map(entries.map((entry) => [entry.name, entry]));

  const listTools = async (
    context: Mcp20260728RequestContext,
    input?: unknown,
  ): Promise<Mcp20260728Result> => {
    const ctx = requireMcp20260728RequestContext(context);
    // Cursor accepted for wire-shape parity; the full static tool set is
    // always returned and never paginated.
    readCursorRequest(input);
    const effectiveScope = new Set(ctx.scope);
    const tools = Object.freeze(entries
      .filter((entry) => entry.requiredScopes.every((scope) => effectiveScope.has(scope)))
      .map((entry) => entry.modern));
    return buildToolResult('tools/list', serverInfo, ctx, { tools }, cache['tools/list']);
  };

  const callTool = async (
    context: Mcp20260728RequestContext,
    input?: unknown,
  ): Promise<Mcp20260728Result> => {
    const ctx = requireMcp20260728RequestContext(context);
    const request = readCallToolInput(input);
    const entry = registry.get(request.name);
    if (entry === undefined) {
      throw new Mcp20260728RequestError('invalid_params', 'Unknown tool.', { name: request.name });
    }
    let validatedArgs: Readonly<Record<string, unknown>>;
    try {
      validatedArgs = entry.validateInput(request.arguments ?? {}, ctx.budget);
    } catch (error) {
      if (error instanceof McpToolInputError) {
        throw new Mcp20260728RequestError('invalid_params', 'Invalid tool arguments.', {
          name: request.name,
          issues: error.issues,
        });
      }
      throw error;
    }
    let result: McpReadToolResult;
    try {
      result = await toolCore.callTool(ctx, request.name, validatedArgs);
    } catch (error) {
      if (error instanceof McpUnknownToolError || error instanceof McpInvalidToolNameError || error instanceof McpToolScopeDeniedError) {
        throw new Mcp20260728RequestError('invalid_params', 'Unknown tool.', { name: request.name });
      }
      if (error instanceof McpReadRequestAbortedError) throw error;
      throw error;
    }
    if (entry.validateOutput !== undefined) {
      entry.validateOutput(result.structuredContent);
    }
    if (containsRawSecretMarker(result)) {
      throw new Mcp20260728ReadToolSecretMarkerError();
    }
    const fields: Record<string, unknown> = {
      content: result.content === undefined ? [] : result.content,
    };
    if (result.structuredContent !== undefined) fields.structuredContent = result.structuredContent;
    if (result.isError !== undefined) fields.isError = result.isError;
    return buildToolResult('tools/call', serverInfo, ctx, fields, undefined);
  };

  return Object.freeze({ listTools, callTool });
}

function buildToolResult(
  method: 'tools/list' | 'tools/call',
  serverInfo: Mcp20260728ServerInfo,
  context: Mcp20260728RequestContext,
  fields: Readonly<Record<string, unknown>>,
  cache: Mcp20260728CacheMetadata | undefined,
): Mcp20260728Result {
  const snapshot = snapshotMcpData(fields, context.budget) as Readonly<Record<string, unknown>>;
  if (!TOOL_RESULT_SCHEMAS[method].safeParse(snapshot).success) {
    throw new TypeError('MCP Read Tool adapter produced an invalid Modern result.');
  }
  return createMcp20260728Result({
    method,
    serverInfo,
    fields: snapshot,
    ...(cache !== undefined ? { cache } : {}),
  });
}

function readToolEntries(
  toolCore: McpStatelessToolCore,
  schemaBudget: Required<McpSchemaBudget>,
): ToolEntry[] {
  const definitions = toolCore.listTools();
  if (!Array.isArray(definitions) || Object.getPrototypeOf(definitions) !== Array.prototype) {
    throw configError();
  }
  return definitions.map((definition) => {
    assertExactDataObject(definition, ['name', 'description', 'inputSchema'], ['outputSchema', 'requiredScopes'], configError);
    const name = readOwnData(definition, 'name', configError);
    const description = readOwnData(definition, 'description', configError);
    const inputSchema = readOwnData(definition, 'inputSchema', configError);
    const outputSchema = readOptionalData(definition, 'outputSchema');
    const requiredScopes = readOptionalData(definition, 'requiredScopes');
    if (typeof name !== 'string' || name.length === 0) throw configError();
    const scopes = readRequiredScopes(requiredScopes);
    if (typeof description !== 'string' || description.length === 0) throw configError();
    if (typeof inputSchema !== 'object' || inputSchema === null || Array.isArray(inputSchema)) {
      throw configError();
    }
    if (outputSchema !== undefined
      && (typeof outputSchema !== 'object' || outputSchema === null || Array.isArray(outputSchema))) {
      throw configError();
    }
    assertMcpSchemaWithinBudget(inputSchema, schemaBudget);
    if (outputSchema !== undefined) assertMcpSchemaWithinBudget(outputSchema, schemaBudget);
    let validateInput: McpToolInputValidator;
    let validateOutput: McpToolOutputValidator | undefined;
    try {
      validateInput = createMcpToolInputValidator(inputSchema as McpToolInputSchema);
      if (outputSchema !== undefined) {
        validateOutput = createMcpToolOutputValidator(outputSchema as McpToolOutputSchema);
      }
    } catch {
      throw configError();
    }
    const modern: Readonly<Record<string, unknown>> = Object.freeze({
      name,
      description,
      inputSchema: inputSchema as McpToolInputSchema,
      ...(outputSchema !== undefined
        ? { outputSchema: outputSchema as McpToolOutputSchema }
        : {}),
    });
    if (!ToolSchema.safeParse(modern).success) {
      throw configError();
    }
    return Object.freeze({
      name,
      modern,
      validateInput,
      requiredScopes: scopes,
      ...(validateOutput !== undefined ? { validateOutput } : {}),
    });
  });
}

function readRequiredScopes(value: unknown): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw configError();
  const scopes = value.map((scope) => {
    if (typeof scope !== 'string' || scope.length === 0 || scope.length > 128) throw configError();
    return scope;
  });
  if (new Set(scopes).size !== scopes.length) throw configError();
  return Object.freeze(scopes);
}

function resolveSchemaBudget(options: Mcp20260728ReadToolAdapterOptions): Required<McpSchemaBudget> {
  const raw = readOwnValue(options, 'schemaBudget');
  if (raw === undefined) return DEFAULT_MCP_SCHEMA_BUDGET;
  return resolveMcpSchemaBudget(raw as McpSchemaBudget);
}

function readToolCore(options: Mcp20260728ReadToolAdapterOptions): McpStatelessToolCore {
  const candidate = readOwnValue(options, 'toolCore', configError);
  assertExactDataObject(candidate, ['listTools', 'callTool'], [], configError);
  for (const name of ['listTools', 'callTool'] as const) {
    if (typeof readOwnData(candidate, name, configError) !== 'function') throw configError();
  }
  return candidate as McpStatelessToolCore;
}

function readServerInfo(options: Mcp20260728ReadToolAdapterOptions): Mcp20260728ServerInfo {
  const raw = readOwnValue(options, 'serverInfo', configError);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || nodeTypes.isProxy(raw)) {
    throw configError();
  }
  const parsed = ImplementationSchema.safeParse(raw);
  if (!parsed.success) throw configError();
  return Object.freeze(snapshotMcpData(parsed.data) as Mcp20260728ServerInfo);
}

function readCache(
  options: Mcp20260728ReadToolAdapterOptions,
): Readonly<Partial<Record<'tools/list', Mcp20260728CacheMetadata>>> {
  const raw = readOwnValue(options, 'cache');
  if (raw === undefined) return Object.freeze({});
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || nodeTypes.isProxy(raw)) {
    throw configError();
  }
  const keys = Reflect.ownKeys(raw);
  if (keys.some((key) => typeof key !== 'string' || key !== 'tools/list')) throw configError();
  const descriptor = Object.getOwnPropertyDescriptor(raw, 'tools/list');
  if (descriptor === undefined || !('value' in descriptor) || descriptor.value === undefined) {
    return Object.freeze({});
  }
  return Object.freeze({ 'tools/list': validateCacheMetadata(descriptor.value) });
}

function validateCacheMetadata(raw: unknown): Mcp20260728CacheMetadata {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || nodeTypes.isProxy(raw)) {
    throw configError();
  }
  const record = raw as Readonly<Record<string, unknown>>;
  const ttlMs = readOwnValue(record, 'ttlMs', configError);
  const cacheScope = readOwnValue(record, 'cacheScope', configError);
  if (typeof ttlMs !== 'number' || !Number.isSafeInteger(ttlMs) || ttlMs < 0) throw configError();
  if (cacheScope !== 'public' && cacheScope !== 'private') throw configError();
  return Object.freeze({ ttlMs, cacheScope });
}

function readCursorRequest(value: unknown): void {
  if (value === undefined) return;
  assertExactDataObject(value, [], ['cursor'], () => invalidParams('tool list cursor'));
  const cursor = readOptionalData(value, 'cursor');
  if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length === 0)) {
    throw invalidParams('tool list cursor');
  }
}

function readCallToolInput(
  value: unknown,
): Readonly<{ name: string; arguments?: Readonly<Record<string, unknown>> }> {
  assertExactDataObject(value, ['name'], ['arguments'], () => invalidParams('tool call'));
  const name = readOwnData(value, 'name', () => invalidParams('tool call'));
  if (typeof name !== 'string' || name.length === 0) throw invalidParams('tool call name');
  const args = readOptionalData(value, 'arguments');
  if (args === undefined) return Object.freeze({ name });
  if (typeof args !== 'object' || args === null || Array.isArray(args) || nodeTypes.isProxy(args)) {
    throw invalidParams('tool call arguments');
  }
  return Object.freeze({ name, arguments: args as Readonly<Record<string, unknown>> });
}

function invalidParams(message: string): Mcp20260728RequestError {
  return new Mcp20260728RequestError('invalid_params', `Invalid ${message}.`);
}

function configError(): TypeError {
  return new TypeError('Invalid Modern MCP Read Tool adapter configuration.');
}

function assertExactDataObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
  fail: () => Error = configError,
): asserts value is object {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || nodeTypes.isProxy(value)) {
    throw fail();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw fail();
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string' || !allowed.has(key))) throw fail();
  if (required.some((key) => !keys.includes(key))) throw fail();
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) throw fail();
  }
}

function readOwnValue(value: object, name: string, fail: () => Error = configError): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor)) throw fail();
  return descriptor.value;
}

function readOwnData(value: object, name: string, fail: () => Error = configError): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor === undefined || !('value' in descriptor)) throw fail();
  return descriptor.value;
}

function readOptionalData(value: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor === undefined || !('value' in descriptor)) return undefined;
  return descriptor.value;
}
