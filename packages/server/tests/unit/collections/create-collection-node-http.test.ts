/**
 * P1-08 POST /api/v1/collections/{collectionId}/nodes HTTP contract (Fastify inject).
 *
 * Optional transport tests. Covers: 401, CSRF, folder/bookmark 201, file:// 422,
 * unauthorized (viewer 403 / stranger 404), exact command retry.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'vitest';
import {
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
  executeMemoryTransaction,
} from '../../support/product-http-harness.js';
import { createMemoryProductCollectionMutationUnitOfWork } from '../../support/product-canonical-memory.js';
import {
  COMMAND_A,
  COMMAND_B,
  NOW,
  createMemoryWritePorts,
  createState,
  type MemoryState,
} from '../../support/memory-collections-write-ports.js';
import { loadConfig } from '../../support/test-config.js';
import type { MembershipRole } from '../../../src/modules/access-policy/index.js';
import { type CollectionsUnitOfWork } from '../../../src/modules/collections/index.js';
import { type IdentityUnitOfWork } from '../../../src/modules/identity/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createInMemoryBetterAuthTestFactory, issueTestSession } from '../../support/better-auth-test-factory.js';

const COLLECTION_ID = 'col-http-node-create-1';
const ROOT_ID = 'root-http-node-create-1';
const RESOURCE_REV = 'resource-http-create-1';
const CONTENT_REV = 'content-http-create-1';
const POLICY_REV = 'policy-http-create-1';
const ROOT_CHILDREN_REV = 'children-http-root-1';

type ApiApp = ReturnType<typeof buildApiApp>;

interface Harness {
  readonly app: ApiApp;
  readonly config: ReturnType<typeof loadConfig>;
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly factory: ReturnType<typeof createInMemoryBetterAuthTestFactory>;
  readonly collectionsState: MemoryState;
}

function createHarness(): Harness {
  const identityState = createIdentityMemoryState(NOW);
  const identityUnitOfWork = createIdentityMemoryUnitOfWork(identityState);
  const factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork });
  const collectionsState = createState();
  const collectionsUnitOfWork: CollectionsUnitOfWork = {
    execute: (work) => executeMemoryTransaction(
      collectionsState,
      (transaction) => work(createMemoryWritePorts(transaction)),
    ),
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
    browserSessionAuthority: factory.authority,
  });

  return { app, config, identityUnitOfWork, factory, collectionsState };
}

interface AuthedClient {
  readonly cookie: string;
  readonly csrfToken: string;
  readonly subjectId: string;
}

async function issueSession(harness: Harness, subject: string, handle: string): Promise<AuthedClient> {
  const client = await issueTestSession({ factory: harness.factory, subject, displayName: subject, handle });
  return {
    cookie: client.cookie,
    csrfToken: client.csrfToken,
    subjectId: client.subjectId,
  };
}

function seedCollection(
  harness: Harness,
  options: {
    ownerSubjectId: string;
    memberships?: Array<{ subjectId: string; role: MembershipRole }>;
  },
): void {
  const createdAt = new Date(harness.collectionsState.now);
  harness.collectionsState.collections.set(COLLECTION_ID, {
    id: COLLECTION_ID,
    ownerSubjectId: options.ownerSubjectId,
    title: 'HTTP Create Node',
    summary: null,
    kind: 'bookmarks',
    visibility: 'private',
    rootNodeId: ROOT_ID,
    resourceRevision: RESOURCE_REV,
    contentRevision: CONTENT_REV,
    policyRevision: POLICY_REV,
    commitOrdinal: 1n,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
  });
  harness.collectionsState.memberships.push({
    collectionId: COLLECTION_ID,
    subjectId: options.ownerSubjectId,
    role: 'owner',
  });
  for (const m of options.memberships ?? []) {
    harness.collectionsState.memberships.push({
      collectionId: COLLECTION_ID,
      subjectId: m.subjectId,
      role: m.role,
    });
  }
  harness.collectionsState.nodes.set(ROOT_ID, {
    id: ROOT_ID,
    collectionId: COLLECTION_ID,
    kind: 'folder',
    isRoot: true,
    parentId: null,
    positionToken: null,
    title: 'HTTP Create Node',
    url: null,
    description: null,
    tags: [],
    visibility: 'inherit',
    resourceRevision: 'root-res-1',
    childrenRevision: ROOT_CHILDREN_REV,
    deletedAt: null,
    createdAt,
    updatedAt: createdAt,
  });
}

function authedHeaders(
  harness: Harness,
  client: AuthedClient,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    cookie: client.cookie,
    origin: harness.config.productOrigin,
    'x-csrf-token': client.csrfToken,
    'content-type': 'application/json',
    ...extra,
  };
}

function nodesUrl(collectionId = COLLECTION_ID): string {
  return `/api/v1/collections/${collectionId}/nodes`;
}

function folderBody(title = 'HTTP Folder') {
  return {
    parentId: ROOT_ID,
    afterId: null,
    beforeId: null,
    node: {
      kind: 'folder' as const,
      title,
      description: null,
      tags: [] as string[],
      visibility: 'inherit' as const,
    },
  };
}

function bookmarkBody(url: string) {
  return {
    parentId: ROOT_ID,
    afterId: null,
    beforeId: null,
    node: {
      kind: 'bookmark' as const,
      title: 'HTTP Bookmark',
      url,
      description: null,
      tags: [] as string[],
      visibility: 'inherit' as const,
    },
  };
}

function assertProductError(
  response: {
    statusCode: number;
    headers: Record<string, string | string[] | undefined>;
    json(): unknown;
  },
  expectedStatus: number,
  expectedCode: string,
): void {
  assert.equal(response.statusCode, expectedStatus);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  const envelope = response.json() as { error: Record<string, unknown> };
  assert.equal(envelope.error.code, expectedCode);
}

const apps: ApiApp[] = [];
afterEach(async () => {
  while (apps.length > 0) await apps.pop()?.close();
});

describe('POST /api/v1/collections/:collectionId/nodes HTTP contract', () => {
  test('401 without session', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const response = await harness.app.inject({
      method: 'POST',
      url: nodesUrl(),
      headers: {
        origin: harness.config.productOrigin,
        'x-csrf-token': 'not-a-real-csrf-token-value____________',
        'content-type': 'application/json',
        'known-command-id': COMMAND_A,
      },
      payload: folderBody(),
    });
    assertProductError(response, 401, 'authentication_required');
  });

  test('403 csrf_failed without Origin', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'csrf-node', 'csrfn1');
    seedCollection(harness, { ownerSubjectId: client.subjectId });
    const response = await harness.app.inject({
      method: 'POST',
      url: nodesUrl(),
      headers: {
        cookie: client.cookie,
        'x-csrf-token': client.csrfToken,
        'content-type': 'application/json',
        'known-command-id': COMMAND_A,
      },
      payload: folderBody(),
    });
    assertProductError(response, 403, 'csrf_failed');
  });

  test('201 folder create returns CreateNodeResult + Location/ETag', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'ok-node', 'oknode1');
    seedCollection(harness, { ownerSubjectId: client.subjectId });

    const response = await harness.app.inject({
      method: 'POST',
      url: nodesUrl(),
      headers: authedHeaders(harness, client, { 'known-command-id': COMMAND_A }),
      payload: folderBody('Transport Folder'),
    });

    assert.equal(response.statusCode, 201);
    assert.equal(response.headers['cache-control'], 'private, no-store');
    assert.equal(typeof response.headers.etag, 'string');
    assert.match(String(response.headers.location), /\/nodes\//);
    const body = response.json() as {
      node: Record<string, unknown>;
      parent: Record<string, unknown>;
      fence: Record<string, unknown>;
    };
    assert.equal(body.node.kind, 'folder');
    assert.equal(body.node.title, 'Transport Folder');
    assert.equal(body.node.parentId, ROOT_ID);
    assert.equal(body.node.etag, response.headers.etag);
    assert.equal(body.parent.id, ROOT_ID);
    assert.ok(body.fence.contentRevision);
  });

  test('201 bookmark create; file:// → 422 invalid_document', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'bm-node', 'bmnode1');
    seedCollection(harness, { ownerSubjectId: client.subjectId });

    const ok = await harness.app.inject({
      method: 'POST',
      url: nodesUrl(),
      headers: authedHeaders(harness, client, { 'known-command-id': COMMAND_A }),
      payload: bookmarkBody('https://example.test/ok'),
    });
    assert.equal(ok.statusCode, 201);
    const created = ok.json() as { node: { url: string; iconUrl?: string | null; kind: string } };
    assert.equal(
      `${created.node.url}|${created.node.kind}|${Object.hasOwn(created.node, 'iconUrl')}|${String(created.node.iconUrl)}`,
      'https://example.test/ok|bookmark|true|null',
    );

    const bad = await harness.app.inject({
      method: 'POST',
      url: nodesUrl(),
      headers: authedHeaders(harness, client, { 'known-command-id': COMMAND_B }),
      payload: bookmarkBody('file:///etc/passwd'),
    });
    assertProductError(bad, 422, 'invalid_document');
  });

  test('viewer 403; stranger 404; exact command retry', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const owner = await issueSession(harness, 'owner-n', 'ownern1');
    const viewer = await issueSession(harness, 'viewer-n', 'viewern1');
    const stranger = await issueSession(harness, 'stranger-n', 'strangern1');
    seedCollection(harness, {
      ownerSubjectId: owner.subjectId,
      memberships: [{ subjectId: viewer.subjectId, role: 'viewer' }],
    });

    assertProductError(
      await harness.app.inject({
        method: 'POST',
        url: nodesUrl(),
        headers: authedHeaders(harness, viewer, { 'known-command-id': COMMAND_A }),
        payload: folderBody('Viewer'),
      }),
      403,
      'insufficient_permission',
    );
    assertProductError(
      await harness.app.inject({
        method: 'POST',
        url: nodesUrl(),
        headers: authedHeaders(harness, stranger, { 'known-command-id': COMMAND_B }),
        payload: folderBody('Stranger'),
      }),
      404,
      'resource_not_found',
    );

    const payload = folderBody('Retry');
    const first = await harness.app.inject({
      method: 'POST',
      url: nodesUrl(),
      headers: authedHeaders(harness, owner, { 'known-command-id': COMMAND_A }),
      payload,
    });
    assert.equal(first.statusCode, 201);
    const ops = harness.collectionsState.operations.length;
    const second = await harness.app.inject({
      method: 'POST',
      url: nodesUrl(),
      headers: authedHeaders(harness, owner, { 'known-command-id': COMMAND_A }),
      payload,
    });
    assert.equal(second.statusCode, 201);
    assert.equal(second.headers.etag, first.headers.etag);
    assert.deepEqual(second.json(), first.json());
    assert.equal(harness.collectionsState.operations.length, ops);
  });
});

