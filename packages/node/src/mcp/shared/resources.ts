/**
 * stateless, protocol-neutral MCP Resource projection ports and
 * canonical models.
 *
 * This module is the reusable application core that replaces the removed
 * per-session Resource Server. It owns no instance state: every
 * `listResources` / `readResource` call re-accepts a frozen per-request
 * trusted context (authorization binding, scope, budget, abort signal and
 * opaque host residual) and returns a validated, deeply frozen projection.
 * The same core instance safely serves concurrent requests for different
 * principals; no hidden per-client instance and no retained request context.
 *
 * The application projection port and the canonical models are deliberately
 * protocol-neutral: they carry no MCP Header, JSON-RPC, transport or protocol
 * lifecycle types. The URI codec stays an injected capability from
 * `src/mcp/resource-uri.ts` so URI authority validation remains
 * protocol-independent.
 */
import { types as nodeTypes } from 'node:util';

import type { McpReadResource, McpResourceUriCodec } from '../resource-uri.js';
import type { McpWriteInputBudget } from '../safe-data.js';
import { resolveMcpWriteInputBudget, snapshotMcpData } from '../safe-data.js';
import type { McpAuthorizationBinding } from './authorization.js';
import { snapshotMcpAuthorizationBinding } from './authorization.js';

/** Trusted origin of a projected Resource body or list entry. */
export type McpResourceProvenance =
  | Readonly<{ origin: 'internal' }>
  | Readonly<{ origin: 'external'; sourceUri: string }>;

/** One protocol-neutral Resource list entry (host projection). */
export interface McpResourceListItem {
  readonly uri: string;
  readonly name: string;
  readonly mimeType: string;
  readonly provenance: McpResourceProvenance;
  /** Optional MCP Resource description (truncated host summary). */
  readonly description?: string;
  /** Optional MCP Resource annotations (host-owned; never authorization). */
  readonly _meta?: Readonly<Record<string, unknown>>;
}

/** Protocol-neutral Resource list request (opaque cursor passthrough). */
export interface McpResourceListInput {
  readonly cursor?: string;
}

/** Validated Resource list result. */
export interface McpResourceListResult {
  readonly resources: readonly McpResourceListItem[];
  readonly nextCursor?: string;
}

/** One validated Resource content projection (no wire metadata). */
export interface McpResourceContentProjection {
  readonly uri: string;
  readonly mimeType: string;
  readonly text: string;
  readonly provenance: McpResourceProvenance;
}

/** Validated Resource read result. */
export interface McpResourceReadResult {
  readonly contents: readonly McpResourceContentProjection[];
}

/**
 * Per-request read budget. Reuses the shared JSON own-data write budget
 * fields for tool-style output snapshot and adds Resource-specific limits for
 * list items, content entries, text bytes and cursor length.
 */
export interface McpResourceReadBudget extends McpWriteInputBudget {
  readonly maxListItems?: number;
  readonly maxReadContents?: number;
  readonly maxTextBytes?: number;
  readonly maxCursorLength?: number;
}

export const DEFAULT_MCP_RESOURCE_READ_BUDGET: Required<McpResourceReadBudget> = Object.freeze({
  maxDepth: 32,
  maxNodes: 10_000,
  maxBytes: 1_048_576,
  maxOperations: 1_000,
  maxListItems: 1_000,
  maxReadContents: 1_000,
  maxTextBytes: 1_048_576,
  maxCursorLength: 1_024,
});
const MCP_RESOURCE_URI_MAX_BYTES = 16 * 1024;

