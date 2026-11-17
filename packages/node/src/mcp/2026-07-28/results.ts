/**
 * Modern MCP `2026-07-28` result / error / cache mapping.
 *
 * Every Modern result MUST carry a `resultType` discriminator and, for
 * cacheable operations, the `ttlMs` / `cacheScope` cache metadata
 * (migration decision §3). This module builds such results from
 * protocol-neutral host projections, validates and stamps them, and returns a
 * deeply frozen snapshot so mutation after the adapter call cannot leak.
 *
 * Error mapping: `normalizeMcp20260728Error` collapses any thrown value into
 * the stable wire codes `-32020` (`HeaderMismatch`) / `-32021`
 * (`MissingRequiredClientCapability`) / `-32022` (`UnsupportedProtocolVersion`)
 * when it is a known adapter error, and otherwise returns a low-sensitivity
 * `-32603` (Internal Error) — no caller-controlled SDK message/data leaks.
 *
 * Vocabulary alignment (SDK pinned 2.3.1):
 * - `resultType` is `'complete' | 'input_required'`; `input_required` is only
 *   legal on `tools/call`, `prompts/get` and `resources/read`
 *   (`EXTENDED_RESULT_TYPE_METHODS`).
 * - Cacheable operations: `tools/list`, `prompts/list`, `resources/list`,
 *   `resources/templates/list`, `resources/read`, `server/discover`
 *   (`CACHEABLE_RESULT_METHODS`); defaults are `ttlMs: 0`,
 *   `cacheScope: 'private'` (`DEFAULT_CACHE_TTL_MS` / `DEFAULT_CACHE_SCOPE`).
 * - `_meta` carries `io.modelcontextprotocol/serverInfo` (spec PR #3002).
 */
import { snapshotMcpData, type McpWriteInputBudget } from '../safe-data.js';
import type { Mcp20260728ClientInfo } from './request-context.js';
import {
  MCP_WIRE_INTERNAL_ERROR_CODE,
  Mcp20260728RequestError,
  MCP_WIRE_HEADER_MISMATCH_ERROR_CODE,
  MCP_WIRE_MISSING_REQUIRED_CLIENT_CAPABILITY_ERROR_CODE,
  MCP_WIRE_UNSUPPORTED_PROTOCOL_VERSION_ERROR_CODE,
} from './request-context.js';
import {
  ImplementationSchema,
  ResultMetaObjectSchema,
  SERVER_INFO_META_KEY,
} from '../../shared/mcp-sdk-boundary.js';

/** Server implementation info stamped into result `_meta`. */
export type Mcp20260728ServerInfo = Mcp20260728ClientInfo;

/** The `2026-07-28` result discriminator. */
export type Mcp20260728ResultType = 'complete' | 'input_required';

/** `2026-07-28` cache scope vocabulary. */
export type Mcp20260728CacheScope = 'public' | 'private';

/** Validated cache metadata for cacheable read/list results. */
export interface Mcp20260728CacheMetadata {
  readonly ttlMs: number;
  readonly cacheScope: Mcp20260728CacheScope;
  /**
   * Trusted per-result assertion that the cached payload is caller-independent
   * and was produced for an anonymous caller. It is only meaningful with
   * `cacheScope: 'public'` and is never emitted on the wire.
   *
   * Scope-aware hosts (for example a public Resource projection or an adapter
   * that has just checked `binding.kind === 'anonymous'`) may set it.
   * Scope-blind static adapter `cache` options must not carry it: the adapters
   * reject that configuration and only add the mark after verifying the
   * per-request binding.
   *
   * A host whose observed cache projection must stay exactly
   * `{ ttlMs, cacheScope }` may attach this as a non-enumerable own data
   * property; the factory reads own data descriptors regardless of
   * enumerability and never copies the assertion to the result.
   */
  readonly callerScope?: 'anonymous';
}

/** Methods whose results may be `input_required` (multi round-trip requests). */
export const MCP_20260728_EXTENDED_RESULT_TYPE_METHODS: readonly string[] = Object.freeze([
  'tools/call',
  'prompts/get',
  'resources/read',
]);

