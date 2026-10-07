/**
 * P1-06 GET /api/v1/collections/{collectionId}/editor HTTP contract (Fastify inject).
 *
 * Harness:
 *   buildApiApp({ identityUnitOfWork, collectionsUnitOfWork, collectionsEditorReadUnitOfWork })
 *   Memory session + memory editor read UoW wrapping getCollectionEditorPage ports.
 *
 * Covers: 401, 400 invalid_cursor, 404 conceal, 200 shape.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'vitest';
import {
  createIdentityMemoryPorts,
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
  type IdentityMemoryState,
} from '../../support/product-http-harness.js';
import { createMemoryProductCollectionMutationUnitOfWork } from '../../support/product-canonical-memory.js';
import { loadConfig } from '../../support/test-config.js';
import type {
  AccessPolicyFactsPort,
  MembershipRole,
  ResourcePolicyFacts,
} from '../../../src/modules/access-policy/index.js';
import {
  createProductEditorCursorSigner,
  type CollectionEditorSnapshot,
  type CollectionsEditorReadUnitOfWork,
  type CollectionsUnitOfWork,
  type EditorCollectionRow,
  type EditorLiveNodeRow,
  type EditorRootNodeRow,
  type GetCollectionEditorPagePorts,
} from '../../../src/modules/collections/index.js';
import {
  type IdentityPorts,
  type IdentityUnitOfWork,
} from '../../../src/modules/identity/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createInMemoryBetterAuthTestFactory, issueTestSession } from '../../support/better-auth-test-factory.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date('2026-07-22T12:00:00.000Z');
const COLLECTION_ID = 'col-http-editor-1';
const ROOT_ID = 'root-http-editor-1';
const CONTENT_REV = 'content-http-1';
const POLICY_REV = 'policy-http-1';
const RESOURCE_REV = 'resource-http-1';
const CHILDREN_REV = 'children-http-1';
const CURSOR_KEY = 'http-editor-cursor-test-key';

// ---------------------------------------------------------------------------
// Identity memory
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Editor memory state + ports
// ---------------------------------------------------------------------------

interface EditorMembership {
  collectionId: string;
  subjectId: string;
  role: MembershipRole;
}

interface EditorMemoryState {
  now: Date;
  collection: EditorCollectionRow | null;
  root: EditorRootNodeRow | null;
  nodes: EditorLiveNodeRow[];
  memberships: EditorMembership[];
  ownerSubjectId: string;
  cursorKey: string;
  productOrigin: string;
  iconObjectIds: Map<string, string>;
}

function createEditorState(): EditorMemoryState {
  return {
    now: new Date(NOW),
    collection: null,
    root: null,
    nodes: [],
    memberships: [],
    ownerSubjectId: '',
    cursorKey: CURSOR_KEY,
    productOrigin: 'https://app.example.test',
    iconObjectIds: new Map(),
  };
}

function seedEditorCollection(
  state: EditorMemoryState,
  input: {
    collectionId?: string;
    rootId?: string;
    ownerSubjectId: string;
    visibility?: 'private' | 'public';
  },
): void {
  const collectionId = input.collectionId ?? COLLECTION_ID;
  const rootId = input.rootId ?? ROOT_ID;
  const createdAt = new Date(state.now);
  state.ownerSubjectId = input.ownerSubjectId;
  state.collection = {
    id: collectionId,
    kind: 'bookmarks',
    title: 'HTTP Editor Tree',
    summary: null,
    visibility: input.visibility ?? 'private',
    rootNodeId: rootId,
    resourceRevision: RESOURCE_REV,
    contentRevision: CONTENT_REV,
    policyRevision: POLICY_REV,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
  };
  state.root = {
    id: rootId,
    collectionId,
    title: 'HTTP Editor Tree',
    description: null,
    tags: [],
    resourceRevision: RESOURCE_REV,
    childrenRevision: CHILDREN_REV,
    createdAt,
    updatedAt: createdAt,
  };
  state.memberships.push({
    collectionId,
    subjectId: input.ownerSubjectId,
    role: 'owner',
  });
  state.nodes.push({
    id: 'bm-http-1',
    collectionId,
    parentId: rootId,
    kind: 'bookmark',
    title: 'Example',
    url: 'https://example.com/',
    description: null,
    tags: [],
    positionToken: '0001',
    resourceRevision: 'rev-bm-1',
    childrenRevision: 'ch-bm-1',
    createdAt,
    updatedAt: createdAt,
  });
}

function createEditorPorts(state: EditorMemoryState): GetCollectionEditorPagePorts {
  const accessPolicy: AccessPolicyFactsPort = {
    async loadCollectionFacts(input) {
      if (!state.collection || state.collection.id !== input.collectionId) return null;
      const membership = state.memberships.find(
        (m) => m.collectionId === input.collectionId && m.subjectId === input.actorSubjectId,
      );
      const facts: ResourcePolicyFacts = {
        collectionId: state.collection.id,
        ownerSubjectId: state.ownerSubjectId,
        visibility: state.collection.visibility,
        policyRevision: state.collection.policyRevision,
        membershipRole: membership?.role ?? null,
        deleted: state.collection.deletedAt !== null,
      };
      return facts;
    },
  };

  return {
    clock: { now: async () => new Date(state.now) },
    collections: {
      async lockForShare(collectionId) {
        if (!state.collection || state.collection.id !== collectionId) return null;
        const collection = state.collection;
        return {
          id: collection.id,
          ownerSubjectId: state.ownerSubjectId,
          title: collection.title,
          summary: collection.summary,
          kind: collection.kind,
          visibility: collection.visibility,
          allowSearchIndexing: collection.allowSearchIndexing ?? false,
          publicationSlug: collection.publicationSlug ?? null,
          publishedAt: collection.publishedAt ?? null,
          rootNodeId: collection.rootNodeId,
          resourceRevision: collection.resourceRevision,
          contentRevision: collection.contentRevision,
          policyRevision: collection.policyRevision,
          commitOrdinal: 0n,
          createdAt: collection.createdAt,
          updatedAt: collection.updatedAt,
          deletedAt: collection.deletedAt,
        };
      },
    },
    accessPolicy,
    cursorSigner: createProductEditorCursorSigner({ current: { id: 'test-v1', key: state.cursorKey } }),
    productOrigin: state.productOrigin,
    bookmarkIcons: {
      async findObjectIdsByNodeIds(nodeIds) {
        const result = new Map<string, string>();
        if (nodeIds.length === 0) return result;
        for (const id of nodeIds) {
          const objectId = state.iconObjectIds.get(id);
          if (objectId) result.set(id, objectId);
        }
        return result;
      },
    },
    loadSnapshot: {
      async loadCollectionEditorSnapshot(input) {
        if (!state.collection || state.collection.id !== input.collectionId) return null;
        if (!state.root) return null;
        let rows = state.nodes
          .filter((n) => n.collectionId === input.collectionId)
          .slice()
          .sort((a, b) => {
            if (a.parentId !== b.parentId) return a.parentId < b.parentId ? -1 : 1;
            if (a.positionToken !== b.positionToken) {
              return a.positionToken < b.positionToken ? -1 : 1;
            }
            return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
          });
        if (input.after) {
          rows = rows.filter((n) => {
            const after = input.after!;
            if (n.parentId > after.parentKey) return true;
            if (n.parentId < after.parentKey) return false;
            if (n.positionToken > after.positionKey) return true;
            if (n.positionToken < after.positionKey) return false;
            return n.id > after.nodeId;
          });
        }
        const snapshot: CollectionEditorSnapshot = {
          collection: { ...state.collection },
          root: { ...state.root },
          nodes: rows.slice(0, input.limit + 1).map((n) => ({ ...n })),
        };
        return snapshot;
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type ApiApp = ReturnType<typeof buildApiApp>;

interface Harness {
  readonly app: ApiApp;
  readonly config: ReturnType<typeof loadConfig>;
  readonly identityState: IdentityMemoryState;
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly factory: ReturnType<typeof createInMemoryBetterAuthTestFactory>;
  readonly editorState: EditorMemoryState;
}

function createHarness(): Harness {
  const identityState = createIdentityMemoryState(NOW);
  const identityPorts = createIdentityMemoryPorts(identityState);
  const identityUnitOfWork = createIdentityMemoryUnitOfWork(identityState);
  const factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork });

  const editorState = createEditorState();
  const collectionsEditorReadUnitOfWork: CollectionsEditorReadUnitOfWork = {
    execute: async (work) => work(createEditorPorts(editorState)),
  };

  // Write UoW is required to register collection routes; editor tests do not call it.
  const collectionsUnitOfWork: CollectionsUnitOfWork = {
    execute: async () => {
      throw new Error('collections write UoW not used by editor HTTP tests');
    },
  };

  const config = loadConfig({
    DATABASE_URL: 'postgres://localhost/known_test',
    PRODUCT_ORIGIN: 'https://app.example.test',
    ALLOWED_ORIGINS: 'https://app.example.test',
    OIDC_ISSUER: 'https://issuer.example/realms/known',
    OIDC_CLIENT_ID: 'known-web',
    OIDC_REDIRECT_URI: 'https://app.example.test/api/v1/auth/oidc/callback',
    OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
    OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
    OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
  });

  const app = buildApiApp({
    collectionMetadataMutationRoutes: 'disabled',
    config,
    identityUnitOfWork,
    collectionsUnitOfWork,
    productCollectionMutationUnitOfWork:
      createMemoryProductCollectionMutationUnitOfWork(collectionsUnitOfWork),
    collectionsEditorReadUnitOfWork,
    browserSessionAuthority: factory.authority,
  });

  return {
    app,
    config,
    identityState,
    identityUnitOfWork,
    factory,
    editorState,
  };
}

interface AuthedClient {
  readonly cookie: string;
  readonly accountId: string;
  readonly subjectId: string;
}

/**
 * Issue a browser session for a unique OIDC subject.
 * Handle must be unique per account (assertValidHandle: [A-Za-z0-9._~-]{1,64}).
 * Never hardcode a shared handle — multi-account tests (owner + stranger) collide.
 */