/** Resolves a per-request read budget against safe-integer defaults. */
export function resolveMcpResourceReadBudget(
  budget?: McpResourceReadBudget,
): Required<McpResourceReadBudget> {
  const base = resolveMcpWriteInputBudget(budget);
  const limits = Object.freeze({
    ...base,
    maxListItems: readReadLimit(budget, 'maxListItems', DEFAULT_MCP_RESOURCE_READ_BUDGET.maxListItems),
    maxReadContents: readReadLimit(budget, 'maxReadContents', DEFAULT_MCP_RESOURCE_READ_BUDGET.maxReadContents),
    maxTextBytes: readReadLimit(budget, 'maxTextBytes', DEFAULT_MCP_RESOURCE_READ_BUDGET.maxTextBytes),
    maxCursorLength: readReadLimit(budget, 'maxCursorLength', DEFAULT_MCP_RESOURCE_READ_BUDGET.maxCursorLength),
  });
  for (const name of ['maxListItems', 'maxReadContents', 'maxTextBytes', 'maxCursorLength'] as const) {
    if (!Number.isSafeInteger(limits[name]) || limits[name] < 1) {
      throw new TypeError(`MCP Resource read budget must contain safe positive integer ${name}.`);
    }
  }
  return limits;
}

/**
 * Protocol-neutral clock port. Hosts may inject an own-data `now` function;
 * the core validates it so the Modern Resource adapter can derive cache metadata from a
 * trusted clock without the core owning a clock implementation.
 */
export interface McpReadClockPort {
  readonly now: () => Date;
}

/**
 * Per-request trusted context asserted by the trusted host boundary. This is
 * an application contract, not a TypeScript claim that in-process callers
 * cannot forge values; transport adapters must construct it only after
 * authentication and authorization. Every core call re-accepts and
 * re-validates the current binding, scope, budget and abort signal; no
 * context captured from an earlier request is reused. Raw tokens, client
 * secrets and reversible credential material never enter this context.
 */
export interface McpTrustedReadRequestContext {
  /** Current anonymous or authenticated authorization binding. */
  readonly binding: McpAuthorizationBinding;
  /** Authorization scopes granted by the trusted host for this request. */
  readonly scope: readonly string[];
  /** Current per-request read budget; validated on every call. */
  readonly budget: McpResourceReadBudget;
  /** Host-owned abort signal for this request; checked at call boundaries. */
  readonly abortSignal: AbortSignal;
  /** Opaque host residual authorization/decision metadata carried to application ports. */
  readonly authorization: Readonly<Record<string, unknown>>;
}

/**
 * Strict per-call validator: snapshots and deep-freezes the trusted read
 * context, rejecting accessors, Proxies, mutation-after-call, missing or
 * extra fields, invalid bindings, invalid scope/budget and non-signal abort
 * handles. Throws {@link McpReadRequestContextError} on any failure.
 */
export function requireTrustedReadRequestContext(
  context: unknown,
): McpTrustedReadRequestContext {
  if (typeof context !== 'object' || context === null || nodeTypes.isProxy(context)) {
    throw readContextError();
  }
  const binding = readOwnValue(context, 'binding', readContextError);
  const scope = readOwnValue(context, 'scope', readContextError);
  const budget = readOwnValue(context, 'budget', readContextError);
  const abortSignal = readOwnValue(context, 'abortSignal', readContextError);
  const authorization = readOwnValue(context, 'authorization', readContextError);
  if (
    typeof authorization !== 'object' || authorization === null || Array.isArray(authorization)
    || nodeTypes.isProxy(authorization)
  ) {
    throw readContextError();
  }
  if (budget === undefined) throw readContextError();
  let ownedBinding: McpAuthorizationBinding;
  try {
    ownedBinding = snapshotMcpAuthorizationBinding(binding);
  } catch {
    throw readContextError();
  }
  let ownedBudget: Required<McpResourceReadBudget>;
  try {
    ownedBudget = resolveMcpResourceReadBudget(budget as McpResourceReadBudget);
  } catch {
    throw readContextError();
  }
  let ownedScope: readonly string[];
  try {
    ownedScope = snapshotReadScope(scope, ownedBudget);
  } catch {
    throw readContextError();
  }
  const ownedAbortSignal = requireAbortSignal(abortSignal);
  let ownedAuthorization: Readonly<Record<string, unknown>>;
  try {
    ownedAuthorization = snapshotMcpData(authorization, ownedBudget) as Readonly<Record<string, unknown>>;
  } catch {
    throw readContextError();
  }
  return Object.freeze({
    binding: ownedBinding,
    scope: ownedScope,
    budget: ownedBudget,
    abortSignal: ownedAbortSignal,
    authorization: ownedAuthorization,
  });
}

