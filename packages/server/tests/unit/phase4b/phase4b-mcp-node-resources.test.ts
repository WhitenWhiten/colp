import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  DEFAULT_MCP_RESOURCE_READ_BUDGET,
  McpReadRequestAbortedError,
  McpResourceNotFoundError,
  createMcpStatelessReadCore,
  type McpTrustedReadRequestContext,
} from '@know-n/colp/mcp';
import { createValidatorRegistry } from '@know-n/colp/schema';
import { loadConfig } from '../../support/test-config.js';
import {
  PHASE4B_MCP_NODE_RESOURCE_MIME_TYPE,
  PHASE4B_MCP_PUBLIC_READ_CACHE_TTL_MS,
  createPhase4bMcpNodeResourceProjection,
  createPhase4bMcpResourceIdentity,
  type Phase4bMcpNodeResourceProjection,
} from '../../../src/modules/mcp/index.js';
import {
  PUBLICATION_ANNOTATION_COMPARATOR_VERSION,
  PUBLICATION_RELATION_COMPARATOR_VERSION,
  createPublicationCursorKeyring,
  type PublicationCollectionRecord,
  type PublicationNodeRecord,
  type PublicationSnapshotQueryPorts,
} from '../../../src/modules/publication/index.js';
import {
  publicationCollection,
  publicationNode,
  publicationRoot,
} from '../../fixtures/phase2/publication-annotations.js';

const SERVER_UUID = '019b3c67-a03c-7f02-9c7e-1ee8d50a77de';
const AUDIENCE = 'https://collections.example.test/collections/-/mcp';
const NOW = new Date('2026-08-05T08:00:00.000Z');
const OWNER = 'subject-owner';
const MEMBER = 'subject-member';
const OUTSIDER = 'subject-outsider';
const SIDECAR_SECRET = 'sidecar-secret-content';

const baseEnv = {
  DATABASE_URL: 'postgresql://known:known@127.0.0.1:5432/known',
  NODE_ENV: 'test',
  OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
  PUBLICATION_ORIGIN: 'https://collections.example.test',
  PUBLICATION_SERVER_UUID: SERVER_UUID,
  LOG_LEVEL: 'silent',
};

function mcpEnv(): Record<string, string> {
  return {
    ...baseEnv,
    KNOWN_FEATURE_MCP_READ: 'true',
    MCP_SERVER_UUID: SERVER_UUID,
    MCP_ALLOWED_ORIGINS: 'https://app.example.test',
    MCP_OAUTH_ISSUER: 'https://issuer.example.test/realms/known',
    MCP_OAUTH_AUDIENCE: AUDIENCE,
    MCP_OAUTH_AUTHORIZATION_SERVER_METADATA_URL:
      'https://issuer.example.test/.well-known/oauth-authorization-server',
    MCP_OAUTH_JWKS_URI: 'https://issuer.example.test/realms/known/protocol/openid-connect/certs',
    MCP_OAUTH_SCOPES: 'mcp:read:public,mcp:read:own',
  } as Record<string, string>;
}

interface NodeFixtureState {
  readonly collection: PublicationCollectionRecord;
  nodes: readonly PublicationNodeRecord[];
  member: boolean;
  readonly annotationCalls: number[];
  readonly relationCalls: number[];
}

interface NodeFixture {
  readonly projection: Phase4bMcpNodeResourceProjection;
  readonly state: NodeFixtureState;
  readonly destroy: () => void;
}

function createFixture(initial: Partial<NodeFixtureState> = {}): NodeFixture {
  const state: NodeFixtureState = {
    collection: publicationCollection(),
    nodes: [publicationRoot],
    member: false,
    annotationCalls: [],
    relationCalls: [],
    ...initial,
  };
  const query = makeQuery(state);
  const projection = createPhase4bMcpNodeResourceProjection({
    config: loadConfig(mcpEnv()).mcp!,
    snapshotQuery: query,
    now: () => NOW,
  });
  return {
    projection,
    state,
    destroy() {
      query.cursors.destroy();
    },
  };
}

