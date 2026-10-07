import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import {
  type GetNodeReadableReplicaPorts,
  type ReadableReplicaBookmarkLoad,
  type ReadableReplicaView,
} from '../../../src/modules/collections/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createInMemoryBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import {
  assertProductErrorEnvelope,
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
  issueTestSession,
} from '../../support/product-http-harness.js';

const COL = 'col_owner_01';
const BOOKMARK = 'bm_article_01';
const FOLDER = 'folder_notes_01';
const UNKNOWN = 'bm_missing_01';
const ILLEGAL = 'bad id with spaces';
const BOOKMARK_URL = 'https://example.test/article';
const STORED_ETAG = '"rr-sidecar-1"';
const PATH = `/api/v1/collections/${COL}/nodes/${BOOKMARK}/readable`;
const FOLDER_PATH = `/api/v1/collections/${COL}/nodes/${FOLDER}/readable`;
const UNKNOWN_PATH = `/api/v1/collections/${COL}/nodes/${UNKNOWN}/readable`;
const ILLEGAL_PATH = `/api/v1/collections/${COL}/nodes/${encodeURIComponent(ILLEGAL)}/readable`;
const NOW = new Date('2026-08-24T08:00:00.000Z');

const baseEnv = {
  DATABASE_URL: 'postgres://localhost/readable_replica_http_test',
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

function noneView(): ReadableReplicaView {
  return {
    nodeId: BOOKMARK,
    collectionId: COL,
    status: 'none',
    sourceUrl: BOOKMARK_URL,
    title: null,
    byline: null,
    wordCount: 0,
    extractedAt: null,
    failureCode: null,
    sections: [],
    etag: null,
  };
}

function sidecarLoad(replica: ReadableReplicaBookmarkLoad['replica']): ReadableReplicaBookmarkLoad {
  return {
    nodeId: BOOKMARK,
    collectionId: COL,
    bookmarkUrl: BOOKMARK_URL,
    replica,
  };
}

function memoryPorts(input: {
  readonly ownerSubjectId: string;
  readonly viewerSubjectId: string;
  readonly visibility: 'private' | 'public' | 'unlisted';
  readonly load: ReadableReplicaBookmarkLoad | null | 'folder';
}): GetNodeReadableReplicaPorts {
  return {
    accessPolicy: {
      async loadCollectionFacts({ collectionId, actorSubjectId }) {
        if (collectionId !== COL) return null;
        const membershipRole = actorSubjectId === input.viewerSubjectId ? 'viewer' : null;
        return {
          collectionId: COL,
          ownerSubjectId: input.ownerSubjectId,
          visibility: input.visibility,
          policyRevision: 'pol-1',
          membershipRole,
          deleted: false,
        };
      },
    },
    replicas: {
      async loadBookmarkReplica({ collectionId, nodeId }) {
        if (collectionId !== COL) return null;
        if (nodeId === FOLDER || input.load === 'folder') return null;
        if (nodeId !== BOOKMARK) return null;
        return input.load === 'folder' ? null : input.load;
      },
    },
  };
}

async function harness(input: {
  readonly enabled: boolean;
  readonly visibility?: 'private' | 'public' | 'unlisted';
  readonly load?: ReadableReplicaBookmarkLoad | null | 'folder';
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
  const outsider = await issueTestSession({
    factory, subject: 'outsider-subject', displayName: 'Outsider', handle: 'hvout',
  });
  const ports = memoryPorts({
    ownerSubjectId: owner.subjectId,
    viewerSubjectId: viewer.subjectId,
    visibility: input.visibility ?? 'private',
    load: input.load === undefined ? sidecarLoad(null) : input.load,
  });
  const app = buildApiApp({
    config,
    identityUnitOfWork: identity,
    browserSessionAuthority: factory.authority,
    readableReplicas: {
      execute: async (work) => work(ports),
    },
  });
  apps.push(app);
  return { app, owner, viewer, outsider };
}

describe('GET /api/v1/collections/:collectionId/nodes/:nodeId/readable', () => {
  test('anonymous requests are 401 authentication_required before flag gating', async () => {
    const off = await harness({ enabled: false });
    assertProductErrorEnvelope(
      await off.app.inject({ method: 'GET', url: PATH }),
      401,
      'authentication_required',
    );
    const on = await harness({ enabled: true });
    assertProductErrorEnvelope(
      await on.app.inject({ method: 'GET', url: PATH }),
      401,
      'authentication_required',
    );
  });

  test('flag off 404 resource_not_found without feature_temporarily_unavailable', async () => {
    const { app, owner } = await harness({ enabled: false });
    assert.match(app.printRoutes(), /readable/u);
    const response = await app.inject({
      method: 'GET', url: PATH, headers: { cookie: owner.cookie },
    });
    assertProductErrorEnvelope(response, 404, 'resource_not_found');
    assert.equal(JSON.stringify(response.json()).includes('feature_temporarily_unavailable'), false);
    assert.equal(response.headers['cache-control'], 'private, no-store');
  });

  test('owner no-row is 200 status none, etag null, no ETag header', async () => {
    const { app, owner } = await harness({ enabled: true, load: sidecarLoad(null) });
    const response = await app.inject({
      method: 'GET', url: PATH, headers: { cookie: owner.cookie },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), noneView());
    assert.equal(response.headers.etag, undefined);
    assert.equal(response.headers['cache-control'], 'private, no-store');
  });

  test('sidecar row returns stored etag column and ETag header', async () => {
    const extractedAt = '2026-08-24T08:00:00.000Z';
    const { app, owner } = await harness({
      enabled: true,
      load: sidecarLoad({
        status: 'ready',
        sourceUrl: BOOKMARK_URL,
        title: 'Article',
        byline: 'Ada',
        wordCount: 12,
        extractedAt: new Date(extractedAt),
        failureCode: null,
        sections: [{ id: 's0', heading: 'Intro', paragraphs: [{ id: 's0-p0', text: 'Hello' }] }],
        etag: STORED_ETAG,
      }),
    });
    const response = await app.inject({
      method: 'GET', url: PATH, headers: { cookie: owner.cookie },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as ReadableReplicaView;
    assert.equal(body.status, 'ready');
    assert.equal(body.etag, STORED_ETAG);
    assert.equal(body.title, 'Article');
    assert.equal(response.headers.etag, STORED_ETAG);
    assert.equal(response.headers['cache-control'], 'private, no-store');
  });

  test('viewer member can GET; outsider and public non-member are 404', async () => {
    const membered = await harness({ enabled: true });
    const viewerOk = await membered.app.inject({
      method: 'GET', url: PATH, headers: { cookie: membered.viewer.cookie },
    });
    assert.equal(viewerOk.statusCode, 200);
    assert.equal((viewerOk.json() as ReadableReplicaView).status, 'none');
    assertProductErrorEnvelope(await membered.app.inject({
      method: 'GET', url: PATH, headers: { cookie: membered.outsider.cookie },
    }), 404, 'resource_not_found');
    const published = await harness({ enabled: true, visibility: 'public' });
    assertProductErrorEnvelope(await published.app.inject({
      method: 'GET', url: PATH, headers: { cookie: published.outsider.cookie },
    }), 404, 'resource_not_found');
  });

  test('folder, unknown, and illegal ids are 404 not 400', async () => {
    const { app, owner } = await harness({ enabled: true, load: 'folder' });
    assertProductErrorEnvelope(await app.inject({
      method: 'GET', url: FOLDER_PATH, headers: { cookie: owner.cookie },
    }), 404, 'resource_not_found');
    assertProductErrorEnvelope(await app.inject({
      method: 'GET', url: UNKNOWN_PATH, headers: { cookie: owner.cookie },
    }), 404, 'resource_not_found');
    const illegal = await app.inject({
      method: 'GET', url: ILLEGAL_PATH, headers: { cookie: owner.cookie },
    });
    assertProductErrorEnvelope(illegal, 404, 'resource_not_found');
    assert.notEqual(illegal.statusCode, 400);
  });
});