/** Fail-closed error when a per-request trusted read context is malformed. */
export class McpReadRequestContextError extends TypeError {
  readonly code = 'invalid_read_request_context' as const;

  constructor() {
    super('MCP Read request context is invalid.');
    this.name = 'McpReadRequestContextError';
  }
}

/** Dedicated abort error; a request that was cancelled never yields a result. */
export class McpReadRequestAbortedError extends Error {
  readonly code = 'request_aborted' as const;

  constructor() {
    super('MCP Read request was aborted.');
    this.name = 'McpReadRequestAbortedError';
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

/** Fail-closed signal that a projected Resource does not exist (never leaks details). */
export class McpResourceNotFoundError extends Error {
  readonly code = 'resource_not_found' as const;

  constructor() {
    super('MCP Resource was not found.');
    this.name = 'McpResourceNotFoundError';
  }
}

/**
 * Host-supplied, protocol-neutral Resource projection port. The port
 * authorizes and projects; the core validates, canonicalizes URIs, enforces
 * budgets, hides application exceptions and never retains caller context.
 */
export interface McpResourceProjectionPort {
  readonly listResources: (
    input: Readonly<McpResourceListInput>,
    context: McpTrustedReadRequestContext,
  ) => unknown | PromiseLike<unknown>;
  readonly readResource: (
    input: Readonly<{ resource: McpReadResource }>,
    context: McpTrustedReadRequestContext,
  ) => unknown | PromiseLike<unknown>;
}

export interface McpStatelessReadCoreOptions {
  readonly projection: McpResourceProjectionPort;
  /** Protocol-neutral URI codec bound to this server's stable authority. */
  readonly uriCodec: McpResourceUriCodec;
  /** Optional own-data clock port (reserved for cache metadata). */
  readonly clock?: McpReadClockPort;
}

export interface McpStatelessReadCore {
  readonly listResources: (
    context: McpTrustedReadRequestContext,
    input: unknown,
  ) => Promise<McpResourceListResult>;
  readonly readResource: (
    context: McpTrustedReadRequestContext,
    input: unknown,
  ) => Promise<McpResourceReadResult>;
}

/**
 * Creates the reusable stateless Read application core. One frozen instance
 * safely serves concurrent per-request contexts; request-scoped state exists
 * only in call arguments and return values.
 */
export function createMcpStatelessReadCore(
  options: McpStatelessReadCoreOptions,
): McpStatelessReadCore {
  if (arguments.length !== 1) throw configError();
  if (typeof options !== 'object' || options === null || nodeTypes.isProxy(options)) throw configError();
  const projection = readProjectionPort(options);
  const uriCodec = readUriCodec(options);
  assertOptionalClock(options);

  const listResources = async (...args: [context: unknown, input: unknown]): Promise<McpResourceListResult> => {
    try {
      assertArgumentCount(args.length, 2);
      const context = requireTrustedReadRequestContext(args[0]);
      assertNotAborted(context.abortSignal);
      const budget = resolveMcpResourceReadBudget(context.budget);
      const cursor = readOptionalCursor(args[1], budget);
      const request = Object.freeze(cursor === undefined ? {} : { cursor });
      const raw = await Reflect.apply(projection.listResources, projection.receiver, [request, context]);
      assertNotAborted(context.abortSignal);
      return validateListResult(raw, uriCodec.parse, budget);
    } catch (error) {
      throw classifyReadError(error);
    }
  };

  const readResource = async (...args: [context: unknown, input: unknown]): Promise<McpResourceReadResult> => {
    let uri: string;
    try {
      assertArgumentCount(args.length, 2);
      const context = requireTrustedReadRequestContext(args[0]);
      assertNotAborted(context.abortSignal);
      const budget = resolveMcpResourceReadBudget(context.budget);
      uri = readUriInput(args[1]);
      if (uri.length > MCP_RESOURCE_URI_MAX_BYTES || Buffer.byteLength(uri, 'utf8') > MCP_RESOURCE_URI_MAX_BYTES) {
        throw resourceError();
      }
      const resource = parseCanonical(uri, uriCodec);
      const raw = await Reflect.apply(projection.readResource, projection.receiver, [
        Object.freeze({ resource }),
        context,
      ]);
      assertNotAborted(context.abortSignal);
      return validateReadResult(raw, uri, budget);
    } catch (error) {
      throw classifyReadError(error);
    }
  };

  return Object.freeze({ listResources, readResource });
}

function classifyReadError(error: unknown): never {
  if (
    error instanceof McpReadRequestContextError
    || error instanceof McpReadRequestAbortedError
    || error instanceof McpResourceNotFoundError
  ) {
    throw error;
  }
  throw resourceError();
}

function readProjectionPort(options: McpStatelessReadCoreOptions): {
  readonly receiver: object;
  readonly listResources: McpResourceProjectionPort['listResources'];
  readonly readResource: McpResourceProjectionPort['readResource'];
} {
  const candidate = readOwnValue(options, 'projection', configError);
  const names = ['listResources', 'readResource'] as const;
  assertExactDataObject(candidate, names, [], configError);
  const methods = names.map((name) => readOwnData(candidate as object, name, configError));
  if (methods.some((method) => typeof method !== 'function')) throw configError();
  return Object.freeze({
    receiver: candidate as object,
    listResources: methods[0] as McpResourceProjectionPort['listResources'],
    readResource: methods[1] as McpResourceProjectionPort['readResource'],
  });
}

function readUriCodec(options: McpStatelessReadCoreOptions): McpResourceUriCodec {
  const candidate = readOwnValue(options, 'uriCodec', configError);
  const names = ['serverUuid', 'collectionMetadata', 'collectionSnapshot', 'collectionNode', 'parse'] as const;
  assertExactDataObject(candidate, names, [], configError);
  const serverUuid = readOwnData(candidate as object, 'serverUuid', configError);
  if (typeof serverUuid !== 'string' || serverUuid.length === 0) throw configError();
  for (const name of ['collectionMetadata', 'collectionSnapshot', 'collectionNode', 'parse'] as const) {
    const method = readOwnData(candidate as object, name, configError);
    if (typeof method !== 'function') throw configError();
  }
  return candidate as McpResourceUriCodec;
}

function assertOptionalClock(options: McpStatelessReadCoreOptions): void {
  if (!Object.hasOwn(options, 'clock')) return;
  const clock = readOwnValue(options, 'clock', configError);
  if (clock === undefined) return;
  assertExactDataObject(clock, ['now'], [], configError);
  const now = readOwnData(clock as object, 'now', configError);
  if (typeof now !== 'function') throw configError();
}

function readOptionalCursor(input: unknown, budget: Required<McpResourceReadBudget>): string | undefined {
  assertExactDataObject(input, [], ['cursor']);
  const cursor = readOptionalData(input, 'cursor');
  if (cursor === undefined) return undefined;
  if (typeof cursor !== 'string' || cursor.length === 0) throw resourceError();
  if (Buffer.byteLength(cursor, 'utf8') > budget.maxCursorLength) throw resourceError();
  return cursor;
}

function validateListResult(
  value: unknown,
  parse: (uri: string) => McpReadResource,
  budget: Required<McpResourceReadBudget>,
): McpResourceListResult {
  assertExactDataObject(value, ['resources'], ['nextCursor']);
  // Charge the complete projection before cloning any per-item metadata. A
  // per-item snapshot with the full budget would otherwise let a page of many
  // individually-valid metadata objects exceed the aggregate request budget.
  chargeAggregateResourceBytes(value, budget);
  const rawResources = readOwnData(value, 'resources');
  assertStrictArray(rawResources);
  if (rawResources.length > budget.maxListItems) throw resourceError();
  const resources = rawResources.map((candidate) => {
    assertExactDataObject(candidate, ['uri', 'name', 'mimeType', 'provenance'], ['description', '_meta']);
    const uri = readNonEmptyString(candidate, 'uri');
    parse(uri);
    const provenance = readProvenance(readOwnData(candidate, 'provenance'));
    const description = readOptionalData(candidate, 'description');
    if (description !== undefined && (typeof description !== 'string' || description.length === 0)) {
      throw resourceError();
    }
    const meta = readOptionalData(candidate, '_meta');
    let ownedMeta: Readonly<Record<string, unknown>> | undefined;
    if (meta !== undefined) {
      if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) throw resourceError();
      try {
        ownedMeta = Object.freeze(snapshotMcpData(meta, budget) as Readonly<Record<string, unknown>>);
      } catch {
        throw resourceError();
      }
    }
    return Object.freeze({
      uri,
      name: readNonEmptyString(candidate, 'name'),
      mimeType: readNonEmptyString(candidate, 'mimeType'),
      provenance,
      ...(description === undefined ? {} : { description }),
      ...(ownedMeta === undefined ? {} : { _meta: ownedMeta }),
    });
  });
  Object.freeze(resources);
  const nextCursor = readOptionalData(value, 'nextCursor');
  if (nextCursor !== undefined) {
    if (typeof nextCursor !== 'string' || nextCursor.length === 0) throw resourceError();
    if (Buffer.byteLength(nextCursor, 'utf8') > budget.maxCursorLength) throw resourceError();
  }
  return Object.freeze(nextCursor === undefined ? { resources } : { resources, nextCursor });
}

function validateReadResult(
  value: unknown,
  uri: string,
  budget: Required<McpResourceReadBudget>,
): McpResourceReadResult {
  assertExactDataObject(value, ['contents']);
  chargeAggregateResourceBytes(value, budget);
  const rawContents = readOwnData(value, 'contents');
  assertStrictArray(rawContents);
  if (rawContents.length > budget.maxReadContents) throw resourceError();
  const contents = rawContents.map((candidate) => {
    assertExactDataObject(candidate, ['mimeType', 'text', 'provenance']);
    const text = readOwnData(candidate, 'text');
    if (typeof text !== 'string') throw resourceError();
    if (Buffer.byteLength(text, 'utf8') > budget.maxTextBytes) throw resourceError();
    const provenance = readProvenance(readOwnData(candidate, 'provenance'));
    return Object.freeze({
      uri,
      mimeType: readNonEmptyString(candidate, 'mimeType'),
      text,
      provenance,
    });
  });
  return Object.freeze({ contents: Object.freeze(contents) });
}

interface AggregateResourceBudgetState {
  readonly ancestors: WeakSet<object>;
  nodes: number;
  bytes: number;
}

/** Bounded preflight walk used only to account the whole Resource result. */
function chargeAggregateResourceBytes(
  value: unknown,
  budget: Required<McpResourceReadBudget>,
): void {
  const state: AggregateResourceBudgetState = { ancestors: new WeakSet<object>(), nodes: 0, bytes: 0 };
  walkAggregateResourceValue(value, state, budget, 0);
}

function walkAggregateResourceValue(
  value: unknown,
  state: AggregateResourceBudgetState,
  budget: Required<McpResourceReadBudget>,
  depth: number,
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
        walkAggregateResourceValue(descriptor.value, state, budget, depth + 1);
      }
    } finally {
      state.ancestors.delete(value);
    }
  } else {
    throw resourceError();
  }
  if (state.bytes > budget.maxBytes) throw resourceError();
}

