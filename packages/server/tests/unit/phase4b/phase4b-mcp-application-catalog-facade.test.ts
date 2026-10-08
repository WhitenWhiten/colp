/**
 * T-01: facade listTools / collections.list against the era-neutral catalog.
 * Companion to phase4b-mcp-application-catalog.test.ts.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'vitest';
import ts from 'typescript';
import {
  DEFAULT_MCP_RESOURCE_READ_BUDGET,
  createAnonymousPublicBinding,
  createAuthenticatedBinding,
  createMcpResourceTemplates,
  type Mcp20260728RequestContext,
} from '@know-n/colp/mcp';
import { loadConfig } from '../../support/test-config.js';
import {
  PHASE4B_MCP_COLLECTION_RESOURCE_MIME_TYPE,
  PHASE4B_MCP_NODE_RESOURCE_MIME_TYPE,
  PHASE4B_MCP_READ_TOOL_CATALOG,
  PHASE4B_MCP_READ_TOOL_COLLECTION_ID_HEADER,
  PHASE4B_MCP_READ_TOOL_NAMES,
  PHASE4B_MCP_READ_TOOL_REQUIRED_SCOPES,
  PHASE4B_MCP_SNAPSHOT_RESOURCE_MIME_TYPE,
  PHASE4B_MCP_NODE_CREATE_BOOKMARK_REQUIRED_KEYS,
  PHASE4B_MCP_NODE_CREATE_FOLDER_REQUIRED_KEYS,
  PHASE4B_MCP_WRITE_COLLECTION_ID_HEADER,
  PHASE4B_MCP_WRITE_MOUNTED_TOOL_NAMES,
  PHASE4B_MCP_WRITE_TOOL_REQUIRED_SCOPES,
  canAccessPhase4bMcpReadTools,
  canAccessPhase4bMcpWriteTools,
  canCallPhase4bMcpWriteTool,
  collectionsGetDefinition,
  collectionsGetSnapshotDefinition,
  nodesGetDefinition,
  createMcpApplicationContext,
  createPhase4bMcpReadToolAdapter,
  createPhase4bMcpRequestContext,
  createPhase4bMcpResourceIdentity,
  type Phase4bMcpCollectionResourceProjection,
  type Phase4bMcpNodeResourceProjection,
  type Phase4bMcpSnapshotResourceProjection,
} from '../../../src/modules/mcp/index.js';
import { createInMemoryWriteToolFixture } from '../../support/phase4b-mcp-write-tools-fixture.js';
import { mcpEnv } from '../../support/phase4b-mcp-transport-scaffold.js';
import { createPhase4bMcpApplicationFacadeFromColpAdapters } from '../../../src/transport/mcp/mcp-strict-application-adapter.js';

const AUDIENCE = 'https://collections.example.test/collections/-/mcp';
const SERVER_UUID = '019b3c67-a03c-7f02-9c7e-1ee8d50a77de';
const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities';

const ANONYMOUS = createAnonymousPublicBinding({
  resourceAudience: AUDIENCE,
  securityEpoch: 'epoch-1',
});
const AUTHENTICATED = createAuthenticatedBinding({
  credentialKind: 'oauth',
  principalId: 'urn:known:subject:alice',
  clientId: 'known-mcp-oauth-client',
  credentialBindingId: 'credential-1',
  resourceAudience: AUDIENCE,
  securityEpoch: 'epoch-1',
});

const READ_SCOPES = Object.freeze(['mcp:read:public'] as const);
const WRITE_SCOPES = Object.freeze([
  'mcp:read:public',
  'nodes:write',
  'access:write',
  'changes:commit',
  'changes:cancel',
] as const);

function emptyCollectionProjection(): Phase4bMcpCollectionResourceProjection {
  return Object.freeze({
    async listResources() {
      return Object.freeze({ resources: Object.freeze([]) });
    },
    async readResource() {
      throw new Error('unused');
    },
    async cacheForList() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'private' as const });
    },
    async cacheForRead() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'private' as const });
    },
  });
}

function emptySnapshotProjection(): Phase4bMcpSnapshotResourceProjection {
  return Object.freeze({
    async readResource() {
      throw new Error('unused');
    },
    async readPage() {
      throw new Error('unused');
    },
    async cacheForRead() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'private' as const });
    },
  });
}

function emptyNodeProjection(): Phase4bMcpNodeResourceProjection {
  return Object.freeze({
    async readResource() {
      throw new Error('unused');
    },
    async cacheForRead() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'private' as const });
    },
  });
}

function createFacade(writeAdapter?: ReturnType<typeof createInMemoryWriteToolFixture>['bundle']['adapter']) {
  const config = loadConfig(mcpEnv()).mcp!;
  const readSurface = createPhase4bMcpReadToolAdapter({
    collectionProjection: emptyCollectionProjection(),
    snapshotProjection: emptySnapshotProjection(),
    nodeProjection: emptyNodeProjection(),
    serverUuid: SERVER_UUID,
  });
  return createPhase4bMcpApplicationFacadeFromColpAdapters({
    resourceIdentity: createPhase4bMcpResourceIdentity(config),
    collectionProjection: emptyCollectionProjection(),
    snapshotProjection: emptySnapshotProjection(),
    nodeProjection: emptyNodeProjection(),
    readToolAdapter: readSurface.adapter,
    ...(writeAdapter === undefined ? {} : { writeToolAdapter: writeAdapter }),
  });
}

function applicationContext(
  binding = AUTHENTICATED,
  scope: readonly string[] = READ_SCOPES,
) {
  return createMcpApplicationContext({
    principal: binding.kind === 'anonymous'
      ? Object.freeze({
        kind: 'anonymous' as const,
        principalId: 'public' as const,
        resourceAudience: binding.resourceAudience,
        securityEpoch: binding.securityEpoch,
      })
      : Object.freeze({
        kind: 'authenticated' as const,
        principalId: binding.principalId,
        clientId: binding.clientId,
        credentialBindingId: binding.credentialBindingId,
        resourceAudience: binding.resourceAudience,
        securityEpoch: binding.securityEpoch,
      }),
    scopes: scope,
    abortSignal: new AbortController().signal,
    budgets: DEFAULT_MCP_RESOURCE_READ_BUDGET,
    correlationId: 'catalog-test',
  });
}

test('facade listTools matches the current strict read/write catalog and scope branches', async () => {
  const writeFixture = createInMemoryWriteToolFixture();
  const facade = createFacade(writeFixture.bundle.adapter);
  const anonymous = await facade.listTools(applicationContext(ANONYMOUS, []));
  assert.deepEqual(anonymous.tools.map((tool) => tool.name), [...PHASE4B_MCP_READ_TOOL_NAMES]);
  assert.equal(anonymous.tools[0]?.inputSchema, collectionsGetDefinition.inputSchema);
  assert.equal(anonymous.tools.some((tool) => tool.name === 'nodes.create'), false);

  const readOnly = await facade.listTools(applicationContext(AUTHENTICATED, READ_SCOPES));
  assert.deepEqual(readOnly.tools.map((tool) => tool.name), [...PHASE4B_MCP_READ_TOOL_NAMES]);

  const emptyAuth = await facade.listTools(applicationContext(AUTHENTICATED, []));
  assert.deepEqual(emptyAuth.tools, []);

  const writeList = await facade.listTools(applicationContext(AUTHENTICATED, WRITE_SCOPES));
  assert.deepEqual(
    writeList.tools.map((tool) => tool.name),
    [...PHASE4B_MCP_READ_TOOL_NAMES, ...PHASE4B_MCP_WRITE_MOUNTED_TOOL_NAMES].sort(),
  );
  assert.deepEqual(
    writeList.tools.find((tool) => tool.name === 'changes.commit')?.requiredScopes,
    PHASE4B_MCP_WRITE_TOOL_REQUIRED_SCOPES['changes.commit'],
  );

  const templates = await facade.listResourceTemplates(applicationContext(ANONYMOUS, []));
  assert.deepEqual(templates.resourceTemplates.map((entry) => entry.name), ['collection', 'collection-node']);
});

test('facade lists and calls collections.list when own-data ports and mcp:read:own are present', async () => {
  const now = new Date('2026-08-29T00:00:00.000Z');
  const ownedCollectionsQuery = Object.freeze({
    reads: Object.freeze({
      listOwnedCollections: async () => Object.freeze([
        Object.freeze({
          id: 'col-owned-1',
          kind: 'bookmarks' as const,
          title: '测试收藏夹',
          summary: null,
          visibility: 'private' as const,
          rootNodeId: 'root-owned-1',
          publicationSlug: null,
          allowSearchIndexing: false,
          publishedAt: null,
          resourceRevision: 'r1',
          contentRevision: 'c1',
          policyRevision: 'p1',
          createdAt: now,
          updatedAt: now,
        }),
      ]),
    }),
    cursors: Object.freeze({
      sign: () => 'unused',
      verify: () => {
        throw new Error('collections.list first page must not verify a cursor');
      },
      destroy: () => undefined,
    }),
    clock: Object.freeze({ now: async () => now }),
  });
  const writeFixture = createInMemoryWriteToolFixture();
  const config = loadConfig(mcpEnv()).mcp!;
  const readSurface = createPhase4bMcpReadToolAdapter({
    collectionProjection: emptyCollectionProjection(),
    snapshotProjection: emptySnapshotProjection(),
    nodeProjection: emptyNodeProjection(),
    serverUuid: SERVER_UUID,
  });
  const facade = createPhase4bMcpApplicationFacadeFromColpAdapters({
    resourceIdentity: createPhase4bMcpResourceIdentity(config),
    collectionProjection: emptyCollectionProjection(),
    snapshotProjection: emptySnapshotProjection(),
    nodeProjection: emptyNodeProjection(),
    readToolAdapter: readSurface.adapter,
    writeToolAdapter: writeFixture.bundle.adapter,
    ownedCollectionsQuery,
  });
  const context = createMcpApplicationContext({
    principal: Object.freeze({
      kind: 'authenticated' as const,
      principalId: AUTHENTICATED.principalId,
      clientId: AUTHENTICATED.clientId,
      credentialBindingId: AUTHENTICATED.credentialBindingId,
      resourceAudience: AUTHENTICATED.resourceAudience,
      securityEpoch: AUTHENTICATED.securityEpoch,
    }),
    scopes: Object.freeze(['mcp:read:public', 'mcp:read:own', 'nodes:write']),
    abortSignal: new AbortController().signal,
    budgets: DEFAULT_MCP_RESOURCE_READ_BUDGET,
    correlationId: 'owned-list',
    authorization: Object.freeze({ accountSubjectId: 'subject-alice' }),
  });
  const listed = await facade.listTools(context);
  assert.equal(listed.tools.some((tool) => tool.name === 'collections.list'), true);
  const called = await facade.callTool(context, 'collections.list', {});
  assert.equal(called.kind, 'complete');
  if (called.kind !== 'complete') return;
  assert.equal(
    Array.isArray(called.content) ? (called.content[0] as { type?: string } | undefined)?.type : undefined,
    'text',
  );
  assert.deepEqual(JSON.parse(
    Array.isArray(called.content) && called.content[0] && 'text' in called.content[0]
      ? String(called.content[0].text)
      : 'null',
  ), called.structuredContent);
  assert.deepEqual(called.structuredContent, {
    page: { returnedCount: 1, hasMore: false, nextCursor: null },
    collections: [
      {
        id: 'col-owned-1',
        title: '测试收藏夹',
        visibility: 'private',
        rootNodeId: 'root-owned-1',
        revision: 'r1',
        contentRevision: 'c1',
        policyRevision: 'p1',
      },
    ],
  });
});

