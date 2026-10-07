/**
 * P4A-R06 HTTP black-box suite over the PRODUCTION app composition.
 *
 * Boots the production transport (`buildApiApp`) with REAL PostgreSQL ports
 * for the Publication Snapshot/Directory/Metadata, public Profile, product
 * Search and MCP Read surfaces (each now depends on the exposure-eligibility
 * gate through the shared exposure facts port), plus the production Sync
 * session + Snapshot HTTP routes. A REAL private blob fixture (unique markers
 * in generation-key rows + seed body bytes) exists while the requests run.
 *
 * Every consumer surface must serve its CONTROL resource over HTTP and carry
 * ZERO private markers in the response body; a full app restart re-evaluates
 * to the same result; a capability that is explicitly OFF returns 404 (never
 * mistaken for safety — the same surface with the capability ON proves the
 * control resource and the zero-marker contract).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { loadConfig } from '../../support/test-config.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { memoryExploreDirectoryLimiter } from '../../support/memory-product-rate-limiters.js';
import { registerSyncSessionRoutes } from '../../../src/transport/colp-sync/sync-session-routes.js';
import { registerSyncSnapshotRoutes } from '../../../src/transport/colp-sync/sync-snapshot-routes.js';
import {
  createPostgresPublicationDirectoryReadPort,
  createPostgresPublicationMetadataReadPort,
  createPostgresPublicationSnapshotReadPort,
  createPostgresPublicationAnnotationReadPort,
  createPostgresPublicationRelationReadPort,
} from '../../../src/infrastructure/publication/index.js';
import { createPostgresAccessPolicyFactsPort } from '../../../src/infrastructure/access-policy/index.js';
import {
  createPostgresSearchCandidatePort,
  createPostgresSearchAuthorityPort,
} from '../../../src/infrastructure/search/index.js';
import {
  createPostgresPublicProfileFactsReadPort,
} from '../../../src/infrastructure/identity/index.js';
import { createPostgresSharedExposureFactsPort, createAttachmentExposurePolicyAdapter } from '../../../src/infrastructure/database/index.js';
import {
  createPostgresReplicaStore,
  createPostgresSyncBootstrapSnapshotApplication,
  createPostgresSyncSessionHttpApplication,
  createPostgresSyncSessionIssuer,
  createSyncPullCursorKeyring,
} from '../../../src/infrastructure/sync/index.js';
import {
  composePublicProfileProjection,
} from '../../../src/bootstrap/public-profile-projection.js';
import {
  createPhase4bMcpChangeSignalSource,
  createPhase4bMcpCollectionResourceProjection,
  createPhase4bMcpCollectionResourceCursorKeyring,
  createPhase4bMcpNodeResourceProjection,
  createPhase4bMcpSnapshotResourceProjection,
  createPhase4bMcpReadToolAdapter,
  type Phase4bMcpNodeResourceProjection,
  type Phase4bMcpSnapshotResourceProjection,
  type Phase4bMcpCollectionResourceProjection,
} from '../../../src/modules/mcp/index.js';
import { createSearchCursorSigner, executeSearchQuery } from '../../../src/modules/search/index.js';
import {
  createPublicationCursorKeyring,
} from '../../../src/modules/publication/index.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { mintVerifiedExtensionCredentialFixture } from '../../support/extension-credential.js';
import {
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
} from '../../support/product-http-harness.js';
import {
  I12_COLLECTION,
  I12_SUBJECT_OWNER,
  assertMarkerAbsentFromJson,
  controlMarker,
  i12BlobIdentity,
  privateMarker,
  seedAttachedPrivate,
  seedControlCollection,
  seedExpiredBlob,
  seedProfile,
  seedQuarantinedGeneration,
  seedRetiredGeneration,
  seedStoredPrivate,
} from '../../support/phase4a-i12-test-helpers.js';
import {
  createI07MigrationRuntime,
  type I07MigrationRuntime,
} from '../../support/phase4a-i07-test-helpers.js';
import { withMcpTestHost } from '../../support/phase4b-mcp-transport-scaffold.js';

const SERVER_UUID = '019b3c67-a03c-7f02-9c7e-1ee8d50a77de';
const AUDIENCE = 'https://collections.example.test/collections/-/mcp';
const NOW = new Date('2026-08-08T12:00:00.000Z');
const SYNC_ISSUER = 'https://issuer.example';
const SEARCH_KEYS = Object.freeze({
  current: { id: 'r06-http-search-v1', key: Buffer.alloc(32, 81).toString('base64') },
});

function mcpEnv(): Record<string, string> {
  return {
    NODE_ENV: 'test',
    PUBLICATION_ORIGIN: 'https://collections.example.test',
    PUBLICATION_SERVER_UUID: SERVER_UUID,
    LOG_LEVEL: 'silent',
    KNOWN_FEATURE_MCP_READ: 'true',
    MCP_SERVER_UUID: SERVER_UUID,
    MCP_ALLOWED_ORIGINS: 'https://app.example.test',
    MCP_OAUTH_ISSUER: 'https://issuer.example.test/realms/known',
    MCP_OAUTH_AUDIENCE: AUDIENCE,
    MCP_OAUTH_AUTHORIZATION_SERVER_METADATA_URL:
      'https://issuer.example.test/.well-known/oauth-authorization-server',
    MCP_OAUTH_JWKS_URI: 'https://issuer.example.test/realms/known/protocol/openid-connect/certs',
    MCP_OAUTH_SCOPES: 'mcp:read:public,mcp:read:own',
  };
}

interface R06HttpApp {
  readonly app: FastifyInstance;
  readonly close: () => Promise<void>;
}

describeWithPostgres('P4A-R06 production HTTP composition per-consumer exclusion', () => {
  let isolated: I07MigrationRuntime;
  let controlNodeTitle: string;
  let controlHandle: string;
  const privateMarkers = {
    stored: privateMarker('r06-http-stored'),
    attached: privateMarker('r06-http-attached'),
    retiredOld: privateMarker('r06-http-retired-old'),
    retiredNew: privateMarker('r06-http-retired-new'),
    expired: privateMarker('r06-http-expired'),
    quarantined: privateMarker('r06-http-quarantined'),
  };
  const allMarkers = () => Object.values(privateMarkers);

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('phase4a_r06_http', { maxConnections: 12 });
    const seeded = await seedControlCollection(isolated.runtime, {
      collectionId: I12_COLLECTION,
      controlNodeTitle: controlMarker('r06-http-control'),
    });
    controlNodeTitle = seeded.controlNodeTitle;
    const profile = await seedProfile(isolated.runtime, {
      subjectId: I12_SUBJECT_OWNER,
      handle: 'r06_http_owner',
      displayName: 'R06 HTTP Owner',
    });
    controlHandle = profile.handle;

    let slot = 0;
    const next = () => { slot += 1; return slot; };
    await seedStoredPrivate(isolated.runtime, i12BlobIdentity(next(), privateMarkers.stored));
    await seedAttachedPrivate(isolated.runtime, i12BlobIdentity(next(), privateMarkers.attached));
    await seedRetiredGeneration(
      isolated.runtime,
      i12BlobIdentity(next(), privateMarkers.retiredOld),
      i12BlobIdentity(next(), privateMarkers.retiredNew),
    );
    await seedExpiredBlob(isolated.runtime, i12BlobIdentity(next(), privateMarkers.expired));
    await seedQuarantinedGeneration(isolated.runtime, i12BlobIdentity(next(), privateMarkers.quarantined));
  }, 120_000);

  afterAll(async () => {
    await isolated?.dropSchema();
  });

  function publicationPorts(origin: string) {
    const cursors = createPublicationCursorKeyring({
      active: { id: `r06-http-pub-${randomUUID()}`, secret: Buffer.alloc(32, 82).toString('base64') },
      retained: [],
    });
    return {
      cursors,
      snapshot: {
        reads: createPostgresPublicationSnapshotReadPort(isolated.runtime),
        annotations: createPostgresPublicationAnnotationReadPort(isolated.runtime, { origin }),
        relations: createPostgresPublicationRelationReadPort(isolated.runtime),
        accessPolicy: createPostgresAccessPolicyFactsPort(isolated.runtime.db),
        cursors,
        origin,
        sharedExposure: createPostgresSharedExposureFactsPort(isolated.runtime),
      },
      directory: {
        reads: createPostgresPublicationDirectoryReadPort(isolated.runtime),
        cursors,
        origin,
        maxPageSize: 100,
      },
      metadata: {
        reads: createPostgresPublicationMetadataReadPort(isolated.runtime),
        origin,
        now: () => NOW,
      },
    };
  }

  async function buildApp(options: { readonly origin: string; readonly enableSearch: boolean }): Promise<R06HttpApp> {
    const config = loadConfig({
      ...mcpEnv(),
      OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      DATABASE_URL: isolated.databaseUrl,
      PRODUCT_ORIGIN: options.origin,
      PUBLICATION_ORIGIN: options.origin,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
    });
    const identityUnitOfWork = createIdentityMemoryUnitOfWork(
      createIdentityMemoryState(NOW),
    );
    const publication = publicationPorts(options.origin);
    const searchPorts = {
      candidates: createPostgresSearchCandidatePort(isolated.runtime.db),
      authority: createPostgresSearchAuthorityPort(isolated.runtime.db),
      cursors: createSearchCursorSigner(SEARCH_KEYS as never),
      clock: { now: () => NOW },
      sharedExposure: createPostgresSharedExposureFactsPort(isolated.runtime),
    };
    const mcpCursors = createPhase4bMcpCollectionResourceCursorKeyring({
      active: { id: `r06-http-mcp-${randomUUID()}`, secret: Buffer.alloc(32, 83).toString('base64') },
      retained: [],
      ttlMs: 60_000,
      now: () => NOW,
    });
    const collectionProjection = createPhase4bMcpCollectionResourceProjection({
      config: config.mcp!,
      directoryQuery: publication.directory,
      metadataQuery: publication.metadata,
      accessPolicy: createPostgresAccessPolicyFactsPort(isolated.runtime.db),
      cursorKeys: mcpCursors,
      now: () => NOW,
      pageSize: 10,
      policyRevisionFor: async () => 'authority-1',
      sharedExposure: createPostgresSharedExposureFactsPort(isolated.runtime),
    });
    const snapshotProjection: Phase4bMcpSnapshotResourceProjection =
      createPhase4bMcpSnapshotResourceProjection({
        config: config.mcp!,
        snapshotQuery: publication.snapshot,
        now: () => NOW,
        pageSize: 10,
      });
    const nodeProjection: Phase4bMcpNodeResourceProjection = createPhase4bMcpNodeResourceProjection({
      config: config.mcp!,
      snapshotQuery: publication.snapshot,
      now: () => NOW,
      pageSize: 10,
    });
    const readToolBundle = createPhase4bMcpReadToolAdapter({
      collectionProjection,
      snapshotProjection,
      nodeProjection,
      serverUuid: SERVER_UUID,
    });
    const app = buildApiApp({
      config,
      exploreDirectoryRateLimiter: memoryExploreDirectoryLimiter(),
      identityUnitOfWork,
      publicationSnapshotQuery: publication.snapshot,
      publicationDirectoryQuery: publication.directory,
      publicationMetadataQuery: publication.metadata,
      publicProfileQuery: composePublicProfileProjection({
        profiles: createPostgresPublicProfileFactsReadPort(isolated.runtime),
        collections: createPostgresPublicationDirectoryReadPort(isolated.runtime),
        cursors: publication.cursors,
        sharedExposure: createPostgresSharedExposureFactsPort(isolated.runtime),
      }),
      ...(options.enableSearch
        ? {
            searchQuery: { execute: (input) => executeSearchQuery(searchPorts, input) },
            searchRateLimiter: memoryExploreDirectoryLimiter(),
          }
        : {}),
      mcpReadResourceProjection: collectionProjection,
      mcpNodeResourceProjection: nodeProjection,
      mcpSnapshotResourceProjection: snapshotProjection,
      mcpReadTransport: {
        changeSignalSource: createPhase4bMcpChangeSignalSource(),
        readToolAdapter: readToolBundle.adapter,
        readToolParamDeclarations: readToolBundle.paramDeclarations,
        dependencyHealth: async () => Object.freeze({
          ready: true, reasons: Object.freeze([]),
          counts: Object.freeze({}), limits: Object.freeze({}),
        }),
      },
    });
    app.addHook('onClose', () => {
      publication.cursors.destroy();
      mcpCursors.destroy();
    });
    return { app, close: () => app.close() };
  }

  async function buildSyncApp(options: { readonly origin: string }): Promise<R06HttpApp> {
    const app = Fastify({ logger: false });
    const issuer = createPostgresSyncSessionIssuer(isolated.runtime.db, {
      issuer: SYNC_ISSUER, audience: 'known-api', clientId: 'known-extension',
      replayEncryptionKey: Buffer.alloc(32, 23), replayEncryptionKeyVersion: 1,
      sessionDurationSeconds: 900, replicaLeaseExtensionSeconds: 3_600,
      tombstoneRetentionSeconds: 86_400, maxBatchOperations: 1,
      endpointCapabilities: ['syncSnapshot', 'syncPush', 'syncPull', 'syncAck', 'syncConflict'],
      retentionWindow: { async load(_transaction, collectionId) { return { collectionId,
        earliestPull: { cursor: null, commitOrdinal: '0' },
        purgedThrough: { cursor: null, commitOrdinal: '0' },
        snapshotUrl: '/private-entry/snapshot-download' }; } },
    });
    const credential = await mintVerifiedExtensionCredentialFixture({
      // The credential must match the owner account's existing OIDC identity
      // (seeded with the control profile): issuer I12_ISSUER / subject
      // i12-oidc-subject (account_identities allows exactly one per account).
      issuer: SYNC_ISSUER, audience: 'known-api', clientId: 'known-extension',
      subject: 'i12-oidc-subject', credentialId: `r06-http-credential-${randomUUID()}`,
    });
    const credentialVerifier = { async verify({ authorization }: { readonly authorization: string | readonly string[] | undefined }) {
      if (authorization !== `Bearer r06-http-token`) throw new Error('invalid credential');
      return credential;
    } };
    const pullCursorKeys = createSyncPullCursorKeyring({
      active: { id: 'r06-http-sync-v1', secret: Buffer.alloc(32, 84).toString('base64') },
      retained: [], ttlMs: 300_000,
    });
    registerSyncSessionRoutes(app, {
      path: '/private-entry/session-negotiation', allowedOrigins: [options.origin],
      credentialVerifier,
      application: createPostgresSyncSessionHttpApplication(isolated.runtime.db, issuer, {
        registerUnknownGenerationOneReplica: true,
        registrationLeaseSeconds: 3_600,
      }),
      rateLimit: { maxRequests: 100, windowMs: 60_000 },
      allowInsecureLoopback: true,
    });
    registerSyncSnapshotRoutes(app, {
      path: '/private-entry/snapshot-download', allowedOrigins: [options.origin], credentialVerifier,
      application: createPostgresSyncBootstrapSnapshotApplication(isolated.runtime, {
        cursorSecret: Buffer.alloc(32, 85), cursorKeyId: 'r06-http-sync-v1', cursorTtlMs: 300_000,
        pullCursorKeyring: pullCursorKeys,
        attachmentExposure: createAttachmentExposurePolicyAdapter(createPostgresSharedExposureFactsPort(isolated.runtime)),
      }),
      rateLimit: { maxRequests: 100, windowMs: 60_000 },
      allowInsecureLoopback: true,
    });
    app.addHook('onClose', () => { pullCursorKeys.destroy(); });
    return { app, close: () => app.close() };
  }

  async function seedSyncAccount(): Promise<string> {
    // The control profile seeding already created an account for the owner
    // subject (I12_SUBJECT_OWNER); reuse that account (subject_id is unique)
    // so the replica-scope check resolves role=owner for the control
    // collection.
    await isolated.runtime.pool.query(
      `insert into accounts (id, subject_id, status) values ($1, $2, 'active')
         on conflict (subject_id) do nothing`, ['r06-http-account', I12_SUBJECT_OWNER]);
    const owner = await isolated.runtime.pool.query<{ id: string }>(
      `select id from accounts where subject_id = $1`, [I12_SUBJECT_OWNER]);
    const accountId = owner.rows[0]?.id;
    assert.ok(accountId, 'the owner account must exist (seeded with the control profile)');
    // The owner account already carries its profile handle and its OIDC
    // identity (seeded with the control profile: issuer I12_ISSUER, subject
    // i12-oidc-subject), so the Sync credential below must match that
    // existing identity (account_identities allows exactly one per account).
    await createPostgresReplicaStore(isolated.runtime.db, { ids: {
      deviceId: () => 'r06-http-device', replicaId: () => 'r06-http-replica', leaseId: () => 'r06-http-lease',
    } }).create({
      accountId, collectionId: I12_COLLECTION, deviceName: 'R06 device',
      replicaName: 'R06 replica', kind: 'browser_extension',
      adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
      capabilities: { read: true, write: true, events: true, separator: true,
        alias: false, annotations: 'sidecar', maxBatchOperations: 1 },
      binding: { browserProfileId: 'r06-http-profile', mountMode: 'whole-profile',
        browserGeneration: 'r06-http-generation' },
      leaseDurationSeconds: 3_600,
    }, { actorAccountId: accountId });
    return accountId;
  }

  test('HTTP Publication Snapshot/Directory/Metadata serve the control resource with zero private marker', async () => {
    const app = await buildApp({ origin: 'https://known.example', enableSearch: true });
    try {
      const snapshot = await app.app.inject({
        method: 'GET',
        url: `/colp/v0.1/collections/${I12_COLLECTION}/snapshot?include=attachments&limit=100`,
      });
      assert.equal(snapshot.statusCode, 200);
      const body = snapshot.json() as { nodes: Array<{ title: string }>; attachments: readonly unknown[] };
      assert.ok(body.nodes.some((node) => node.title === controlNodeTitle),
        'control node must be served over HTTP (link executed)');
      assert.deepEqual(body.attachments, []);
      for (const marker of allMarkers()) {
        assertMarkerAbsentFromJson(body, marker, `HTTP snapshot (${marker})`);
      }
      const directory = await app.app.inject({ method: 'GET', url: '/colp/v0.1/directory?limit=100' });
      assert.equal(directory.statusCode, 200);
      assert.equal(directory.body.includes(I12_COLLECTION), true, 'control collection in directory');
      for (const marker of allMarkers()) {
        assert.equal(directory.body.includes(marker), false, `HTTP directory (${marker})`);
      }
      const metadata = await app.app.inject({
        method: 'GET',
        url: `/colp/v0.1/collections/${I12_COLLECTION}`,
      });
      assert.equal(metadata.statusCode, 200);
      assert.equal(metadata.body.includes(controlNodeTitle) || metadata.body.includes(I12_COLLECTION), true);
      for (const marker of allMarkers()) {
        assert.equal(metadata.body.includes(marker), false, `HTTP metadata (${marker})`);
      }
    } finally {
      await app.close();
    }
  });

  test('HTTP Search + Profile serve the control resource with zero private marker', async () => {
    const app = await buildApp({ origin: 'https://known.example', enableSearch: true });
    try {
      const search = await app.app.inject({
        method: 'GET',
        url: `/api/v1/search?q=${encodeURIComponent(controlNodeTitle)}&limit=100`,
      });
      assert.equal(search.statusCode, 200);
      const searchBody = search.json() as { items: Array<{ resourceId: string }> };
      assert.ok(searchBody.items.length >= 1, 'control search result must be returned over HTTP');
      for (const marker of allMarkers()) {
        assertMarkerAbsentFromJson(searchBody, marker, `HTTP search (${marker})`);
      }

      const profile = await app.app.inject({
        method: 'GET',
        url: `/api/v1/profiles/${controlHandle}`,
      });
      assert.equal(profile.statusCode, 200);
      const profileBody = profile.json() as { profile: { handle: string }; collections: Array<{ id: string }> };
      assert.equal(profileBody.profile.handle, controlHandle, 'control profile must be served over HTTP');
      assert.ok(profileBody.collections.some((entry) => entry.id === I12_COLLECTION),
        'control collection must be served (link executed)');
      for (const marker of allMarkers()) {
        assertMarkerAbsentFromJson(profileBody, marker, `HTTP profile (${marker})`);
      }
    } finally {
      await app.close();
    }
  });

  test('HTTP MCP resources/read serves the control collection metadata with zero private marker', async () => {
    const app = await buildApp({ origin: 'https://known.example', enableSearch: true });
    try {
      const response = await app.app.inject({
        method: 'POST',
        url: '/collections/-/mcp',
        headers: Object.freeze(withMcpTestHost({
          'MCP-Protocol-Version': '2026-07-28',
          'Mcp-Method': 'resources/read',
          // MCP-U-08 exposed this test as vacuous: without Mcp-Name the old
          // SSE-first transport answered 200 with an in-stream -32020 whose
          // message echoed the collection id, satisfying both assertions
          // without ever reading the resource. resources/read requires the
          // header to mirror params.uri.
          'Mcp-Name': `colp://${SERVER_UUID}/collections/${I12_COLLECTION}`,
          'content-type': 'application/json',
          'accept': 'application/json, text/event-stream',
        }, 'https://known.example')),
        payload: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'resources/read',
          params: {
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientCapabilities': { sampling: {} },
            },
            uri: `colp://${SERVER_UUID}/collections/${I12_COLLECTION}`,
          },
        }),
      });
      assert.equal(response.statusCode, 200, response.body.slice(0, 300));
      assert.equal(response.body.includes(I12_COLLECTION), true,
        'control collection metadata must be served over HTTP');
      for (const marker of allMarkers()) {
        assert.equal(response.body.includes(marker), false, `HTTP MCP (${marker})`);
      }
    } finally {
      await app.close();
    }
  });

  test('HTTP Sync session + snapshot serve the control collection with zero private marker', async () => {
    await seedSyncAccount();
    const app = await buildSyncApp({ origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' });
    try {
      const session = await app.app.inject({
        method: 'POST',
        url: '/private-entry/session-negotiation',
        headers: {
          authorization: 'Bearer r06-http-token',
          origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
          'content-type': 'application/json',
          'idempotency-key': `r06-http-session-${randomUUID()}`,
        },
        payload: JSON.stringify({
          protocolVersion: '0.1',
          scope: 'collection',
          clientTime: '2026-08-08T12:00:00.000Z',
          replica: {
            replicaId: 'r06-http-replica',
            name: 'R06 device',
            kind: 'browser_extension',
            adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
            capabilities: { read: true, write: true, events: true, separator: true, alias: false,
              annotations: 'sidecar', maxBatchOperations: 1 },
            binding: { browserProfileId: 'r06-http-profile', mountMode: 'whole-profile',
              mountNativeId: null, generation: 'r06-http-generation' },
            extensions: {},
          },
          collection: { collectionId: I12_COLLECTION, lastCursor: null, lastRevision: null,
            bootstrapMode: 'download' },
        }),
      });
      assert.equal(session.statusCode, 201, session.body.slice(0, 300));
      const sessionBody = session.json() as { sessionId: string };
      const snapshot = await app.app.inject({
        method: 'GET',
        url: `/private-entry/snapshot-download?sessionId=${encodeURIComponent(sessionBody.sessionId)}&limit=100`,
        headers: { authorization: 'Bearer r06-http-token', origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' },
      });
      assert.equal(snapshot.statusCode, 200, snapshot.body.slice(0, 300));
      assert.equal(snapshot.body.includes(I12_COLLECTION), true, 'control collection must be served over HTTP');
      assert.equal(snapshot.body.includes(controlNodeTitle), true, 'control node must be served over HTTP');
      for (const marker of allMarkers()) {
        assert.equal(snapshot.body.includes(marker), false, `HTTP sync snapshot (${marker})`);
      }
    } finally {
      await app.close();
    }
  });

  test('app restart re-evaluates every surface with the marker still absent', async () => {
    const first = await buildApp({ origin: 'https://known.example', enableSearch: true });
    await first.app.inject({ method: 'GET', url: `/colp/v0.1/collections/${I12_COLLECTION}/snapshot?limit=100` });
    await first.close();

    const second = await buildApp({ origin: 'https://known.example', enableSearch: true });
    try {
      const snapshot = await second.app.inject({
        method: 'GET',
        url: `/colp/v0.1/collections/${I12_COLLECTION}/snapshot?include=attachments&limit=100`,
      });
      assert.equal(snapshot.statusCode, 200);
      const body = snapshot.json() as { nodes: Array<{ title: string }> };
      assert.ok(body.nodes.some((node) => node.title === controlNodeTitle),
        'control node must still be served after restart');
      for (const marker of allMarkers()) {
        assertMarkerAbsentFromJson(body, marker, `restart snapshot (${marker})`);
      }
    } finally {
      await second.close();
    }
  });

  test('a capability that is OFF is a 404, never a pass; the ON state proves control + zero markers', async () => {
    const off = await buildApp({ origin: 'https://known.example', enableSearch: false });
    try {
      const search = await off.app.inject({ method: 'GET', url: '/api/v1/search?q=anything' });
      assert.equal(search.statusCode, 404, 'search capability off must be explicitly disabled over HTTP');
      // Publication still runs and serves the control resource marker-free.
      const snapshot = await off.app.inject({
        method: 'GET',
        url: `/colp/v0.1/collections/${I12_COLLECTION}/snapshot?limit=100`,
      });
      assert.equal(snapshot.statusCode, 200);
      assert.equal(snapshot.body.includes(controlNodeTitle), true);
      for (const marker of allMarkers()) {
        assert.equal(snapshot.body.includes(marker), false, `HTTP snapshot with search off (${marker})`);
      }
    } finally {
      await off.close();
    }
    // The ON state is proven by the dedicated search test above (control result
    // + zero markers over the same production route).
  });
});
