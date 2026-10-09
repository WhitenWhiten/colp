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
import { createValidatorRegistry } from '@know-n/colp/schema';
import type { SnapshotNode } from '@know-n/colp/types';
import {
  PublicationNotFoundError,
  PublicationSnapshotExpiredError,
  getPublicationSnapshotPage,
  type PublicationPrincipal,
  type PublicationSnapshotPageResult,
  type PublicationSnapshotQueryPorts,
} from '../publication/index.js';
import { requireMcpAccountSubjectId } from './account-context.js';
import type { McpReadFeatureConfig } from './config.js';
import { PHASE4B_MCP_PUBLIC_READ_CACHE_TTL_MS } from './read-cache.js';
import { serializeMcpIJson } from './snapshot-resources.js';
import {
  MCP_OAUTH_SCOPE_READ_OWN,
  MCP_OAUTH_SCOPE_READ_PUBLIC,
} from './scope-requirements.js';

export const PHASE4B_MCP_NODE_RESOURCE_MIME_TYPE =
  'application/vnd.collection-protocol.node+json' as const;
export const PHASE4B_MCP_NODE_RESOURCE_CACHE_TTL_MS = PHASE4B_MCP_PUBLIC_READ_CACHE_TTL_MS;

const NODE_READ_LIMIT = 2;

export type McpNodeLinkHealth = 'pending' | 'healthy' | 'redirect' | 'broken';

export interface Phase4bMcpNodeResourceProjectionOptions {
  readonly config: McpReadFeatureConfig;
  readonly snapshotQuery: PublicationSnapshotQueryPorts;
  readonly now?: () => Date;
  readonly readLinkHealth?: (
    collectionId: string,
    nodeId: string,
  ) => Promise<McpNodeLinkHealth | null>;
}

export type Phase4bMcpNodeResourceContentProjection = Readonly<{
  readonly mimeType: string;
  readonly text: string;
  readonly provenance: McpResourceProvenance;
}>;

export type Phase4bMcpNodeResourceReadResult = Readonly<{
  readonly contents: readonly Phase4bMcpNodeResourceContentProjection[];
}>;

export interface Phase4bMcpNodeResourceProjection {
  /** Wire read for a `collection-node` Resource URI. */
  readonly readResource: (
    input: Readonly<{ readonly resource: McpReadResource }>,
    context: McpTrustedReadRequestContext,
  ) => Promise<Phase4bMcpNodeResourceReadResult>;
  readonly cacheForRead: (
    input: Readonly<{ readonly resource: McpReadResource }>,
    context: McpTrustedReadRequestContext,
  ) => Promise<Mcp20260728CacheMetadata>;
}

interface ProjectionState {
  readonly config: McpReadFeatureConfig;
  readonly snapshotQuery: PublicationSnapshotQueryPorts;
  readonly now: () => Date;
  readonly readLinkHealth?: Phase4bMcpNodeResourceProjectionOptions['readLinkHealth'];
}

/**
 * P4B-R10 Node Resource projection. It delegates authority, revision fencing,
 * Schema/semantic validation and safe Node projection to the existing
 * Publication Snapshot query scoped to the requested Node; it never creates an
 * MCP read model, never emits ownerSubjectId/raw policy, and never returns a
 * null/placeholder Node that could imply hidden data.
 */