/** Closed set of cacheable `2026-07-28` operations (SDK `CACHEABLE_RESULT_METHODS`). */
export const MCP_20260728_CACHEABLE_RESULT_METHODS: readonly string[] = Object.freeze([
  'tools/list',
  'prompts/list',
  'resources/list',
  'resources/templates/list',
  'resources/read',
  'server/discover',
]);

/**
 * Cacheable methods whose result can differ by caller scope/principal.
 * `tools/list` is scope-filtered; `resources/list` and `resources/read` are
 * visibility/authorization-dependent; `prompts/list` may be filtered by the
 * same permissions.
 *
 * The result factory cannot infer caller scope from the declaration alone, so
 * `public` + TTL on these methods is accepted only with the explicit
 * `callerScope: 'anonymous'` assertion. Scope-blind paths enforce that
 * assertion: adapter `cache` options reject an explicit assertion, while the
 * adapters add it only after verifying the per-request binding (and fail closed
 * for authenticated callers); the host transport does the same (see
 * `2026-07-28/resources.ts`, `2026-07-28/tools.ts` and the server's
 * `assertCacheAuthority`). Marking a scope-dependent result `public` with a
 * non-zero TTL without such a check lets a shared intermediary replay one
 * principal's result to another.
 */
export const MCP_20260728_PRINCIPAL_SCOPED_CACHE_METHODS: readonly string[] = Object.freeze([
  'tools/list',
  'prompts/list',
  'resources/list',
  'resources/read',
]);

const DEFAULT_CACHE_TTL_MS = 0;
const DEFAULT_CACHE_SCOPE: Mcp20260728CacheScope = 'private';

/** Host projection input for building one Modern result. */
export interface Mcp20260728ResultInput {
  readonly method: string;
  readonly resultType?: Mcp20260728ResultType;
  readonly cache?: Mcp20260728CacheMetadata;
  readonly serverInfo?: Mcp20260728ServerInfo;
  /** Protocol-neutral result fields (contents, resources, structuredContent, ...). */
  readonly fields?: Readonly<Record<string, unknown>>;
  /** Trusted host limit for a generated result; never derived from client input. */
  readonly fieldsBudget?: McpWriteInputBudget;
}

/** Frozen Modern result with required `resultType` and cache metadata. */
export interface Mcp20260728Result {
  readonly resultType: Mcp20260728ResultType;
  readonly ttlMs?: number;
  readonly cacheScope?: Mcp20260728CacheScope;
  readonly _meta?: Readonly<{ [SERVER_INFO_META_KEY]: Mcp20260728ServerInfo }>;
  readonly [field: string]: unknown;
}

/**
 * Builds a frozen Modern result. Defaults: `resultType: 'complete'`; for
 * cacheable `complete` results, `ttlMs: 0` + `cacheScope: 'private'` unless
 * the host provides valid metadata. `input_required` is confined to the
 * extended result-type methods; non-cacheable methods never carry cache
 * fields (mirrors the SDK encode contract). Scope-filtered cacheable results
 * (see {@link MCP_20260728_PRINCIPAL_SCOPED_CACHE_METHODS}) reject a `public`
 * cache scope with a non-zero TTL unless the host explicitly marks the payload
 * as caller-independent for an anonymous caller
 * (`cache.callerScope: 'anonymous'`). Hosts that compute cache metadata per
 * request from a verified binding (the server Resource projections and the
 * scope-aware adapters) set that mark only after establishing the caller is
 * anonymous; scope-blind adapter `cache` options can never set it. Malformed
 * host input throws `TypeError` (host bug).
 */
