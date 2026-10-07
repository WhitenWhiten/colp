import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  DEFAULT_MCP_RESOURCE_READ_BUDGET,
  type McpTrustedReadRequestContext,
} from '@know-n/colp/mcp';
import { loadConfig } from '../../support/test-config.js';
import {
  PHASE4B_MCP_COLLECTION_RESOURCE_DESCRIPTION_MAX_CHARS,
  PHASE4B_MCP_PUBLIC_READ_CACHE_TTL_MS,
  createPhase4bMcpChangeSignalSource,
  createPhase4bMcpCollectionResourceCursorKeyring,
  createPhase4bMcpCollectionResourceProjection,
} from '../../../src/modules/mcp/index.js';
import {
  createPublicationCursorKeyring,
  type PublicationDirectoryReadPort,
  type PublicationDirectoryRecord,
  type PublicationMetadataRecord,
} from '../../../src/modules/publication/index.js';
import type { AccessPolicyFactsPort } from '../../../src/modules/access-policy/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { mapMcpListResourceWireItem } from '../../../src/transport/mcp/mcp-read-routes.js';
import { emptyReadToolAdapterBundle } from '../../support/phase4b-mcp-read-tools-fixture.js';
import {
  emptyNodeResourceProjection,
  emptySnapshotResourceProjection,
  mcpEnv,
  modernBody,
  parseJsonRpc,
  postJson,
  SERVER_UUID,
  type TestServer,
} from '../../support/phase4b-mcp-transport-scaffold.js';

const AUDIENCE = 'https://collections.example.test/collections/-/mcp';
const NOW = new Date('2026-08-05T08:00:00.000Z');
const LONG_SUMMARY = `Fresh public notes. ${'x'.repeat(400)}`;

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close().catch(() => undefined)));
});

interface AnnotatedItem {
  readonly uri: string;
  readonly name: string;
  readonly description?: string;
  readonly _meta?: { readonly nodeCount: number; readonly updatedAt: string };
}

function directoryRecords(): PublicationDirectoryRecord[] {
  return [
    {
      id: 'fresh',
      ownerSubjectId: 'owner',
      title: 'Fresh Collection',
      summary: LONG_SUMMARY,
      kind: 'bookmarks',
      visibility: 'public',
      publicationSlug: 'fresh',
      tags: [],
      language: null,
      nodeCount: 12,
      updatedAt: '2026-08-05T07:00:00.000Z',
      orderingUpdatedAtMicros: '3000000',
      protectedAuthorized: false,
    },
    {
      id: 'older',
      ownerSubjectId: 'owner',
      title: 'Older Collection',
      summary: '  A short public path.  ',
      kind: 'bookmarks',
      visibility: 'public',
      publicationSlug: 'older',
      tags: [],
      language: null,
      nodeCount: 3,
      updatedAt: '2026-07-01T00:00:00.000Z',
      orderingUpdatedAtMicros: '2000000',
      protectedAuthorized: false,
    },
  ];
}

function metadataRecords(): PublicationMetadataRecord[] {
  return directoryRecords().map((record) => ({
    id: record.id,
    ownerSubjectId: record.ownerSubjectId,
    kind: record.kind,
    title: record.title,
    summary: record.summary,
    visibility: record.visibility,
    publicationSlug: record.publicationSlug,
    rootNodeId: `${record.id}-root`,
    rootAvailable: true,
    contentRevision: 'content-1',
    policyRevision: 'policy-1',
    tags: record.tags,
    language: record.language,
    membershipRole: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: record.updatedAt,
    deletedAt: null,
  }));
}

function createDirectoryRead(): PublicationDirectoryReadPort {
  const records = directoryRecords();
  return {
    async loadPage(request) {
      const sorted = [...records].sort((left, right) => {
        const time = Number(right.orderingUpdatedAtMicros) - Number(left.orderingUpdatedAtMicros);
        if (time !== 0) return time;
        return left.id.localeCompare(right.id, 'en', { sensitivity: 'variant' });
      });
      let page = sorted;
      if (request.after !== undefined) {
        const anchor = sorted.find((record) =>
          createHash('sha256').update(record.id).digest('hex').slice(0, 32)
            === request.after!.idLocator);
        const anchorIndex = anchor === undefined ? -1 : sorted.indexOf(anchor);
        if (anchorIndex < 0) throw new Error('publication directory anchor missing');
        page = sorted.slice(anchorIndex + 1);
      }
      return Object.freeze(page.slice(0, request.limit + 1));
    },
  };
}

function createProjection() {
  const publicationCursors = createPublicationCursorKeyring({
    active: { id: 'publication-wire', secret: Buffer.alloc(32, 41).toString('base64') },
    retained: [],
  });
  const mcpCursors = createPhase4bMcpCollectionResourceCursorKeyring({
    active: { id: 'mcp-wire', secret: Buffer.alloc(32, 43).toString('base64') },
    retained: [],
    ttlMs: 60_000,
    now: () => NOW,
  });
  const projection = createPhase4bMcpCollectionResourceProjection({
    config: loadConfig(mcpEnv()).mcp!,
    directoryQuery: {
      reads: createDirectoryRead(),
      cursors: publicationCursors,
      origin: 'https://known.example',
    },
    metadataQuery: {
      reads: {
        async load(input) {
          const key = input.collectionId ?? input.publicationSlug;
          return metadataRecords().find((record) =>
            record.id === key || record.publicationSlug === key) ?? null;
        },
      },
      origin: 'https://known.example',
      now: () => NOW,
    },
    accessPolicy: {
      async loadCollectionFacts() { return null; },
    } as AccessPolicyFactsPort,
    cursorKeys: mcpCursors,
    now: () => NOW,
    pageSize: 2,
    sharedExposure: Object.freeze({ async listBlobFacts() { return []; } }),
  });
  return {
    projection,
    destroy() {
      mcpCursors.destroy();
      publicationCursors.destroy();
    },
  };
}

