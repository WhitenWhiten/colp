/**
 * Host owned unpublished MCP reads (`mcp:read:own`) against the canonical
 * port. Companion to phase4b-mcp-read-tools.test.ts.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  McpResourceNotFoundError,
  McpToolOutputUnavailableError,
  createAuthenticatedBinding,
  type Mcp20260728RequestContext,
} from '@know-n/colp/mcp';
import {
  PHASE4B_MCP_READ_TOOL_COLLECTION_ID_HEADER,
  PHASE4B_MCP_READ_TOOL_PARAM_DECLARATIONS,
  createPhase4bMcpReadToolAdapter,
  createPhase4bMcpRequestContext,
  decodeOwnedSnapshotCursor,
  encodeOwnedSnapshotCursor,
  type Phase4bMcpCollectionResourceProjection,
  type Phase4bMcpNodeResourceProjection,
  type Phase4bMcpOwnedCollectionReadPort,
  type Phase4bMcpOwnedCollectionRecord,
  type Phase4bMcpOwnedNodeRecord,
  type Phase4bMcpSnapshotResourceProjection,
} from '../../../src/modules/mcp/index.js';

const AUDIENCE = 'https://collections.example.test/collections/-/mcp';
const SERVER_UUID = '019b3c67-a03c-7f02-9c7e-1ee8d50a77de';
const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities';
const AUTHENTICATED = createAuthenticatedBinding({
  credentialKind: 'oauth',
  principalId: 'urn:known:subject:alice',
  clientId: 'known-mcp-oauth-client',
  credentialBindingId: 'credential-1',
  resourceAudience: AUDIENCE,
  securityEpoch: 'epoch-1',
});
const OWNED_AT = new Date('2026-08-29T08:00:00.000Z');

function meta(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
    [CLIENT_CAPABILITIES_META_KEY]: Object.freeze({ tools: Object.freeze({ call: true }) }),
  });
}

function callContext(
  name: string,
  args: Readonly<Record<string, unknown>>,
  binding = AUTHENTICATED,
  scope: readonly string[] = ['mcp:read:public'],
  authorization: Readonly<Record<string, unknown>> = Object.freeze({}),
): Mcp20260728RequestContext {
  const headers: Array<{ readonly name: string; readonly value: string }> = [
    Object.freeze({ name: 'MCP-Protocol-Version', value: '2026-07-28' }),
    Object.freeze({ name: 'Mcp-Method', value: 'tools/call' }),
    Object.freeze({ name: 'Mcp-Name', value: name }),
    Object.freeze({ name: `Mcp-Param-${PHASE4B_MCP_READ_TOOL_COLLECTION_ID_HEADER}`, value: String(args.collectionId) }),
  ];
  return createPhase4bMcpRequestContext({
    headers,
    httpMethod: 'POST',
    body: Object.freeze({
      method: 'tools/call',
      params: Object.freeze({
        _meta: meta(),
        name,
        arguments: args,
      }),
    }),
    binding,
    scope,
    authorization,
    paramDeclarations: PHASE4B_MCP_READ_TOOL_PARAM_DECLARATIONS,
  });
}

function collectionProjection(
  reject: ReadonlySet<string> = new Set(),
): Phase4bMcpCollectionResourceProjection {
  const metadata = Object.freeze({
    collection: Object.freeze({
      id: 'collection-1',
      title: 'Public library',
      visibility: 'public',
      updatedAt: '2026-08-05T00:00:00.000Z',
    }),
  });
  return Object.freeze({
    async listResources() {
      return Object.freeze({ resources: Object.freeze([]) });
    },
    async readResource(input) {
      if (reject.has(input.resource.collectionId)) throw new McpResourceNotFoundError();
      return Object.freeze({
        contents: Object.freeze([
          Object.freeze({
            mimeType: 'application/vnd.collection-protocol.collection+json',
            text: JSON.stringify(metadata),
            provenance: Object.freeze({ origin: 'internal' }),
          }),
        ]),
      });
    },
    async cacheForList() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'private' });
    },
    async cacheForRead() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'private' });
    },
  });
}

function snapshotProjection(
  reject: ReadonlySet<string> = new Set(),
): Phase4bMcpSnapshotResourceProjection {
  const collection = Object.freeze({
    id: 'collection-1',
    title: 'Snapshot 1',
    visibility: 'public',
    updatedAt: '2026-08-05T00:00:00.000Z',
  });
  return Object.freeze({
    async readResource(input) {
      if (reject.has(input.resource.collectionId)) throw new McpResourceNotFoundError();
      return Object.freeze({
        contents: Object.freeze([
          Object.freeze({
            mimeType: 'application/vnd.collection-protocol.snapshot+json',
            text: JSON.stringify(Object.freeze({
              complete: true,
              collection,
              revision: 'content-1.policy-1',
            })),
            provenance: Object.freeze({ origin: 'internal' }),
          }),
        ]),
      });
    },
    async readPage() {
      throw new McpResourceNotFoundError();
    },
    async cacheForRead() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'private' });
    },
  });
}

function nodeProjection(reject = false): Phase4bMcpNodeResourceProjection {
  return Object.freeze({
    async readResource() {
      if (reject) throw new McpResourceNotFoundError();
      return Object.freeze({
        contents: Object.freeze([
          Object.freeze({
            mimeType: 'application/vnd.collection-protocol.node+json',
            text: JSON.stringify(Object.freeze({
              id: 'node-1',
              collectionId: 'collection-1',
              kind: 'bookmark',
              title: 'Example node',
              revision: 'content-1',
            })),
            provenance: Object.freeze({ origin: 'internal' }),
          }),
        ]),
      });
    },
    async cacheForRead() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'private' });
    },
  });
}

function ownedCollectionRecord(): Phase4bMcpOwnedCollectionRecord {
  return Object.freeze({
    id: 'private-collection',
    kind: 'bookmarks',
    title: 'Private library',
    summary: null,
    visibility: 'private',
    rootNodeId: 'private-root',
    publicationSlug: null,
    resourceRevision: 'res-1',
    contentRevision: 'cnt-1',
    policyRevision: 'pol-1',
    createdAt: OWNED_AT,
    updatedAt: OWNED_AT,
  });
}

function ownedNodeRecord(): Phase4bMcpOwnedNodeRecord {
  return Object.freeze({
    id: 'private-root',
    collectionId: 'private-collection',
    parentId: null,
    kind: 'folder',
    isRoot: true,
    title: 'Private library',
    url: null,
    description: null,
    visibility: 'inherit',
    positionToken: null,
    resourceRevision: 'node-res-1',
    childrenRevision: 'ch-1',
    createdAt: OWNED_AT,
    updatedAt: OWNED_AT,
  });
}

function stubOwnedRead(): Phase4bMcpOwnedCollectionReadPort {
  const collection = ownedCollectionRecord();
  const node = ownedNodeRecord();
  return Object.freeze({
    async readCollection(input) {
      if (input.collectionId !== collection.id || input.actorSubjectId !== 'subject-alice') return null;
      return collection;
    },
    async readSnapshot(input) {
      if (input.collectionId !== collection.id || input.actorSubjectId !== 'subject-alice') return null;
      return Object.freeze({
        collection,
        root: node,
        nodes: Object.freeze([]),
        hasMore: false,
        nextAfter: null,
      });
    },
    async readNode(input) {
      if (
        input.collectionId !== collection.id
        || input.nodeId !== node.id
        || input.actorSubjectId !== 'subject-alice'
      ) {
        return null;
      }
      return node;
    },
  });
}

function ownedCallContext(
  name: string,
  args: Readonly<Record<string, unknown>>,
  scope: readonly string[] = ['mcp:read:own'],
): Mcp20260728RequestContext {
  return callContext(
    name,
    args,
    AUTHENTICATED,
    scope,
    Object.freeze({ accountSubjectId: 'subject-alice' }),
  );
}

function unpublishedSurface() {
  return createPhase4bMcpReadToolAdapter({
    collectionProjection: collectionProjection(new Set(['private-collection'])),
    snapshotProjection: snapshotProjection(new Set(['private-collection'])),
    nodeProjection: nodeProjection(true),
    serverUuid: SERVER_UUID,
    ownedRead: stubOwnedRead(),
  });
}

test('mcp:read:own collections.get returns canonical resourceRevision for unpublished private libraries', async () => {
  const result = await unpublishedSurface().adapter.callTool(
    ownedCallContext('collections.get', Object.freeze({ collectionId: 'private-collection' })),
    { name: 'collections.get', arguments: Object.freeze({ collectionId: 'private-collection' }) },
  );
  const collection = (result.structuredContent as { collection?: { revision?: string; visibility?: string } })
    .collection;
  assert.equal(collection?.visibility, 'private');
  assert.equal(collection?.revision, 'res-1');
});

test('mcp:read:public-only does not use the owned canonical port', async () => {
  await assert.rejects(
    () => unpublishedSurface().adapter.callTool(
      ownedCallContext(
        'collections.get',
        Object.freeze({ collectionId: 'private-collection' }),
        ['mcp:read:public'],
      ),
      { name: 'collections.get', arguments: Object.freeze({ collectionId: 'private-collection' }) },
    ),
    McpToolOutputUnavailableError,
  );
});

test('mcp:read:own nodes.get and get_snapshot serve unpublished private targets', async () => {
  const surface = unpublishedSurface();
  const node = await surface.adapter.callTool(
    ownedCallContext(
      'nodes.get',
      Object.freeze({ collectionId: 'private-collection', nodeId: 'private-root' }),
    ),
    {
      name: 'nodes.get',
      arguments: Object.freeze({ collectionId: 'private-collection', nodeId: 'private-root' }),
    },
  );
  assert.equal((node.structuredContent as { revision?: string }).revision, 'node-res-1');

  const snapshot = await surface.adapter.callTool(
    ownedCallContext('collections.get_snapshot', Object.freeze({ collectionId: 'private-collection' })),
    { name: 'collections.get_snapshot', arguments: Object.freeze({ collectionId: 'private-collection' }) },
  );
  const body = snapshot.structuredContent as {
    collection?: { revision?: string };
    page?: { complete?: boolean };
  };
  assert.equal(body.collection?.revision, 'res-1');
  assert.equal(body.page?.complete, true);
  assert.equal(encodeOwnedSnapshotCursor('private-collection', {
    parentKey: 'root',
    positionKey: 'a',
    nodeId: 'n1',
    contentRevision: 'cnt-1',
    policyRevision: 'pol-1',
  }).startsWith('own2.'), true);
});

test('mcp:read:own falls through to Publication for collections the actor does not own', async () => {
  const surface = createPhase4bMcpReadToolAdapter({
    collectionProjection: collectionProjection(),
    snapshotProjection: snapshotProjection(),
    nodeProjection: nodeProjection(),
    serverUuid: SERVER_UUID,
    ownedRead: stubOwnedRead(),
  });
  const result = await surface.adapter.callTool(
    ownedCallContext('collections.get', Object.freeze({ collectionId: 'collection-1' })),
    { name: 'collections.get', arguments: Object.freeze({ collectionId: 'collection-1' }) },
  );
  assert.equal(
    (result.structuredContent as { collection?: { id?: string; visibility?: string } }).collection?.id,
    'collection-1',
  );
  assert.equal(
    (result.structuredContent as { collection?: { visibility?: string } }).collection?.visibility,
    'public',
  );
});

test('owned snapshot cursors round-trip and reject a mismatched collection', () => {
  const cursor = encodeOwnedSnapshotCursor('private-collection', {
    parentKey: 'root',
    positionKey: 'a',
    nodeId: 'n1',
    contentRevision: 'cnt-1',
    policyRevision: 'pol-1',
  });
  assert.deepEqual(decodeOwnedSnapshotCursor('private-collection', cursor), {
    parentKey: 'root',
    positionKey: 'a',
    nodeId: 'n1',
    contentRevision: 'cnt-1',
    policyRevision: 'pol-1',
  });
  assert.equal(decodeOwnedSnapshotCursor('other-collection', cursor), undefined);
  assert.equal(decodeOwnedSnapshotCursor('private-collection', 'not-an-owned-cursor'), undefined);
});
