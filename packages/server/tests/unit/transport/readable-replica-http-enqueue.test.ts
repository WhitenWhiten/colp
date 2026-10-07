import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import {
  readableReplicaExtractCommandScope,
  readableReplicaExtractFingerprint,
  type ReadableReplicaEnqueuePorts,
  type ReadableReplicaRow,
  type ReadableReplicaView,
} from '../../../src/modules/collections/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createInMemoryBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import {
  assertProductErrorEnvelope,
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
  createMemoryProductCommandReceiptPort,
  productCommandReceiptKey,
  issueTestSession,
  type MemoryProductCommandReceipts,
} from '../../support/product-http-harness.js';

const COL = 'col_owner_01';
const BOOKMARK = 'bm_article_01';
const FOLDER = 'folder_notes_01';
const BOOKMARK_URL = 'https://example.test/article';
const CHANGED_URL = 'https://example.test/article-v2';
const STORED_ETAG = '"rr-sidecar-1"';
const PATH = `/api/v1/collections/${COL}/nodes/${BOOKMARK}/readable`;
const FOLDER_PATH = `/api/v1/collections/${COL}/nodes/${FOLDER}/readable`;
const NOW = new Date('2026-08-24T08:00:00.000Z');
const COOLDOWN_MS = 60_000;

const baseEnv = {
  DATABASE_URL: 'postgres://localhost/readable_replica_http_enqueue_test',
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
};

const apps: Array<ReturnType<typeof buildApiApp>> = [];
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });

type MutableReplica = ReadableReplicaRow & { enqueuedAt: Date | null };

type Store = {
  replica: MutableReplica | null;
  bookmarkUrl: string;
  writes: number;
  receipts: MemoryProductCommandReceipts;
  now: Date;
};

function readyRow(overrides: Partial<MutableReplica> = {}): MutableReplica {
  return {
    status: 'ready',
    sourceUrl: BOOKMARK_URL,
    title: 'Article',
    byline: 'Ada',
    wordCount: 12,
    extractedAt: NOW,
    failureCode: null,
    sections: [{ id: 's0', heading: 'Intro', paragraphs: [{ id: 's0-p0', text: 'Hello' }] }],
    etag: STORED_ETAG,
    enqueuedAt: new Date(NOW.getTime() - COOLDOWN_MS - 1_000),
    ...overrides,
  };
}

function pendingRow(overrides: Partial<MutableReplica> = {}): MutableReplica {
  return {
    status: 'pending',
    sourceUrl: BOOKMARK_URL,
    title: null,
    byline: null,
    wordCount: 0,
    extractedAt: null,
    failureCode: null,
    sections: [],
    etag: '"rr-pending-1"',
    enqueuedAt: NOW,
    ...overrides,
  };
}

function failedRow(overrides: Partial<MutableReplica> = {}): MutableReplica {
  return {
    status: 'failed',
    sourceUrl: BOOKMARK_URL,
    title: null,
    byline: null,
    wordCount: 0,
    extractedAt: null,
    failureCode: 'timeout',
    sections: [],
    etag: '"rr-failed-1"',
    enqueuedAt: NOW,
    ...overrides,
  };
}

function asRow(replica: MutableReplica): ReadableReplicaRow {
  return {
    status: replica.status,
    sourceUrl: replica.sourceUrl,
    title: replica.title,
    byline: replica.byline,
    wordCount: replica.wordCount,
    extractedAt: replica.extractedAt,
    failureCode: replica.failureCode,
    sections: replica.sections,
    etag: replica.etag,
  };
}

function enqueuePorts(input: {
  readonly ownerSubjectId: string;
  readonly viewerSubjectId: string;
  readonly store: Store;
}): ReadableReplicaEnqueuePorts {
  return {
    accessPolicy: {
      async loadCollectionFacts({ collectionId, actorSubjectId }) {
        if (collectionId !== COL) return null;
        const membershipRole = actorSubjectId === input.viewerSubjectId ? 'viewer' : null;
        return {
          collectionId: COL,
          ownerSubjectId: input.ownerSubjectId,
          visibility: 'private',
          policyRevision: 'pol-1',
          membershipRole,
          deleted: false,
        };
      },
    },
    replicas: {
      async loadEnqueueState({ collectionId, nodeId }) {
        if (collectionId !== COL || nodeId !== BOOKMARK) return null;
        const replica = input.store.replica;
        return {
          nodeId: BOOKMARK,
          collectionId: COL,
          bookmarkUrl: input.store.bookmarkUrl,
          replica: replica === null ? null : asRow(replica),
          enqueuedAt: replica?.enqueuedAt ?? null,
        };
      },
      async savePending(record) {
        input.store.writes += 1;
        const next: MutableReplica = {
          status: 'pending',
          sourceUrl: record.sourceUrl,
          title: null,
          byline: null,
          wordCount: 0,
          extractedAt: null,
          failureCode: null,
          sections: [],
          etag: record.etag,
          enqueuedAt: record.enqueuedAt,
        };
        input.store.replica = next;
        return asRow(next);
      },
    },
    receipts: createMemoryProductCommandReceiptPort(input.store.receipts),
    clock: { now: async () => input.store.now },
  };
}