function readProvenance(value: unknown): McpResourceProvenance {
  if (typeof value !== 'object' || value === null) throw resourceError();
  const origin = readOptionalData(value, 'origin');
  if (origin === 'internal') {
    assertExactDataObject(value, ['origin']);
    return Object.freeze({ origin });
  }
  if (origin === 'external') {
    assertExactDataObject(value, ['origin', 'sourceUri']);
    return Object.freeze({ origin, sourceUri: readNonEmptyString(value, 'sourceUri') });
  }
  throw resourceError();
}

function readUriInput(value: unknown): string {
  assertExactDataObject(value, ['uri']);
  return readNonEmptyString(value, 'uri');
}

function parseCanonical(
  uri: string,
  codec: McpResourceUriCodec,
): McpReadResource {
  const resource = codec.parse(uri);
  const canonical = resource.kind === 'collection-metadata'
    ? codec.collectionMetadata(resource.collectionId)
    : resource.kind === 'collection-snapshot'
      ? codec.collectionSnapshot(resource.collectionId)
      : codec.collectionNode(resource.collectionId, resource.nodeId);
  if (canonical !== uri) throw resourceError();
  return resource;
}

function snapshotReadScope(scope: unknown, budget: Required<McpResourceReadBudget>): readonly string[] {
  const snapshot = snapshotMcpData(scope, budget);
  if (!Array.isArray(snapshot) || snapshot.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    throw readContextError();
  }
  return snapshot;
}

