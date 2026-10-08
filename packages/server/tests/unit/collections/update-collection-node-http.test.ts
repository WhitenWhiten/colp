/**
 * P1-08 PATCH /api/v1/collections/{collectionId}/nodes/{nodeId} HTTP contract.
 *
 * Optional transport tests. Covers: 401, CSRF, If-Match required/stale, merge-patch
 * media type, root_immutable, file:// url, unauthorized, exact retry.
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

const COMMAND_A = '5de3947e-6271-4fdf-a946-d22e58a99c2a';
const COMMAND_B = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
const NOW = new Date('2026-07-22T12:00:00.000Z');
const COLLECTION_ID = 'col-http-node-update-1';
const ROOT_ID = 'root-http-node-update-1';
const FOLDER_ID = 'folder-http-node-update-1';
const BOOKMARK_ID = 'bookmark-http-node-update-1';
const RESOURCE_REV = 'resource-http-update-1';
const CONTENT_REV = 'content-http-update-1';
const POLICY_REV = 'policy-http-update-1';
const FOLDER_RESOURCE_REV = 'folder-resource-http-1';
const BOOKMARK_RESOURCE_REV = 'bookmark-resource-http-1';
const ROOT_RESOURCE_REV = 'root-resource-http-1';
const MERGE_PATCH = 'application/merge-patch+json';

type NodeVisibility = 'inherit' | 'protected' | 'private';

// ---------------------------------------------------------------------------
// Identity memory
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Collections memory
// ---------------------------------------------------------------------------

interface MembershipRow {
  collectionId: string;
  subjectId: string;
  role: MembershipRole;
  grantedAt: Date;
}

interface MutableCollection extends LockedCollectionRow {}

interface MutableNode {
  id: string;
  collectionId: string;
  kind: 'folder' | 'bookmark';
  isRoot: boolean;
  parentId: string | null;
  positionToken: string | null;
  title: string;
  url: string | null;
  description: string | null;
  tags: string[];
  visibility: NodeVisibility;
  resourceRevision: string;
  childrenRevision: string;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface CollectionsMemoryState {
  now: Date;
  receipts: MemoryProductCommandReceipts;
  ledger: IdLedgerReserveEntry[];
  bootstrapCollections: CollectionBootstrapRow[];
  collections: Map<string, MutableCollection>;
  nodes: Map<string, MutableNode>;
  rootBootstrap: RootNodeBootstrapRow[];
  memberships: MembershipRow[];
  policies: Map<string, { collectionId: string; policyJson: Readonly<Record<string, unknown>>; updatedAt: Date }>;
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

function createCollectionsWritePorts(state: CollectionsMemoryState): CollectionsWritePorts {
  return {
    receipts: createMemoryProductCommandReceiptPort(state.receipts),
    clock: { now: async () => new Date(state.now) },
    idLedger: {
      async reserve(entries: readonly IdLedgerReserveEntry[]) {
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
        return row ? { ...row } : null;
      },
      async lockForShare(collectionId) {
        return this.lockForUpdate(collectionId);
      },
      async advanceContentFence(collectionId, update) {
        const row = state.collections.get(collectionId);
        if (!row) throw new Error('missing collection');
        row.contentRevision = update.contentRevision;
        row.commitOrdinal = update.commitOrdinal;
        row.updatedAt = update.updatedAt;
        if (update.policyRevision !== undefined) {
          row.policyRevision = update.policyRevision;
        }
      },
    },
    nodes: {
      async insertRoot(row: RootNodeBootstrapRow) {
        state.rootBootstrap.push({ ...row });
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
    accessPolicy: {
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
    } satisfies AccessPolicyWritePort,
    accessPolicyFacts: {
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
    } satisfies AccessPolicyFactsPort,
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type ApiApp = ReturnType<typeof buildApiApp>;

interface Harness {
  readonly app: ApiApp;
  readonly config: ReturnType<typeof loadConfig>;
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly factory: ReturnType<typeof createInMemoryBetterAuthTestFactory>;
  readonly collectionsState: CollectionsMemoryState;
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
    nodes: new Map(),
    rootBootstrap: [],
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
    title: 'HTTP Update Node',
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
  const baseNode = {
    collectionId: COLLECTION_ID,
    description: null as string | null,
    tags: [] as string[],
    visibility: 'inherit' as NodeVisibility,
    deletedAt: null as Date | null,
    createdAt,
    updatedAt: createdAt,
  };
  harness.collectionsState.nodes.set(ROOT_ID, {
    ...baseNode,
    id: ROOT_ID,
    kind: 'folder',
    isRoot: true,
    parentId: null,
    positionToken: null,
    title: 'HTTP Update Node',
    url: null,
    resourceRevision: ROOT_RESOURCE_REV,
    childrenRevision: 'root-ch-1',
  });
  harness.collectionsState.nodes.set(FOLDER_ID, {
    ...baseNode,
    id: FOLDER_ID,
    kind: 'folder',
    isRoot: false,
    parentId: ROOT_ID,
    positionToken: 'F',
    title: 'Folder',
    url: null,
    resourceRevision: FOLDER_RESOURCE_REV,
    childrenRevision: 'folder-ch-1',
  });
  harness.collectionsState.nodes.set(BOOKMARK_ID, {
    ...baseNode,
    id: BOOKMARK_ID,
    kind: 'bookmark',
    isRoot: false,
    parentId: ROOT_ID,
    positionToken: 'B',
    title: 'Bookmark',
    url: 'https://example.test/original',
    resourceRevision: BOOKMARK_RESOURCE_REV,
    childrenRevision: 'bm-ch-unused',
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
    'content-type': MERGE_PATCH,
    ...extra,
  };
}

function nodeUrl(nodeId: string, collectionId = COLLECTION_ID): string {
  return `/api/v1/collections/${collectionId}/nodes/${nodeId}`;
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

describe('PATCH /api/v1/collections/:collectionId/nodes/:nodeId HTTP contract', () => {
  test('401 without session', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const response = await harness.app.inject({
      method: 'PATCH',
      url: nodeUrl(FOLDER_ID),
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

  test('428 precondition_required when If-Match missing', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'ifmatch-n', 'ifmatchn1');
    seedTree(harness, { ownerSubjectId: client.subjectId });

    const response = await harness.app.inject({
      method: 'PATCH',
      url: nodeUrl(FOLDER_ID),
      headers: authedHeaders(harness, client, { 'known-command-id': COMMAND_A }),
      payload: { title: 'No If-Match' },
    });
    const error = assertProductError(response, 428, 'precondition_required');
    assert.equal(error.precondition, 'resource');
  });

  test('412 stale If-Match; 415 wrong media type', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'stale-n', 'stalen1');
    seedTree(harness, { ownerSubjectId: client.subjectId });

    const stale = await harness.app.inject({
      method: 'PATCH',
      url: nodeUrl(FOLDER_ID),
      headers: authedHeaders(harness, client, {
        'known-command-id': COMMAND_A,
        'if-match': strongEntityTag('stale-rev'),
      }),
      payload: { title: 'Stale' },
    });
    const err = assertProductError(stale, 412, 'precondition_failed');
    assert.equal(err.precondition, 'resource');
    assert.equal(err.currentEtag, strongEntityTag(FOLDER_RESOURCE_REV));

    const media = await harness.app.inject({
      method: 'PATCH',
      url: nodeUrl(FOLDER_ID),
      headers: authedHeaders(harness, client, {
        'known-command-id': COMMAND_B,
        'if-match': strongEntityTag(FOLDER_RESOURCE_REV),
        'content-type': 'application/json',
      }),
      payload: { title: 'Wrong media' },
    });
    assertProductError(media, 415, 'unsupported_media_type');
  });

  test('200 folder patch; root_immutable 409; file:// bookmark 422', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'ok-upd-n', 'okupdn1');
    seedTree(harness, { ownerSubjectId: client.subjectId });

    const ok = await harness.app.inject({
      method: 'PATCH',
      url: nodeUrl(FOLDER_ID),
      headers: authedHeaders(harness, client, {
        'known-command-id': COMMAND_A,
        'if-match': strongEntityTag(FOLDER_RESOURCE_REV),
      }),
      payload: { title: 'Renamed' },
    });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.headers['cache-control'], 'private, no-store');
    const body = ok.json() as { node: Record<string, unknown>; fence: Record<string, unknown> };
    assert.equal(body.node.title, 'Renamed');
    assert.equal(body.node.etag, ok.headers.etag);
    assert.ok(body.fence.contentRevision);

    const root = await harness.app.inject({
      method: 'PATCH',
      url: nodeUrl(ROOT_ID),
      headers: authedHeaders(harness, client, {
        'known-command-id': COMMAND_B,
        'if-match': strongEntityTag(ROOT_RESOURCE_REV),
      }),
      payload: { title: 'Root rename' },
    });
    assertProductError(root, 409, 'root_immutable');

    const fileUrl = await harness.app.inject({
      method: 'PATCH',
      url: nodeUrl(BOOKMARK_ID),
      headers: authedHeaders(harness, client, {
        'known-command-id': 'cccccccc-dddd-4eee-8fff-000000000001',
        'if-match': strongEntityTag(BOOKMARK_RESOURCE_REV),
      }),
      payload: { url: 'file:///tmp/x' },
    });
    assertProductError(fileUrl, 422, 'invalid_document');
  });

  test('viewer 403; stranger 404; exact retry', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const owner = await issueSession(harness, 'owner-upd', 'owneru1');
    const viewer = await issueSession(harness, 'viewer-upd', 'vieweru1');
    const stranger = await issueSession(harness, 'stranger-upd', 'strangeru1');
    seedTree(harness, {
      ownerSubjectId: owner.subjectId,
      memberships: [{ subjectId: viewer.subjectId, role: 'viewer' }],
    });

    assertProductError(
      await harness.app.inject({
        method: 'PATCH',
        url: nodeUrl(FOLDER_ID),
        headers: authedHeaders(harness, viewer, {
          'known-command-id': COMMAND_A,
          'if-match': strongEntityTag(FOLDER_RESOURCE_REV),
        }),
        payload: { title: 'Viewer' },
      }),
      403,
      'insufficient_permission',
    );
    assertProductError(
      await harness.app.inject({
        method: 'PATCH',
        url: nodeUrl(FOLDER_ID),
        headers: authedHeaders(harness, stranger, {
          'known-command-id': COMMAND_B,
          'if-match': strongEntityTag(FOLDER_RESOURCE_REV),
        }),
        payload: { title: 'Stranger' },
      }),
      404,
      'resource_not_found',
    );

    const payload = { title: 'Retry Title' };
    const headers = authedHeaders(harness, owner, {
      'known-command-id': COMMAND_A,
      'if-match': strongEntityTag(FOLDER_RESOURCE_REV),
    });
    const first = await harness.app.inject({
      method: 'PATCH',
      url: nodeUrl(FOLDER_ID),
      headers,
      payload,
    });
    assert.equal(first.statusCode, 200);
    const ops = harness.collectionsState.operations.length;
    const second = await harness.app.inject({
      method: 'PATCH',
      url: nodeUrl(FOLDER_ID),
      headers,
      payload,
    });
    assert.equal(second.statusCode, 200);
    assert.equal(second.headers.etag, first.headers.etag);
    assert.deepEqual(second.json(), first.json());
    assert.equal(harness.collectionsState.operations.length, ops);
  });
});

