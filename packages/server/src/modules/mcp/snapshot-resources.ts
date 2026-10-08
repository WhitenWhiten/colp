import {
  McpReadRequestAbortedError,
  McpReadRequestContextError,
  McpResourceNotFoundError,
  resolveMcpResourceReadBudget,
  type Mcp20260728CacheMetadata,
  type McpReadResource,
  type McpResourceProvenance,
  type McpTrustedReadRequestContext,
} from '@know-n/colp/mcp';
import {
  PUBLICATION_SNAPSHOT_DEFAULT_LIMIT,
  PUBLICATION_SNAPSHOT_MAX_LIMIT,
  PublicationNotFoundError,
  PublicationSnapshotExpiredError,
  getPublicationSnapshotPage,
  type PublicationPrincipal,
  type PublicationSnapshotPageResult,
  type PublicationSnapshotQueryPorts,
} from '../publication/index.js';
import { requireMcpAccountSubjectId } from './account-context.js';
import type { McpReadFeatureConfig, McpReadFeatureConfigAssertOptions } from './config.js';
import { PHASE4B_MCP_PUBLIC_READ_CACHE_TTL_MS } from './read-cache.js';
import {
  createPhase4bMcpResourceIdentity,
  type Phase4bMcpResourceIdentity,
} from './resource-identity.js';

export const PHASE4B_MCP_SNAPSHOT_RESOURCE_MIME_TYPE =
  'application/vnd.collection-protocol.snapshot+json' as const;
export const PHASE4B_MCP_SNAPSHOT_DEFAULT_PAGE_SIZE = PUBLICATION_SNAPSHOT_DEFAULT_LIMIT;
export const PHASE4B_MCP_SNAPSHOT_MAX_PAGE_SIZE = PUBLICATION_SNAPSHOT_MAX_LIMIT;
export const PHASE4B_MCP_SNAPSHOT_SUMMARY_TYPE = 'collection_snapshot_summary' as const;
export const PHASE4B_MCP_SNAPSHOT_LINK_AUDIENCE = Object.freeze(['user', 'assistant'] as const);
export const PHASE4B_MCP_SNAPSHOT_LINK_PRIORITY = 0.8;
export const PHASE4B_MCP_SNAPSHOT_CACHE_TTL_MS = PHASE4B_MCP_PUBLIC_READ_CACHE_TTL_MS;

export interface Phase4bMcpSnapshotResourceProjectionOptions {
  readonly config: McpReadFeatureConfig;
  readonly snapshotQuery: PublicationSnapshotQueryPorts;
  readonly now?: () => Date;
  /** First-page Snapshot limit. Defaults to the Publication default (200). */
  readonly pageSize?: number;
  /** Same P4 re-assert options `loadConfig` used; omit for production-strict. */
  readonly assertOptions?: McpReadFeatureConfigAssertOptions;
}

export interface Phase4bMcpSnapshotResourcePageInput {
  readonly resource: McpReadResource;
  readonly pageCursor?: string;
}

export type Phase4bMcpSnapshotResourceContentProjection = Readonly<{
  readonly mimeType: string;
  readonly text: string;
  readonly provenance: McpResourceProvenance;
}>;

export type Phase4bMcpSnapshotResourceReadResult = Readonly<{
  readonly contents: readonly Phase4bMcpSnapshotResourceContentProjection[];
}>;

export interface Phase4bMcpSnapshotResourceProjection {
  /** Wire read for a `collection-snapshot` Resource URI. */
  readonly readResource: (
    input: Readonly<{ readonly resource: McpReadResource }>,
    context: McpTrustedReadRequestContext,
  ) => Promise<Phase4bMcpSnapshotResourceReadResult>;
  /**
   * Bounded continuation read used by the `collections.get_snapshot` Tool and
   * by the R09 mutation/expiry tests. The wire `resources/read` method remains
   * URI-only; the cursor stays an opaque Publication paging representation.
   */
  readonly readPage: (
    input: Phase4bMcpSnapshotResourcePageInput,
    context: McpTrustedReadRequestContext,
  ) => Promise<Phase4bMcpSnapshotResourceReadResult>;
  readonly cacheForRead: (
    input: Readonly<{ readonly resource: McpReadResource }>,
    context: McpTrustedReadRequestContext,
  ) => Promise<Mcp20260728CacheMetadata>;
}

interface ProjectionState {
  readonly config: McpReadFeatureConfig;
  readonly snapshotQuery: PublicationSnapshotQueryPorts;
  readonly now: () => Date;
  readonly pageSize: number;
  readonly identity: Phase4bMcpResourceIdentity;
}