export function createMcp20260728Result(input: Mcp20260728ResultInput): Mcp20260728Result {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError('MCP result input must be an own-data object.');
  }
  const method = readOwnValue(input, 'method');
  if (typeof method !== 'string' || method.length === 0) {
    throw new TypeError('MCP result requires a method.');
  }
  const resultTypeRaw = readOwnValue(input, 'resultType');
  let resultType: Mcp20260728ResultType = resultTypeRaw === undefined ? 'complete' : resultTypeRaw as Mcp20260728ResultType;
  if (resultType !== 'complete' && resultType !== 'input_required') {
    throw new TypeError(`Invalid resultType: ${String(resultTypeRaw)}`);
  }
  if (resultType === 'input_required' && !MCP_20260728_EXTENDED_RESULT_TYPE_METHODS.includes(method)) {
    throw new TypeError(
      `Handler for ${method} returned resultType 'input_required', but results of ${method} only support 'complete' on protocol revision 2026-07-28`,
    );
  }

  const cacheRaw = readOwnValue(input, 'cache');
  let cache: Mcp20260728CacheMetadata | undefined;
  if (cacheRaw !== undefined) {
    cache = validateCacheMetadata(cacheRaw);
  }
  const isCacheable = resultType === 'complete' && MCP_20260728_CACHEABLE_RESULT_METHODS.includes(method);
  if (isCacheable && cache?.callerScope === 'anonymous' && cache.cacheScope !== 'public') {
    throw new TypeError(
      `MCP ${method} result cache callerScope 'anonymous' requires cacheScope 'public'.`,
    );
  }
  if (
    isCacheable
    && cache?.cacheScope === 'public'
    && cache.ttlMs > 0
    && MCP_20260728_PRINCIPAL_SCOPED_CACHE_METHODS.includes(method)
    && cache.callerScope !== 'anonymous'
  ) {
    throw new TypeError(
      `MCP ${method} result depends on the caller's scope; cacheScope 'public' with a TTL requires the explicit callerScope 'anonymous' assertion.`,
    );
  }
  const ttlMs = isCacheable ? (cache?.ttlMs ?? DEFAULT_CACHE_TTL_MS) : undefined;
  const cacheScope = isCacheable ? (cache?.cacheScope ?? DEFAULT_CACHE_SCOPE) : undefined;

  const serverInfoRaw = readOwnValue(input, 'serverInfo');
  let meta: Mcp20260728Result['_meta'];
  if (serverInfoRaw !== undefined) {
    if (typeof serverInfoRaw !== 'object' || serverInfoRaw === null) {
      throw new TypeError('MCP result serverInfo must be an object.');
    }
    const serverInfoParsed = ImplementationSchema.safeParse(serverInfoRaw);
    if (!serverInfoParsed.success) {
      throw new TypeError('MCP result serverInfo is invalid.');
    }
    const metaCandidate = { [SERVER_INFO_META_KEY]: serverInfoParsed.data };
    const parsed = ResultMetaObjectSchema.safeParse(metaCandidate);
    if (!parsed.success) {
      throw new TypeError('MCP result _meta failed SDK schema validation.');
    }
    meta = Object.freeze({
      [SERVER_INFO_META_KEY]: Object.freeze(
        snapshotMcpData(parsed.data[SERVER_INFO_META_KEY]) as Mcp20260728ServerInfo,
      ),
    });
  }

  const fieldsRaw = readOwnValue(input, 'fields');
  const fields = fieldsRaw === undefined
    ? Object.freeze({})
    : snapshotFields(fieldsRaw, readOwnValue(input, 'fieldsBudget') as McpWriteInputBudget | undefined);

  const result = Object.freeze({
    resultType,
    ...(ttlMs !== undefined ? { ttlMs } : {}),
    ...(cacheScope !== undefined ? { cacheScope } : {}),
    ...(meta !== undefined ? { _meta: meta } : {}),
    ...fields,
  }) as Mcp20260728Result;
  return result;
}

