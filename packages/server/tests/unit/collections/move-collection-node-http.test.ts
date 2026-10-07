/**
 * P1-09 POST /api/v1/collections/{collectionId}/nodes/{nodeId}/move HTTP contract.
 *
 * Covers: 401, CSRF, If-Match required/stale, same-parent reorder, cross-parent move,
 * cycle, root_immutable, stale parent revisions, unauthorized, exact retry.
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
  type NodeInsertRow,
  type NodeParentPositionUpdateRow,
  type NodePositionUpdateRow,
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
const COMMAND_C = '11111111-2222-4333-8444-555555555555';
const NOW = new Date('2026-07-22T12:00:00.000Z');

const COLLECTION_ID = 'col-http-node-move-1';
const ROOT_ID = 'root-http-node-move-1';
const FOLDER_A = 'folder-a-http-move-1';
const FOLDER_B = 'folder-b-http-move-1';
const BOOKMARK_1 = 'bookmark-1-http-move-1';
const BOOKMARK_2 = 'bookmark-2-http-move-1';
const BOOKMARK_3 = 'bookmark-3-http-move-1';
const BOOKMARK_IN_A = 'bookmark-in-a-http-move-1';

const RESOURCE_REV = 'resource-http-move-1';
const CONTENT_REV = 'content-http-move-1';
const POLICY_REV = 'policy-http-move-1';
const ROOT_RESOURCE_REV = 'root-resource-http-move-1';
const ROOT_CHILDREN_REV = 'root-ch-http-move-1';
const FOLDER_A_RESOURCE_REV = 'folder-a-resource-http-1';
const FOLDER_A_CHILDREN_REV = 'folder-a-ch-http-1';
const FOLDER_B_RESOURCE_REV = 'folder-b-resource-http-1';
const FOLDER_B_CHILDREN_REV = 'folder-b-ch-http-1';
const BOOKMARK_1_RESOURCE_REV = 'bm1-resource-http-1';
const BOOKMARK_2_RESOURCE_REV = 'bm2-resource-http-1';
const BOOKMARK_3_RESOURCE_REV = 'bm3-resource-http-1';
const BOOKMARK_IN_A_RESOURCE_REV = 'bm-in-a-resource-http-1';

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
        throw new Error('updateContent not used by move HTTP path');
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
      async updateParentAndPosition(collectionId, nodeId, update: NodeParentPositionUpdateRow) {
        const row = state.nodes.get(nodeId);
        if (!row || row.collectionId !== collectionId) {
          throw new Error(`missing node ${nodeId}`);
        }
        row.parentId = update.parentId;
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
    createdAt,
    updatedAt: createdAt,
  });
}

/**
 * Tree:
 *   ROOT
 *     FOLDER_A (a)
 *       BOOKMARK_IN_A (m)
 *       FOLDER_B (z)
 *     BOOKMARK_1 (b)
 *     BOOKMARK_2 (m)
 *     BOOKMARK_3 (z)
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
    title: 'HTTP Move Node',
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

  putNode(harness, {
    id: ROOT_ID,
    parentId: null,
    kind: 'folder',
    isRoot: true,
    title: 'HTTP Move Node',
    positionToken: null,
    resourceRevision: ROOT_RESOURCE_REV,
    childrenRevision: ROOT_CHILDREN_REV,
  });
  putNode(harness, {
    id: FOLDER_A,
    parentId: ROOT_ID,
    kind: 'folder',
    title: 'Folder A',
    positionToken: 'a',
    resourceRevision: FOLDER_A_RESOURCE_REV,
    childrenRevision: FOLDER_A_CHILDREN_REV,
  });
  putNode(harness, {
    id: BOOKMARK_IN_A,
    parentId: FOLDER_A,
    kind: 'bookmark',
    title: 'In A',
    positionToken: 'm',
    resourceRevision: BOOKMARK_IN_A_RESOURCE_REV,
    childrenRevision: 'bm-ch-unused',
  });
  putNode(harness, {
    id: FOLDER_B,
    parentId: FOLDER_A,
    kind: 'folder',
    title: 'Folder B',
    positionToken: 'z',
    resourceRevision: FOLDER_B_RESOURCE_REV,
    childrenRevision: FOLDER_B_CHILDREN_REV,
  });
  putNode(harness, {
    id: BOOKMARK_1,
    parentId: ROOT_ID,
    kind: 'bookmark',
    title: 'Bookmark 1',
    positionToken: 'b',
    resourceRevision: BOOKMARK_1_RESOURCE_REV,
    childrenRevision: 'bm-ch-unused-1',
  });
  putNode(harness, {
    id: BOOKMARK_2,
    parentId: ROOT_ID,
    kind: 'bookmark',
    title: 'Bookmark 2',
    positionToken: 'm',
    resourceRevision: BOOKMARK_2_RESOURCE_REV,
    childrenRevision: 'bm-ch-unused-2',
  });
  putNode(harness, {
    id: BOOKMARK_3,
    parentId: ROOT_ID,
    kind: 'bookmark',
    title: 'Bookmark 3',
    positionToken: 'z',
    resourceRevision: BOOKMARK_3_RESOURCE_REV,
    childrenRevision: 'bm-ch-unused-3',
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

function moveUrl(nodeId: string, collectionId = COLLECTION_ID): string {
  return `/api/v1/collections/${collectionId}/nodes/${nodeId}/move`;
}

function moveBody(
  overrides: {
    newParentId?: string;
    afterId?: string | null;
    beforeId?: string | null;
    baseSourceParentRevision?: string;
    baseTargetParentRevision?: string;
  } = {},
): Record<string, unknown> {
  return {
    newParentId: overrides.newParentId ?? ROOT_ID,
    afterId: overrides.afterId === undefined ? BOOKMARK_3 : overrides.afterId,
    beforeId: overrides.beforeId === undefined ? null : overrides.beforeId,
    baseSourceParentRevision: overrides.baseSourceParentRevision ?? ROOT_CHILDREN_REV,
    baseTargetParentRevision: overrides.baseTargetParentRevision ?? ROOT_CHILDREN_REV,
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
  assert.equal(response.headers['cache-control'], 'private, no-store');
  const envelope = response.json() as { error: Record<string, unknown> };
  assert.equal(envelope.error.code, expectedCode);
  return envelope.error;
}

const apps: ApiApp[] = [];
afterEach(async () => {
  while (apps.length > 0) await apps.pop()?.close();
});

describe('POST /api/v1/collections/:collectionId/nodes/:nodeId/move HTTP contract', () => {
  test('401 without session', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const response = await harness.app.inject({
      method: 'POST',
      url: moveUrl(BOOKMARK_2),
      headers: {
        origin: harness.config.productOrigin,
        'x-csrf-token': 'not-a-real-csrf-token-value____________',
        'content-type': 'application/json',
        'known-command-id': COMMAND_A,
        'if-match': strongEntityTag(BOOKMARK_2_RESOURCE_REV),
      },
      payload: moveBody(),
    });
    assertProductError(response, 401, 'authentication_required');
  });

  test('403 csrf_failed without Origin', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'csrf-move', 'csrfmove1');
    seedTree(harness, { ownerSubjectId: client.subjectId });

    const response = await harness.app.inject({
      method: 'POST',
      url: moveUrl(BOOKMARK_2),
      headers: {
        cookie: client.cookie,
        'x-csrf-token': client.csrfToken,
        'content-type': 'application/json',
        'known-command-id': COMMAND_A,
        'if-match': strongEntityTag(BOOKMARK_2_RESOURCE_REV),
      },
      payload: moveBody(),
    });
    assertProductError(response, 403, 'csrf_failed');
  });

  test('428 precondition_required when If-Match missing', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'ifmatch-move', 'ifmatchm1');
    seedTree(harness, { ownerSubjectId: client.subjectId });

    const response = await harness.app.inject({
      method: 'POST',
      url: moveUrl(BOOKMARK_2),
      headers: authedHeaders(harness, client, { 'known-command-id': COMMAND_A }),
      payload: moveBody(),
    });
    const error = assertProductError(response, 428, 'precondition_required');
    assert.equal(error.precondition, 'resource');
  });

  test('412 stale If-Match', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'stale-move', 'stalemove1');
    seedTree(harness, { ownerSubjectId: client.subjectId });

    const stale = await harness.app.inject({
      method: 'POST',
      url: moveUrl(BOOKMARK_2),
      headers: authedHeaders(harness, client, {
        'known-command-id': COMMAND_A,
        'if-match': strongEntityTag('stale-rev'),
      }),
      payload: moveBody(),
    });
    const err = assertProductError(stale, 412, 'precondition_failed');
    assert.equal(err.precondition, 'resource');
    assert.equal(err.currentEtag, strongEntityTag(BOOKMARK_2_RESOURCE_REV));
  });

  test('200 same-parent reorder returns MoveNodeResult', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'ok-reorder', 'okreorder1');
    seedTree(harness, { ownerSubjectId: client.subjectId });

    const ok = await harness.app.inject({
      method: 'POST',
      url: moveUrl(BOOKMARK_2),
      headers: authedHeaders(harness, client, {
        'known-command-id': COMMAND_A,
        'if-match': strongEntityTag(BOOKMARK_2_RESOURCE_REV),
      }),
      payload: moveBody({
        newParentId: ROOT_ID,
        afterId: BOOKMARK_3,
        beforeId: null,
        baseSourceParentRevision: ROOT_CHILDREN_REV,
        baseTargetParentRevision: ROOT_CHILDREN_REV,
      }),
    });

    assert.equal(ok.statusCode, 200);
    assert.equal(ok.headers['cache-control'], 'private, no-store');
    assert.equal(typeof ok.headers.etag, 'string');
    const body = ok.json() as {
      node: Record<string, unknown>;
      sourceParent: Record<string, unknown>;
      targetParent: Record<string, unknown>;
      fence: Record<string, unknown>;
    };
    assert.equal(body.node.id, BOOKMARK_2);
    assert.equal(body.node.parentId, ROOT_ID);
    assert.equal(body.node.etag, ok.headers.etag);
    assert.equal(body.sourceParent.id, ROOT_ID);
    assert.equal(body.targetParent.id, ROOT_ID);
    assert.notEqual(body.sourceParent.childrenRevision, ROOT_CHILDREN_REV);
    assert.equal(body.sourceParent.childrenRevision, body.targetParent.childrenRevision);
    assert.ok(body.fence.contentRevision);
    assert.equal(harness.collectionsState.nodes.get(BOOKMARK_2)!.parentId, ROOT_ID);
  });

  test('200 cross-parent move advances both parents', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'ok-cross', 'okcross1');
    seedTree(harness, { ownerSubjectId: client.subjectId });

    const ok = await harness.app.inject({
      method: 'POST',
      url: moveUrl(BOOKMARK_1),
      headers: authedHeaders(harness, client, {
        'known-command-id': COMMAND_A,
        'if-match': strongEntityTag(BOOKMARK_1_RESOURCE_REV),
      }),
      payload: moveBody({
        newParentId: FOLDER_A,
        afterId: BOOKMARK_IN_A,
        beforeId: FOLDER_B,
        baseSourceParentRevision: ROOT_CHILDREN_REV,
        baseTargetParentRevision: FOLDER_A_CHILDREN_REV,
      }),
    });

    assert.equal(ok.statusCode, 200);
    const body = ok.json() as {
      node: { parentId: string; position: string };
      sourceParent: { id: string; childrenRevision: string };
      targetParent: { id: string; childrenRevision: string };
    };
    assert.equal(body.node.parentId, FOLDER_A);
    assert.equal(body.sourceParent.id, ROOT_ID);
    assert.equal(body.targetParent.id, FOLDER_A);
    assert.notEqual(body.sourceParent.childrenRevision, ROOT_CHILDREN_REV);
    assert.notEqual(body.targetParent.childrenRevision, FOLDER_A_CHILDREN_REV);
    assert.equal(harness.collectionsState.nodes.get(BOOKMARK_1)!.parentId, FOLDER_A);
  });

  test('409 cycle when reparenting under descendant', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'cycle-move', 'cyclemove1');
    seedTree(harness, { ownerSubjectId: client.subjectId });

    const response = await harness.app.inject({
      method: 'POST',
      url: moveUrl(FOLDER_A),
      headers: authedHeaders(harness, client, {
        'known-command-id': COMMAND_A,
        'if-match': strongEntityTag(FOLDER_A_RESOURCE_REV),
      }),
      payload: moveBody({
        newParentId: FOLDER_B,
        afterId: null,
        beforeId: null,
        baseSourceParentRevision: ROOT_CHILDREN_REV,
        baseTargetParentRevision: FOLDER_B_CHILDREN_REV,
      }),
    });

    // Product maps cycle to invalid_document (422) or a 409 domain conflict.
    assert.ok(
      response.statusCode === 422 || response.statusCode === 409,
      `status ${response.statusCode}`,
    );
    const envelope = response.json() as { error: { code: string } };
    assert.ok(
      envelope.error.code === 'invalid_document'
        || envelope.error.code === 'position_context_stale'
        || envelope.error.code === 'revision_conflict',
      envelope.error.code,
    );
    assert.equal(harness.collectionsState.nodes.get(FOLDER_A)!.parentId, ROOT_ID);
    assert.equal(harness.collectionsState.operations.length, 0);
  });

  test('409 root_immutable', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'root-move', 'rootmove1');
    seedTree(harness, { ownerSubjectId: client.subjectId });

    const response = await harness.app.inject({
      method: 'POST',
      url: moveUrl(ROOT_ID),
      headers: authedHeaders(harness, client, {
        'known-command-id': COMMAND_A,
        'if-match': strongEntityTag(ROOT_RESOURCE_REV),
      }),
      payload: moveBody({
        newParentId: FOLDER_A,
        afterId: null,
        beforeId: null,
        baseSourceParentRevision: ROOT_CHILDREN_REV,
        baseTargetParentRevision: FOLDER_A_CHILDREN_REV,
      }),
    });
    assertProductError(response, 409, 'root_immutable');
    assert.equal(harness.collectionsState.operations.length, 0);
  });

  test('409 position_context_stale for source and target parent revisions', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'stale-parent', 'stalepar1');
    seedTree(harness, { ownerSubjectId: client.subjectId });

    const staleSource = await harness.app.inject({
      method: 'POST',
      url: moveUrl(BOOKMARK_1),
      headers: authedHeaders(harness, client, {
        'known-command-id': COMMAND_A,
        'if-match': strongEntityTag(BOOKMARK_1_RESOURCE_REV),
      }),
      payload: moveBody({
        newParentId: FOLDER_A,
        afterId: null,
        beforeId: null,
        baseSourceParentRevision: 'stale-source',
        baseTargetParentRevision: FOLDER_A_CHILDREN_REV,
      }),
    });
    assertProductError(staleSource, 409, 'position_context_stale');

    const staleTarget = await harness.app.inject({
      method: 'POST',
      url: moveUrl(BOOKMARK_1),
      headers: authedHeaders(harness, client, {
        'known-command-id': COMMAND_B,
        'if-match': strongEntityTag(BOOKMARK_1_RESOURCE_REV),
      }),
      payload: moveBody({
        newParentId: FOLDER_A,
        afterId: null,
        beforeId: null,
        baseSourceParentRevision: ROOT_CHILDREN_REV,
        baseTargetParentRevision: 'stale-target',
      }),
    });
    assertProductError(staleTarget, 409, 'position_context_stale');
    assert.equal(harness.collectionsState.operations.length, 0);
  });

  test('viewer 403; stranger 404; exact command retry', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const owner = await issueSession(harness, 'owner-move', 'ownerm1');
    const viewer = await issueSession(harness, 'viewer-move', 'viewerm1');
    const stranger = await issueSession(harness, 'stranger-move', 'strangerm1');
    seedTree(harness, {
      ownerSubjectId: owner.subjectId,
      memberships: [{ subjectId: viewer.subjectId, role: 'viewer' }],
    });

    assertProductError(
      await harness.app.inject({
        method: 'POST',
        url: moveUrl(BOOKMARK_2),
        headers: authedHeaders(harness, viewer, {
          'known-command-id': COMMAND_A,
          'if-match': strongEntityTag(BOOKMARK_2_RESOURCE_REV),
        }),
        payload: moveBody(),
      }),
      403,
      'insufficient_permission',
    );
    assertProductError(
      await harness.app.inject({
        method: 'POST',
        url: moveUrl(BOOKMARK_2),
        headers: authedHeaders(harness, stranger, {
          'known-command-id': COMMAND_B,
          'if-match': strongEntityTag(BOOKMARK_2_RESOURCE_REV),
        }),
        payload: moveBody(),
      }),
      404,
      'resource_not_found',
    );

    const payload = moveBody({
      newParentId: ROOT_ID,
      afterId: BOOKMARK_3,
      beforeId: null,
      baseSourceParentRevision: ROOT_CHILDREN_REV,
      baseTargetParentRevision: ROOT_CHILDREN_REV,
    });
    const headers = authedHeaders(harness, owner, {
      'known-command-id': COMMAND_C,
      'if-match': strongEntityTag(BOOKMARK_2_RESOURCE_REV),
    });
    const first = await harness.app.inject({
      method: 'POST',
      url: moveUrl(BOOKMARK_2),
      headers,
      payload,
    });
    assert.equal(first.statusCode, 200);
    const ops = harness.collectionsState.operations.length;
    const second = await harness.app.inject({
      method: 'POST',
      url: moveUrl(BOOKMARK_2),
      headers,
      payload,
    });
    assert.equal(second.statusCode, 200);
    assert.equal(second.headers.etag, first.headers.etag);
    assert.deepEqual(second.json(), first.json());
    assert.equal(harness.collectionsState.operations.length, ops);
  });
});