/**
 * P4B-R09 Snapshot Resource projection. It delegates authority, revision
 * fencing, Schema/semantic validation and safe projection to the existing
 * Publication Snapshot query; it never creates an MCP read model, never emits
 * ownerSubjectId or raw policy, and never turns a partial Snapshot into a fake
 * complete representation.
 */
export function createPhase4bMcpSnapshotResourceProjection(
  options: Phase4bMcpSnapshotResourceProjectionOptions,
): Phase4bMcpSnapshotResourceProjection {
  if (!isRecord(options)) {
    throw new TypeError('MCP Snapshot Resource projection options are required.');
  }
  const config = readOwnData(options, 'config', projectionConfigError) as McpReadFeatureConfig;
  const snapshotQuery = readOwnData(
    options,
    'snapshotQuery',
    projectionConfigError,
  ) as PublicationSnapshotQueryPorts;
  const nowValue = readOptionalData(options, 'now');
  const now = nowValue === undefined ? () => new Date() : nowValue as () => Date;
  if (typeof now !== 'function') throw projectionConfigError();
  const pageSizeValue = readOptionalData(options, 'pageSize') as number | undefined;
  const pageSize = pageSizeValue === undefined
    ? PHASE4B_MCP_SNAPSHOT_DEFAULT_PAGE_SIZE
    : pageSizeValue;
  if (!Number.isSafeInteger(pageSize) || pageSize < 2 || pageSize > PHASE4B_MCP_SNAPSHOT_MAX_PAGE_SIZE) {
    throw projectionConfigError();
  }
  if (!isRecord(config) || !isRecord(snapshotQuery)) throw projectionConfigError();
  const assertOptionsValue = readOptionalData(options, 'assertOptions');
  if (
    assertOptionsValue !== undefined
    && (typeof assertOptionsValue !== 'object' || assertOptionsValue === null
      || Array.isArray(assertOptionsValue))
  ) {
    throw projectionConfigError();
  }

  const state: ProjectionState = Object.freeze({
    config,
    snapshotQuery,
    now,
    pageSize,
    identity: createPhase4bMcpResourceIdentity(
      config,
      (assertOptionsValue ?? {}) as McpReadFeatureConfigAssertOptions,
    ),
  });

  return Object.freeze({
    readResource: (
      input: Readonly<{ readonly resource: McpReadResource }>,
      context: McpTrustedReadRequestContext,
    ) => projectPage(state, Object.freeze({ resource: input.resource }), context),
    readPage: (input: Phase4bMcpSnapshotResourcePageInput, context: McpTrustedReadRequestContext) =>
      projectPage(state, input, context),
    cacheForRead: (
      input: Readonly<{ readonly resource: McpReadResource }>,
      context: McpTrustedReadRequestContext,
    ) => projectReadCache(state, input, context),
  });
}

async function projectPage(
  state: Readonly<ProjectionState>,
  input: Phase4bMcpSnapshotResourcePageInput,
  context: McpTrustedReadRequestContext,
): Promise<Phase4bMcpSnapshotResourceReadResult> {
  const budget = resolveMcpResourceReadBudget(context.budget);
  assertNotAborted(context.abortSignal);
  if (!isRecord(input) || input.resource?.kind !== 'collection-snapshot') {
    throw new McpResourceNotFoundError();
  }
  if (
    input.pageCursor !== undefined
    && (typeof input.pageCursor !== 'string' || input.pageCursor.length === 0
      || Buffer.byteLength(input.pageCursor, 'utf8') > budget.maxCursorLength)
  ) {
    throw new McpReadRequestContextError();
  }
  const result = await loadSnapshotPage(state, input.resource.collectionId, context, input.pageCursor);
  const snapshot = result.snapshot;
  const complete = result.nextCursor === null && snapshot.complete === true;
  if (complete && fitsCompleteSnapshot(snapshot, budget)) {
    return content(serializeMcpIJson(snapshot));
  }
  return content(serializeMcpIJson(buildSummary(state, result, budget)));
}

async function loadSnapshotPage(
  state: Readonly<ProjectionState>,
  collectionId: string,
  context: McpTrustedReadRequestContext,
  pageCursor: string | undefined,
): Promise<PublicationSnapshotPageResult> {
  assertNotAborted(context.abortSignal);
  try {
    const result = await getPublicationSnapshotPage(state.snapshotQuery, {
      collectionId,
      principal: principalFromBinding(context.binding, context.authorization),
      query: {
        limit: state.pageSize,
        ...(pageCursor === undefined ? {} : { pageCursor }),
      },
    });
    assertNotAborted(context.abortSignal);
    return result;
  } catch (error) {
    if (error instanceof McpReadRequestAbortedError) throw error;
    if (error instanceof PublicationNotFoundError || error instanceof PublicationSnapshotExpiredError) {
      throw new McpResourceNotFoundError();
    }
    throw error;
  }
}