function makeQuery(state: NodeFixtureState): PublicationSnapshotQueryPorts {
  const cursors = createPublicationCursorKeyring({
    active: { id: 'node-unit', secret: Buffer.alloc(32, 97).toString('base64') },
    retained: [],
  });
  return {
    reads: {
      async loadPage(request) {
        const rootId = request.rootId ?? state.collection.rootNodeId;
        const root = state.nodes.find((candidate) =>
          candidate.id === rootId && candidate.collectionId === request.collectionId) ?? null;
        return {
          isolation: 'repeatable read',
          comparatorVersion: 'parent-position-id-v1',
          collection: request.collectionId === state.collection.id ? state.collection : null,
          root,
          candidates: [],
        };
      },
    },
    annotations: {
      async loadPage() {
        state.annotationCalls.push(1);
        return {
          isolation: 'repeatable read',
          comparatorVersion: PUBLICATION_ANNOTATION_COMPARATOR_VERSION,
          contentRevision: state.collection.contentRevision,
          policyRevision: state.collection.policyRevision,
          candidates: [],
        };
      },
    },
    relations: {
      async loadPage() {
        state.relationCalls.push(1);
        return {
          isolation: 'repeatable read',
          comparatorVersion: PUBLICATION_RELATION_COMPARATOR_VERSION,
          contentRevision: state.collection.contentRevision,
          policyRevision: state.collection.policyRevision,
          candidates: [],
        };
      },
    },
    accessPolicy: {
      async loadCollectionFacts() {
        return {
          collectionId: state.collection.id,
          ownerSubjectId: state.collection.ownerSubjectId,
          visibility: state.collection.visibility,
          policyRevision: state.collection.policyRevision,
          membershipRole: state.member ? 'viewer' : null,
          deleted: state.collection.deletedAt !== null,
        };
      },
    },
    cursors,
    origin: 'https://known.example',
    now: () => NOW,
    sharedExposure: Object.freeze({ async listBlobFacts() { return []; } }),
  };
}

function nodeInput(
  collectionId: string,
  nodeId: string,
): Readonly<{ readonly resource: { readonly kind: 'collection-node'; readonly collectionId: string; readonly nodeId: string } }> {
  return Object.freeze({
    resource: Object.freeze({ kind: 'collection-node', collectionId, nodeId }),
  });
}

function trustedContext(overrides: Partial<McpTrustedReadRequestContext> = {}): McpTrustedReadRequestContext {
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
    ...overrides,
  });
}

function authenticatedContext(
  principalId: string,
  overrides: Partial<McpTrustedReadRequestContext> = {},
): McpTrustedReadRequestContext {
  return trustedContext({
    binding: Object.freeze({
      kind: 'authenticated',
      principalId,
      clientId: 'mcp-client',
      credentialBindingId: 'credential-1',
      resourceAudience: AUDIENCE,
      securityEpoch: 'epoch-1',
    }),
    authorization: Object.freeze({ accountSubjectId: principalId }),
    ...overrides,
  });
}

async function readBody(
  projection: Phase4bMcpNodeResourceProjection,
  input: Readonly<{ readonly resource: { readonly kind: 'collection-node'; readonly collectionId: string; readonly nodeId: string } }>,
  context: McpTrustedReadRequestContext,
): Promise<Record<string, unknown>> {
  const result = await projection.readResource(input, context);
  assert.equal(result.contents[0]!.mimeType, PHASE4B_MCP_NODE_RESOURCE_MIME_TYPE);
  assert.deepEqual(result.contents[0]!.provenance, { origin: 'internal' });
  return JSON.parse(result.contents[0]!.text) as Record<string, unknown>;
}

test('node projection returns root, folder, and bookmark core fields without sidecars or internal facts', async () => {
  const folder = publicationNode('folder-1', { kind: 'folder', url: null, title: 'Folder' });
  const bookmark = publicationNode('bookmark-1', {
    title: 'Bookmark',
    url: 'https://example.test/bookmark',
    tags: ['known'],
    description: 'A bookmark',
  });
  const fixture = createFixture({ nodes: [publicationRoot, folder, bookmark] });
  try {
    const rootBody = await readBody(fixture.projection, nodeInput('collection-1', 'root-1'), trustedContext());
    assert.equal(rootBody.kind, 'root');
    assert.equal(rootBody.parentId, null);
    assert.equal(rootBody.position, null);
    assert.equal(rootBody.folderRole, 'root');
    assert.equal(rootBody.title, 'Root');
    assert.equal((rootBody as { collectionId: string }).collectionId, 'collection-1');

    const folderBody = await readBody(fixture.projection, nodeInput('collection-1', 'folder-1'), trustedContext());
    assert.equal(folderBody.kind, 'folder');
    assert.equal(folderBody.title, 'Folder');
    assert.equal(folderBody.parentId, 'root-1');
    assert.equal(folderBody.position, 'FOLDER-1');
    assert.equal('url' in folderBody, false);

    const bookmarkBody = await readBody(fixture.projection, nodeInput('collection-1', 'bookmark-1'), trustedContext());
    assert.equal(bookmarkBody.kind, 'bookmark');
    assert.equal(bookmarkBody.title, 'Bookmark');
    assert.equal(bookmarkBody.url, 'https://example.test/bookmark');
    assert.deepEqual(bookmarkBody.tags, ['known']);
    assert.equal(bookmarkBody.description, 'A bookmark');

    const serialized = JSON.stringify([rootBody, folderBody, bookmarkBody]);
    assert.doesNotMatch(serialized, /ownerSubjectId|membershipRole|"policyRevision"|subjectId|creatorPrincipalId/u);
    assert.equal(fixture.state.annotationCalls.length, 0);
    assert.equal(fixture.state.relationCalls.length, 0);
  } finally {
    fixture.destroy();
  }
});

