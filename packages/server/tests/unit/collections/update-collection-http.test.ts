/**
 * P1-07 PATCH /api/v1/collections/{collectionId} HTTP contract (Fastify inject).
 *
 * Harness:
 *   buildApiApp({ config, identityUnitOfWork, collectionsUnitOfWork })
 *   Memory session + memory CollectionsWritePorts (lock/update + accessPolicyFacts).
 *
 * Covers: merge-patch media type, If-Match, CSRF/Origin, auth conceal/deny,
 * command replay/reuse, 200 UpdateCollectionResult, 412/428 preconditions.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'vitest';
import {
  createIdentityMemoryPorts,
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
  createMemoryProductCommandReceiptPort,
  executeMemoryTransaction,
  type IdentityMemoryState,
  type MemoryProductCommandReceipts,
} from '../../support/product-http-harness.js';
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
  type PolicyRevisionInsert,
  type ProductCollectionMutationUnitOfWork,
  type ResourceRevisionInsert,
  type RootNodeBootstrapRow,
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
const COMMAND_E = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const NOW = new Date('2026-07-22T12:00:00.000Z');

const COLLECTION_ID = 'col-http-meta-1';
const ROOT_ID = 'root-http-meta-1';
const RESOURCE_REV = 'resource-http-meta-1';
const CONTENT_REV = 'content-http-meta-1';
const POLICY_REV = 'policy-http-meta-1';
const MERGE_PATCH = 'application/merge-patch+json';

// ---------------------------------------------------------------------------
// Identity memory
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Collections write memory (create + update metadata)
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

interface CollectionsMemoryState {
  now: Date;
  receipts: MemoryProductCommandReceipts;
  ledger: IdLedgerReserveEntry[];
  /** Create bootstrap rows (unused by PATCH path but part of write ports). */
  bootstrapCollections: CollectionBootstrapRow[];
  collections: Map<string, MutableCollection>;
  nodes: RootNodeBootstrapRow[];
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
      },
    },
    nodes: {
      async insertRoot(row) {
        state.nodes.push({ ...row });
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

function createProductCollectionMutationUnitOfWork(
  state: CollectionsMemoryState,
): ProductCollectionMutationUnitOfWork {
  return {
    async execute(work) {
      return executeMemoryTransaction(state, async (transaction) => {
        const writes = createCollectionsWritePorts(transaction);
        return work({
          receipts: writes.receipts,
          clock: writes.clock,
          collections: writes.collections,
          accessPolicy: writes.accessPolicyFacts,
          canonical: {
            async bootstrapOwnedCollection() { throw new Error('update harness does not bootstrap collections'); },
            async execute(input) {
              const row = transaction.collections.get(input.collectionId);
              if (!row) throw new Error('missing collection');
              const fields = input.mutation.fields!.kindFields;
              const ordinal = row.commitOrdinal + 1n;
              const resourceRevision = `resource-canonical-${ordinal}`;
              const contentRevision = `content-canonical-${ordinal}`;
              const policyChanged = fields.visibility !== row.visibility
                || fields.allowSearchIndexing !== row.allowSearchIndexing;
              const policyRevision = policyChanged ? `policy-canonical-${ordinal}` : row.policyRevision;
              row.title = String(fields.title);
              row.summary = fields.summary === null ? null : String(fields.summary);
              row.visibility = fields.visibility as LockedCollectionRow['visibility'];
              row.allowSearchIndexing = fields.allowSearchIndexing as boolean;
              if (typeof fields.publicationSlug === 'string') {
                row.publicationSlug = fields.publicationSlug;
                row.publishedAt ??= new Date(transaction.now);
              }
              row.resourceRevision = resourceRevision;
              row.contentRevision = contentRevision;
              row.policyRevision = policyRevision;
              row.commitOrdinal = ordinal;
              row.updatedAt = new Date(transaction.now);
              transaction.operations.push({ operationId: input.operationId, collectionId: input.collectionId, commitOrdinal: ordinal, operationType: 'resource.update', payload: {}, actorPrincipalId: input.actor.principalId, createdAt: new Date(transaction.now) });
              transaction.audit.push({ operationId: input.operationId, collectionId: input.collectionId, principalId: input.actor.principalId, eventType: 'resource.update', details: {}, createdAt: new Date(transaction.now) });
              transaction.outbox.push({ outboxId: `outbox-${ordinal}`, domainEventId: input.operationId, eventType: 'collection.updated', eventVersion: 1, handlerName: 'collection_updated_projection', handlerMode: 'projection_latest_only', aggregateType: 'collection', aggregateId: input.collectionId, aggregateScope: input.collectionId, aggregateRevision: resourceRevision, commitOrdinal: ordinal, payload: {}, occurredAt: new Date(transaction.now) });
              return {
                operationId: input.operationId,
                collectionId: input.collectionId,
                resourceId: input.collectionId,
                action: 'update' as const,
                allocation: {
                  commitOrdinal: ordinal,
                  resourceRevision,
                  contentRevision,
                  ...(policyChanged ? { policyRevision } : {}),
                  childrenRevisions: {},
                },
              };
            },
          },
        });
      });
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
    nodes: [],
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
  const productCollectionMutationUnitOfWork = createProductCollectionMutationUnitOfWork(collectionsState);

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
    config,
    identityUnitOfWork,
    collectionsUnitOfWork,
    productCollectionMutationUnitOfWork,
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

function seedCollection(
  harness: Harness,
  options: {
    collectionId?: string;
    ownerSubjectId: string;
    title?: string;
    summary?: string | null;
    visibility?: LockedCollectionRow['visibility'];
    resourceRevision?: string;
    contentRevision?: string;
    policyRevision?: string;
    commitOrdinal?: bigint;
    memberships?: Array<{ subjectId: string; role: MembershipRole }>;
  },
): MutableCollection {
  const collectionId = options.collectionId ?? COLLECTION_ID;
  const createdAt = new Date(harness.collectionsState.now);
  const row: MutableCollection = {
    id: collectionId,
    ownerSubjectId: options.ownerSubjectId,
    title: options.title ?? 'HTTP Original',
    summary: options.summary === undefined ? 'http summary' : options.summary,
    kind: 'bookmarks',
    visibility: options.visibility ?? 'private',
    allowSearchIndexing: false,
    rootNodeId: ROOT_ID,
    resourceRevision: options.resourceRevision ?? RESOURCE_REV,
    contentRevision: options.contentRevision ?? CONTENT_REV,
    policyRevision: options.policyRevision ?? POLICY_REV,
    commitOrdinal: options.commitOrdinal ?? 1n,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
  };
  harness.collectionsState.collections.set(collectionId, row);
  harness.collectionsState.memberships.push({
    collectionId,
    subjectId: options.ownerSubjectId,
    role: 'owner',
    grantedAt: createdAt,
  });
  for (const m of options.memberships ?? []) {
    harness.collectionsState.memberships.push({
      collectionId,
      subjectId: m.subjectId,
      role: m.role,
      grantedAt: createdAt,
    });
  }
  return row;
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

function patchUrl(collectionId = COLLECTION_ID): string {
  return `/api/v1/collections/${collectionId}`;
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

describe('PATCH /api/v1/collections/:collectionId HTTP contract', () => {
  test('401 without session', async () => {
    const harness = createHarness();
    apps.push(harness.app);

    const response = await harness.app.inject({
      method: 'PATCH',
      url: patchUrl(),
      headers: {
        origin: harness.config.productOrigin,
        'x-csrf-token': 'not-a-real-csrf-token-value____________',
        'content-type': MERGE_PATCH,
        'known-command-id': COMMAND_A,
        'if-match': strongEntityTag(RESOURCE_REV),
      },
      payload: { title: 'Nope' },
    });

    assertProductError(response, 401, 'authentication_required');
  });

  test('403 csrf_failed without Origin/CSRF', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'csrf-user', 'csrfuser1');
    seedCollection(harness, { ownerSubjectId: client.subjectId });

    const missingOrigin = await harness.app.inject({
      method: 'PATCH',
      url: patchUrl(),
      headers: {
        cookie: client.cookie,
        'x-csrf-token': client.csrfToken,
        'content-type': MERGE_PATCH,
        'known-command-id': COMMAND_A,
        'if-match': strongEntityTag(RESOURCE_REV),
      },
      payload: { title: 'X' },
    });
    assertProductError(missingOrigin, 403, 'csrf_failed');

    const missingCsrf = await harness.app.inject({
      method: 'PATCH',
      url: patchUrl(),
      headers: {
        cookie: client.cookie,
        origin: harness.config.productOrigin,
        'content-type': MERGE_PATCH,
        'known-command-id': COMMAND_B,
        'if-match': strongEntityTag(RESOURCE_REV),
      },
      payload: { title: 'X' },
    });
    assertProductError(missingCsrf, 403, 'csrf_failed');
  });

  test('428 precondition_required when If-Match missing', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'ifmatch-user', 'ifmatch1');
    seedCollection(harness, { ownerSubjectId: client.subjectId });

    const response = await harness.app.inject({
      method: 'PATCH',
      url: patchUrl(),
      headers: authedHeaders(harness, client, { 'known-command-id': COMMAND_A }),
      payload: { title: 'No If-Match' },
    });

    const error = assertProductError(response, 428, 'precondition_required');
    assert.equal(error.precondition, 'resource');
    assert.equal(error.recovery, 'refresh_and_retry');
  });

  test('400 invalid_request for weak tag, *, multi-value If-Match', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'weak-user', 'weakuser1');
    seedCollection(harness, { ownerSubjectId: client.subjectId });

    const cases: Array<{ label: string; commandId: string; ifMatch: string }> = [
      {
        label: 'weak tag',
        commandId: COMMAND_A,
        ifMatch: `W/${strongEntityTag(RESOURCE_REV)}`,
      },
      { label: 'star', commandId: COMMAND_B, ifMatch: '*' },
      {
        label: 'multi-value list',
        commandId: COMMAND_C,
        ifMatch: `${strongEntityTag(RESOURCE_REV)}, ${strongEntityTag('other')}`,
      },
      {
        label: 'bare revision (not strong entity-tag)',
        commandId: COMMAND_D,
        ifMatch: RESOURCE_REV,
      },
    ];

    for (const sample of cases) {
      const response = await harness.app.inject({
        method: 'PATCH',
        url: patchUrl(),
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

  test('media type not application/merge-patch+json → 415', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'media-user', 'mediauser1');
    seedCollection(harness, { ownerSubjectId: client.subjectId });

    const response = await harness.app.inject({
      method: 'PATCH',
      url: patchUrl(),
      headers: authedHeaders(harness, client, {
        'known-command-id': COMMAND_A,
        'if-match': strongEntityTag(RESOURCE_REV),
        'content-type': 'application/json',
      }),
      payload: { title: 'Wrong media' },
    });

    assertProductError(response, 415, 'unsupported_media_type');
  });

  test('422 invalid document: empty patch, additional properties, null title, overlong', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'doc-user', 'docuser1');
    seedCollection(harness, { ownerSubjectId: client.subjectId });
    const ifMatch = strongEntityTag(RESOURCE_REV);

    const cases: Array<{ label: string; commandId: string; body: unknown }> = [
      { label: 'empty object', commandId: COMMAND_A, body: {} },
      {
        label: 'additional tags',
        commandId: COMMAND_B,
        body: { title: 'X', tags: ['a'] },
      },
      {
        label: 'additional visibility',
        commandId: COMMAND_C,
        body: { visibility: 'public' },
      },
      {
        label: 'additional kind',
        commandId: COMMAND_D,
        body: { kind: 'mixed', title: 'X' },
      },
      {
        label: 'title null',
        commandId: COMMAND_E,
        body: { title: null },
      },
    ];

    for (const sample of cases) {
      const response = await harness.app.inject({
        method: 'PATCH',
        url: patchUrl(),
        headers: authedHeaders(harness, client, {
          'known-command-id': sample.commandId,
          'if-match': ifMatch,
        }),
        payload: sample.body,
      });
      assert.equal(response.statusCode, 422, sample.label);
      assertProductError(response, 422, 'invalid_document');
    }

    // Overlong title — separate command id
    const overlong = await harness.app.inject({
      method: 'PATCH',
      url: patchUrl(),
      headers: authedHeaders(harness, client, {
        'known-command-id': 'cccccccc-dddd-4eee-8fff-000000000001',
        'if-match': ifMatch,
      }),
      payload: { title: 't'.repeat(513) },
    });
    assertProductError(overlong, 422, 'invalid_document');
  });

  test('412 precondition_failed with precondition=resource and currentEtag when stale', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'stale-user', 'staleuser1');
    seedCollection(harness, {
      ownerSubjectId: client.subjectId,
      resourceRevision: RESOURCE_REV,
    });

    const response = await harness.app.inject({
      method: 'PATCH',
      url: patchUrl(),
      headers: authedHeaders(harness, client, {
        'known-command-id': COMMAND_A,
        'if-match': strongEntityTag('stale-revision-token'),
      }),
      payload: { title: 'Stale attempt' },
    });

    const error = assertProductError(response, 412, 'precondition_failed');
    assert.equal(error.precondition, 'resource');
    assert.equal(error.currentEtag, strongEntityTag(RESOURCE_REV));
    assert.equal(error.recovery, 'refresh_and_retry');
    assert.equal(harness.collectionsState.operations.length, 0);
    assert.equal(
      harness.collectionsState.collections.get(COLLECTION_ID)!.title,
      'HTTP Original',
    );
  });

  test('200 success: Cache-Control, ETag, UpdateCollectionResult shape; new revision', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'ok-user', 'okuser01');
    seedCollection(harness, {
      ownerSubjectId: client.subjectId,
      title: 'Before',
      summary: 'keep',
    });

    const response = await harness.app.inject({
      method: 'PATCH',
      url: patchUrl(),
      headers: authedHeaders(harness, client, {
        'known-command-id': COMMAND_A,
        'if-match': strongEntityTag(RESOURCE_REV),
      }),
      payload: { title: 'After', summary: null },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'private, no-store');
    assert.equal(typeof response.headers['x-request-id'], 'string');
    assert.equal(typeof response.headers.etag, 'string');

    const body = response.json() as {
      collection: {
        id: string;
        kind: string;
        title: string;
        summary: string | null;
        visibility: string;
        rootNodeId: string;
        revision: string;
        etag: string;
        contentRevision: string;
        contentEtag: string;
        policyRevision: string;
        policyEtag: string;
        createdAt: string;
        updatedAt: string;
      };
    };

    assert.deepEqual(Object.keys(body), ['collection']);
    assert.equal(body.collection.id, COLLECTION_ID);
    assert.equal(body.collection.title, 'After');
    assert.equal(body.collection.summary, null);
    assert.equal(body.collection.visibility, 'private');
    assert.equal(body.collection.kind, 'bookmarks');
    assert.equal(body.collection.rootNodeId, ROOT_ID);
    assert.equal(Object.hasOwn(body.collection, 'publicationSlug'), false);
    assert.equal(Object.hasOwn(body.collection, 'publishedAt'), false);
    assert.equal(body.collection.policyRevision, POLICY_REV);
    assert.notEqual(body.collection.revision, RESOURCE_REV);
    assert.equal(body.collection.etag, strongEntityTag(body.collection.revision));
    assert.equal(response.headers.etag, body.collection.etag);

    assert.equal(harness.collectionsState.operations.length, 1);
    assert.equal(harness.collectionsState.audit.length, 1);
    assert.equal(harness.collectionsState.outbox.length, 1);
    assert.equal(harness.collectionsState.collections.get(COLLECTION_ID)!.commitOrdinal, 2n);
  });

  test('exact replay same commandId+body+If-Match → same 200 body/headers, no second write', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'replay-user', 'replayu1');
    seedCollection(harness, { ownerSubjectId: client.subjectId });
    const headers = authedHeaders(harness, client, {
      'known-command-id': COMMAND_A,
      'if-match': strongEntityTag(RESOURCE_REV),
    });
    const payload = { title: 'Replay Title' };

    const first = await harness.app.inject({
      method: 'PATCH',
      url: patchUrl(),
      headers,
      payload,
    });
    assert.equal(first.statusCode, 200);

    const second = await harness.app.inject({
      method: 'PATCH',
      url: patchUrl(),
      headers,
      payload,
    });
    assert.equal(second.statusCode, 200);
    assert.deepEqual(second.json(), first.json());
    assert.equal(second.headers.etag, first.headers.etag);
    assert.equal(second.headers['cache-control'], 'private, no-store');
    assert.notEqual(second.headers['x-request-id'], first.headers['x-request-id']);

    assert.equal(harness.collectionsState.operations.length, 1);
    assert.equal(harness.collectionsState.collections.get(COLLECTION_ID)!.commitOrdinal, 2n);
  });

  test('same commandId different body → 409 command_id_reused', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'reuse-user', 'reuseu01');
    seedCollection(harness, { ownerSubjectId: client.subjectId });
    const headers = authedHeaders(harness, client, {
      'known-command-id': COMMAND_A,
      'if-match': strongEntityTag(RESOURCE_REV),
    });

    const first = await harness.app.inject({
      method: 'PATCH',
      url: patchUrl(),
      headers,
      payload: { title: 'First Intent' },
    });
    assert.equal(first.statusCode, 200);

    const reused = await harness.app.inject({
      method: 'PATCH',
      url: patchUrl(),
      headers,
      payload: { title: 'Different Intent' },
    });

    assertProductError(reused, 409, 'command_id_reused');
    assert.equal(harness.collectionsState.operations.length, 1);
  });

  test('viewer denied → 403; non-member private → 404; missing collection → 404', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const owner = await issueSession(harness, 'auth-owner', 'authown1');
    const viewer = await issueSession(harness, 'auth-viewer', 'authview1');
    const stranger = await issueSession(harness, 'auth-stranger', 'authstr1');

    seedCollection(harness, {
      ownerSubjectId: owner.subjectId,
      visibility: 'private',
      memberships: [{ subjectId: viewer.subjectId, role: 'viewer' }],
    });

    const asViewer = await harness.app.inject({
      method: 'PATCH',
      url: patchUrl(),
      headers: authedHeaders(harness, viewer, {
        'known-command-id': COMMAND_A,
        'if-match': strongEntityTag(RESOURCE_REV),
      }),
      payload: { title: 'Viewer blocked' },
    });
    assertProductError(asViewer, 403, 'insufficient_permission');

    const asStranger = await harness.app.inject({
      method: 'PATCH',
      url: patchUrl(),
      headers: authedHeaders(harness, stranger, {
        'known-command-id': COMMAND_B,
        'if-match': strongEntityTag(RESOURCE_REV),
      }),
      payload: { title: 'Stranger blocked' },
    });
    assertProductError(asStranger, 404, 'resource_not_found');

    const missing = await harness.app.inject({
      method: 'PATCH',
      url: patchUrl('does-not-exist'),
      headers: authedHeaders(harness, owner, {
        'known-command-id': COMMAND_C,
        'if-match': strongEntityTag(RESOURCE_REV),
      }),
      payload: { title: 'Missing' },
    });
    assertProductError(missing, 404, 'resource_not_found');
  });

  test('editor can update metadata', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const owner = await issueSession(harness, 'ed-owner', 'edowner1');
    const editor = await issueSession(harness, 'ed-editor', 'ededitor1');
    seedCollection(harness, {
      ownerSubjectId: owner.subjectId,
      memberships: [{ subjectId: editor.subjectId, role: 'editor' }],
    });

    const response = await harness.app.inject({
      method: 'PATCH',
      url: patchUrl(),
      headers: authedHeaders(harness, editor, {
        'known-command-id': COMMAND_A,
        'if-match': strongEntityTag(RESOURCE_REV),
      }),
      payload: { title: 'Editor wrote' },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json() as { collection: { title: string } };
    assert.equal(body.collection.title, 'Editor wrote');
  });

  test('owner can publish with canonical Location while editor cannot manage publication', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const owner = await issueSession(harness, 'pub-owner', 'pubowner1');
    const editor = await issueSession(harness, 'pub-editor', 'pubeditor1');
    seedCollection(harness, {
      ownerSubjectId: owner.subjectId,
      memberships: [{ subjectId: editor.subjectId, role: 'editor' }],
    });

    const denied = await harness.app.inject({
      method: 'PATCH',
      url: patchUrl(),
      headers: authedHeaders(harness, editor, {
        'known-command-id': COMMAND_A,
        'if-match': strongEntityTag(RESOURCE_REV),
      }),
      payload: { visibility: 'public', publicationSlug: 'team-notes' },
    });
    assertProductError(denied, 403, 'insufficient_permission');

    const published = await harness.app.inject({
      method: 'PATCH',
      url: patchUrl(),
      headers: authedHeaders(harness, owner, {
        'known-command-id': COMMAND_B,
        'if-match': strongEntityTag(RESOURCE_REV),
      }),
      payload: { visibility: 'public', publicationSlug: 'team-notes' },
    });
    assert.equal(published.statusCode, 200);
    assert.equal(published.headers.location, `${harness.config.productOrigin}/c/team-notes`);
    assert.equal(published.headers['cache-control'], 'private, no-store');
    const body = published.json() as {
      collection: { visibility: string; publicationSlug: string; publishedAt: string };
    };
    assert.equal(body.collection.visibility, 'public');
    assert.equal(body.collection.publicationSlug, 'team-notes');
    assert.equal(body.collection.publishedAt, '2026-07-22T12:00:00Z');

    const replay = await harness.app.inject({
      method: 'PATCH',
      url: patchUrl(),
      headers: authedHeaders(harness, owner, {
        'known-command-id': COMMAND_B,
        'if-match': strongEntityTag(RESOURCE_REV),
      }),
      payload: { visibility: 'public', publicationSlug: 'team-notes' },
    });
    assert.equal(replay.statusCode, published.statusCode);
    assert.deepEqual(replay.json(), published.json());
    for (const header of ['etag', 'location', 'cache-control', 'content-type'] as const) {
      assert.equal(replay.headers[header], published.headers[header], header);
    }
  });

  test('owner can opt search indexing independently while editor is denied', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const owner = await issueSession(harness, 'search-owner', 'searchown');
    const editor = await issueSession(harness, 'search-editor', 'searched');
    const row = seedCollection(harness, {
      ownerSubjectId: owner.subjectId,
      memberships: [{ subjectId: editor.subjectId, role: 'editor' }],
    });

    const denied = await harness.app.inject({
      method: 'PATCH',
      url: patchUrl(),
      headers: authedHeaders(harness, editor, {
        'known-command-id': COMMAND_A,
        'if-match': strongEntityTag(RESOURCE_REV),
      }),
      payload: { allowSearchIndexing: true },
    });
    assertProductError(denied, 403, 'insufficient_permission');
    assert.equal(row.allowSearchIndexing, false);

    const optedIn = await harness.app.inject({
      method: 'PATCH',
      url: patchUrl(),
      headers: authedHeaders(harness, owner, {
        'known-command-id': COMMAND_B,
        'if-match': strongEntityTag(RESOURCE_REV),
      }),
      payload: { allowSearchIndexing: true },
    });
    assert.equal(optedIn.statusCode, 200);
    const body = optedIn.json() as {
      collection: { visibility: string; allowSearchIndexing: boolean; policyRevision: string };
    };
    assert.equal(body.collection.visibility, 'private');
    assert.equal(body.collection.allowSearchIndexing, true);
    assert.notEqual(body.collection.policyRevision, POLICY_REV);
    assert.equal(harness.collectionsState.collections.get(COLLECTION_ID)?.allowSearchIndexing, true);
  });

  test('private drafts cannot reserve publication slugs', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const owner = await issueSession(harness, 'draft-owner', 'draftown1');
    seedCollection(harness, { ownerSubjectId: owner.subjectId });
    const response = await harness.app.inject({
      method: 'PATCH',
      url: patchUrl(),
      headers: authedHeaders(harness, owner, {
        'known-command-id': COMMAND_A,
        'if-match': strongEntityTag(RESOURCE_REV),
      }),
      payload: { publicationSlug: 'reserved-draft' },
    });
    assertProductError(response, 422, 'invalid_document');
    const body = response.json() as { error: { fieldErrors: Array<{ path: string }> } };
    assert.equal(body.error.fieldErrors[0]?.path, '/publicationSlug');
    assert.equal(response.headers.location, undefined);
  });

  test('field authority: kind/visibility/root cannot be patched via merge patch', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'field-user', 'fieldu01');
    seedCollection(harness, { ownerSubjectId: client.subjectId });

    for (const [label, body, commandId] of [
      ['cover', { cover: 'x' }, COMMAND_A],
      ['rootNodeId', { rootNodeId: 'evil' }, COMMAND_B],
      ['visibility', { visibility: 'public' }, COMMAND_C],
      ['kind', { kind: 'mixed' }, COMMAND_D],
    ] as const) {
      const response = await harness.app.inject({
        method: 'PATCH',
        url: patchUrl(),
        headers: authedHeaders(harness, client, {
          'known-command-id': commandId,
          'if-match': strongEntityTag(RESOURCE_REV),
        }),
        payload: body,
      });
      assert.equal(response.statusCode, 422, label);
      assertProductError(response, 422, 'invalid_document');
    }

    // Successful title-only leaves authority fields untouched.
    const ok = await harness.app.inject({
      method: 'PATCH',
      url: patchUrl(),
      headers: authedHeaders(harness, client, {
        'known-command-id': COMMAND_E,
        'if-match': strongEntityTag(RESOURCE_REV),
      }),
      payload: { title: 'Authority ok' },
    });
    assert.equal(ok.statusCode, 200);
    const row = harness.collectionsState.collections.get(COLLECTION_ID)!;
    assert.equal(row.kind, 'bookmarks');
    assert.equal(row.visibility, 'private');
    assert.equal(row.rootNodeId, ROOT_ID);
  });

  test('summary-only and title-only legal patches succeed', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness, 'patch-user', 'patchu01');
    seedCollection(harness, {
      ownerSubjectId: client.subjectId,
      title: 'T0',
      summary: 'S0',
    });

    const titleOnly = await harness.app.inject({
      method: 'PATCH',
      url: patchUrl(),
      headers: authedHeaders(harness, client, {
        'known-command-id': COMMAND_A,
        'if-match': strongEntityTag(RESOURCE_REV),
      }),
      payload: { title: 'T1' },
    });
    assert.equal(titleOnly.statusCode, 200);
    const afterTitle = titleOnly.json() as {
      collection: { title: string; summary: string | null; etag: string };
    };
    assert.equal(afterTitle.collection.title, 'T1');
    assert.equal(afterTitle.collection.summary, 'S0');

    const summaryOnly = await harness.app.inject({
      method: 'PATCH',
      url: patchUrl(),
      headers: authedHeaders(harness, client, {
        'known-command-id': COMMAND_B,
        'if-match': afterTitle.collection.etag,
      }),
      payload: { summary: 'S1' },
    });
    assert.equal(summaryOnly.statusCode, 200);
    const afterSummary = summaryOnly.json() as {
      collection: { title: string; summary: string | null };
    };
    assert.equal(afterSummary.collection.title, 'T1');
    assert.equal(afterSummary.collection.summary, 'S1');
  });
});