export function createPhase4bMcpNodeResourceProjection(
  options: Phase4bMcpNodeResourceProjectionOptions,
): Phase4bMcpNodeResourceProjection {
  if (!isRecord(options)) {
    throw new TypeError('MCP Node Resource projection options are required.');
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
  if (!isRecord(config) || !isRecord(snapshotQuery)) throw projectionConfigError();

  const readLinkHealth = readOptionalData(options, 'readLinkHealth');
  if (readLinkHealth !== undefined && typeof readLinkHealth !== 'function') throw projectionConfigError();
  const state: ProjectionState = Object.freeze({
    config,
    snapshotQuery,
    now,
    ...(typeof readLinkHealth === 'function'
      ? { readLinkHealth: readLinkHealth as NonNullable<ProjectionState['readLinkHealth']> }
      : {}),
  });

  return Object.freeze({
    readResource: (
      input: Readonly<{ readonly resource: McpReadResource }>,
      context: McpTrustedReadRequestContext,
    ) => projectRead(state, input, context),
    cacheForRead: (
      input: Readonly<{ readonly resource: McpReadResource }>,
      context: McpTrustedReadRequestContext,
    ) => projectReadCache(state, input, context),
  });
}

async function projectRead(
  state: Readonly<ProjectionState>,
  input: Readonly<{ readonly resource: McpReadResource }>,
  context: McpTrustedReadRequestContext,
): Promise<Phase4bMcpNodeResourceReadResult> {
  const budget = resolveMcpResourceReadBudget(context.budget);
  assertNotAborted(context.abortSignal);
  if (!isRecord(input) || input.resource?.kind !== 'collection-node') {
    throw new McpResourceNotFoundError();
  }
  const result = await loadNodePage(state, input.resource.collectionId, input.resource.nodeId, context);
  if (
    result.snapshot.nodes.length !== 1
    || result.snapshot.collection.id !== input.resource.collectionId
    || result.snapshot.nodes[0]!.id !== input.resource.nodeId
    || result.snapshot.nodes[0]!.collectionId !== input.resource.collectionId
  ) {
    throw new McpResourceNotFoundError();
  }
  const node = result.snapshot.nodes[0]!;
  const core = projectCoreNode(node);
  validateNode(core);
  const linkHealth = state.readLinkHealth
    ? await state.readLinkHealth(node.collectionId, node.id)
    : null;
  const payload = attachNodeLinkHealth(core, linkHealth ?? null);
  let text: string;
  try {
    text = serializeMcpIJson(payload);
  } catch {
    throw new McpReadRequestContextError();
  }
  if (Buffer.byteLength(text, 'utf8') > budget.maxTextBytes) {
    throw new McpReadRequestContextError();
  }
  return content(text);
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
  if (!isRecord(input) || input.resource?.kind !== 'collection-node') {
    return privateCache();
  }
  try {
    const result = await loadNodePage(state, input.resource.collectionId, input.resource.nodeId, context);
    const node = result.snapshot.nodes[0];
    if (
      result.projection === 'public'
      && result.snapshot.collection.visibility === 'public'
      && result.snapshot.nodes.length === 1
      && result.snapshot.collection.id === input.resource.collectionId
      && node?.id === input.resource.nodeId
      && node?.collectionId === input.resource.collectionId
      && isPubliclyVisibleSnapshotNode(node)
    ) {
      return publicCache();
    }
  } catch (error) {
    if (error instanceof McpReadRequestAbortedError) throw error;
    // Cache declarations are conservative when authority cannot be confirmed.
  }
  return privateCache();
}

async function loadNodePage(
  state: Readonly<ProjectionState>,
  collectionId: string,
  nodeId: string,
  context: McpTrustedReadRequestContext,
): Promise<PublicationSnapshotPageResult> {
  assertNotAborted(context.abortSignal);
  try {
    const result = await getPublicationSnapshotPage(state.snapshotQuery, {
      collectionId,
      principal: principalFromContext(context),
      query: {
        root: nodeId,
        depth: 0,
        limit: NODE_READ_LIMIT,
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

export function attachNodeLinkHealth(
  core: Readonly<Record<string, unknown>>,
  status: McpNodeLinkHealth | null,
): Readonly<Record<string, unknown>> {
  return status === null ? core : { ...core, linkHealth: status };
}

function projectCoreNode(node: SnapshotNode): Readonly<Record<string, unknown>> {
  const visibility = node.kind === 'root'
    ? undefined
    : node.visibility === 'inherit'
      ? undefined
      : node.visibility;
  const description = node.description === undefined ? undefined : node.description;
  const tags = node.tags === undefined || node.tags.length === 0 ? undefined : [...node.tags];
  return Object.freeze({
    id: node.id,
    collectionId: node.collectionId,
    kind: node.kind,
    parentId: node.parentId,
    position: node.position,
    ...(node.kind === 'root' ? { folderRole: node.folderRole, title: node.title } : { title: node.title }),
    ...(node.kind === 'bookmark' ? { url: node.url } : {}),
    ...(visibility === undefined ? {} : { visibility }),
    ...(description === undefined ? {} : { description }),
    ...(tags === undefined ? {} : { tags }),
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    revision: node.revision,
  });
}

function validateNode(node: Readonly<Record<string, unknown>>): void {
  const validation = createValidatorRegistry().validate('node', node);
  if (!validation.valid) {
    throw new McpReadRequestContextError();
  }
}

function isPubliclyVisibleSnapshotNode(node: SnapshotNode): boolean {
  return node.kind === 'root' || node.visibility === undefined || node.visibility === 'inherit';
}

function content(text: string): Phase4bMcpNodeResourceReadResult {
  return Object.freeze({
    contents: Object.freeze([
      Object.freeze({
        mimeType: PHASE4B_MCP_NODE_RESOURCE_MIME_TYPE,
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

function principalFromContext(
  context: McpTrustedReadRequestContext,
): PublicationPrincipal {
  if (
    context.binding.kind === 'authenticated'
    && context.scope.includes(MCP_OAUTH_SCOPE_READ_PUBLIC)
    && !context.scope.includes(MCP_OAUTH_SCOPE_READ_OWN)
  ) {
    return Object.freeze({ kind: 'anonymous' });
  }
  return principalFromBinding(context.binding, context.authorization);
}

function privateCache(): Mcp20260728CacheMetadata {
  return Object.freeze({
    ttlMs: 0,
    cacheScope: 'private',
  });
}

function publicCache(): Mcp20260728CacheMetadata {
  return Object.freeze({
    ttlMs: PHASE4B_MCP_NODE_RESOURCE_CACHE_TTL_MS,
    cacheScope: 'public',
  });
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new McpReadRequestAbortedError();
}

function projectionConfigError(): TypeError {
  return new TypeError('Invalid MCP Node Resource projection configuration.');
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