async function issueSession(harness: Harness, subject = 'editor-http-user'): Promise<AuthedClient> {
  const handle = `editor_${subject}`
    .replace(/[^A-Za-z0-9._~-]/g, '_')
    .slice(0, 64);
  const client = await issueTestSession({ factory: harness.factory, subject, displayName: 'Editor', handle });
  return {
    cookie: client.cookie,
    accountId: client.accountId,
    subjectId: client.subjectId,
  };
}

function assertProductError(
  response: { statusCode: number; headers: Record<string, string | string[] | undefined>; json(): unknown },
  expectedStatus: number,
  expectedCode: string,
): Record<string, unknown> {
  assert.equal(response.statusCode, expectedStatus);
  assert.match(String(response.headers['content-type'] ?? ''), /application\/json/i);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.equal(typeof response.headers['x-request-id'], 'string');

  const envelope = response.json() as { error: Record<string, unknown> };
  assert.deepEqual(Object.keys(envelope), ['error']);
  assert.equal(envelope.error.code, expectedCode);
  assert.equal(typeof envelope.error.message, 'string');
  assert.ok((envelope.error.message as string).length > 0);
  assert.equal(envelope.error.requestId, response.headers['x-request-id']);
  return envelope.error;
}

const apps: ApiApp[] = [];