async function projectReadCache(
  state: Readonly<ProjectionState>,
  input: Readonly<{ readonly resource: McpReadResource }>,
  context: McpTrustedReadRequestContext,
): Promise<Mcp20260728CacheMetadata> {
  assertNotAborted(context.abortSignal);
  if (context.binding.kind !== 'anonymous') {
    return privateCache();
  }
  if (!isRecord(input) || input.resource?.kind !== 'collection-snapshot') {
    return privateCache();
  }
  try {
    const result = await loadSnapshotPage(state, input.resource.collectionId, context, undefined);
    if (
      result.projection === 'public'
      && result.nextCursor === null
      && result.snapshot.complete === true
      && result.snapshot.collection.visibility === 'public'
    ) {
      return Object.freeze({
        ttlMs: PHASE4B_MCP_SNAPSHOT_CACHE_TTL_MS,
        cacheScope: 'public',
      });
    }
  } catch (error) {
    if (error instanceof McpReadRequestAbortedError) throw error;
    // Cache declarations are conservative when authority cannot be confirmed.
  }
  return privateCache();
}

function fitsCompleteSnapshot(
  snapshot: PublicationSnapshotPageResult['snapshot'],
  budget: ReturnType<typeof resolveMcpResourceReadBudget>,
): boolean {
  try {
    assertStructureWithinBudget(snapshot, budget.maxDepth, budget.maxNodes);
  } catch {
    return false;
  }
  return Buffer.byteLength(serializeMcpIJson(snapshot), 'utf8') <= budget.maxTextBytes;
}

function assertStructureWithinBudget(value: unknown, maxDepth: number, maxNodes: number): void {
  const seen = new WeakSet<object>();
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): void => {
    if (depth > maxDepth) throw new TypeError('Snapshot exceeded depth budget.');
    nodes += 1;
    if (nodes > maxNodes) throw new TypeError('Snapshot exceeded node budget.');
    if (candidate === null || typeof candidate === 'string'
      || typeof candidate === 'boolean' || typeof candidate === 'number') {
      if (typeof candidate === 'number' && !Number.isFinite(candidate)) {
        throw new TypeError('Snapshot contains a non-finite number.');
      }
      return;
    }
    if (typeof candidate !== 'object' || seen.has(candidate)) {
      throw new TypeError('Snapshot structure is not ordinary JSON data.');
    }
    seen.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        for (const item of candidate) visit(item, depth + 1);
        return;
      }
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('Snapshot object is not ordinary JSON data.');
      }
      for (const key of Reflect.ownKeys(candidate)) {
        if (typeof key !== 'string') throw new TypeError('Snapshot object has a symbol key.');
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (descriptor === undefined || !('value' in descriptor)) {
          throw new TypeError('Snapshot object has an accessor property.');
        }
        visit(descriptor.value, depth + 1);
      }
    } finally {
      seen.delete(candidate);
    }
  };
  visit(value, 0);
}

function buildSummary(
  state: Readonly<ProjectionState>,
  result: PublicationSnapshotPageResult,
  budget: ReturnType<typeof resolveMcpResourceReadBudget>,
): Readonly<Record<string, unknown>> {
  const snapshot = result.snapshot;
  const collection = snapshot.collection;
  const uri = state.identity.collectionSnapshot(collection.id);
  const nextCursor = result.nextCursor;
  const summary = Object.freeze({
    type: PHASE4B_MCP_SNAPSHOT_SUMMARY_TYPE,
    complete: false,
    bounded: true,
    reason: nextCursor === null ? 'output_budget' : 'continuation_available',
    resourceLink: Object.freeze({
      type: 'resource_link',
      uri,
      name: 'Collection snapshot',
      mimeType: PHASE4B_MCP_SNAPSHOT_RESOURCE_MIME_TYPE,
      annotations: Object.freeze({
        audience: PHASE4B_MCP_SNAPSHOT_LINK_AUDIENCE,
        priority: PHASE4B_MCP_SNAPSHOT_LINK_PRIORITY,
        lastModified: collection.updatedAt,
      }),
    }),
    collection: Object.freeze({
      id: collection.id,
      title: collection.title,
      visibility: collection.visibility,
      updatedAt: collection.updatedAt,
      revision: snapshot.revision,
    }),
    revision: snapshot.revision,
    generatedAt: snapshot.generatedAt,
    countsScope: 'page',
    counts: Object.freeze({
      nodes: snapshot.nodes.length,
      annotations: snapshot.annotations.length,
      relations: snapshot.relations.length,
      attachments: snapshot.attachments.length,
      tombstones: snapshot.tombstones.length,
    }),
    page: Object.freeze({
      sequence: snapshot.page.sequence,
      hasMore: nextCursor !== null,
      nextCursor,
      complete: false,
    }),
    ...(nextCursor === null
      ? {}
      : {
          continuation: Object.freeze({
            cursor: nextCursor,
            sequence: snapshot.page.sequence + 1,
          }),
        }),
  });
  // The summary is a fixed-size envelope, not unbounded Snapshot content. It
  // must still obey the byte budget, but applying the data node/depth budget
  // here would make a tiny-but-valid fallback unrepresentable.
  if (Buffer.byteLength(serializeMcpIJson(summary), 'utf8') > budget.maxTextBytes) {
    throw new McpReadRequestContextError();
  }
  return summary;
}