function requireAbortSignal(signal: unknown): AbortSignal {
  if (typeof signal !== 'object' || signal === null || Array.isArray(signal) || nodeTypes.isProxy(signal)) {
    throw readContextError();
  }
  let aborted: unknown;
  let addEventListener: unknown;
  try {
    aborted = (signal as { readonly aborted: unknown }).aborted;
    addEventListener = (signal as { readonly addEventListener?: unknown }).addEventListener;
  } catch {
    throw readContextError();
  }
  if (typeof aborted !== 'boolean' || typeof addEventListener !== 'function') {
    throw readContextError();
  }
  return signal as AbortSignal;
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new McpReadRequestAbortedError();
  }
}

function readReadLimit(
  budget: McpResourceReadBudget | undefined,
  name: 'maxListItems' | 'maxReadContents' | 'maxTextBytes' | 'maxCursorLength',
  fallback: number,
): number {
  if (budget === undefined) return fallback;
  const descriptor = Object.getOwnPropertyDescriptor(budget, name);
  if (descriptor === undefined) return fallback;
  if (!('value' in descriptor) || descriptor.value === undefined) return fallback;
  return descriptor.value as number;
}

function assertExactDataObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
  fail: () => Error = resourceError,
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

function assertStrictArray(value: unknown): asserts value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw resourceError();
  const keys = Reflect.ownKeys(value);
  const expected = new Set<string | symbol>(['length']);
  for (let index = 0; index < value.length; index += 1) expected.add(String(index));
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) throw resourceError();
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor)) throw resourceError();
  }
}

function readOwnValue(value: object, name: string, fail: () => Error = resourceError): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor)) throw fail();
  return descriptor.value;
}

function readOwnData(value: object, name: string, fail: () => Error = resourceError): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor === undefined || !('value' in descriptor)) throw fail();
  return descriptor.value;
}

function readOptionalData(value: unknown, name: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor === undefined || !('value' in descriptor)) return undefined;
  return descriptor.value;
}

function readNonEmptyString(value: object, name: string): string {
  const candidate = readOwnData(value, name);
  if (typeof candidate !== 'string' || candidate.length === 0) throw resourceError();
  return candidate;
}

function assertArgumentCount(actual: number, expected: number): void {
  if (actual !== expected) throw resourceError();
}

function configError(): TypeError {
  return new TypeError('Invalid stateless MCP Read core configuration.');
}

function readContextError(): McpReadRequestContextError {
  return new McpReadRequestContextError();
}

function resourceError(): McpResourceRequestError {
  return new McpResourceRequestError();
}
