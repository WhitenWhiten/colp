/**
 * P1-08 PATCH /api/v1/collections/{collectionId}/nodes/{nodeId} HTTP contract.
 *
 * Harness: buildApiApp + memory session/CollectionsWritePorts.
 *
 * Covers: CSRF/Origin/session, merge-patch media type, If-Match required 428,
 * Known-Command-Id, success 200 ETag/Cache-Control, root_immutable 409,
 * stale 412, error envelope codes.
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
  strongEntityTag,
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
  type NodeContentUpdateRow,
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

const COLLECTION_ID = 'col-http-nupd-1';
const ROOT_ID = 'root-http-nupd-1';
const FOLDER_ID = 'folder-http-nupd-1';
const BOOKMARK_ID = 'bookmark-http-nupd-1';
const RESOURCE_REV = 'collection-res-http';
const CONTENT_REV = 'collection-content-http';
const POLICY_REV = 'collection-policy-http';
const FOLDER_RESOURCE_REV = 'folder-res-http-1';
const BOOKMARK_RESOURCE_REV = 'bookmark-res-http-1';
const ROOT_RESOURCE_REV = 'root-res-http-1';
const MERGE_PATCH = 'application/merge-patch+json';

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
      async insertNode() {
        throw new Error('insertNode not used by update HTTP path');
      },
      async getNode(collectionId, nodeId) {
        const row = state.nodes.get(nodeId);
        if (!row || row.collectionId !== collectionId) return null;
        return toLockedNode(row);
      },
      async listLiveSiblingPositions(
        _collectionId,
        _parentId,
      ): Promise<readonly SiblingPositionRow[]> {
        return [];
      },
      async updateContent(collectionId, nodeId, update: NodeContentUpdateRow) {
        const row = state.nodes.get(nodeId);
        if (!row || row.collectionId !== collectionId) {
          throw new Error(`missing node ${nodeId}`);
        }
        row.title = update.title;
        row.url = update.url;
        row.description = update.description;
        row.tags = [...update.tags];
        row.visibility = update.visibility;
        row.resourceRevision = update.resourceRevision;
        row.updatedAt = update.updatedAt;
      },
      async updatePosition() {
        throw new Error('updatePosition not used by update HTTP path');
      },
      async advanceChildrenRevision() {
        throw new Error('children revision must not advance on content update');
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
      async insertChildrenRevision() {
        throw new Error('children revision must not advance on content update');
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
  const client = await issueTestSession({ factory: harness.factory, subject, displayName: subject, handle });
  return {
    cookie: client.cookie,
    csrfToken: client.csrfToken,
    accountId: client.accountId,
    subjectId: client.subjectId,
  };
}

function seedGraph(
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
    title: 'HTTP Update Node Collection',
    summary: null,
    kind: 'bookmarks',
    visibility: 'private',
    rootNodeId: ROOT_ID,
    resourceRevision: RESOURCE_REV,
    contentRevision: CONTENT_REV,
    policyRevision: POLICY_REV,
    commitOrdinal: 2n,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
  });
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
    resourceRevision: ROOT_RESOURCE_REV,
    childrenRevision: 'root-children',
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
  });
  harness.collectionsState.nodes.set(FOLDER_ID, {
    id: FOLDER_ID,
    collectionId: COLLECTION_ID,
    parentId: ROOT_ID,
    kind: 'folder',
    isRoot: false,
    title: 'Folder Before',
    url: null,
    description: 'desc',
    tags: ['t1'],
    visibility: 'inherit',
    positionToken: 'U',
    resourceRevision: FOLDER_RESOURCE_REV,
    childrenRevision: 'folder-children',
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
  });
  harness.collectionsState.nodes.set(BOOKMARK_ID, {
    id: BOOKMARK_ID,
    collectionId: COLLECTION_ID,
    parentId: ROOT_ID,
    kind: 'bookmark',
    isRoot: false,
    title: 'Bookmark Before',
    url: 'https://example.com/before',
    description: 'bm',
    tags: [],
    visibility: 'inherit',
    positionToken: 'V',
    resourceRevision: BOOKMARK_RESOURCE_REV,
    childrenRevision: 'bm-unused',
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
  });
}

function nodeUrl(nodeId = FOLDER_ID, collectionId = COLLECTION_ID): string {
  return `/api/v1/collections/${collectionId}/nodes/${nodeId}`;
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
    'content-type': MERGE_PATCH,
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

describe('PATCH /api/v1/collections/:collectionId/nodes/:nodeId HTTP contract', () => {
  test('401 without session', async () => {
    const harness = createHarness();
    apps.push(harness.app);

    const response = await harness.app.inject({
      method: 'PATCH',
      url: nodeUrl(),
      headers: {
        origin: harness.config.productOrigin,
        'x-csrf-token': 'not-a-real-csrf-token-value____________',
        'content-type': MERGE_PATCH,
        'known-command-id': COMMAND_A,
        'if-match': strongEntityTag(FOLDER_RESOURCE_REV),
      },
      payload: { title: 'Nope' },
    });

    assertProductError(response, 401, 'authentication_required');
  });

  test('403 csrf_failed without Origin/CSRF', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'csrf-upd', 'csrfupd1');
    seedGraph(harness, { ownerSubjectId: client.subjectId });

    const missingOrigin = await harness.app.inject({
      method: 'PATCH',
      url: nodeUrl(),
      headers: {
        cookie: client.cookie,
        'x-csrf-token': client.csrfToken,
        'content-type': MERGE_PATCH,
        'known-command-id': COMMAND_A,
        'if-match': strongEntityTag(FOLDER_RESOURCE_REV),
      },
      payload: { title: 'X' },
    });
    assertProductError(missingOrigin, 403, 'csrf_failed');

    const missingCsrf = await harness.app.inject({
      method: 'PATCH',
      url: nodeUrl(),
      headers: {
        cookie: client.cookie,
        origin: harness.config.productOrigin,
        'content-type': MERGE_PATCH,
        'known-command-id': COMMAND_B,
        'if-match': strongEntityTag(FOLDER_RESOURCE_REV),
      },
      payload: { title: 'X' },
    });
    assertProductError(missingCsrf, 403, 'csrf_failed');
  });

  test('428 precondition_required when If-Match missing', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'ifmatch-n', 'ifmatchn1');
    seedGraph(harness, { ownerSubjectId: client.subjectId });

    const response = await harness.app.inject({
      method: 'PATCH',
      url: nodeUrl(),
      headers: authedHeaders(harness, client, {
        'known-command-id': COMMAND_A,
      }),
      payload: { title: 'No If-Match' },
    });

    const error = assertProductError(response, 428, 'precondition_required');
    assert.equal(error.precondition, 'resource');
    assert.equal(error.recovery, 'refresh_and_retry');
  });

  test('400 invalid_request for weak tag, *, multi-value If-Match', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'weak-n', 'weakn001');
    seedGraph(harness, { ownerSubjectId: client.subjectId });

    const cases: Array<{ label: string; commandId: string; ifMatch: string }> = [
      {
        label: 'weak tag',
        commandId: COMMAND_A,
        ifMatch: `W/${strongEntityTag(FOLDER_RESOURCE_REV)}`,
      },
      { label: 'star', commandId: COMMAND_B, ifMatch: '*' },
      {
        label: 'multi-value',
        commandId: COMMAND_C,
        ifMatch: `${strongEntityTag(FOLDER_RESOURCE_REV)}, ${strongEntityTag('other')}`,
      },
      {
        label: 'bare revision',
        commandId: COMMAND_D,
        ifMatch: FOLDER_RESOURCE_REV,
      },
    ];

    for (const sample of cases) {
      const response = await harness.app.inject({
        method: 'PATCH',
        url: nodeUrl(),
        headers: authedHeaders(harness, client, {
          'known-command-id': sample.commandId,
          'if-match': sample.ifMatch,
        }),
        payload: { title: 'Bad If-Match' },
      });
      assertProductError(response, 400, 'invalid_request');
      void sample.label;
    }
  });

  test('400 when Known-Command-Id missing', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'cmd-upd', 'cmdupd001');
    seedGraph(harness, { ownerSubjectId: client.subjectId });

    const response = await harness.app.inject({
      method: 'PATCH',
      url: nodeUrl(),
      headers: authedHeaders(harness, client, {
        'if-match': strongEntityTag(FOLDER_RESOURCE_REV),
      }),
      payload: { title: 'No command' },
    });
    assertProductError(response, 400, 'invalid_request');
  });

  test('415 when media type is not application/merge-patch+json', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'media-upd', 'mediaupd1');
    seedGraph(harness, { ownerSubjectId: client.subjectId });

    const response = await harness.app.inject({
      method: 'PATCH',
      url: nodeUrl(),
      headers: authedHeaders(harness, client, {
        'known-command-id': COMMAND_A,
        'if-match': strongEntityTag(FOLDER_RESOURCE_REV),
        'content-type': 'application/json',
      }),
      payload: { title: 'Wrong media' },
    });

    assertProductError(response, 415, 'unsupported_media_type');
  });

  test('422 invalid_document: empty patch, folder+url, authority fields', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'doc-upd', 'docupd001');
    seedGraph(harness, { ownerSubjectId: client.subjectId });
    const ifMatch = strongEntityTag(FOLDER_RESOURCE_REV);

    const cases: Array<{ label: string; commandId: string; body: unknown }> = [
      { label: 'empty', commandId: COMMAND_A, body: {} },
      {
        label: 'folder url',
        commandId: COMMAND_B,
        body: { url: 'https://example.com/' },
      },
      {
        label: 'kind',
        commandId: COMMAND_C,
        body: { kind: 'bookmark' },
      },
      {
        label: 'position',
        commandId: COMMAND_D,
        body: { position: 'Z' },
      },
    ];

    for (const sample of cases) {
      const response = await harness.app.inject({
        method: 'PATCH',
        url: nodeUrl(),
        headers: authedHeaders(harness, client, {
          'known-command-id': sample.commandId,
          'if-match': ifMatch,
        }),
        payload: sample.body,
      });
      assert.equal(response.statusCode, 422, sample.label);
      assertProductError(response, 422, 'invalid_document');
    }
  });

  test('412 precondition_failed when stale If-Match', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'stale-upd', 'staleupd1');
    seedGraph(harness, { ownerSubjectId: client.subjectId });

    const response = await harness.app.inject({
      method: 'PATCH',
      url: nodeUrl(),
      headers: authedHeaders(harness, client, {
        'known-command-id': COMMAND_A,
        'if-match': strongEntityTag('stale-revision-token'),
      }),
      payload: { title: 'Stale' },
    });

    const error = assertProductError(response, 412, 'precondition_failed');
    assert.equal(error.precondition, 'resource');
    assert.equal(error.currentEtag, strongEntityTag(FOLDER_RESOURCE_REV));
    assert.equal(error.recovery, 'refresh_and_retry');
    assert.equal(harness.collectionsState.operations.length, 0);
    assert.equal(
      harness.collectionsState.nodes.get(FOLDER_ID)!.title,
      'Folder Before',
    );
  });

  test('409 root_immutable when patching root', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'root-upd', 'rootupd01');
    seedGraph(harness, { ownerSubjectId: client.subjectId });

    const response = await harness.app.inject({
      method: 'PATCH',
      url: nodeUrl(ROOT_ID),
      headers: authedHeaders(harness, client, {
        'known-command-id': COMMAND_A,
        'if-match': strongEntityTag(ROOT_RESOURCE_REV),
      }),
      payload: { title: 'Cannot' },
    });

    assertProductError(response, 409, 'root_immutable');
    assert.equal(harness.collectionsState.nodes.get(ROOT_ID)!.title, 'Root');
  });

  test('404 conceal for stranger; 403 viewer deny', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const owner = await issueSession(harness, 'owner-upd', 'ownerupd1');
    const viewer = await issueSession(harness, 'viewer-u', 'vieweru01');
    const stranger = await issueSession(harness, 'stranger-u', 'strangeru');
    seedGraph(harness, {
      ownerSubjectId: owner.subjectId,
      memberships: [{ subjectId: viewer.subjectId, role: 'viewer' }],
    });

    const concealed = await harness.app.inject({
      method: 'PATCH',
      url: nodeUrl(),
      headers: authedHeaders(harness, stranger, {
        'known-command-id': COMMAND_A,
        'if-match': strongEntityTag(FOLDER_RESOURCE_REV),
      }),
      payload: { title: 'Nope' },
    });
    assertProductError(concealed, 404, 'resource_not_found');

    const denied = await harness.app.inject({
      method: 'PATCH',
      url: nodeUrl(),
      headers: authedHeaders(harness, viewer, {
        'known-command-id': COMMAND_B,
        'if-match': strongEntityTag(FOLDER_RESOURCE_REV),
      }),
      payload: { title: 'Viewer' },
    });
    assertProductError(denied, 403, 'insufficient_permission');
  });

  test('200 success: ETag, Cache-Control, UpdateNodeResult shape', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'ok-upd', 'okupd001');
    seedGraph(harness, { ownerSubjectId: client.subjectId });

    const response = await harness.app.inject({
      method: 'PATCH',
      url: nodeUrl(),
      headers: authedHeaders(harness, client, {
        'known-command-id': COMMAND_A,
        'if-match': strongEntityTag(FOLDER_RESOURCE_REV),
      }),
      payload: { title: 'Folder After', description: null, tags: null },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'private, no-store');
    assert.equal(typeof response.headers.etag, 'string');
    assert.match(String(response.headers.etag), /^"[^"]+"$/);

    const body = response.json() as {
      node: Record<string, unknown>;
      fence: Record<string, unknown>;
    };
    assert.ok(body.node);
    assert.ok(body.fence);
    assert.equal(body.node.kind, 'folder');
    assert.equal(body.node.title, 'Folder After');
    assert.equal(body.node.description, null);
    assert.deepEqual(body.node.tags, []);
    assert.equal(body.node.etag, response.headers.etag);
    assert.notEqual(body.node.revision, FOLDER_RESOURCE_REV);
    assert.equal(typeof body.fence.contentRevision, 'string');

    assert.equal(harness.collectionsState.operations.length, 1);
    assert.equal(harness.collectionsState.audit.length, 1);
    assert.equal(harness.collectionsState.outbox.length, 1);
  });

  test('bookmark url update 200; null url 422', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'bm-upd', 'bmupd001');
    seedGraph(harness, { ownerSubjectId: client.subjectId });

    const ok = await harness.app.inject({
      method: 'PATCH',
      url: nodeUrl(BOOKMARK_ID),
      headers: authedHeaders(harness, client, {
        'known-command-id': COMMAND_A,
        'if-match': strongEntityTag(BOOKMARK_RESOURCE_REV),
      }),
      payload: { url: 'https://example.com/after' },
    });
    assert.equal(ok.statusCode, 200);
    const okBody = ok.json() as { node: { url: string } };
    assert.equal(okBody.node.url, 'https://example.com/after');

    const current = harness.collectionsState.nodes.get(BOOKMARK_ID)!.resourceRevision;
    const bad = await harness.app.inject({
      method: 'PATCH',
      url: nodeUrl(BOOKMARK_ID),
      headers: authedHeaders(harness, client, {
        'known-command-id': COMMAND_B,
        'if-match': strongEntityTag(current),
      }),
      payload: { url: null },
    });
    assertProductError(bad, 422, 'invalid_document');
  });

  test('exact retry returns same 200 without second mutation', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'retry-upd', 'retryupd1');
    seedGraph(harness, { ownerSubjectId: client.subjectId });

    const headers = authedHeaders(harness, client, {
      'known-command-id': COMMAND_A,
      'if-match': strongEntityTag(FOLDER_RESOURCE_REV),
    });
    const payload = { title: 'Idempotent Title' };

    const first = await harness.app.inject({
      method: 'PATCH',
      url: nodeUrl(),
      headers,
      payload,
    });
    assert.equal(first.statusCode, 200);
    const firstBody = first.json();
    const opCount = harness.collectionsState.operations.length;
    const title = harness.collectionsState.nodes.get(FOLDER_ID)!.title;

    const second = await harness.app.inject({
      method: 'PATCH',
      url: nodeUrl(),
      headers,
      payload,
    });
    assert.equal(second.statusCode, 200);
    assert.deepEqual(second.json(), firstBody);
    assert.equal(harness.collectionsState.operations.length, opCount);
    assert.equal(harness.collectionsState.nodes.get(FOLDER_ID)!.title, title);
  });

  test('command_id_reused different body → 409', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'reuse-upd', 'reuseupd1');
    seedGraph(harness, { ownerSubjectId: client.subjectId });

    const first = await harness.app.inject({
      method: 'PATCH',
      url: nodeUrl(),
      headers: authedHeaders(harness, client, {
        'known-command-id': COMMAND_A,
        'if-match': strongEntityTag(FOLDER_RESOURCE_REV),
      }),
      payload: { title: 'First Intent' },
    });
    assert.equal(first.statusCode, 200);

    const current = harness.collectionsState.nodes.get(FOLDER_ID)!.resourceRevision;
    const second = await harness.app.inject({
      method: 'PATCH',
      url: nodeUrl(),
      headers: authedHeaders(harness, client, {
        'known-command-id': COMMAND_A,
        'if-match': strongEntityTag(current),
      }),
      payload: { title: 'Second Intent' },
    });
    assertProductError(second, 409, 'command_id_reused');
  });
});