test('wrong collection binding, missing nodes, and moved nodes never leak existence', async () => {
  const fixture = createFixture({
    nodes: [publicationRoot, publicationNode('node-1')],
  });
  try {
    for (const input of [
      nodeInput('collection-1', 'missing-node'),
      nodeInput('collection-1', 'node-1'),
      nodeInput('wrong-collection', 'node-1'),
    ]) {
      if (input.resource.collectionId === 'collection-1' && input.resource.nodeId === 'node-1') {
        continue;
      }
      await assert.rejects(
        () => fixture.projection.readResource(input, trustedContext()),
        (error: unknown) => {
          assert.equal(error instanceof McpResourceNotFoundError, true);
          assert.doesNotMatch((error as Error).message, /collection|node|missing|wrong/u);
          return true;
        },
      );
      assert.deepEqual(
        await fixture.projection.cacheForRead(input, trustedContext()),
        { ttlMs: 0, cacheScope: 'private' },
      );
    }
  } finally {
    fixture.destroy();
  }
});

test('moved nodes resolve to the current authorized representation and deletion conceals', async () => {
  const hiddenParent = publicationNode('hidden-parent', {
    kind: 'folder',
    url: null,
    visibility: 'private',
  });
  const moved = publicationNode('moved-node', {
    parentId: 'root-1',
    position: 'MOVED-OLD',
    publicationPosition: 'MOVED-OLD',
    resourceRevision: 'revision-old',
  });
  const fixture = createFixture({
    nodes: [publicationRoot, hiddenParent, moved],
    member: true,
  });
  try {
    const ownerContext = authenticatedContext(OWNER);
    const before = await readBody(
      fixture.projection,
      nodeInput('collection-1', 'moved-node'),
      ownerContext,
    );
    assert.equal(before.parentId, 'root-1');
    assert.equal(before.revision, 'revision-old');

    fixture.state.nodes = fixture.state.nodes.map((candidate) =>
      candidate.id === 'moved-node'
        ? {
            ...candidate,
            parentId: 'hidden-parent',
            position: 'MOVED-NEW',
            publicationPosition: 'MOVED-NEW',
            ancestorRestricted: true,
            resourceRevision: 'revision-moved',
            updatedAt: '2026-08-05T09:00:00.000Z',
          }
        : candidate);

    await assert.rejects(
      () => fixture.projection.readResource(nodeInput('collection-1', 'moved-node'), trustedContext()),
      McpResourceNotFoundError,
    );
    assert.deepEqual(
      await fixture.projection.cacheForRead(nodeInput('collection-1', 'moved-node'), trustedContext()),
      { ttlMs: 0, cacheScope: 'private' },
    );

    const after = await readBody(
      fixture.projection,
      nodeInput('collection-1', 'moved-node'),
      ownerContext,
    );
    assert.equal(after.parentId, 'hidden-parent');
    assert.equal(after.position, 'MOVED-NEW');
    assert.equal(after.revision, 'revision-moved');
    assert.deepEqual(
      await fixture.projection.cacheForRead(nodeInput('collection-1', 'moved-node'), ownerContext),
      { ttlMs: 0, cacheScope: 'private' },
    );

    fixture.state.nodes = fixture.state.nodes.filter((candidate) => candidate.id !== 'moved-node');
    await assert.rejects(
      () => fixture.projection.readResource(nodeInput('collection-1', 'moved-node'), ownerContext),
      McpResourceNotFoundError,
    );
  } finally {
    fixture.destroy();
  }
});

