/**
 * Host owned-library MCP reads (`mcp:read:own`).
 *
 * Publication projections require a publication slug, so unpublished private
 * collections are invisible there even to the owner. This port reads the
 * canonical Collection/Node rows after membership authorization and returns
 * resource-revision fences agents can feed to write tools.
 */
import { formatUtcDateTime } from '../collections/index.js';
import { readMcpAccountSubjectId } from './account-context.js';
import { MCP_OAUTH_SCOPE_READ_OWN } from './oauth-verifier.js';
import type { McpTrustedReadRequestContext } from '@know-n/colp/mcp';

export const PHASE4B_MCP_OWNED_SNAPSHOT_DEFAULT_LIMIT = 200;
export const PHASE4B_MCP_OWNED_SNAPSHOT_CURSOR_PREFIX = 'own2.' as const;

export interface Phase4bMcpOwnedCollectionRecord {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly summary: string | null;
  readonly visibility: 'private' | 'protected' | 'unlisted' | 'public';
  readonly rootNodeId: string;
  readonly publicationSlug: string | null;
  readonly resourceRevision: string;
  readonly contentRevision: string;
  readonly policyRevision: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface Phase4bMcpOwnedNodeRecord {
  readonly id: string;
  readonly collectionId: string;
  readonly parentId: string | null;
  readonly kind: 'folder' | 'bookmark';
  readonly isRoot: boolean;
  readonly title: string;
  readonly url: string | null;
  readonly description: string | null;
  readonly visibility: 'inherit' | 'protected' | 'private';
  readonly positionToken: string | null;
  readonly resourceRevision: string;
  readonly childrenRevision: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface Phase4bMcpOwnedSnapshotAfter {
  readonly contentRevision: string;
  readonly policyRevision: string;
  readonly parentKey: string;
  readonly positionKey: string;
  readonly nodeId: string;
}

export interface Phase4bMcpOwnedSnapshotRecord {
  /** Only set by ports that read each page from one database snapshot. */
  readonly consistency?: 'version-fenced';
  readonly collection: Phase4bMcpOwnedCollectionRecord;
  readonly root: Phase4bMcpOwnedNodeRecord | null;
  readonly nodes: readonly Phase4bMcpOwnedNodeRecord[];
  readonly hasMore: boolean;
  readonly nextAfter: Phase4bMcpOwnedSnapshotAfter | null;
}

export interface Phase4bMcpOwnedCollectionReadPort {
  readonly readCollection: (input: {
    readonly collectionId: string;
    readonly actorSubjectId: string;
  }) => Promise<Phase4bMcpOwnedCollectionRecord | null>;
  readonly readSnapshot: (input: {
    readonly collectionId: string;
    readonly actorSubjectId: string;
    readonly limit: number;
    readonly after?: Phase4bMcpOwnedSnapshotAfter;
  }) => Promise<Phase4bMcpOwnedSnapshotRecord | null>;
  readonly readNode: (input: {
    readonly collectionId: string;
    readonly nodeId: string;
    readonly actorSubjectId: string;
  }) => Promise<Phase4bMcpOwnedNodeRecord | null>;
}

export function canUseOwnedMcpRead(context: McpTrustedReadRequestContext): boolean {
  if (context.binding.kind !== 'authenticated') return false;
  return context.scope.includes(MCP_OAUTH_SCOPE_READ_OWN);
}

export function ownedMcpActorSubjectId(
  context: McpTrustedReadRequestContext,
): string | undefined {
  return readMcpAccountSubjectId(context.authorization);
}

export function projectOwnedCollectionMetadata(
  record: Phase4bMcpOwnedCollectionRecord,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    collection: Object.freeze({
      id: record.id,
      kind: record.kind,
      title: record.title,
      ...(record.summary === null ? {} : { summary: record.summary }),
      visibility: record.visibility,
      rootNodeId: record.rootNodeId,
      ...(record.publicationSlug === null ? {} : { publicationSlug: record.publicationSlug }),
      revision: record.resourceRevision,
      contentRevision: record.contentRevision,
      policyRevision: record.policyRevision,
      createdAt: formatUtcDateTime(record.createdAt),
      updatedAt: formatUtcDateTime(record.updatedAt),
    }),
  });
}

