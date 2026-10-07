/**
 * P1-05 createCollection HTTP contract tests (Fastify inject).
 *
 * Harness:
 *   buildApiApp({ config, identityUnitOfWork, collectionsUnitOfWork, oidcProvider })
 *   Memory identity (session) + memory CollectionsUnitOfWork wrapping the
 *   create-owned-collection canonical write ports.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'vitest';
import {
  createIdentityMemoryPorts,
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
  createMemoryProductCommandReceiptPort,
  executeMemoryTransaction,
  assertProductErrorEnvelope,
  authenticatedMutationHeaders,
  issueTestSession,
  type IdentityMemoryState,
  type MemoryProductCommandReceipts,
} from '../../support/product-http-harness.js';
import { loadConfig } from '../../support/test-config.js';
import type {
  AccessPolicyWritePort,
  MembershipRole,
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
  type PolicyRevisionInsert,
  type ProductCollectionMutationUnitOfWork,
  type ResourceRevisionInsert,
  type RootNodeBootstrapRow,
} from '../../../src/modules/collections/index.js';
import type { IdentityPorts, IdentityUnitOfWork } from '../../../src/modules/identity/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createInMemoryBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';

// ---------------------------------------------------------------------------
// Stable fixtures
// ---------------------------------------------------------------------------

const COMMAND_A = '5de3947e-6271-4fdf-a946-d22e58a99c2a';
const COMMAND_B = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
const COMMAND_C = '11111111-2222-4333-8444-555555555555';
const COMMAND_D = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const NOW = new Date('2026-07-22T12:00:00.000Z');

const VALID_BODY = {
  kind: 'bookmarks',
  title: 'Reading List',
  summary: 'phase-1 owned collection',
} as const;

const BODY_LIMIT_BYTES = 16 * 1024;

// ---------------------------------------------------------------------------
// Identity memory (browser-auth-transport pattern)
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Collections memory (create-owned-collection pattern)
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

interface CollectionsMemoryState {
  now: Date;
  receipts: MemoryProductCommandReceipts;
  ledger: IdLedgerReserveEntry[];
  collections: CollectionBootstrapRow[];
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

function createMemoryAccessPolicy(state: CollectionsMemoryState): AccessPolicyWritePort {
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

function createCollectionsMemoryPorts(state: CollectionsMemoryState): CollectionsWritePorts {
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
        state.collections.push({ ...row });
      },
      async lockForUpdate() {
        return null;
      },
      async lockForShare() {
        return null;
      },
      async advanceContentFence() {
        return undefined;
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
    accessPolicy: createMemoryAccessPolicy(state),
  };
}

function createProductCollectionMutationUnitOfWork(
  state: CollectionsMemoryState,
): ProductCollectionMutationUnitOfWork {
  return {
    async execute(work) {
      return executeMemoryTransaction(state, (transaction) => work({
        receipts: createMemoryProductCommandReceiptPort(transaction.receipts),
        clock: { now: async () => new Date(transaction.now) },
        collections: { async lockForUpdate() { return null; } },
        accessPolicy: { async loadCollectionFacts() { return null; } },
        canonical: {
          async execute() { throw new Error('create harness does not execute metadata mutations'); },
          async bootstrapOwnedCollection(input) {
            const now = new Date(transaction.now);
            transaction.ledger.push(
              { resourceId: input.collectionId, resourceType: 'collection' },
              { resourceId: input.rootNodeId, resourceType: 'node' },
              { resourceId: input.operationId, resourceType: 'operation' },
              { resourceId: input.domainEventId, resourceType: 'domain-event' },
              { resourceId: input.outboxId, resourceType: 'outbox' },
            );
            transaction.collections.push({
              id: input.collectionId, ownerSubjectId: input.actor.subjectId,
              title: input.title, summary: input.summary, kind: input.kind, visibility: 'private',
              rootNodeId: input.rootNodeId, resourceRevision: input.resourceRevision,
              contentRevision: input.contentRevision, policyRevision: input.policyRevision,
              commitOrdinal: 1n, createdAt: now, updatedAt: now,
            });
            transaction.nodes.push({
              id: input.rootNodeId, collectionId: input.collectionId, title: input.title,
              resourceRevision: input.rootResourceRevision,
              childrenRevision: input.rootChildrenRevision, createdAt: now, updatedAt: now,
            });
            transaction.memberships.push({ collectionId: input.collectionId, subjectId: input.actor.subjectId, role: 'owner', grantedAt: now });
            transaction.policies.set(input.collectionId, { collectionId: input.collectionId, policyJson: {}, updatedAt: now });
            transaction.operations.push({ operationId: input.operationId, collectionId: input.collectionId, commitOrdinal: 1n, operationType: 'create_owned_collection', payload: {}, actorPrincipalId: input.actor.principalId, createdAt: now });
            transaction.audit.push({ operationId: input.operationId, collectionId: input.collectionId, principalId: input.actor.principalId, eventType: 'collection.created', details: {}, createdAt: now });
            transaction.outbox.push({ outboxId: input.outboxId, domainEventId: input.domainEventId, eventType: 'collection.created', eventVersion: 1, handlerName: 'collection_created_projection', handlerMode: 'projection_latest_only', aggregateType: 'collection', aggregateId: input.collectionId, aggregateScope: input.collectionId, aggregateRevision: input.resourceRevision, commitOrdinal: 1n, payload: {}, occurredAt: now });
            return { createdAt: now, updatedAt: now, commitOrdinal: 1n };
          },
        },
      }));
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
    collections: [],
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
      (transaction) => work(createCollectionsMemoryPorts(transaction)),
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

async function issueSession(harness: Harness, subject = 'create-collection-user'): Promise<AuthedClient> {
  return issueTestSession({
    factory: harness.factory,
    subject,
    displayName: 'Creator',
    handle: 'creator1',
  });
}

function authedHeaders(
  harness: Harness,
  client: AuthedClient,
  extra: Record<string, string> = {},
): Record<string, string> {
  return authenticatedMutationHeaders({
    client,
    origin: harness.config.productOrigin,
    contentType: 'application/json',
    extra,
  });
}

function assertProductError(
  response: { statusCode: number; headers: Record<string, string | string[] | undefined>; json(): unknown },
  expectedStatus: number,
  expectedCode: string,
): Record<string, unknown> {
  return assertProductErrorEnvelope(response, expectedStatus, expectedCode);
}

const apps: ApiApp[] = [];

afterEach(async () => {
  while (apps.length > 0) {
    const app = apps.pop();
    await app?.close();
  }
});

test('fails at app construction when collection or node mutation routes lack canonical UoW', () => {
  const harness = createHarness();
  apps.push(harness.app);
  assert.throws(
    () => buildApiApp({
      config: harness.config,
      identityUnitOfWork: harness.identityUnitOfWork,
      collectionsUnitOfWork: harness.collectionsUnitOfWork,
    }),
    /require a canonical product mutation unit of work/i,
  );
  assert.throws(
    () => buildApiApp({
      config: harness.config,
      identityUnitOfWork: harness.identityUnitOfWork,
      collectionsUnitOfWork: harness.collectionsUnitOfWork,
      collectionMetadataMutationRoutes: 'disabled',
    }),
    /require a canonical product mutation unit of work/i,
  );
});

test('does not allow production composition to disable collection metadata mutation routes', () => {
  const harness = createHarness();
  apps.push(harness.app);
  assert.throws(
    () => buildApiApp({
      config: { ...harness.config, nodeEnv: 'production' },
      collectionMetadataMutationRoutes: 'disabled',
    }),
    /may only be disabled in test composition/i,
  );
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/v1/collections HTTP contract', () => {
  test('401 without session', async () => {
    const harness = createHarness();
    apps.push(harness.app);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: {
        origin: harness.config.productOrigin,
        'x-csrf-token': 'not-a-real-csrf-token-value____________',
        'content-type': 'application/json',
        'known-command-id': COMMAND_A,
      },
      payload: VALID_BODY,
    });

    assertProductError(response, 401, 'authentication_required');
  });

  test('403 csrf_failed without Origin/CSRF', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness);

    const missingOrigin = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: {
        cookie: client.cookie,
        'x-csrf-token': client.csrfToken,
        'content-type': 'application/json',
        'known-command-id': COMMAND_A,
      },
      payload: VALID_BODY,
    });
    assertProductError(missingOrigin, 403, 'csrf_failed');

    const missingCsrf = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: {
        cookie: client.cookie,
        origin: harness.config.productOrigin,
        'content-type': 'application/json',
        'known-command-id': COMMAND_B,
      },
      payload: VALID_BODY,
    });
    assertProductError(missingCsrf, 403, 'csrf_failed');
  });

  test('fails closed for wrong Origin and a CSRF token bound to another session', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness);
    const otherSession = await issueSession(harness);

    const cases = [
      {
        label: 'wrong origin',
        headers: authedHeaders(harness, client, {
          origin: 'https://evil.example.test',
          'known-command-id': COMMAND_A,
        }),
      },
      {
        label: 'null origin',
        headers: authedHeaders(harness, client, {
          origin: 'null',
          'known-command-id': COMMAND_B,
        }),
      },
      {
        label: 'other session token',
        headers: authedHeaders(harness, client, {
          'x-csrf-token': otherSession.csrfToken,
          'known-command-id': COMMAND_C,
        }),
      },
    ];

    for (const sample of cases) {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/collections',
        headers: sample.headers,
        payload: VALID_BODY,
      });
      assertProductError(response, 403, 'csrf_failed');
    }
    assert.equal(harness.collectionsState.receipts.size, 0);
    assert.equal(harness.collectionsState.collections.length, 0);
  });

  test('rejects ambiguous Origin and CSRF headers before route admission', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness);

    for (const headers of [
      {
        ...authedHeaders(harness, client, { 'known-command-id': COMMAND_A }),
        origin: [harness.config.productOrigin, 'https://evil.example.test'],
      },
      {
        ...authedHeaders(harness, client, { 'known-command-id': COMMAND_B }),
        'x-csrf-token': [client.csrfToken, client.csrfToken],
      },
    ]) {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/collections',
        headers,
        payload: VALID_BODY,
      });
      assertProductError(response, 400, 'invalid_request');
    }
    assert.equal(harness.collectionsState.receipts.size, 0);
    assert.equal(harness.collectionsState.collections.length, 0);
  });

  test('400 missing Known-Command-Id', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: authedHeaders(harness, client),
      payload: VALID_BODY,
    });

    assertProductError(response, 400, 'invalid_request');
  });

  test('400 invalid command id format', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness);

    for (const bad of [
      'not-a-uuid',
      '5DE3947E-6271-4FDF-A946-D22E58A99C2A', // uppercase rejected
      '5de3947e-6271-5fdf-a946-d22e58a99c2a', // not version 4
      '5de3947e-6271-4fdf-c946-d22e58a99c2a', // invalid variant
    ]) {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/collections',
        headers: authedHeaders(harness, client, { 'known-command-id': bad }),
        payload: VALID_BODY,
      });
      assertProductError(response, 400, 'invalid_request');
    }
  });

  test('422 invalid body (missing title, additional property, wrong types)', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness);

    const cases: Array<{ label: string; commandId: string; body: unknown }> = [
      {
        label: 'missing title',
        commandId: COMMAND_A,
        body: { kind: 'bookmarks', summary: null },
      },
      {
        label: 'additional property',
        commandId: COMMAND_B,
        body: { ...VALID_BODY, ownerId: 'evil' },
      },
      {
        label: 'wrong title type',
        commandId: COMMAND_C,
        body: { kind: 'bookmarks', title: 42, summary: null },
      },
      {
        label: 'invalid kind',
        commandId: COMMAND_D,
        body: { kind: 'not-a-kind', title: 'X', summary: null },
      },
    ];

    for (const sample of cases) {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/collections',
        headers: authedHeaders(harness, client, { 'known-command-id': sample.commandId }),
        payload: sample.body,
      });
      assert.equal(response.statusCode, 422, sample.label);
      assertProductError(response, 422, 'invalid_document');
    }
  });

  test('201 success: Location, ETag, private visibility, Cache-Control', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: authedHeaders(harness, client, { 'known-command-id': COMMAND_A }),
      payload: VALID_BODY,
    });

    assert.equal(response.statusCode, 201);
    assert.equal(response.headers['cache-control'], 'private, no-store');
    assert.equal(typeof response.headers['x-request-id'], 'string');

    const body = response.json() as {
      collection: {
        id: string;
        visibility: string;
        title: string;
        etag: string;
        kind: string;
      };
      root: {
        id: string;
        collectionId: string;
        kind: string;
        folderRole: string;
        title: string;
      };
    };

    assert.equal(body.collection.visibility, 'private');
    assert.equal(body.collection.title, VALID_BODY.title);
    assert.equal(body.collection.kind, VALID_BODY.kind);
    assert.equal(response.headers.location, `/api/v1/collections/${body.collection.id}`);
    assert.equal(response.headers.etag, body.collection.etag);
    assert.equal(body.root.collectionId, body.collection.id);
    assert.equal(body.root.kind, 'folder');
    assert.equal(body.root.folderRole, 'root');
    assert.equal(body.root.title, VALID_BODY.title);

    // Domain side effects through memory UoW
    assert.equal(harness.collectionsState.collections.length, 1);
    assert.equal(harness.collectionsState.collections[0]!.visibility, 'private');
    assert.equal(harness.collectionsState.collections[0]!.ownerSubjectId, client.subjectId);
    assert.equal(harness.collectionsState.nodes.length, 1);
    assert.equal(harness.collectionsState.memberships.length, 1);
    assert.equal(harness.collectionsState.memberships[0]!.role, 'owner');
    assert.equal(harness.collectionsState.memberships[0]!.subjectId, client.subjectId);
  });

  test('exact replay same commandId+body → same 201 body/headers Location/ETag', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness);
    const headers = authedHeaders(harness, client, { 'known-command-id': COMMAND_A });

    const first = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers,
      payload: VALID_BODY,
    });
    assert.equal(first.statusCode, 201);

    const second = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers,
      payload: VALID_BODY,
    });
    assert.equal(second.statusCode, 201);

    assert.deepEqual(second.json(), first.json());
    assert.equal(second.headers.location, first.headers.location);
    assert.equal(second.headers.etag, first.headers.etag);
    assert.equal(second.headers['cache-control'], 'private, no-store');
    // Dynamic request ids must differ; stable headers must not.
    assert.notEqual(second.headers['x-request-id'], first.headers['x-request-id']);

    // No second domain write
    assert.equal(harness.collectionsState.collections.length, 1);
    assert.equal(harness.collectionsState.operations.length, 1);
  });

  test('active command maps to 409 command_in_progress with bounded retry guidance', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness);
    const headers = authedHeaders(harness, client, { 'known-command-id': COMMAND_A });

    const first = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers,
      payload: VALID_BODY,
    });
    assert.equal(first.statusCode, 201);
    const receipt = [...harness.collectionsState.receipts.values()][0];
    assert.ok(receipt);
    receipt.status = 'in_progress';
    delete receipt.result;

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers,
      payload: VALID_BODY,
    });
    const error = assertProductError(response, 409, 'command_in_progress');
    assert.equal(response.headers['retry-after'], '1');
    assert.equal(error.recovery, 'same_request');
    assert.equal(error.sameRequestRetrySafe, true);
    assert.equal(error.retryAfterSeconds, 1);
  });

  test('expired command result maps to 410 command_result_expired', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness);
    const headers = authedHeaders(harness, client, { 'known-command-id': COMMAND_A });

    const first = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers,
      payload: VALID_BODY,
    });
    assert.equal(first.statusCode, 201);
    const receipt = [...harness.collectionsState.receipts.values()][0];
    assert.ok(receipt);
    receipt.expired = true;

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers,
      payload: VALID_BODY,
    });
    const error = assertProductError(response, 410, 'command_result_expired');
    assert.equal(error.recovery, 'user_action');
    assert.equal(error.sameRequestRetrySafe, false);
  });

  test('same commandId different body → 409 command_id_reused', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness);
    const headers = authedHeaders(harness, client, { 'known-command-id': COMMAND_A });

    const first = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers,
      payload: VALID_BODY,
    });
    assert.equal(first.statusCode, 201);

    const reused = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers,
      payload: {
        kind: 'reading_path',
        title: 'Different intent',
        summary: null,
      },
    });

    assertProductError(reused, 409, 'command_id_reused');
    assert.equal(harness.collectionsState.collections.length, 1);
    assert.equal(harness.collectionsState.operations.length, 1);
  });

  test('media type not application/json → 415 if admission enforces', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: authedHeaders(harness, client, {
        'known-command-id': COMMAND_A,
        'content-type': 'text/plain',
      }),
      payload: JSON.stringify(VALID_BODY),
    });

    assertProductError(response, 415, 'unsupported_media_type');
  });

  test('body over 16 KiB → 413 if admission enforces bodyLimitBytes', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const client = await issueSession(harness);

    // Oversized JSON: summary pad past bodyLimitBytes (16 KiB).
    const oversized = {
      kind: 'bookmarks',
      title: 'Too large',
      summary: 'x'.repeat(BODY_LIMIT_BYTES),
    };
    const payload = JSON.stringify(oversized);
    assert.ok(Buffer.byteLength(payload, 'utf8') > BODY_LIMIT_BYTES);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: authedHeaders(harness, client, { 'known-command-id': COMMAND_A }),
      payload,
    });

    assertProductError(response, 413, 'payload_too_large');
    assert.equal(harness.collectionsState.collections.length, 0);
  });
});