function validateCacheMetadata(raw: unknown): Mcp20260728CacheMetadata {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new TypeError('MCP result cache must be an object.');
  }
  const record = raw as Readonly<Record<string, unknown>>;
  const ttlMs = readOwnValue(record, 'ttlMs');
  const cacheScope = readOwnValue(record, 'cacheScope');
  const callerScope = readOwnValue(record, 'callerScope');
  if (typeof ttlMs !== 'number' || !Number.isSafeInteger(ttlMs) || ttlMs < 0) {
    throw new TypeError('MCP result cache ttlMs must be a non-negative safe integer.');
  }
  if (cacheScope !== 'public' && cacheScope !== 'private') {
    throw new TypeError("MCP result cache cacheScope must be 'public' or 'private'.");
  }
  if (callerScope !== undefined && callerScope !== 'anonymous') {
    throw new TypeError("MCP result cache callerScope must be 'anonymous' when present.");
  }
  return Object.freeze({
    ttlMs,
    cacheScope,
    ...(callerScope === 'anonymous' ? { callerScope } : {}),
  });
}

/** Result keys the adapter owns and must never be smuggled through `fields`. */
const RESERVED_RESULT_FIELD_KEYS: ReadonlySet<string> = new Set([
  'resultType',
  'ttlMs',
  'cacheScope',
  '_meta',
]);

function snapshotFields(fields: unknown, budget?: McpWriteInputBudget): Readonly<Record<string, unknown>> {
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) {
    throw new TypeError('MCP result fields must be an object.');
  }
  for (const key of Object.keys(fields)) {
    if (RESERVED_RESULT_FIELD_KEYS.has(key)) {
      throw new TypeError(
        `MCP result fields must not carry the adapter-owned key '${key}'; use the resultType/cache/serverInfo inputs.`,
      );
    }
  }
  const snapshot = snapshotMcpData(fields, budget) as Readonly<Record<string, unknown>>;
  return snapshot;
}

function readOwnValue(value: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor === undefined || !('value' in descriptor)) return undefined;
  return descriptor.value;
}

/** Stable wire error shape hosts can emit as a JSON-RPC error response. */
export interface Mcp20260728WireError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

const KNOWN_WIRE_CODES: ReadonlySet<number> = new Set([
  MCP_WIRE_HEADER_MISMATCH_ERROR_CODE,
  MCP_WIRE_MISSING_REQUIRED_CLIENT_CAPABILITY_ERROR_CODE,
  MCP_WIRE_UNSUPPORTED_PROTOCOL_VERSION_ERROR_CODE,
  -32600,
  -32601,
  -32602,
  -32603,
]);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalizes any thrown value into a stable, low-sensitivity wire error.
 * Adapter errors keep their `-32020/-32021/-32022` codes and host-controlled
 * details. Upstream SDK-shaped errors are an untrusted boundary: when their
 * code is recognized, only a fixed protocol message is emitted and their
 * caller-controlled `message`/`data` are discarded. Everything else collapses
 * to `-32603` `Internal error` without leaking internal details.
 */
export function normalizeMcp20260728Error(error: unknown): Mcp20260728WireError {
  if (error instanceof Mcp20260728RequestError) {
    return {
      code: error.wireCode,
      message: error.message,
      ...(error.data !== undefined ? { data: error.data } : {}),
    };
  }
  if (isRecord(error)) {
    const code = error.code;
    if (typeof code === 'number' && KNOWN_WIRE_CODES.has(code)) {
      return {
        code,
        message: SAFE_WIRE_MESSAGES[code] ?? 'Internal error',
      };
    }
  }
  return Object.freeze({ code: MCP_WIRE_INTERNAL_ERROR_CODE, message: 'Internal error' });
}

/** Fixed messages used for untrusted SDK-shaped errors. */
const SAFE_WIRE_MESSAGES: Readonly<Record<number, string>> = Object.freeze({
  [MCP_WIRE_HEADER_MISMATCH_ERROR_CODE]: 'Request headers do not match.',
  [MCP_WIRE_MISSING_REQUIRED_CLIENT_CAPABILITY_ERROR_CODE]: 'A required client capability is missing.',
  [MCP_WIRE_UNSUPPORTED_PROTOCOL_VERSION_ERROR_CODE]: 'Unsupported protocol version.',
  [-32600]: 'Invalid request.',
  [-32601]: 'Method not found.',
  [-32602]: 'Invalid params.',
  [-32603]: 'Internal error',
});