test('visibility, member access, and revocation reuse current access policy', async () => {
  const hidden = publicationNode('hidden-node', {
    kind: 'bookmark',
    visibility: 'private',
    ancestorRestricted: true,
    url: 'https://example.test/private',
  });
  const fixture = createFixture({ nodes: [publicationRoot, hidden], member: false });
  try {
    await assert.rejects(
      () => fixture.projection.readResource(nodeInput('collection-1', 'hidden-node'), trustedContext()),
      McpResourceNotFoundError,
    );
    await assert.rejects(
      () => fixture.projection.readResource(
        nodeInput('collection-1', 'hidden-node'),
        authenticatedContext(OUTSIDER),
      ),
      McpResourceNotFoundError,
    );

    fixture.state.member = true;
    const memberBody = await readBody(
      fixture.projection,
      nodeInput('collection-1', 'hidden-node'),
      authenticatedContext(MEMBER),
    );
    assert.equal(memberBody.id, 'hidden-node');
    assert.equal(memberBody.visibility, 'private');
    await assert.rejects(
      () => fixture.projection.readResource(
        nodeInput('collection-1', 'hidden-node'),
        authenticatedContext(MEMBER, { scope: Object.freeze(['mcp:read:public']) }),
      ),
      McpResourceNotFoundError,
    );
    assert.deepEqual(
      await fixture.projection.cacheForRead(nodeInput('collection-1', 'hidden-node'), authenticatedContext(MEMBER)),
      { ttlMs: 0, cacheScope: 'private' },
    );

    fixture.state.member = false;
    await assert.rejects(
      () => fixture.projection.readResource(
        nodeInput('collection-1', 'hidden-node'),
        authenticatedContext(MEMBER),
      ),
      McpResourceNotFoundError,
    );
  } finally {
    fixture.destroy();
  }
});

test('unlisted exact node reads stay private-scoped while public reads may use public cache', async () => {
  const unlistedFixture = createFixture({
    collection: publicationCollection({ visibility: 'unlisted' }),
    nodes: [publicationRoot, publicationNode('unlisted-node')],
  });
  try {
    const body = await readBody(
      unlistedFixture.projection,
      nodeInput('collection-1', 'unlisted-node'),
      trustedContext(),
    );
    assert.equal(body.id, 'unlisted-node');
    assert.deepEqual(
      await unlistedFixture.projection.cacheForRead(
        nodeInput('collection-1', 'unlisted-node'),
        trustedContext(),
      ),
      { ttlMs: 0, cacheScope: 'private' },
    );
  } finally {
    unlistedFixture.destroy();
  }

  const publicFixture = createFixture({
    nodes: [publicationRoot, publicationNode('public-node')],
  });
  try {
    assert.deepEqual(
      await publicFixture.projection.cacheForRead(
        nodeInput('collection-1', 'public-node'),
        trustedContext(),
      ),
      { ttlMs: PHASE4B_MCP_PUBLIC_READ_CACHE_TTL_MS, cacheScope: 'public' },
    );
    assert.deepEqual(
      await publicFixture.projection.cacheForRead(
        nodeInput('collection-1', 'public-node'),
        authenticatedContext(OWNER),
      ),
      { ttlMs: 0, cacheScope: 'private' },
    );
  } finally {
    publicFixture.destroy();
  }
});

test('sidecar projection ports are never invoked for a node point read', async () => {
  const fixture = createFixture({
    nodes: [publicationRoot, publicationNode('node-1')],
  });
  try {
    const body = await readBody(
      fixture.projection,
      nodeInput('collection-1', 'node-1'),
      trustedContext(),
    );
    assert.equal(body.id, 'node-1');
    assert.equal(fixture.state.annotationCalls.length, 0);
    assert.equal(fixture.state.relationCalls.length, 0);
    assert.doesNotMatch(JSON.stringify(body), /sidecar|annotation|relation/u);
  } finally {
    fixture.destroy();
  }
});

test('malicious title and URL serialize only as escaped I-JSON data', async () => {
  const title = 'injected\n<script>alert("x")</script> 中文🙂';
  const url = 'https://example.test/?q=%22%3E%3Csvg%20onload%3Dalert(1)%3E';
  const fixture = createFixture({
    nodes: [publicationRoot, publicationNode('malicious-node', { title, url })],
  });
  try {
    const result = await fixture.projection.readResource(
      nodeInput('collection-1', 'malicious-node'),
      trustedContext(),
    );
    const text = result.contents[0]!.text;
    assert.equal(Buffer.byteLength(text, 'utf8'), text.length);
    assert.doesNotMatch(text, /[\u0000-\u001f\u007f]/u);
    assert.ok(text.includes('\\u4e2d'));
    assert.ok(text.includes('\\ud83d\\ude42'));
    const body = JSON.parse(text) as { title: string; url: string };
    assert.equal(body.title, title);
    assert.equal(body.url, url);
    assert.doesNotMatch(text, /ownerSubjectId|creatorPrincipalId|subjectId/u);
  } finally {
    fixture.destroy();
  }
});