function anonymousContext(): McpTrustedReadRequestContext {
  return Object.freeze({
    binding: Object.freeze({
      kind: 'anonymous',
      principalId: 'public',
      resourceAudience: AUDIENCE,
      securityEpoch: 'epoch-1',
    }),
    scope: Object.freeze([]),
    budget: DEFAULT_MCP_RESOURCE_READ_BUDGET,
    abortSignal: new AbortController().signal,
    authorization: Object.freeze({}),
  });
}

async function startListApi(
  projection: ReturnType<typeof createProjection>['projection'],
): Promise<TestServer> {
  const env = mcpEnv();
  const config = loadConfig(env);
  const toolAdapter = emptyReadToolAdapterBundle();
  const app = buildApiApp({
    config,
    mcpReadTransport: {
      changeSignalSource: createPhase4bMcpChangeSignalSource(),
      readToolAdapter: toolAdapter.adapter,
      readToolParamDeclarations: toolAdapter.paramDeclarations,
    },
    mcpReadResourceProjection: projection,
    mcpNodeResourceProjection: emptyNodeResourceProjection(),
    mcpSnapshotResourceProjection: emptySnapshotResourceProjection(),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  apps.push(app);
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('server is not listening');
  return { app, config, origin: `http://127.0.0.1:${address.port}` };
}

function assertAnnotatedFirstPage(items: readonly AnnotatedItem[]): void {
  assert.deepEqual(items.map((entry) => entry.uri.split('/').at(-1)), ['fresh', 'older']);
  assert.equal(items[0]!.description?.startsWith('Fresh public notes.'), true);
  assert.equal(items[0]!.description?.endsWith('…'), true);
  assert.ok((items[0]!.description?.length ?? 0) <= PHASE4B_MCP_COLLECTION_RESOURCE_DESCRIPTION_MAX_CHARS);
  assert.deepEqual(items[0]!._meta, { nodeCount: 12, updatedAt: '2026-08-05T07:00:00.000Z' });
  assert.equal(items[1]!.description, 'A short public path.');
  assert.deepEqual(items[1]!._meta, { nodeCount: 3, updatedAt: '2026-07-01T00:00:00.000Z' });
}

test('remapper forwards projection description and _meta without inventing keys', async () => {
  const fixture = createProjection();
  try {
    const listed = await fixture.projection.listResources(Object.freeze({}), anonymousContext());
    const items = listed.resources as readonly AnnotatedItem[];
    assertAnnotatedFirstPage(items);
    const wire = items.map((entry) => mapMcpListResourceWireItem({
      uri: entry.uri,
      name: entry.name,
      mimeType: 'application/vnd.collection-protocol.collection+json',
      ...(entry.description === undefined ? {} : { description: entry.description }),
      ...(entry._meta === undefined ? {} : { _meta: entry._meta }),
    }));
    assert.deepEqual(Object.keys(wire[0]!).sort(), ['_meta', 'description', 'mimeType', 'name', 'uri']);
    assertAnnotatedFirstPage(wire);
  } finally {
    fixture.destroy();
  }
});

test('anonymous HTTP resources/list keeps description, _meta, newest-first, and public cache', async () => {
  const fixture = createProjection();
  try {
    const server = await startListApi(fixture.projection);
    const response = await postJson(server, 'resources/list', 1);
    assert.equal(response.status, 200);
    const payload = parseJsonRpc(await response.text());
    assert.equal(payload.result?.resultType, 'complete');
    assert.equal(payload.result?.cacheScope, 'public');
    assert.equal(payload.result?.ttlMs, PHASE4B_MCP_PUBLIC_READ_CACHE_TTL_MS);
    assert.ok((payload.result?.ttlMs as number) > 0);
    const items = payload.result?.resources as readonly AnnotatedItem[];
    assertAnnotatedFirstPage(items);
    assert.equal(SERVER_UUID.length > 0, true);
  } finally {
    fixture.destroy();
  }
});

test('anonymous HTTP resources/read of public collection metadata uses public cache', async () => {
  const fixture = createProjection();
  try {
    const server = await startListApi(fixture.projection);
    const uri = `colp://${SERVER_UUID}/collections/fresh`;
    const response = await postJson(server, 'resources/read', 2, {
      headers: { 'mcp-name': uri },
      body: modernBody('resources/read', 2, { uri }),
    });
    assert.equal(response.status, 200);
    const payload = parseJsonRpc(await response.text());
    assert.equal(payload.result?.resultType, 'complete');
    assert.equal(payload.result?.cacheScope, 'public');
    assert.equal(payload.result?.ttlMs, PHASE4B_MCP_PUBLIC_READ_CACHE_TTL_MS);
    assert.ok((payload.result?.ttlMs as number) > 0);
    const text = (payload.result?.contents as readonly { readonly text?: string }[] | undefined)
      ?.[0]?.text;
    assert.equal(JSON.parse(text ?? '{}').collection.id, 'fresh');
  } finally {
    fixture.destroy();
  }
});
