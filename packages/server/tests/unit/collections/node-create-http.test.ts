/**
 * P1-08 POST /api/v1/collections/{collectionId}/nodes HTTP contract (Fastify inject).
 *
 * Harness:
 *   buildApiApp({ config, identityUnitOfWork, collectionsUnitOfWork })
 *   Memory session + CollectionsWritePorts implementing create node path.
 *
 * Covers: CSRF/Origin/session, application/json media type, Known-Command-Id,
 * success 201 Location/ETag/Cache-Control, error envelope codes.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'vitest';
import {
  createIdentityMemoryPorts,
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
  createMemoryProductCommandReceiptPort,
  executeMemoryTransaction,
  type MemoryProductCommandReceipts,
  type IdentityMemoryState,
} from '../../support/product-http-harness.js';
import { createMemoryProductCollectionMutationUnitOfWork } from '../../support/product-canonical-memory.js';
import { loadConfig } from '../../support/test-config.js';
import type {
  AccessPolicyFactsPort,
  AccessPolicyWritePort,
  MembershipRole,
  ResourcePolicyFacts,
} from '../../../src/modules/access-policy/index.js';
import {
  type BootstrapAuditRecord,
  type BootstrapOperationRecord,
  type BootstrapOutboxRecord,
  type ChildrenRevisionInsert,
  type CollectionBootstrapRow,
  type CollectionsUnitOfWork,
  type CollectionsWritePorts,
  type ContentRevisionInsert,
  type IdLedgerReserveEntry,
  type LockedCollectionRow,
  type LockedNodeRow,
  type NodeInsertRow,
  type PolicyRevisionInsert,
  type ResourceRevisionInsert,
  type RootNodeBootstrapRow,
  type SiblingPositionRow,
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

const COMMAND_A = '5de3947e-6271-4fdf-a946-d22e58a99c2a';
const COMMAND_B = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
const COMMAND_C = '11111111-2222-4333-8444-555555555555';
const COMMAND_D = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const NOW = new Date('2026-07-22T12:00:00.000Z');

const COLLECTION_ID = 'col-http-node-1';
const ROOT_ID = 'root-http-node-1';
const RESOURCE_REV = 'resource-http-node-1';
const CONTENT_REV = 'content-http-node-1';
const POLICY_REV = 'policy-http-node-1';
const ROOT_CHILDREN_REV = 'root-children-http-1';
const BODY_LIMIT_BYTES = 16 * 1024;

const VALID_FOLDER_BODY = {
  parentId: ROOT_ID,
  afterId: null,
  beforeId: null,
  node: {
    kind: 'folder',
    title: 'HTTP Folder',
    description: null,
    tags: [],
    visibility: 'inherit',
  },
} as const;

const VALID_BOOKMARK_BODY = {
  parentId: ROOT_ID,
  afterId: null,
  beforeId: null,
  node: {
    kind: 'bookmark',
    title: 'HTTP Bookmark',
    url: 'https://example.com/http',
    description: null,
    tags: ['http'],
    visibility: 'inherit',
  },
} as const;

// ---------------------------------------------------------------------------
// Identity memory
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Collections write memory
// ---------------------------------------------------------------------------

interface MembershipRow {
  collectionId: string;
  subjectId: string;
  role: MembershipRole;
  grantedAt: Date;
}

interface PolicyRow {
  collectionId: string;
  policyJson: Readonly<Record<string, unknown>>;
  updatedAt: Date;
}

type MutableCollection = LockedCollectionRow;

type MutableNode = {
  id: string;
  collectionId: string;
  parentId: string | null;
  kind: 'folder' | 'bookmark';
  isRoot: boolean;
  title: string;
  url: string | null;
  description: string | null;
  tags: string[];
  visibility: 'inherit' | 'protected' | 'private';
  positionToken: string | null;
  resourceRevision: string;
  childrenRevision: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

interface CollectionsMemoryState {
  now: Date;
  receipts: MemoryProductCommandReceipts;
  ledger: IdLedgerReserveEntry[];
  bootstrapCollections: CollectionBootstrapRow[];
  collections: Map<string, MutableCollection>;
  rootBootstraps: RootNodeBootstrapRow[];
  nodes: Map<string, MutableNode>;
  memberships: MembershipRow[];
  policies: Map<string, PolicyRow>;
  resourceRevisions: ResourceRevisionInsert[];
  contentRevisions: ContentRevisionInsert[];
  policyRevisions: PolicyRevisionInsert[];
  childrenRevisions: ChildrenRevisionInsert[];
  operations: BootstrapOperationRecord[];
  audit: BootstrapAuditRecord[];
  outbox: BootstrapOutboxRecord[];
}

function toLockedNode(row: MutableNode): LockedNodeRow {
  return {
    id: row.id,
    collectionId: row.collectionId,
    parentId: row.parentId,
    kind: row.kind,
    isRoot: row.isRoot,
    title: row.title,
    url: row.url,
    description: row.description,
    tags: [...row.tags],
    visibility: row.visibility,
    positionToken: row.positionToken,
    resourceRevision: row.resourceRevision,
    childrenRevision: row.childrenRevision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

function createMemoryAccessPolicyWrite(state: CollectionsMemoryState): AccessPolicyWritePort {
  return {
    async insertMembership(input) {
      state.memberships.push({
        collectionId: input.collectionId,
        subjectId: input.subjectId,
        role: input.role,
        grantedAt: input.grantedAt,
      });
    },
    async deleteMembership(input) {
      const before = state.memberships.length;
      state.memberships = state.memberships.filter(
        (m) => !(m.collectionId === input.collectionId && m.subjectId === input.subjectId),
      );
      return state.memberships.length < before;
    },
    async upsertCollectionPolicy(input) {
      state.policies.set(input.collectionId, {
        collectionId: input.collectionId,
        policyJson: input.policyJson ?? {},
        updatedAt: input.updatedAt,
      });
    },
  };
}

function createMemoryAccessPolicyFacts(state: CollectionsMemoryState): AccessPolicyFactsPort {
  return {
    async loadCollectionFacts(input): Promise<ResourcePolicyFacts | null> {
      const collection = state.collections.get(input.collectionId);
      if (!collection) return null;
      const membership = state.memberships.find(
        (m) => m.collectionId === input.collectionId && m.subjectId === input.actorSubjectId,
      );
      return {
        collectionId: collection.id,
        ownerSubjectId: collection.ownerSubjectId,
        visibility: collection.visibility,
        policyRevision: collection.policyRevision,
        membershipRole: membership?.role ?? null,
        deleted: collection.deletedAt !== null,
      };
    },
  };
}

function createCollectionsWritePorts(state: CollectionsMemoryState): CollectionsWritePorts {
  return {
    receipts: createMemoryProductCommandReceiptPort(state.receipts),
    clock: {
      now: async () => new Date(state.now),
    },
    idLedger: {
      async reserve(entries) {
        for (const entry of entries) {
          if (state.ledger.some((e) => e.resourceId === entry.resourceId)) {
            throw new Error(`duplicate ledger id ${entry.resourceId}`);
          }
          state.ledger.push({ ...entry });
        }
      },
    },
    collections: {
      async insertBootstrap(row) {
        state.bootstrapCollections.push({ ...row });
      },
      async lockForUpdate(collectionId) {
        const row = state.collections.get(collectionId);
        if (!row) return null;
        return { ...row };
      },
      async lockForShare(collectionId) {
        return this.lockForUpdate(collectionId);
      },
      async advanceContentFence(collectionId, update) {
        const row = state.collections.get(collectionId);
        if (!row) throw new Error(`missing collection ${collectionId}`);
        row.contentRevision = update.contentRevision;
        row.commitOrdinal = update.commitOrdinal;
        row.updatedAt = update.updatedAt;
        if (update.policyRevision !== undefined) {
          row.policyRevision = update.policyRevision;
        }
      },
    },
    nodes: {
      async insertRoot(row) {
        state.rootBootstraps.push({ ...row });
      },
      async insertNode(row: NodeInsertRow) {
        state.nodes.set(row.id, {
          id: row.id,
          collectionId: row.collectionId,
          parentId: row.parentId,
          kind: row.kind,
          isRoot: false,
          title: row.title,
          url: row.url,
          description: row.description,
          tags: [...row.tags],
          visibility: row.visibility,
          positionToken: row.positionToken,
          resourceRevision: row.resourceRevision,
          childrenRevision: row.childrenRevision,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          deletedAt: null,
        });
      },
      async getNode(collectionId, nodeId) {
        const row = state.nodes.get(nodeId);
        if (!row || row.collectionId !== collectionId) return null;
        return toLockedNode(row);
      },
      async listLiveSiblingPositions(collectionId, parentId): Promise<readonly SiblingPositionRow[]> {
        return [...state.nodes.values()]
          .filter(
            (n) =>
              n.collectionId === collectionId
              && n.parentId === parentId
              && n.deletedAt === null
              && n.positionToken !== null,
          )
          .sort((a, b) => {
            const pa = a.positionToken!;
            const pb = b.positionToken!;
            if (pa < pb) return -1;
            if (pa > pb) return 1;
            return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
          })
          .map((n) => ({ id: n.id, positionToken: n.positionToken! }));
      },
      async updateContent() {
        throw new Error('updateContent not used by create path');
      },
      async updatePosition(collectionId, nodeId, update) {
        const row = state.nodes.get(nodeId);
        if (!row || row.collectionId !== collectionId) {
          throw new Error(`missing node ${nodeId}`);
        }
        row.positionToken = update.positionToken;
        row.resourceRevision = update.resourceRevision;
        row.updatedAt = update.updatedAt;
      },
      async advanceChildrenRevision(collectionId, nodeId, childrenRevision, updatedAt) {
        const row = state.nodes.get(nodeId);
        if (!row || row.collectionId !== collectionId) {
          throw new Error(`missing parent ${nodeId}`);
        }
        row.childrenRevision = childrenRevision;
        row.updatedAt = updatedAt;
      },
    },
    revisions: {
      async insertResourceRevision(row) {
        state.resourceRevisions.push({ ...row });
      },
      async insertContentRevision(row) {
        state.contentRevisions.push({ ...row });
      },
      async insertPolicyRevision(row) {
        state.policyRevisions.push({ ...row });
      },
      async insertChildrenRevision(row) {
        state.childrenRevisions.push({ ...row });
      },
    },
    operations: {
      async append(record) {
        state.operations.push({ ...record });
      },
    },
    audit: {
      async append(record) {
        state.audit.push({ ...record });
      },
    },
    outbox: {
      async append(record) {
        state.outbox.push({ ...record });
      },
    },
    accessPolicy: createMemoryAccessPolicyWrite(state),
    accessPolicyFacts: createMemoryAccessPolicyFacts(state),
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
  readonly identityPorts: IdentityPorts;
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly factory: ReturnType<typeof createInMemoryBetterAuthTestFactory>;
  readonly collectionsState: CollectionsMemoryState;
  readonly collectionsUnitOfWork: CollectionsUnitOfWork;
}

function createHarness(): Harness {
  const identityState = createIdentityMemoryState(NOW);
  const identityPorts = createIdentityMemoryPorts(identityState);
  const identityUnitOfWork = createIdentityMemoryUnitOfWork(identityState);
  const factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork });

  const collectionsState: CollectionsMemoryState = {
    now: new Date(NOW),
    receipts: new Map(),
    ledger: [],
    bootstrapCollections: [],
    collections: new Map(),
    rootBootstraps: [],
    nodes: new Map(),
    memberships: [],
    policies: new Map(),
    resourceRevisions: [],
    contentRevisions: [],
    policyRevisions: [],
    childrenRevisions: [],
    operations: [],
    audit: [],
    outbox: [],
  };
  const collectionsUnitOfWork: CollectionsUnitOfWork = {
    execute: (work) => executeMemoryTransaction(
      collectionsState,
      (transaction) => work(createCollectionsWritePorts(transaction)),
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

  return {
    app,
    config,
    identityState,
    identityPorts,
    identityUnitOfWork,
    factory,
    collectionsState,
    collectionsUnitOfWork,
  };
}

interface AuthedClient {
  readonly cookie: string;
  readonly csrfToken: string;
  readonly accountId: string;
  readonly subjectId: string;
}

async function issueSession(
  harness: Harness,
  subject: string,
  handle: string,
): Promise<AuthedClient> {
  const client = await issueTestSession({
    factory: harness.factory,
    subject,
    displayName: subject,
    handle,
  });
  return {
    cookie: client.cookie,
    csrfToken: client.csrfToken,
    accountId: client.accountId,
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
  const row: MutableCollection = {
    id: COLLECTION_ID,
    ownerSubjectId: options.ownerSubjectId,
    title: 'HTTP Node Collection',
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
  };
  harness.collectionsState.collections.set(COLLECTION_ID, row);
  harness.collectionsState.memberships.push({
    collectionId: COLLECTION_ID,
    subjectId: options.ownerSubjectId,
    role: 'owner',
    grantedAt: createdAt,
  });
  for (const m of options.memberships ?? []) {
    harness.collectionsState.memberships.push({
      collectionId: COLLECTION_ID,
      subjectId: m.subjectId,
      role: m.role,
      grantedAt: createdAt,
    });
  }
  harness.collectionsState.nodes.set(ROOT_ID, {
    id: ROOT_ID,
    collectionId: COLLECTION_ID,
    parentId: null,
    kind: 'folder',
    isRoot: true,
    title: 'Root',
    url: null,
    description: null,
    tags: [],
    visibility: 'inherit',
    positionToken: null,
    resourceRevision: 'root-res',
    childrenRevision: ROOT_CHILDREN_REV,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
  });
}

function nodesUrl(collectionId = COLLECTION_ID): string {
  return `/api/v1/collections/${collectionId}/nodes`;
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
      payload: VALID_FOLDER_BODY,
    });

    assertProductError(response, 401, 'authentication_required');
  });

  test('403 csrf_failed without Origin/CSRF', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'csrf-node', 'csrfnode1');
    seedCollection(harness, { ownerSubjectId: client.subjectId });

    const missingOrigin = await harness.app.inject({
      method: 'POST',
      url: nodesUrl(),
      headers: {
        cookie: client.cookie,
        'x-csrf-token': client.csrfToken,
        'content-type': 'application/json',
        'known-command-id': COMMAND_A,
      },
      payload: VALID_FOLDER_BODY,
    });
    assertProductError(missingOrigin, 403, 'csrf_failed');

    const missingCsrf = await harness.app.inject({
      method: 'POST',
      url: nodesUrl(),
      headers: {
        cookie: client.cookie,
        origin: harness.config.productOrigin,
        'content-type': 'application/json',
        'known-command-id': COMMAND_B,
      },
      payload: VALID_FOLDER_BODY,
    });
    assertProductError(missingCsrf, 403, 'csrf_failed');
  });

  test('400 when Known-Command-Id missing or invalid', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'cmd-node', 'cmdnode01');
    seedCollection(harness, { ownerSubjectId: client.subjectId });

    const missing = await harness.app.inject({
      method: 'POST',
      url: nodesUrl(),
      headers: authedHeaders(harness, client),
      payload: VALID_FOLDER_BODY,
    });
    assertProductError(missing, 400, 'invalid_request');

    const invalid = await harness.app.inject({
      method: 'POST',
      url: nodesUrl(),
      headers: authedHeaders(harness, client, {
        'known-command-id': 'not-a-uuid',
      }),
      payload: VALID_FOLDER_BODY,
    });
    assertProductError(invalid, 400, 'invalid_request');
  });

  test('415 when media type is not application/json', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'media-node', 'medianode');
    seedCollection(harness, { ownerSubjectId: client.subjectId });

    const response = await harness.app.inject({
      method: 'POST',
      url: nodesUrl(),
      headers: authedHeaders(harness, client, {
        'known-command-id': COMMAND_A,
        'content-type': 'application/merge-patch+json',
      }),
      payload: VALID_FOLDER_BODY,
    });

    assertProductError(response, 415, 'unsupported_media_type');
  });

  test('422 invalid_document for bad body shapes and unsafe url', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'doc-node', 'docnode01');
    seedCollection(harness, { ownerSubjectId: client.subjectId });

    const cases: Array<{ label: string; commandId: string; body: unknown }> = [
      { label: 'empty', commandId: COMMAND_A, body: {} },
      {
        label: 'missing node',
        commandId: COMMAND_B,
        body: { parentId: ROOT_ID, afterId: null, beforeId: null },
      },
      {
        label: 'additional node id',
        commandId: COMMAND_C,
        body: {
          ...VALID_FOLDER_BODY,
          node: { ...VALID_FOLDER_BODY.node, id: 'client-chosen' },
        },
      },
      {
        label: 'javascript url',
        commandId: COMMAND_D,
        body: {
          ...VALID_BOOKMARK_BODY,
          node: { ...VALID_BOOKMARK_BODY.node, url: 'javascript:alert(1)' },
        },
      },
    ];

    for (const sample of cases) {
      const response = await harness.app.inject({
        method: 'POST',
        url: nodesUrl(),
        headers: authedHeaders(harness, client, {
          'known-command-id': sample.commandId,
        }),
        payload: sample.body,
      });
      assert.equal(response.statusCode, 422, sample.label);
      assertProductError(response, 422, 'invalid_document');
    }
  });

  test('413 payload too large when practical', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'big-node', 'bignode01');
    seedCollection(harness, { ownerSubjectId: client.subjectId });

    const hugeTitle = 't'.repeat(BODY_LIMIT_BYTES);
    const response = await harness.app.inject({
      method: 'POST',
      url: nodesUrl(),
      headers: authedHeaders(harness, client, {
        'known-command-id': COMMAND_A,
      }),
      payload: {
        ...VALID_FOLDER_BODY,
        node: { ...VALID_FOLDER_BODY.node, title: hugeTitle, description: 'x'.repeat(BODY_LIMIT_BYTES) },
      },
    });

    // Transport body limit may yield 413; validation may yield 422 before size check.
    assert.ok(
      response.statusCode === 413 || response.statusCode === 422,
      `expected 413 or 422, got ${response.statusCode}`,
    );
    if (response.statusCode === 413) {
      assertProductError(response, 413, 'payload_too_large');
    }
  });

  test('404 resource_not_found for non-member (conceal)', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const owner = await issueSession(harness, 'owner-node', 'ownernode');
    const stranger = await issueSession(harness, 'stranger-n', 'strangern');
    seedCollection(harness, { ownerSubjectId: owner.subjectId });

    const response = await harness.app.inject({
      method: 'POST',
      url: nodesUrl(),
      headers: authedHeaders(harness, stranger, {
        'known-command-id': COMMAND_A,
      }),
      payload: VALID_FOLDER_BODY,
    });

    assertProductError(response, 404, 'resource_not_found');
  });

  test('403 insufficient_permission for viewer', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const owner = await issueSession(harness, 'owner-view', 'ownerview');
    const viewer = await issueSession(harness, 'viewer-n', 'viewern01');
    seedCollection(harness, {
      ownerSubjectId: owner.subjectId,
      memberships: [{ subjectId: viewer.subjectId, role: 'viewer' }],
    });

    const response = await harness.app.inject({
      method: 'POST',
      url: nodesUrl(),
      headers: authedHeaders(harness, viewer, {
        'known-command-id': COMMAND_A,
      }),
      payload: VALID_FOLDER_BODY,
    });

    assertProductError(response, 403, 'insufficient_permission');
  });

  test('201 success: Location, ETag, Cache-Control, CreateNodeResult shape', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'ok-node', 'oknode001');
    seedCollection(harness, { ownerSubjectId: client.subjectId });

    const response = await harness.app.inject({
      method: 'POST',
      url: nodesUrl(),
      headers: authedHeaders(harness, client, {
        'known-command-id': COMMAND_A,
      }),
      payload: VALID_FOLDER_BODY,
    });

    assert.equal(response.statusCode, 201);
    assert.equal(response.headers['cache-control'], 'private, no-store');
    assert.equal(typeof response.headers.etag, 'string');
    assert.match(String(response.headers.etag), /^"[^"]+"$/);
    assert.equal(typeof response.headers.location, 'string');
    assert.match(
      String(response.headers.location),
      new RegExp(`^/api/v1/collections/${COLLECTION_ID}/nodes/`),
    );

    const body = response.json() as {
      node: Record<string, unknown>;
      parent: Record<string, unknown>;
      fence: Record<string, unknown>;
    };
    assert.ok(body.node);
    assert.ok(body.parent);
    assert.ok(body.fence);
    assert.equal(body.node.kind, 'folder');
    assert.equal(body.node.parentId, ROOT_ID);
    assert.equal(body.parent.id, ROOT_ID);
    assert.equal(typeof body.parent.childrenRevision, 'string');
    assert.equal(typeof body.fence.contentRevision, 'string');
    assert.equal(body.node.etag, response.headers.etag);

    // Location target id matches created node
    assert.equal(
      response.headers.location,
      `/api/v1/collections/${COLLECTION_ID}/nodes/${body.node.id}`,
    );

    // Side effects once
    assert.equal(harness.collectionsState.operations.length, 1);
    assert.equal(harness.collectionsState.audit.length, 1);
    assert.equal(harness.collectionsState.outbox.length, 1);
  });

  test('exact retry returns same 201 without double insert', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'retry-node', 'retrynode');
    seedCollection(harness, { ownerSubjectId: client.subjectId });

    const headers = authedHeaders(harness, client, {
      'known-command-id': COMMAND_A,
    });

    const first = await harness.app.inject({
      method: 'POST',
      url: nodesUrl(),
      headers,
      payload: VALID_FOLDER_BODY,
    });
    assert.equal(first.statusCode, 201);
    const firstBody = first.json();
    const nodeCount = harness.collectionsState.nodes.size;
    const opCount = harness.collectionsState.operations.length;

    const second = await harness.app.inject({
      method: 'POST',
      url: nodesUrl(),
      headers,
      payload: VALID_FOLDER_BODY,
    });
    assert.equal(second.statusCode, 201);
    assert.deepEqual(second.json(), firstBody);
    assert.equal(harness.collectionsState.nodes.size, nodeCount);
    assert.equal(harness.collectionsState.operations.length, opCount);
  });

  test('command_id_reused different body → 409', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'reuse-node', 'reusenode');
    seedCollection(harness, { ownerSubjectId: client.subjectId });

    const first = await harness.app.inject({
      method: 'POST',
      url: nodesUrl(),
      headers: authedHeaders(harness, client, { 'known-command-id': COMMAND_A }),
      payload: VALID_FOLDER_BODY,
    });
    assert.equal(first.statusCode, 201);

    const second = await harness.app.inject({
      method: 'POST',
      url: nodesUrl(),
      headers: authedHeaders(harness, client, { 'known-command-id': COMMAND_A }),
      payload: {
        ...VALID_FOLDER_BODY,
        node: { ...VALID_FOLDER_BODY.node, title: 'Different Title' },
      },
    });
    assertProductError(second, 409, 'command_id_reused');
  });
});


