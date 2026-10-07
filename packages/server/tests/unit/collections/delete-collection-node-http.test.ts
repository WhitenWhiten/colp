/**
 * P1-10 DELETE /api/v1/collections/{collectionId}/nodes/{nodeId} HTTP contract.
 *
 * Covers: leaf/bookmark delete, empty folder, non-empty folder without recursive
 * (folder_not_empty), recursive with If-Content-Match, missing recursive
 * confirmation (If-Content-Match), stale content fence, root_immutable,
 * unauthorized, exact retry.
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
  COMMAND_C,
  NOW,
  createMemoryWritePorts,
  createState,
  type MemoryState,
} from '../../support/memory-collections-write-ports.js';
import { loadConfig } from '../../support/test-config.js';
import type { MembershipRole } from '../../../src/modules/access-policy/index.js';
import {
  DeleteSubtreeLimitError,
  strongEntityTag,
  type CollectionsUnitOfWork,
} from '../../../src/modules/collections/index.js';
import { type IdentityUnitOfWork } from '../../../src/modules/identity/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createInMemoryBetterAuthTestFactory, issueTestSession } from '../../support/better-auth-test-factory.js';

const COLLECTION_ID = 'col-http-node-delete-1';
const ROOT_ID = 'root-http-node-delete-1';
const FOLDER_EMPTY = 'folder-empty-http-delete-1';
const FOLDER_NONEMPTY = 'folder-nonempty-http-delete-1';
const FOLDER_CHILD = 'folder-child-http-delete-1';
const BOOKMARK_1 = 'bookmark-1-http-delete-1';
const BOOKMARK_2 = 'bookmark-2-http-delete-1';
const BOOKMARK_IN_FOLDER = 'bookmark-in-folder-http-delete-1';

const RESOURCE_REV = 'resource-http-delete-1';
const CONTENT_REV = 'content-http-delete-1';
const POLICY_REV = 'policy-http-delete-1';
const ROOT_RESOURCE_REV = 'root-resource-http-delete-1';
const ROOT_CHILDREN_REV = 'root-ch-http-delete-1';
const FOLDER_EMPTY_RESOURCE_REV = 'folder-empty-resource-http-1';
const FOLDER_EMPTY_CHILDREN_REV = 'folder-empty-ch-http-1';
const FOLDER_NONEMPTY_RESOURCE_REV = 'folder-nonempty-resource-http-1';
const FOLDER_NONEMPTY_CHILDREN_REV = 'folder-nonempty-ch-http-1';
const FOLDER_CHILD_RESOURCE_REV = 'folder-child-resource-http-1';
const FOLDER_CHILD_CHILDREN_REV = 'folder-child-ch-http-1';
const BOOKMARK_1_RESOURCE_REV = 'bm1-resource-http-delete-1';
const BOOKMARK_2_RESOURCE_REV = 'bm2-resource-http-delete-1';
const BOOKMARK_IN_FOLDER_RESOURCE_REV = 'bm-in-folder-resource-http-1';

type ApiApp = ReturnType<typeof buildApiApp>;

interface Harness {
  readonly app: ApiApp;
  readonly config: ReturnType<typeof loadConfig>;
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly factory: ReturnType<typeof createInMemoryBetterAuthTestFactory>;
  readonly collectionsState: MemoryState;
}

function createHarness(options: { readonly mutationError?: Error } = {}): Harness {
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

  const memoryMutationUnitOfWork = createMemoryProductCollectionMutationUnitOfWork(collectionsUnitOfWork);
  const app = buildApiApp({
    collectionMetadataMutationRoutes: 'disabled',
    config,
    identityUnitOfWork,
    collectionsUnitOfWork,
    productCollectionMutationUnitOfWork: options.mutationError
      ? { execute: async () => { throw options.mutationError; } }
      : memoryMutationUnitOfWork,
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

function putNode(
  harness: Harness,
  input: {
    id: string;
    parentId: string | null;
    kind: 'folder' | 'bookmark';
    isRoot?: boolean;
    title: string;
    url?: string | null;
    positionToken: string | null;
    resourceRevision: string;
    childrenRevision: string;
  },
): void {
  const createdAt = new Date(harness.collectionsState.now);
  harness.collectionsState.nodes.set(input.id, {
    id: input.id,
    collectionId: COLLECTION_ID,
    kind: input.kind,
    isRoot: input.isRoot ?? false,
    parentId: input.parentId,
    positionToken: input.positionToken,
    title: input.title,
    url: input.url === undefined
      ? (input.kind === 'bookmark' ? `https://example.test/${input.id}` : null)
      : input.url,
    description: null,
    tags: [],
    visibility: 'inherit',
    resourceRevision: input.resourceRevision,
    childrenRevision: input.childrenRevision,
    deletedAt: null,
    deletedCommitOrdinal: null,
    createdAt,
    updatedAt: createdAt,
  });
}

/**
 * Tree:
 *   ROOT
 *     FOLDER_EMPTY (a)
 *     FOLDER_NONEMPTY (m)
 *       FOLDER_CHILD (a)
 *         BOOKMARK_IN_FOLDER (a)
 *     BOOKMARK_1 (s)
 *     BOOKMARK_2 (z)
 */
