/**
 * Modern MCP `2026-07-28` Resource adapters.
 *
 * Thin adapter layer over the protocol-neutral stateless Read core
 * (`src/mcp/shared/resources.ts`): each method re-validates the Modern
 * per-request context, maps wire params to the shared core's protocol-neutral
 * input, maps the validated core projection back to a Modern result
 * (`complete` + `io.modelcontextprotocol/serverInfo` + accurate cache
 * metadata on the three cacheable resource methods), snapshots the emitted
 * fields against the per-request output budget and validates them against the
 * pinned SDK result schemas before the result is frozen by
 * `createMcp20260728Result`.
 *
 * One frozen adapter instance serves concurrent per-request contexts; no
 * hidden per-client instance and no retained request state. Aborts surface as
 * `McpReadRequestAbortedError`; unknown Resources surface as a stable
 * `invalid_params` (-32602) not-found error consistent with
 * `normalizeMcp20260728Error`.
 */
import { types as nodeTypes } from 'node:util';

import type { McpResourceTemplate } from '../resource-templates.js';
import { snapshotMcpData } from '../safe-data.js';
import {
  McpReadRequestAbortedError,
  McpResourceNotFoundError,
  type McpResourceListResult,
  type McpResourceReadResult,
  type McpStatelessReadCore,
} from '../shared/resources.js';
import {
  ImplementationSchema,
  ListResourceTemplatesResultSchema,
  ListResourcesResultSchema,
  ReadResourceResultSchema,
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

/** Cacheable Resource methods this adapter can stamp with cache metadata. */
export type Mcp20260728CacheableResourceMethod =
  | 'resources/list'
  | 'resources/templates/list'
  | 'resources/read';

export interface Mcp20260728ResourceAdapterOptions {
  /** Shared stateless Read core (listResources / readResource). */
  readonly readCore: McpStatelessReadCore;
  readonly serverInfo: Mcp20260728ServerInfo;
  /** Protocol-neutral Resource templates projected by `resources/templates/list`. */
  readonly templates?: readonly McpResourceTemplate[];
  /** Accurate cache metadata for cacheable Resource methods (defaults 0/private). */
  readonly cache?: Readonly<Partial<Record<Mcp20260728CacheableResourceMethod, Mcp20260728CacheMetadata>>>;
}

export interface Mcp20260728ResourceAdapter {
  readonly listResources: (
    context: Mcp20260728RequestContext,
    input?: unknown,
  ) => Promise<Mcp20260728Result>;
  readonly readResource: (
    context: Mcp20260728RequestContext,
    input?: unknown,
  ) => Promise<Mcp20260728Result>;
  readonly listResourceTemplates: (
    context: Mcp20260728RequestContext,
    input?: unknown,
  ) => Promise<Mcp20260728Result>;
}

const RESOURCE_CACHE_METHODS: readonly Mcp20260728CacheableResourceMethod[] = Object.freeze([
  'resources/list',
  'resources/templates/list',
  'resources/read',
]);

interface McpSchemaValidator {
  readonly safeParse: (value: unknown) => { readonly success: boolean };
}

const RESOURCE_RESULT_SCHEMAS: Readonly<Record<Mcp20260728CacheableResourceMethod, McpSchemaValidator>> =
  Object.freeze({
    'resources/list': ListResourcesResultSchema,
    'resources/templates/list': ListResourceTemplatesResultSchema,
    'resources/read': ReadResourceResultSchema,
  });

/**
 * Creates the reusable Modern Resource adapter. Validates host options
 * (fail-closed `TypeError` on malformed own-data configuration) and returns
 * one frozen instance that safely serves concurrent requests.
 */
export function createMcp20260728ResourceAdapter(
  options: Mcp20260728ResourceAdapterOptions,
): Mcp20260728ResourceAdapter {
  if (arguments.length !== 1) throw configError();
  if (typeof options !== 'object' || options === null || nodeTypes.isProxy(options)) throw configError();
  const readCore = readReadCore(options);
  const serverInfo = readServerInfo(options);
  const templates = readTemplates(options);
  const cache = readCache(options);

  const listResources = async (
    context: Mcp20260728RequestContext,
    input?: unknown,
  ): Promise<Mcp20260728Result> => {
    const ctx = requireMcp20260728RequestContext(context);
    const request = readCursorRequest(input);
    let coreResult: McpResourceListResult;
    try {
      coreResult = await readCore.listResources(ctx, request);
    } catch (error) {
      if (error instanceof McpReadRequestAbortedError) throw error;
      throw error;
    }
    const resources = coreResult.resources.map((entry) => ({
      uri: entry.uri,
      name: entry.name,
      mimeType: entry.mimeType,
      ...(entry.description === undefined ? {} : { description: entry.description }),
      ...(entry._meta === undefined ? {} : { _meta: entry._meta }),
    }));
    return buildResourceResult('resources/list', serverInfo, ctx, {
      resources,
      ...(coreResult.nextCursor !== undefined ? { nextCursor: coreResult.nextCursor } : {}),
    }, cache['resources/list']);
  };

  const readResource = async (
    context: Mcp20260728RequestContext,
    input?: unknown,
  ): Promise<Mcp20260728Result> => {
    const ctx = requireMcp20260728RequestContext(context);
    const request = readUriRequest(input);
    let coreResult: McpResourceReadResult;
    try {
      coreResult = await readCore.readResource(ctx, request);
    } catch (error) {
      if (error instanceof McpResourceNotFoundError) {
        throw new Mcp20260728RequestError('invalid_params', 'Resource not found.', { uri: request.uri });
      }
      if (error instanceof McpReadRequestAbortedError) throw error;
      throw error;
    }
    const contents = coreResult.contents.map((entry) => ({
      uri: entry.uri,
      mimeType: entry.mimeType,
      text: entry.text,
    }));
    return buildResourceResult('resources/read', serverInfo, ctx, { contents }, cache['resources/read']);
  };

  const listResourceTemplates = async (
    context: Mcp20260728RequestContext,
    input?: unknown,
  ): Promise<Mcp20260728Result> => {
    const ctx = requireMcp20260728RequestContext(context);
    // Static host templates: cursor is accepted for wire-shape parity and
    // ignored (the full template set is always returned, never paginated).
    readCursorRequest(input);
    const resourceTemplates = templates.map((entry) => ({
      uriTemplate: entry.uriTemplate,
      name: entry.name,
      title: entry.title,
      mimeType: entry.mimeType,
    }));
    return buildResourceResult(
      'resources/templates/list',
      serverInfo,
      ctx,
      { resourceTemplates },
      cache['resources/templates/list'],
    );
  };

  return Object.freeze({ listResources, readResource, listResourceTemplates });
}

function buildResourceResult(
  method: Mcp20260728CacheableResourceMethod,
  serverInfo: Mcp20260728ServerInfo,
  context: Mcp20260728RequestContext,
  fields: Readonly<Record<string, unknown>>,
  cache: Mcp20260728CacheMetadata | undefined,
): Mcp20260728Result {
  const snapshot = snapshotMcpData(fields, context.budget) as Readonly<Record<string, unknown>>;
  if (!RESOURCE_RESULT_SCHEMAS[method].safeParse(snapshot).success) {
    throw new TypeError('MCP Resource adapter produced an invalid Modern result.');
  }
    return createMcp20260728Result({
    method,
    serverInfo,
    fields: snapshot,
    ...(cache !== undefined ? { cache } : {}),
  });
}

function readReadCore(options: Mcp20260728ResourceAdapterOptions): McpStatelessReadCore {
  const candidate = readOwnValue(options, 'readCore', configError);
  assertExactDataObject(candidate, ['listResources', 'readResource'], [], configError);
  for (const name of ['listResources', 'readResource'] as const) {
    if (typeof readOwnData(candidate, name, configError) !== 'function') throw configError();
  }
  return candidate as McpStatelessReadCore;
}

function readServerInfo(options: Mcp20260728ResourceAdapterOptions): Mcp20260728ServerInfo {
  const raw = readOwnValue(options, 'serverInfo', configError);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || nodeTypes.isProxy(raw)) {
    throw configError();
  }
  const parsed = ImplementationSchema.safeParse(raw);
  if (!parsed.success) throw configError();
  return Object.freeze(snapshotMcpData(parsed.data) as Mcp20260728ServerInfo);
}