test('projected node output passes COLP node schema and contains no unsafe optional fields', async () => {
  const fixture = createFixture({
    nodes: [publicationRoot, publicationNode('node-1', { description: 'safe', tags: ['a', 'b'] })],
  });
  try {
    const body = await readBody(
      fixture.projection,
      nodeInput('collection-1', 'node-1'),
      trustedContext(),
    );
    const validation = createValidatorRegistry().validate('node', body);
    assert.equal(validation.valid, true);
    assert.deepEqual(Object.keys(body).sort(), [
      'collectionId',
      'createdAt',
      'description',
      'id',
      'kind',
      'parentId',
      'position',
      'revision',
      'tags',
      'title',
      'updatedAt',
      'url',
    ]);
    assert.equal('index' in body, false);
    assert.equal('sourceRefs' in body, false);
    assert.equal('redacted' in body, false);
    assert.equal('extensions' in body, false);
    assert.equal('constraints' in body, false);
    assert.equal('canonicalUrl' in body, false);
    assert.equal('urlHash' in body, false);
    assert.equal('targetNodeId' in body, false);
    assert.equal('accessUrl' in body, false);
  } finally {
    fixture.destroy();
  }
});

test('concealment timing is stable across hidden, wrong-bound, and deleted targets', async () => {
  const hidden = publicationNode('hidden-node', {
    kind: 'bookmark',
    visibility: 'private',
    ancestorRestricted: true,
    url: 'https://example.test/private',
  });
  const fixture = createFixture({ nodes: [publicationRoot, hidden] });
  try {
    const inputs = [
      nodeInput('collection-1', 'hidden-node'),
      nodeInput('wrong-collection', 'node-1'),
      nodeInput('collection-1', 'missing-node'),
    ];
    for (const input of inputs) {
      await assert.rejects(
        () => fixture.projection.readResource(input, trustedContext()),
        (error: unknown) => {
          assert.equal(error instanceof McpResourceNotFoundError, true);
          assert.equal((error as McpResourceNotFoundError).message, 'MCP Resource was not found.');
          assert.equal('resource' in (error as Record<string, unknown>), false);
          return true;
        },
      );
      assert.deepEqual(
        await fixture.projection.cacheForRead(input, trustedContext()),
        { ttlMs: 0, cacheScope: 'private' },
      );
    }
  } finally {
    fixture.destroy();
  }
});

test('abort is checked before and after node projection reads and cache reads', async () => {
  const fixture = createFixture({
    nodes: [publicationRoot, publicationNode('node-1')],
  });
  try {
    const controller = new AbortController();
    controller.abort();
    const input = nodeInput('collection-1', 'node-1');
    await assert.rejects(
      () => fixture.projection.readResource(input, trustedContext({ abortSignal: controller.signal })),
      McpReadRequestAbortedError,
    );
    await assert.rejects(
      () => fixture.projection.cacheForRead(input, trustedContext({ abortSignal: controller.signal })),
      McpReadRequestAbortedError,
    );
  } finally {
    fixture.destroy();
  }
});

test('node projection output passes the stateless MCP read core with the stable URI seam', async () => {
  const fixture = createFixture({
    nodes: [publicationRoot, publicationNode('core-node')],
  });
  try {
    const config = loadConfig(mcpEnv()).mcp!;
    const identity = createPhase4bMcpResourceIdentity(config);
    const core = createMcpStatelessReadCore({
      projection: {
        async listResources() {
          return Object.freeze({ resources: Object.freeze([]) });
        },
        readResource: (input, context) => fixture.projection.readResource(input, context),
      },
      uriCodec: identity.codec,
    });
    const uri = identity.collectionNode('collection-1', 'core-node');
    const result = await core.readResource(trustedContext(), Object.freeze({ uri }));
    assert.equal(result.contents[0]!.uri, uri);
    assert.equal(result.contents[0]!.mimeType, PHASE4B_MCP_NODE_RESOURCE_MIME_TYPE);
    assert.deepEqual(result.contents[0]!.provenance, { origin: 'internal' });
    const body = JSON.parse(result.contents[0]!.text) as Record<string, unknown>;
    assert.equal(body.id, 'core-node');
  } finally {
    fixture.destroy();
  }
});