function seedTree(
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
    title: 'HTTP Delete Node',
    summary: null,
    kind: 'bookmarks',
    visibility: 'private',
    rootNodeId: ROOT_ID,
    resourceRevision: RESOURCE_REV,
    contentRevision: CONTENT_REV,
    policyRevision: POLICY_REV,
    commitOrdinal: 3n,
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

  putNode(harness, {
    id: ROOT_ID,
    parentId: null,
    kind: 'folder',
    isRoot: true,
    title: 'HTTP Delete Node',
    positionToken: null,
    resourceRevision: ROOT_RESOURCE_REV,
    childrenRevision: ROOT_CHILDREN_REV,
  });
  putNode(harness, {
    id: FOLDER_EMPTY,
    parentId: ROOT_ID,
    kind: 'folder',
    title: 'Empty Folder',
    positionToken: 'a',
    resourceRevision: FOLDER_EMPTY_RESOURCE_REV,
    childrenRevision: FOLDER_EMPTY_CHILDREN_REV,
  });
  putNode(harness, {
    id: FOLDER_NONEMPTY,
    parentId: ROOT_ID,
    kind: 'folder',
    title: 'Nonempty Folder',
    positionToken: 'm',
    resourceRevision: FOLDER_NONEMPTY_RESOURCE_REV,
    childrenRevision: FOLDER_NONEMPTY_CHILDREN_REV,
  });
  putNode(harness, {
    id: FOLDER_CHILD,
    parentId: FOLDER_NONEMPTY,
    kind: 'folder',
    title: 'Child Folder',
    positionToken: 'a',
    resourceRevision: FOLDER_CHILD_RESOURCE_REV,
    childrenRevision: FOLDER_CHILD_CHILDREN_REV,
  });
  putNode(harness, {
    id: BOOKMARK_IN_FOLDER,
    parentId: FOLDER_CHILD,
    kind: 'bookmark',
    title: 'Deep Bookmark',
    positionToken: 'a',
    resourceRevision: BOOKMARK_IN_FOLDER_RESOURCE_REV,
    childrenRevision: 'bm-ch-unused',
  });
  putNode(harness, {
    id: BOOKMARK_1,
    parentId: ROOT_ID,
    kind: 'bookmark',
    title: 'Bookmark 1',
    positionToken: 's',
    resourceRevision: BOOKMARK_1_RESOURCE_REV,
    childrenRevision: 'bm-ch-unused-1',
  });
  putNode(harness, {
    id: BOOKMARK_2,
    parentId: ROOT_ID,
    kind: 'bookmark',
    title: 'Bookmark 2',
    positionToken: 'z',
    resourceRevision: BOOKMARK_2_RESOURCE_REV,
    childrenRevision: 'bm-ch-unused-2',
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
    ...extra,
  };
}

function deleteUrl(
  nodeId: string,
  options: { collectionId?: string; recursive?: boolean } = {},
): string {
  const collectionId = options.collectionId ?? COLLECTION_ID;
  const base = `/api/v1/collections/${collectionId}/nodes/${nodeId}`;
  if (options.recursive === true) return `${base}?recursive=true`;
  if (options.recursive === false) return `${base}?recursive=false`;
  return base;
}

function assertProductError(
  response: {
    statusCode: number;
    headers: Record<string, string | string[] | undefined>;
    json(): unknown;
  },
  expectedStatus: number,
  expectedCode: string,
): Record<string, unknown> {
  assert.equal(response.statusCode, expectedStatus);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  const envelope = response.json() as { error: Record<string, unknown> };
  assert.equal(envelope.error.code, expectedCode);
  return envelope.error;
}

const apps: ApiApp[] = [];
afterEach(async () => {
  while (apps.length > 0) await apps.pop()?.close();
});

describe('DELETE /api/v1/collections/:collectionId/nodes/:nodeId HTTP contract', () => {
  test('413 payload_too_large preserves the stable recursive-delete limit error', async () => {
    const harness = createHarness({
      mutationError: new DeleteSubtreeLimitError('Recursive delete exceeds the maximum node count of 8.'),
    });
    apps.push(harness.app);
    const client = await issueSession(harness, 'limit-del', 'limitd1');
    seedTree(harness, { ownerSubjectId: client.subjectId });

    const response = await harness.app.inject({
      method: 'DELETE',
      url: deleteUrl(FOLDER_NONEMPTY, { recursive: true }),
      headers: authedHeaders(harness, client, {
        'known-command-id': COMMAND_A,
        'if-match': strongEntityTag(FOLDER_NONEMPTY_RESOURCE_REV),
        'if-content-match': strongEntityTag(CONTENT_REV),
      }),
    });

    const error = assertProductError(response, 413, 'payload_too_large');
    assert.equal(error.message, 'Recursive delete exceeds the maximum node count of 8.');
    assert.equal(harness.collectionsState.operations.length, 0);
  });
  test('401 without session', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const response = await harness.app.inject({
      method: 'DELETE',
      url: deleteUrl(BOOKMARK_1),
      headers: {
        origin: harness.config.productOrigin,
        'x-csrf-token': 'not-a-real-csrf-token-value____________',
        'known-command-id': COMMAND_A,
        'if-match': strongEntityTag(BOOKMARK_1_RESOURCE_REV),
      },
    });
    assertProductError(response, 401, 'authentication_required');
  });

  test('200 leaf/bookmark delete returns DeleteNodeResult', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'ok-bm-del', 'okbmdel1');
    seedTree(harness, { ownerSubjectId: client.subjectId });

    const ok = await harness.app.inject({
      method: 'DELETE',
      url: deleteUrl(BOOKMARK_1),
      headers: authedHeaders(harness, client, {
        'known-command-id': COMMAND_A,
        'if-match': strongEntityTag(BOOKMARK_1_RESOURCE_REV),
      }),
    });

    assert.equal(ok.statusCode, 200);
    assert.equal(ok.headers['cache-control'], 'private, no-store');
    const body = ok.json() as {
      receipt: {
        resourceType: string;
        targetId: string;
        collectionId: string;
        scope: string;
        affectedCount: number;
        operationId: string;
        deletedAt: string;
        deleteRevision: string;
        purgeAfter: string;
      };
      parent: { id: string; childrenRevision: string; childrenEtag: string };
      fence: {
        contentRevision: string;
        contentEtag: string;
        policyRevision: string;
        policyEtag: string;
      };
    };
    assert.equal(body.receipt.resourceType, 'node');
    assert.equal(body.receipt.targetId, BOOKMARK_1);
    assert.equal(body.receipt.collectionId, COLLECTION_ID);
    assert.equal(body.receipt.scope, 'single');
    assert.equal(body.receipt.affectedCount, 1);
    assert.equal(typeof body.receipt.operationId, 'string');
    assert.equal(typeof body.receipt.deletedAt, 'string');
    assert.equal(body.receipt.deleteRevision, harness.collectionsState.nodes.get(BOOKMARK_1)!.resourceRevision);
    assert.notEqual(body.receipt.deleteRevision, body.fence.contentRevision);
    assert.equal(typeof body.receipt.purgeAfter, 'string');
    assert.equal(body.parent.id, ROOT_ID);
    assert.notEqual(body.parent.childrenRevision, ROOT_CHILDREN_REV);
    assert.notEqual(body.fence.contentRevision, CONTENT_REV);
    assert.ok(harness.collectionsState.nodes.get(BOOKMARK_1)!.deletedAt instanceof Date);
    assert.equal(harness.collectionsState.nodes.get(BOOKMARK_2)!.deletedAt, null);
  });

  test('200 empty folder non-recursive delete', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'ok-empty-del', 'okemptyd1');
    seedTree(harness, { ownerSubjectId: client.subjectId });

    const ok = await harness.app.inject({
      method: 'DELETE',
      url: deleteUrl(FOLDER_EMPTY, { recursive: false }),
      headers: authedHeaders(harness, client, {
        'known-command-id': COMMAND_A,
        'if-match': strongEntityTag(FOLDER_EMPTY_RESOURCE_REV),
      }),
    });

    assert.equal(ok.statusCode, 200);
    const body = ok.json() as {
      receipt: { scope: string; affectedCount: number; targetId: string };
    };
    assert.equal(body.receipt.targetId, FOLDER_EMPTY);
    assert.equal(body.receipt.scope, 'single');
    assert.equal(body.receipt.affectedCount, 1);
    assert.ok(harness.collectionsState.nodes.get(FOLDER_EMPTY)!.deletedAt instanceof Date);
  });

  test('409 folder_not_empty for non-empty folder without recursive', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'folder-ne', 'folderne1');
    seedTree(harness, { ownerSubjectId: client.subjectId });

    const response = await harness.app.inject({
      method: 'DELETE',
      url: deleteUrl(FOLDER_NONEMPTY),
      headers: authedHeaders(harness, client, {
        'known-command-id': COMMAND_A,
        'if-match': strongEntityTag(FOLDER_NONEMPTY_RESOURCE_REV),
      }),
    });
    assertProductError(response, 409, 'folder_not_empty');
    assert.equal(harness.collectionsState.nodes.get(FOLDER_NONEMPTY)!.deletedAt, null);
    assert.equal(harness.collectionsState.nodes.get(FOLDER_CHILD)!.deletedAt, null);
    assert.equal(harness.collectionsState.nodes.get(BOOKMARK_IN_FOLDER)!.deletedAt, null);
    assert.equal(harness.collectionsState.operations.length, 0);
  });

  test('200 recursive subtree delete with If-Content-Match', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'ok-rec-del', 'okrecdel1');
    seedTree(harness, { ownerSubjectId: client.subjectId });

    const ok = await harness.app.inject({
      method: 'DELETE',
      url: deleteUrl(FOLDER_NONEMPTY, { recursive: true }),
      headers: authedHeaders(harness, client, {
        'known-command-id': COMMAND_A,
        'if-match': strongEntityTag(FOLDER_NONEMPTY_RESOURCE_REV),
        'if-content-match': strongEntityTag(CONTENT_REV),
      }),
    });

    assert.equal(ok.statusCode, 200);
    const body = ok.json() as {
      receipt: { scope: string; affectedCount: number; targetId: string; deleteRevision: string };
      parent: { id: string; childrenRevision: string };
      fence: { contentRevision: string };
    };
    assert.equal(body.receipt.targetId, FOLDER_NONEMPTY);
    assert.equal(body.receipt.scope, 'subtree');
    assert.equal(body.receipt.affectedCount, 3);
    assert.equal(body.receipt.deleteRevision, harness.collectionsState.nodes.get(FOLDER_NONEMPTY)!.resourceRevision);
    assert.notEqual(body.receipt.deleteRevision, body.fence.contentRevision);
    assert.equal(body.parent.id, ROOT_ID);
    assert.notEqual(body.parent.childrenRevision, ROOT_CHILDREN_REV);
    assert.notEqual(body.fence.contentRevision, CONTENT_REV);

    assert.ok(harness.collectionsState.nodes.get(FOLDER_NONEMPTY)!.deletedAt instanceof Date);
    assert.ok(harness.collectionsState.nodes.get(FOLDER_CHILD)!.deletedAt instanceof Date);
    assert.ok(harness.collectionsState.nodes.get(BOOKMARK_IN_FOLDER)!.deletedAt instanceof Date);
    assert.equal(harness.collectionsState.nodes.get(FOLDER_EMPTY)!.deletedAt, null);
    assert.equal(harness.collectionsState.nodes.get(BOOKMARK_1)!.deletedAt, null);
  });

  test('428 missing recursive confirmation (If-Content-Match required)', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'miss-content', 'misscont1');
    seedTree(harness, { ownerSubjectId: client.subjectId });

    const response = await harness.app.inject({
      method: 'DELETE',
      url: deleteUrl(FOLDER_NONEMPTY, { recursive: true }),
      headers: authedHeaders(harness, client, {
        'known-command-id': COMMAND_A,
        'if-match': strongEntityTag(FOLDER_NONEMPTY_RESOURCE_REV),
      }),
    });
    const error = assertProductError(response, 428, 'precondition_required');
    assert.equal(error.precondition, 'content');
    assert.equal(harness.collectionsState.operations.length, 0);
    assert.equal(harness.collectionsState.nodes.get(FOLDER_NONEMPTY)!.deletedAt, null);
  });

  test('412 stale content fence on recursive delete', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'stale-content', 'stalecon1');
    seedTree(harness, { ownerSubjectId: client.subjectId });

    const response = await harness.app.inject({
      method: 'DELETE',
      url: deleteUrl(FOLDER_NONEMPTY, { recursive: true }),
      headers: authedHeaders(harness, client, {
        'known-command-id': COMMAND_A,
        'if-match': strongEntityTag(FOLDER_NONEMPTY_RESOURCE_REV),
        'if-content-match': strongEntityTag('stale-content-rev'),
      }),
    });
    const error = assertProductError(response, 412, 'precondition_failed');
    assert.equal(error.precondition, 'content');
    assert.equal(error.currentEtag, strongEntityTag(CONTENT_REV));
    assert.equal(harness.collectionsState.operations.length, 0);
    assert.equal(harness.collectionsState.nodes.get(FOLDER_NONEMPTY)!.deletedAt, null);
  });

  test('409 root_immutable', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'root-del', 'rootdel1');
    seedTree(harness, { ownerSubjectId: client.subjectId });

    const response = await harness.app.inject({
      method: 'DELETE',
      url: deleteUrl(ROOT_ID),
      headers: authedHeaders(harness, client, {
        'known-command-id': COMMAND_A,
        'if-match': strongEntityTag(ROOT_RESOURCE_REV),
      }),
    });
    assertProductError(response, 409, 'root_immutable');
    assert.equal(harness.collectionsState.nodes.get(ROOT_ID)!.deletedAt, null);
    assert.equal(harness.collectionsState.operations.length, 0);
  });

  test('viewer 403; stranger 404; exact command retry', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const owner = await issueSession(harness, 'owner-del', 'ownerdel1');
    const viewer = await issueSession(harness, 'viewer-del', 'viewdel1');
    const stranger = await issueSession(harness, 'stranger-del', 'strdel1');
    seedTree(harness, {
      ownerSubjectId: owner.subjectId,
      memberships: [{ subjectId: viewer.subjectId, role: 'viewer' }],
    });

    assertProductError(
      await harness.app.inject({
        method: 'DELETE',
        url: deleteUrl(BOOKMARK_1),
        headers: authedHeaders(harness, viewer, {
          'known-command-id': COMMAND_A,
          'if-match': strongEntityTag(BOOKMARK_1_RESOURCE_REV),
        }),
      }),
      403,
      'insufficient_permission',
    );
    assertProductError(
      await harness.app.inject({
        method: 'DELETE',
        url: deleteUrl(BOOKMARK_1),
        headers: authedHeaders(harness, stranger, {
          'known-command-id': COMMAND_B,
          'if-match': strongEntityTag(BOOKMARK_1_RESOURCE_REV),
        }),
      }),
      404,
      'resource_not_found',
    );

    const headers = authedHeaders(harness, owner, {
      'known-command-id': COMMAND_C,
      'if-match': strongEntityTag(BOOKMARK_2_RESOURCE_REV),
    });
    const first = await harness.app.inject({
      method: 'DELETE',
      url: deleteUrl(BOOKMARK_2),
      headers,
    });
    assert.equal(first.statusCode, 200);
    const firstBody = first.json();
    const ops = harness.collectionsState.operations.length;
    const second = await harness.app.inject({
      method: 'DELETE',
      url: deleteUrl(BOOKMARK_2),
      headers,
    });
    assert.equal(second.statusCode, 200);
    assert.deepEqual(second.json(), firstBody);
    assert.equal(harness.collectionsState.operations.length, ops);
  });

  test('400 when If-Content-Match present on non-recursive delete', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'bad-content', 'badcont1');
    seedTree(harness, { ownerSubjectId: client.subjectId });

    const response = await harness.app.inject({
      method: 'DELETE',
      url: deleteUrl(BOOKMARK_1),
      headers: authedHeaders(harness, client, {
        'known-command-id': COMMAND_A,
        'if-match': strongEntityTag(BOOKMARK_1_RESOURCE_REV),
        'if-content-match': strongEntityTag(CONTENT_REV),
      }),
    });
    assertProductError(response, 400, 'invalid_request');
    assert.equal(harness.collectionsState.nodes.get(BOOKMARK_1)!.deletedAt, null);
  });

  test('422 when recursive=true on bookmark', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'bm-rec', 'bmrec1');
    seedTree(harness, { ownerSubjectId: client.subjectId });

    const response = await harness.app.inject({
      method: 'DELETE',
      url: deleteUrl(BOOKMARK_1, { recursive: true }),
      headers: authedHeaders(harness, client, {
        'known-command-id': COMMAND_A,
        'if-match': strongEntityTag(BOOKMARK_1_RESOURCE_REV),
        'if-content-match': strongEntityTag(CONTENT_REV),
      }),
    });
    assertProductError(response, 422, 'invalid_document');
    assert.equal(harness.collectionsState.nodes.get(BOOKMARK_1)!.deletedAt, null);
  });

  test('428 precondition_required when If-Match missing', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'ifmatch-del', 'ifmatchd1');
    seedTree(harness, { ownerSubjectId: client.subjectId });

    const response = await harness.app.inject({
      method: 'DELETE',
      url: deleteUrl(BOOKMARK_1),
      headers: authedHeaders(harness, client, {
        'known-command-id': COMMAND_A,
      }),
    });
    const error = assertProductError(response, 428, 'precondition_required');
    assert.equal(error.precondition, 'resource');
  });
});