function readTemplates(options: Mcp20260728ResourceAdapterOptions): readonly McpResourceTemplate[] {
  const raw = readOwnValue(options, 'templates');
  if (raw === undefined) return Object.freeze([]);
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype) throw configError();
  const snapshot = snapshotMcpData(raw) as readonly McpResourceTemplate[];
  for (const entry of snapshot) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw configError();
    for (const key of ['uriTemplate', 'name', 'title', 'mimeType'] as const) {
      const value = readOwnValue(entry, key, configError);
      if (typeof value !== 'string' || value.length === 0) throw configError();
    }
  }
  return Object.freeze([...snapshot]);
}

function readCache(
  options: Mcp20260728ResourceAdapterOptions,
): Readonly<Partial<Record<Mcp20260728CacheableResourceMethod, Mcp20260728CacheMetadata>>> {
  const raw = readOwnValue(options, 'cache');
  if (raw === undefined) return Object.freeze({});
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || nodeTypes.isProxy(raw)) {
    throw configError();
  }
  const keys = Reflect.ownKeys(raw);
  if (keys.some((key) => typeof key !== 'string' || !RESOURCE_CACHE_METHODS.includes(key as Mcp20260728CacheableResourceMethod))) {
    throw configError();
  }
  const result: Partial<Record<Mcp20260728CacheableResourceMethod, Mcp20260728CacheMetadata>> = {};
  for (const method of RESOURCE_CACHE_METHODS) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, method);
    if (descriptor === undefined || !('value' in descriptor) || descriptor.value === undefined) continue;
    result[method] = validateCacheMetadata(descriptor.value);
  }
  return Object.freeze(result);
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

function readCursorRequest(value: unknown): Readonly<{ cursor?: string }> {
  if (value === undefined) return Object.freeze({});
  assertExactDataObject(value, [], ['cursor'], () => invalidParams('resource list cursor'));
  const cursor = readOptionalData(value, 'cursor');
  if (cursor === undefined) return Object.freeze({});
  if (typeof cursor !== 'string' || cursor.length === 0) {
    throw invalidParams('resource list cursor');
  }
  return Object.freeze({ cursor });
}

function readUriRequest(value: unknown): Readonly<{ uri: string }> {
  assertExactDataObject(value, ['uri'], [], () => invalidParams('resource read uri'));
  const uri = readOwnData(value, 'uri', () => invalidParams('resource read uri'));
  if (typeof uri !== 'string' || uri.length === 0) throw invalidParams('resource read uri');
  return Object.freeze({ uri });
}

function invalidParams(message: string): Mcp20260728RequestError {
  return new Mcp20260728RequestError('invalid_params', `Invalid ${message}.`);
}

function configError(): TypeError {
  return new TypeError('Invalid Modern MCP Resource adapter configuration.');
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