async function harness(input: {
  readonly enabled: boolean;
  readonly replica?: MutableReplica | null;
  readonly bookmarkUrl?: string;
  readonly receipts?: MemoryProductCommandReceipts;
}) {
  const config = loadConfig({
    ...baseEnv,
    KNOWN_FEATURE_READABLE_REPLICA: input.enabled ? 'true' : 'false',
  });
  const identity = createIdentityMemoryUnitOfWork(createIdentityMemoryState(NOW));
  const factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork: identity });
  const owner = await issueTestSession({
    factory, subject: 'owner-subject', displayName: 'Owner', handle: 'hvowner',
  });
  const viewer = await issueTestSession({
    factory, subject: 'viewer-subject', displayName: 'Viewer', handle: 'hvview',
  });
  const store: Store = {
    replica: input.replica === undefined ? null : input.replica,
    bookmarkUrl: input.bookmarkUrl ?? BOOKMARK_URL,
    writes: 0,
    receipts: input.receipts ?? new Map(),
    now: NOW,
  };
  const app = buildApiApp({
    config,
    identityUnitOfWork: identity,
    browserSessionAuthority: factory.authority,
    readableReplicas: {
      execute: async (work) => {
        const ports = enqueuePorts({
          ownerSubjectId: owner.subjectId,
          viewerSubjectId: viewer.subjectId,
          store,
        });
        return work({
          accessPolicy: ports.accessPolicy,
          replicas: {
            async loadBookmarkReplica({ collectionId, nodeId }) {
              const loaded = await ports.replicas.loadEnqueueState({ collectionId, nodeId });
              if (!loaded) return null;
              return {
                nodeId: loaded.nodeId,
                collectionId: loaded.collectionId,
                bookmarkUrl: loaded.bookmarkUrl,
                replica: loaded.replica,
              };
            },
          },
        });
      },
    },
    readableReplicaEnqueue: {
      execute: async (work) => work(enqueuePorts({
        ownerSubjectId: owner.subjectId,
        viewerSubjectId: viewer.subjectId,
        store,
      })),
    },
  });
  apps.push(app);
  return { app, owner, viewer, store };
}

function mutationHeaders(
  client: { cookie: string; csrfToken: string },
  commandId: string,
): Record<string, string> {
  return {
    cookie: client.cookie,
    origin: 'https://app.example.test',
    'x-csrf-token': client.csrfToken,
    'known-command-id': commandId,
    'content-type': 'application/json',
  };
}