function content(text: string): Phase4bMcpSnapshotResourceReadResult {
  return Object.freeze({
    contents: Object.freeze([
      Object.freeze({
        mimeType: PHASE4B_MCP_SNAPSHOT_RESOURCE_MIME_TYPE,
        text,
        provenance: Object.freeze({ origin: 'internal' }),
      }),
    ]),
  });
}

function principalFromBinding(
  binding: McpTrustedReadRequestContext['binding'],
  authorization: Readonly<Record<string, unknown>>,
): PublicationPrincipal {
  if (binding.kind === 'anonymous') return Object.freeze({ kind: 'anonymous' });
  return Object.freeze({
    kind: 'account',
    principalId: binding.principalId,
    subjectId: requireMcpAccountSubjectId(authorization),
  });
}

function privateCache(): Mcp20260728CacheMetadata {
  return Object.freeze({
    ttlMs: 0,
    cacheScope: 'private',
  });
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new McpReadRequestAbortedError();
}

function projectionConfigError(): TypeError {
  return new TypeError('Invalid MCP Snapshot Resource projection configuration.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOwnData(value: object, name: string, fail: () => Error): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor === undefined || !('value' in descriptor)) throw fail();
  return descriptor.value;
}

function readOptionalData(value: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor === undefined || !('value' in descriptor)) return undefined;
  return descriptor.value;
}

/**
 * Strict ASCII-only JSON serializer for I-JSON Resource text. It rejects
 * unpaired surrogates, non-finite numbers, cycles, symbols and non-plain
 * objects; all non-ASCII characters are emitted as `\uXXXX` or surrogate
 * pairs so the serialized text is byte-stable and easy to audit.
 */
export function serializeMcpIJson(value: unknown): string {
  return serializeValue(value, new WeakSet<object>());
}

function serializeValue(value: unknown, seen: WeakSet<object>): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('MCP I-JSON values must contain only finite numbers.');
    }
    return String(value);
  }
  if (typeof value === 'string') return serializeString(value);
  if (typeof value !== 'object') {
    throw new TypeError('MCP I-JSON values must be JSON data.');
  }
  if (seen.has(value)) throw new TypeError('MCP I-JSON values must not contain cycles.');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.map((item) => serializeValue(item, seen));
      return `[${items.join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('MCP I-JSON objects must use ordinary prototypes.');
    }
    const entries: string[] = [];
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new TypeError('MCP I-JSON objects must not contain symbol keys.');
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        throw new TypeError('MCP I-JSON objects must not contain prototype-polluting keys.');
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor)) {
        throw new TypeError('MCP I-JSON objects must contain only data properties.');
      }
      entries.push(`${serializeString(key)}:${serializeValue(descriptor.value, seen)}`);
    }
    return `{${entries.join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

const JSON_ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  '"': '\\"',
  '\\': '\\\\',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
});

function serializeString(value: string): string {
  let output = '"';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      output += `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }
    const escape = JSON_ESCAPES[character];
    if (escape !== undefined) {
      output += escape;
      continue;
    }
    if (code < 0x80) {
      output += character;
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        throw new TypeError('MCP I-JSON strings must not contain unpaired surrogate code units.');
      }
      const codePoint = ((code - 0xd800) << 10) + (next - 0xdc00) + 0x10000;
      const high = Math.floor((codePoint - 0x10000) / 0x400) + 0xd800;
      const low = ((codePoint - 0x10000) % 0x400) + 0xdc00;
      output += `\\u${high.toString(16).padStart(4, '0')}\\u${low.toString(16).padStart(4, '0')}`;
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError('MCP I-JSON strings must not contain unpaired surrogate code units.');
    }
    output += `\\u${code.toString(16).padStart(4, '0')}`;
  }
  output += '"';
  return output;
}