export function projectOwnedNode(record: Phase4bMcpOwnedNodeRecord): Readonly<Record<string, unknown>> {
  return Object.freeze({
    id: record.id,
    collectionId: record.collectionId,
    kind: record.isRoot ? 'folder' : record.kind,
    ...(record.parentId === null ? {} : { parentId: record.parentId }),
    ...(record.isRoot ? { folderRole: 'root' } : {}),
    title: record.title,
    ...(record.url === null ? {} : { url: record.url }),
    ...(record.description === null ? {} : { description: record.description }),
    ...(record.visibility === 'inherit' || record.isRoot ? {} : { visibility: record.visibility }),
    ...(record.positionToken === null ? {} : { position: record.positionToken }),
    revision: record.resourceRevision,
    ...(record.childrenRevision === null ? {} : { childrenRevision: record.childrenRevision }),
    createdAt: formatUtcDateTime(record.createdAt),
    updatedAt: formatUtcDateTime(record.updatedAt),
  });
}

export function projectOwnedSnapshot(
  record: Phase4bMcpOwnedSnapshotRecord,
  cursor: string | undefined,
): Readonly<Record<string, unknown>> {
  const collection = projectOwnedCollectionMetadata(record.collection).collection as Readonly<
    Record<string, unknown>
  >;
  const hasMore = record.hasMore && record.nextAfter !== null;
  const nextCursor = hasMore && record.nextAfter !== null
    ? encodeOwnedSnapshotCursor(record.collection.id, record.nextAfter)
    : null;
  return Object.freeze({
    collection,
    ...(record.root === null ? {} : { root: projectOwnedNode(record.root) }),
    nodes: Object.freeze(record.nodes.map(projectOwnedNode)),
    page: Object.freeze({
      sequence: cursor === undefined ? 0 : 1,
      ...(record.consistency === undefined ? {} : { consistency: record.consistency }),
      hasMore,
      nextCursor,
      complete: !hasMore,
    }),
    ...(nextCursor === null
      ? {}
      : { continuation: Object.freeze({ cursor: nextCursor }) }),
  });
}

export function encodeOwnedSnapshotCursor(
  collectionId: string,
  after: Phase4bMcpOwnedSnapshotAfter,
): string {
  const payload = Object.freeze({
    v: 2 as const,
    collectionId,
    contentRevision: after.contentRevision,
    policyRevision: after.policyRevision,
    parentKey: after.parentKey,
    positionKey: after.positionKey,
    nodeId: after.nodeId,
  });
  return `${PHASE4B_MCP_OWNED_SNAPSHOT_CURSOR_PREFIX}${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
}

export function decodeOwnedSnapshotCursor(
  collectionId: string,
  cursor: string,
): Phase4bMcpOwnedSnapshotAfter | undefined {
  if (!cursor.startsWith(PHASE4B_MCP_OWNED_SNAPSHOT_CURSOR_PREFIX)) return undefined;
  const encoded = cursor.slice(PHASE4B_MCP_OWNED_SNAPSHOT_CURSOR_PREFIX.length);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Readonly<Record<string, unknown>>;
  if (record.v !== 2 || record.collectionId !== collectionId) return undefined;
  const contentRevision = record.contentRevision;
  const policyRevision = record.policyRevision;
  if (typeof contentRevision !== 'string' || !contentRevision || typeof policyRevision !== 'string' || !policyRevision) return undefined;
  const parentKey = record.parentKey;
  const positionKey = record.positionKey;
  const nodeId = record.nodeId;
  if (typeof parentKey !== 'string' || typeof positionKey !== 'string' || typeof nodeId !== 'string') {
    return undefined;
  }
  if (parentKey.length === 0 && positionKey.length === 0 && nodeId.length === 0) return undefined;
  if (nodeId.length < 1) return undefined;
  return Object.freeze({ parentKey, positionKey, nodeId, contentRevision, policyRevision });
}