afterEach(async () => {
  while (apps.length > 0) {
    const app = apps.pop();
    await app?.close();
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/v1/collections/{collectionId}/editor HTTP', () => {
  test('401 without session', async () => {
    const harness = createHarness();
    apps.push(harness.app);

    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/collections/${COLLECTION_ID}/editor`,
    });

    const error = assertProductError(response, 401, 'authentication_required');
    assert.equal(error.recovery, 'user_action');
  });

  test('400 invalid_cursor for garbage cursor', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness);
    seedEditorCollection(harness.editorState, { ownerSubjectId: client.subjectId });

    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/collections/${COLLECTION_ID}/editor?cursor=not-a-valid-cursor`,
      headers: { cookie: client.cookie },
    });

    const error = assertProductError(response, 400, 'invalid_cursor');
    assert.equal(error.recovery, 'restart_from_first_page');
  });

  test('404 conceal for private collection non-member / missing collection', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const owner = await issueSession(harness, 'owner-user');
    const stranger = await issueSession(harness, 'stranger-user');
    seedEditorCollection(harness.editorState, { ownerSubjectId: owner.subjectId });

    const concealed = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/collections/${COLLECTION_ID}/editor`,
      headers: { cookie: stranger.cookie },
    });
    const concealError = assertProductError(concealed, 404, 'resource_not_found');
    assert.equal(concealError.recovery, 'none');

    const missing = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/collections/does-not-exist/editor',
      headers: { cookie: owner.cookie },
    });
    assertProductError(missing, 404, 'resource_not_found');
  });

  test('200 shape for owner first page', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness);
    seedEditorCollection(harness.editorState, { ownerSubjectId: client.subjectId });

    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/collections/${COLLECTION_ID}/editor`,
      headers: { cookie: client.cookie },
    });

    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers['content-type'] ?? ''), /application\/json/i);
    assert.equal(response.headers['cache-control'], 'private, no-store');
    assert.equal(typeof response.headers['x-request-id'], 'string');

    const body = response.json() as {
      collection: { id: string; contentRevision: string; policyRevision: string; rootNodeId: string };
      root: { id: string; folderRole: string; parentId: null };
      nodes: Array<{ id: string; kind: string }>;
      capabilities: {
        updateCollection: boolean;
        managePublication: boolean;
        createNode: boolean;
        updateNode: boolean;
        moveNode: boolean;
        deleteNode: boolean;
      };
      page: {
        snapshotId: string;
        contentRevision: string;
        policyRevision: string;
        comparatorVersion: string;
        expiresAt: string;
        returnedCount: number;
        hasMore: boolean;
        nextCursor: string | null;
      };
    };

    assert.equal(body.collection.id, COLLECTION_ID);
    assert.equal(body.collection.rootNodeId, ROOT_ID);
    assert.equal(body.collection.contentRevision, CONTENT_REV);
    assert.equal(body.collection.policyRevision, POLICY_REV);
    assert.equal(body.root.id, ROOT_ID);
    assert.equal(body.root.folderRole, 'root');
    assert.equal(body.root.parentId, null);
    assert.equal(body.nodes.length, 1);
    assert.equal(body.nodes[0]!.id, 'bm-http-1');
    assert.equal(body.nodes[0]!.kind, 'bookmark');
    assert.equal(Object.hasOwn(body.nodes[0]!, 'iconUrl'), true);
    assert.equal((body.nodes[0] as { iconUrl?: string | null }).iconUrl, null);
    assert.equal(Object.hasOwn(body.root, 'iconUrl'), false);
    assert.equal(body.capabilities.updateCollection, true);
    assert.equal(body.capabilities.managePublication, true);
    assert.equal(body.capabilities.createNode, true);
    assert.equal(body.page.returnedCount, 1);
    assert.equal(body.page.hasMore, false);
    assert.equal(body.page.nextCursor, null);
    assert.equal(body.page.contentRevision, CONTENT_REV);
    assert.equal(body.page.policyRevision, POLICY_REV);
    assert.ok(body.page.snapshotId.length > 0);
    assert.ok(body.page.expiresAt.length > 0);
    assert.equal(body.page.comparatorVersion, 'v1');
  });

  test('200 bookmark iconUrl is the live same-origin JOIN, not a CDN URL', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness);
    seedEditorCollection(harness.editorState, { ownerSubjectId: client.subjectId });
    const objectId = '01234567-89ab-4cde-8f01-23456789abcd';
    harness.editorState.iconObjectIds.set('bm-http-1', objectId);

    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/collections/${COLLECTION_ID}/editor`,
      headers: { cookie: client.cookie },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as { nodes: Array<{ id: string; kind: string; iconUrl?: string | null }> };
    const bookmark = body.nodes.find((item) => item.id === 'bm-http-1');
    assert.equal(bookmark?.iconUrl, `https://app.example.test/api/v1/favicon/${objectId}`);
    assert.doesNotMatch(response.body, /favicon\.im|duckduckgo/i);
  });
});

