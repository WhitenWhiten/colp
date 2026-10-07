import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import {
  PHASE4B_MCP_READ_TOOL_COLLECTION_ID_HEADER,
  PHASE4B_MCP_WELL_KNOWN_ANONYMOUS_TOOLS,
  PHASE4B_MCP_WELL_KNOWN_DISCOVERY_PATH,
  createPhase4bMcpCollectionResourceCursorKeyring,
  createPhase4bMcpCollectionResourceProjection,
  createPhase4bMcpReadToolAdapter,
} from '../../../src/modules/mcp/index.js';
import {
  createPublicationCursorKeyring,
  type PublicationMetadataRecord,
} from '../../../src/modules/publication/index.js';
import {
  apps,
  authFixture,
  mcpEnv,
  modernBody,
  NOW,
  parseJsonRpc,
  postJson,
  SERVER_UUID,
  startApi,
  toolSnapshotProjection,
  emptyNodeResourceProjection,
} from '../../support/phase4b-mcp-transport-scaffold.js';

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close().catch(() => undefined)));
});

const OWNER = 'subject-owner';

function metadataRecord(
  id: string,
  visibility: 'public' | 'private',
): PublicationMetadataRecord {
  return {
    id,
    ownerSubjectId: OWNER,
    kind: 'bookmarks',
    title: id,
    summary: null,
    visibility,
    publicationSlug: id,
    rootNodeId: `${id}-root`,
    rootAvailable: true,
    contentRevision: 'content-1',
    policyRevision: 'policy-1',
    tags: [],
    language: null,
    membershipRole: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-08-05T08:00:00.000Z',
    deletedAt: null,
  };
}

function createConcealmentProjection() {
  const records = [
    metadataRecord('collection-1', 'public'),
    metadataRecord('private-collection', 'private'),
  ];
  const publicationCursors = createPublicationCursorKeyring({
    active: { id: 'anonymous-tools-publication', secret: Buffer.alloc(32, 41).toString('base64') },
    retained: [],
  });
  const mcpCursors = createPhase4bMcpCollectionResourceCursorKeyring({
    active: { id: 'anonymous-tools-mcp', secret: Buffer.alloc(32, 43).toString('base64') },
    retained: [],
    ttlMs: 60_000,
    now: () => NOW,
  });
  const projection = createPhase4bMcpCollectionResourceProjection({
    config: loadConfig(mcpEnv()).mcp!,
    directoryQuery: {
      reads: { async loadPage() { return []; } },
      cursors: publicationCursors,
      origin: 'https://known.example',
    },
    metadataQuery: {
      reads: {
        async load(input) {
          const key = input.collectionId ?? input.publicationSlug;
          return records.find((record) => record.id === key || record.publicationSlug === key)
            ?? null;
        },
      },
      origin: 'https://known.example',
      now: () => NOW,
    },
    accessPolicy: {
      async loadCollectionFacts(input) {
        const record = records.find((candidate) => candidate.id === input.collectionId);
        if (record === undefined) return null;
        return {
          collectionId: record.id,
          ownerSubjectId: record.ownerSubjectId,
          visibility: record.visibility,
          policyRevision: record.policyRevision,
          membershipRole: input.actorSubjectId === OWNER ? 'owner' : null,
          deleted: false,
        };
      },
    },
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

function collectionGetCall(
  server: Awaited<ReturnType<typeof startApi>>,
  id: number,
  collectionId: string,
  headers: Record<string, string> = {},
) {
  return postJson(server, 'tools/call', id, {
    headers: {
      'mcp-name': 'collections.get',
      [`mcp-param-${PHASE4B_MCP_READ_TOOL_COLLECTION_ID_HEADER}`]: collectionId,
      ...headers,
    },
    body: modernBody('tools/call', id, {
      name: 'collections.get',
      arguments: { collectionId },
    }),
  });
}

test('anonymous public tools/call succeeds and private matches authenticated unauthorized', async () => {
  assert.equal(PHASE4B_MCP_WELL_KNOWN_ANONYMOUS_TOOLS, true);
  const fixture = await authFixture();
  const projection = createConcealmentProjection();
  try {
    const toolAdapter = createPhase4bMcpReadToolAdapter({
      collectionProjection: projection.projection,
      snapshotProjection: toolSnapshotProjection(),
      nodeProjection: emptyNodeResourceProjection(),
      serverUuid: SERVER_UUID,
    });
    const server = await startApi(mcpEnv(), { oauthVerifier: fixture.verifier }, toolAdapter);

    const discovery = await fetch(`${server.origin}${PHASE4B_MCP_WELL_KNOWN_DISCOVERY_PATH}`);
    assert.equal(discovery.status, 200);
    assert.deepEqual((await discovery.json() as { anonymous: unknown }).anonymous, {
      resources: true,
      tools: true,
    });

    const anonymousList = parseJsonRpc(await (await postJson(server, 'tools/list', 0)).text());
    assert.deepEqual(
      (anonymousList.result?.tools as ReadonlyArray<{ readonly name: string }> | undefined)
        ?.map((tool) => tool.name),
      ['collections.get', 'collections.get_snapshot', 'nodes.get'],
    );

    const publicCall = await collectionGetCall(server, 1, 'collection-1');
    assert.equal(publicCall.status, 200);
    const publicPayload = parseJsonRpc(await publicCall.text());
    assert.equal(publicPayload.error, undefined);
    assert.equal(
      (publicPayload.result?.structuredContent as { collection?: { id?: string } })?.collection?.id,
      'collection-1',
    );

    const anonymousPrivate = parseJsonRpc(await (await collectionGetCall(server, 2, 'private-collection')).text());
    const authenticatedPrivate = parseJsonRpc(await (await collectionGetCall(server, 3, 'private-collection', {
      authorization: `Bearer ${fixture.token}`,
    })).text());
    assert.equal(anonymousPrivate.error?.code, -32602);
    assert.deepEqual(anonymousPrivate.error, authenticatedPrivate.error);
    assert.doesNotMatch(anonymousPrivate.error?.message ?? '', /private-collection/u);

    const writeCall = parseJsonRpc(await (await postJson(server, 'tools/call', 4, {
      headers: { 'mcp-name': 'changes.plan' },
      body: modernBody('tools/call', 4, { name: 'changes.plan', arguments: {} }),
    })).text());
    assert.equal(writeCall.error?.code, -32602);
    assert.match(writeCall.error?.message ?? '', /Unknown tool/u);
  } finally {
    projection.destroy();
  }
});