describe('POST /api/v1/collections/:collectionId/nodes/:nodeId/readable', () => {
  test('anonymous requests are 401 authentication_required before CSRF', async () => {
    const { app } = await harness({ enabled: true });
    assertProductErrorEnvelope(await app.inject({
      method: 'POST', url: PATH,
      headers: { origin: 'https://app.example.test', 'content-type': 'application/json' },
      payload: {},
    }), 401, 'authentication_required');
  });

  test('flag off 404 resource_not_found while POST stays mounted', async () => {
    const { app, owner } = await harness({ enabled: false });
    assert.match(app.printRoutes(), /readable/u);
    assertProductErrorEnvelope(await app.inject({
      method: 'POST', url: PATH, headers: mutationHeaders(owner, randomUUID()), payload: {},
    }), 404, 'resource_not_found');
  });

  test('exact Known-Command-Id replay returns the first receipt without a second enqueue', async () => {
    const { app, owner, store } = await harness({ enabled: true, replica: null });
    const commandId = randomUUID();
    const first = await app.inject({
      method: 'POST', url: PATH, headers: mutationHeaders(owner, commandId), payload: {},
    });
    assert.equal(first.statusCode, 200, first.body);
    const firstBody = first.json() as ReadableReplicaView;
    assert.equal(firstBody.status, 'pending');
    assert.equal(store.writes, 1);
    const replay = await app.inject({
      method: 'POST', url: PATH, headers: mutationHeaders(owner, commandId), payload: {},
    });
    assert.equal(replay.statusCode, 200);
    assert.deepEqual(replay.json(), firstBody);
    assert.equal(store.writes, 1);
    assert.equal(replay.headers['cache-control'], 'private, no-store');
  });

  test('command_id_reused is 409 when the fingerprint differs', async () => {
    const { app, owner } = await harness({ enabled: true, replica: null });
    const commandId = randomUUID();
    const first = await app.inject({
      method: 'POST', url: PATH, headers: mutationHeaders(owner, commandId), payload: {},
    });
    assert.equal(first.statusCode, 200, first.body);
    const reused = await app.inject({
      method: 'POST', url: PATH, headers: mutationHeaders(owner, commandId),
      payload: { force: true },
    });
    assertProductErrorEnvelope(reused, 409, 'command_id_reused');
    assert.notEqual(
      (reused.json() as { error?: { code?: string } }).error?.code,
      'command_in_progress',
    );
  });

  test('in-progress is 429 rate_limited and never 409 command_in_progress', async () => {
    const commandId = randomUUID();
    const receipts: MemoryProductCommandReceipts = new Map();
    const { app, owner, store } = await harness({ enabled: true, replica: null, receipts });
    receipts.set(productCommandReceiptKey({
      principalId: owner.accountId,
      commandScope: readableReplicaExtractCommandScope(COL, BOOKMARK),
      commandId,
    }), {
      fingerprint: readableReplicaExtractFingerprint({
        collectionId: COL, nodeId: BOOKMARK, force: false,
      }),
      status: 'in_progress',
    });
    const response = await app.inject({
      method: 'POST', url: PATH, headers: mutationHeaders(owner, commandId), payload: {},
    });
    assert.equal(response.statusCode, 429, response.body);
    const envelope = response.json() as { error: { code: string } };
    assert.equal(envelope.error.code, 'rate_limited');
    assert.notEqual(response.statusCode, 409);
    assert.notEqual(envelope.error.code, 'command_in_progress');
    assert.ok(response.headers['retry-after']);
    assert.equal(store.writes, 0);
  });

  test('cooldown is 429 rate_limited with Retry-After at least 1', async () => {
    const { app, owner, store } = await harness({
      enabled: true,
      replica: readyRow({ enqueuedAt: NOW }),
    });
    const response = await app.inject({
      method: 'POST', url: PATH, headers: mutationHeaders(owner, randomUUID()),
      payload: { force: true },
    });
    assertProductErrorEnvelope(response, 429, 'rate_limited');
    const retryAfter = Number(response.headers['retry-after']);
    assert.equal(Number.isInteger(retryAfter), true);
    assert.ok(retryAfter >= 1);
    assert.equal(retryAfter, Math.max(1, Math.ceil(COOLDOWN_MS / 1000)));
    assert.equal(store.writes, 0);
    assert.equal(store.replica?.status, 'ready');
    assert.equal(store.replica?.enqueuedAt?.getTime(), NOW.getTime());
  });

  test('force requeues a ready row after the cooldown window', async () => {
    const { app, owner, store } = await harness({
      enabled: true,
      replica: readyRow({ enqueuedAt: new Date(NOW.getTime() - COOLDOWN_MS - 1) }),
    });
    const response = await app.inject({
      method: 'POST', url: PATH, headers: mutationHeaders(owner, randomUUID()),
      payload: { force: true },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal((response.json() as ReadableReplicaView).status, 'pending');
    assert.equal(store.writes, 1);
    assert.equal(store.replica?.status, 'pending');
    assert.equal(store.replica?.enqueuedAt?.getTime(), NOW.getTime());
  });

  test('§4.4.6 no row inserts pending and sets enqueued_at', async () => {
    const { app, owner, store } = await harness({ enabled: true, replica: null });
    const response = await app.inject({
      method: 'POST', url: PATH, headers: mutationHeaders(owner, randomUUID()), payload: {},
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json() as ReadableReplicaView;
    assert.equal(body.status, 'pending');
    assert.equal(body.failureCode, null);
    assert.deepEqual(body.sections, []);
    assert.equal(store.writes, 1);
    assert.equal(store.replica?.status, 'pending');
    assert.equal(store.replica?.enqueuedAt?.getTime(), NOW.getTime());
  });

  test('§4.4.6 ready same url without force returns the original view and does not enqueue', async () => {
    const originalEnqueued = new Date(NOW.getTime() - COOLDOWN_MS - 5_000);
    const { app, owner, store } = await harness({
      enabled: true,
      replica: readyRow({ enqueuedAt: originalEnqueued }),
    });
    const response = await app.inject({
      method: 'POST', url: PATH, headers: mutationHeaders(owner, randomUUID()), payload: {},
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json() as ReadableReplicaView;
    assert.equal(body.status, 'ready');
    assert.equal(body.etag, STORED_ETAG);
    assert.equal(body.title, 'Article');
    assert.equal(store.writes, 0);
    assert.equal(store.replica?.status, 'ready');
    assert.equal(store.replica?.enqueuedAt?.getTime(), originalEnqueued.getTime());
  });

  test('§4.4.6 ready but url changed enqueues pending when cooldown has elapsed', async () => {
    const { app, owner, store } = await harness({
      enabled: true,
      bookmarkUrl: CHANGED_URL,
      replica: readyRow({
        sourceUrl: BOOKMARK_URL,
        enqueuedAt: new Date(NOW.getTime() - COOLDOWN_MS - 1),
      }),
    });
    const response = await app.inject({
      method: 'POST', url: PATH, headers: mutationHeaders(owner, randomUUID()), payload: {},
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal((response.json() as ReadableReplicaView).status, 'pending');
    assert.equal(store.writes, 1);
    assert.equal(store.replica?.sourceUrl, CHANGED_URL);
  });

  test('§4.4.6 pending without force is 200 and does not requeue even inside cooldown', async () => {
    const originalEnqueued = NOW;
    const { app, owner, store } = await harness({
      enabled: true,
      replica: pendingRow({ enqueuedAt: originalEnqueued }),
    });
    const response = await app.inject({
      method: 'POST', url: PATH, headers: mutationHeaders(owner, randomUUID()), payload: {},
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal((response.json() as ReadableReplicaView).status, 'pending');
    assert.equal(store.writes, 0);
    assert.equal(store.replica?.enqueuedAt?.getTime(), originalEnqueued.getTime());
    assert.notEqual(response.statusCode, 429);
  });

  test('§4.4.6 pending with force inside cooldown is 429; after cooldown requeues', async () => {
    const cooling = await harness({
      enabled: true,
      replica: pendingRow({ enqueuedAt: NOW }),
    });
    assertProductErrorEnvelope(await cooling.app.inject({
      method: 'POST', url: PATH, headers: mutationHeaders(cooling.owner, randomUUID()),
      payload: { force: true },
    }), 429, 'rate_limited');
    assert.equal(cooling.store.writes, 0);

    const { app, owner, store } = await harness({
      enabled: true,
      replica: pendingRow({ enqueuedAt: new Date(NOW.getTime() - COOLDOWN_MS - 1) }),
    });
    const response = await app.inject({
      method: 'POST', url: PATH, headers: mutationHeaders(owner, randomUUID()),
      payload: { force: true },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal((response.json() as ReadableReplicaView).status, 'pending');
    assert.equal(store.writes, 1);
    assert.equal(store.replica?.enqueuedAt?.getTime(), NOW.getTime());
  });

  test('§4.4.6 failed and unsupported requeue after cooldown and 429 inside it', async () => {
    const cooling = await harness({
      enabled: true,
      replica: failedRow({ enqueuedAt: NOW }),
    });
    assertProductErrorEnvelope(await cooling.app.inject({
      method: 'POST', url: PATH, headers: mutationHeaders(cooling.owner, randomUUID()), payload: {},
    }), 429, 'rate_limited');
    assert.equal(cooling.store.writes, 0);

    const { app, owner, store } = await harness({
      enabled: true,
      replica: failedRow({
        status: 'unsupported',
        failureCode: 'not_html',
        enqueuedAt: new Date(NOW.getTime() - COOLDOWN_MS - 1),
      }),
    });
    const response = await app.inject({
      method: 'POST', url: PATH, headers: mutationHeaders(owner, randomUUID()), payload: {},
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal((response.json() as ReadableReplicaView).status, 'pending');
    assert.equal(store.writes, 1);
  });

  test('POST without If-Match succeeds; viewer may enqueue; folder is 404', async () => {
    const { app, owner, viewer } = await harness({ enabled: true, replica: null });
    const ownerOk = await app.inject({
      method: 'POST', url: PATH, headers: mutationHeaders(owner, randomUUID()), payload: {},
    });
    assert.equal(ownerOk.statusCode, 200, ownerOk.body);
    assert.equal(ownerOk.headers['if-match'], undefined);
    const viewerOk = await app.inject({
      method: 'POST', url: PATH, headers: mutationHeaders(viewer, randomUUID()), payload: {},
    });
    assert.equal(viewerOk.statusCode, 200, viewerOk.body);
    assertProductErrorEnvelope(await app.inject({
      method: 'POST', url: FOLDER_PATH, headers: mutationHeaders(owner, randomUUID()), payload: {},
    }), 404, 'resource_not_found');
  });
});
