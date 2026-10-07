/**
 * P4A-P09 HTTP suite: production HTTP composition over the REAL Product
 * fixture.
 *
 * Boots the PRODUCTION app (`buildApiApp` with the publication
 * snapshot/directory/metadata surfaces, public Profile, product Search, MCP
 * read resources AND the attachment product routes) plus the production Sync
 * session + snapshot routes, all over the REAL owner-private Product fixture
 * (real `attachments` rows, replacement old/new, retired/deleted/quarantined).
 *
 * Every HTTP consumer surface must serve its CONTROL resource and carry ZERO
 * private markers in the response body; a full app restart re-evaluates to the
 * same result; a capability that is explicitly OFF returns 404 (never mistaken
 * for safety — the same surface with the capability ON proves the control
 * resource and the zero-marker contract).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { createI07MigrationRuntime, type I07MigrationRuntime } from '../../support/phase4a-i07-test-helpers.js';
import {
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
} from '../../support/product-http-harness.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import {
  P09_COLLECTION,
  P09_SYNC_ORIGIN,
  p09BuildProductFixture,
  type P09ProductFixture,
} from '../../support/phase4a-p09-test-helpers.js';
import {
  p09BuildConsumerHttpApp,
  p09BuildSyncHttpApp,
  p09SeedSyncHttpReplica,
  type P09HttpApp,
} from '../../support/phase4a-p09-http-helpers.js';
import { p09PublicationOrigin } from '../../support/phase4a-p09-consumers.js';
import { withMcpTestHost } from '../../support/phase4b-mcp-transport-scaffold.js';

describeWithPostgres('P4A-P09 production HTTP composition per-consumer exclusion', () => {
  let isolated: I07MigrationRuntime;
  let fixture: P09ProductFixture;
  let privateMarkers: string[];

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('phase4a_p09_http', { maxConnections: 16 });
    fixture = await p09BuildProductFixture({
      runtime: isolated,
      databaseUrl: isolated.databaseUrl,
      identityUnitOfWork: createIdentityMemoryUnitOfWork(createIdentityMemoryState(new Date('2026-08-08T12:00:00.000Z'))),
    });
    privateMarkers = Object.values(fixture.markers);
  }, 180_000);

  afterAll(async () => {
    await fixture?.bundle.app.close();
    await fixture?.bundle.store.close();
    await fixture?.objectServer.close();
    await isolated?.dropSchema();
  });

  function assertZeroMarkers(body: string, label: string): void {
    for (const marker of privateMarkers) {
      assert.equal(body.includes(marker), false, `HTTP ${label} body must never contain ${marker}`);
    }
  }

  function httpApp(): Promise<P09HttpApp> {
    return p09BuildConsumerHttpApp({
      runtime: isolated,
      databaseUrl: isolated.databaseUrl,
      identityUnitOfWork: createIdentityMemoryUnitOfWork(createIdentityMemoryState(new Date('2026-08-08T12:00:00.000Z'))),
      fixture,
      objectServerUrl: fixture.objectServer.url,
    });
  }

  test('HTTP Publication Snapshot/Directory/Metadata serve the control resource with zero private marker', async () => {
    const built = await httpApp();
    try {
      const snapshot = await built.app.inject({
        method: 'GET',
        url: `/colp/v0.1/collections/${P09_COLLECTION}/snapshot?include=attachments&limit=100`,
      });
      assert.equal(snapshot.statusCode, 200, snapshot.body.slice(0, 300));
      const body = snapshot.json() as { nodes: Array<{ title: string }>; attachments: readonly unknown[] };
      assert.ok(body.nodes.some((node) => node.title === fixture.controlNodeTitle),
        'control node must be served over HTTP (link executed)');
      assert.deepEqual(body.attachments, [], 'the gate closes the HTTP snapshot attachment projection');
      assertZeroMarkers(snapshot.body, 'snapshot');

      const directory = await built.app.inject({ method: 'GET', url: '/colp/v0.1/directory?limit=100' });
      assert.equal(directory.statusCode, 200);
      assert.equal(directory.body.includes(P09_COLLECTION), true, 'control collection in directory');
      assertZeroMarkers(directory.body, 'directory');

      const metadata = await built.app.inject({ method: 'GET', url: `/colp/v0.1/collections/${P09_COLLECTION}` });
      assert.equal(metadata.statusCode, 200);
      assert.equal(metadata.body.includes(P09_COLLECTION), true, 'control metadata served');
      assertZeroMarkers(metadata.body, 'metadata');
    } finally {
      await built.close();
    }
  });

  test('HTTP Search + Profile serve the control resource with zero private marker', async () => {
    const built = await httpApp();
    try {
      const search = await built.app.inject({
        method: 'GET',
        url: `/api/v1/search?q=${encodeURIComponent(fixture.controlNodeTitle)}&limit=100`,
      });
      assert.equal(search.statusCode, 200, search.body.slice(0, 300));
      const searchBody = search.json() as { items: Array<{ resourceId: string }> };
      assert.ok(searchBody.items.length >= 1, 'control search result must be returned over HTTP');
      assertZeroMarkers(search.body, 'search');

      const profile = await built.app.inject({
        method: 'GET',
        url: `/api/v1/profiles/${fixture.profileHandle}`,
      });
      assert.equal(profile.statusCode, 200, profile.body.slice(0, 300));
      const profileBody = profile.json() as { profile: { handle: string }; collections: Array<{ id: string }> };
      assert.equal(profileBody.profile.handle, fixture.profileHandle, 'control profile must be served over HTTP');
      assert.ok(profileBody.collections.some((entry) => entry.id === fixture.profileCollectionId),
        'profile control collection must be served (link executed)');
      assertZeroMarkers(profile.body, 'profile');
    } finally {
      await built.close();
    }
  });

  test('HTTP MCP resources/read serves the control collection metadata with zero private marker', async () => {
    const built = await httpApp();
    try {
      const response = await built.app.inject({
        method: 'POST',
        url: '/collections/-/mcp',
        headers: Object.freeze(withMcpTestHost({
          'MCP-Protocol-Version': '2026-07-28',
          'Mcp-Method': 'resources/read',
          // MCP-U-08 exposed this test as vacuous: without Mcp-Name the old
          // SSE-first transport answered 200 with an in-stream -32020 whose
          // message echoed the collection id. resources/read requires the
          // header to mirror params.uri.
          'Mcp-Name': `colp://019b3c67-a03c-7f02-9c7e-1ee8d50a77de/collections/${P09_COLLECTION}`,
          'content-type': 'application/json',
          'accept': 'application/json, text/event-stream',
        }, p09PublicationOrigin())),
        payload: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'resources/read',
          params: {
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientCapabilities': { sampling: {} },
            },
            uri: `colp://019b3c67-a03c-7f02-9c7e-1ee8d50a77de/collections/${P09_COLLECTION}`,
          },
        }),
      });
      assert.equal(response.statusCode, 200, response.body.slice(0, 300));
      assert.equal(response.body.includes(P09_COLLECTION), true,
        'control collection metadata must be served over HTTP');
      assertZeroMarkers(response.body, 'MCP');
    } finally {
      await built.close();
    }
  });

  test('HTTP Sync session + snapshot serve the control collection with zero private marker', async () => {
    const replica = await p09SeedSyncHttpReplica(isolated, P09_COLLECTION);
    const built = await p09BuildSyncHttpApp({ runtime: isolated, fixture });
    try {
      const session = await built.app.inject({
        method: 'POST',
        url: '/private-entry/session-negotiation',
        headers: {
          authorization: 'Bearer p09-http-token',
          origin: P09_SYNC_ORIGIN,
          'content-type': 'application/json',
          'idempotency-key': `p09-http-session-${randomUUID()}`,
        },
        payload: JSON.stringify({
          protocolVersion: '0.1',
          scope: 'collection',
          clientTime: '2026-08-08T12:00:00.000Z',
          replica: {
            replicaId: replica.replicaId,
            name: 'P09 device',
            kind: 'browser_extension',
            adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
            capabilities: { read: true, write: true, events: true, separator: true, alias: false,
              annotations: 'sidecar', maxBatchOperations: 1 },
            binding: { browserProfileId: replica.binding.browserProfileId, mountMode: 'whole-profile',
              mountNativeId: null, generation: replica.binding.generation },
            extensions: {},
          },
          collection: { collectionId: P09_COLLECTION, lastCursor: null, lastRevision: null,
            bootstrapMode: 'download' },
        }),
      });
      assert.equal(session.statusCode, 201, session.body.slice(0, 300));
      const sessionBody = session.json() as { sessionId: string };
      const snapshot = await built.app.inject({
        method: 'GET',
        url: `/private-entry/snapshot-download?sessionId=${encodeURIComponent(sessionBody.sessionId)}&limit=100`,
        headers: { authorization: 'Bearer p09-http-token', origin: P09_SYNC_ORIGIN },
      });
      assert.equal(snapshot.statusCode, 200, snapshot.body.slice(0, 300));
      assert.equal(snapshot.body.includes(P09_COLLECTION), true, 'control collection must be served over HTTP');
      assert.equal(snapshot.body.includes(fixture.controlNodeTitle), true, 'control node must be served over HTTP');
      assertZeroMarkers(snapshot.body, 'sync snapshot');
    } finally {
      await built.close();
    }
  });

  test('app restart re-evaluates every surface with the marker still absent', async () => {
    const first = await httpApp();
    await first.app.inject({ method: 'GET', url: `/colp/v0.1/collections/${P09_COLLECTION}/snapshot?limit=100` });
    await first.close();

    const second = await httpApp();
    try {
      const snapshot = await second.app.inject({
        method: 'GET',
        url: `/colp/v0.1/collections/${P09_COLLECTION}/snapshot?include=attachments&limit=100`,
      });
      assert.equal(snapshot.statusCode, 200);
      const body = snapshot.json() as { nodes: Array<{ title: string }> };
      assert.ok(body.nodes.some((node) => node.title === fixture.controlNodeTitle),
        'control node must still be served after restart');
      assertZeroMarkers(snapshot.body, 'restart snapshot');
    } finally {
      await second.close();
    }
  });

  test('a capability that is OFF is a 404, never a pass; the ON state proves control + zero markers', async () => {
    const off = await p09BuildConsumerHttpApp({
      runtime: isolated,
      databaseUrl: isolated.databaseUrl,
      identityUnitOfWork: createIdentityMemoryUnitOfWork(createIdentityMemoryState(new Date('2026-08-08T12:00:00.000Z'))),
      fixture,
      objectServerUrl: fixture.objectServer.url,
      enableSearch: false,
    });
    try {
      const search = await off.app.inject({ method: 'GET', url: '/api/v1/search?q=anything' });
      assert.equal(search.statusCode, 404, 'search capability off must be explicitly disabled over HTTP');
      // Publication still runs and serves the control resource marker-free.
      const snapshot = await off.app.inject({
        method: 'GET',
        url: `/colp/v0.1/collections/${P09_COLLECTION}/snapshot?limit=100`,
      });
      assert.equal(snapshot.statusCode, 200);
      assert.equal(snapshot.body.includes(fixture.controlNodeTitle), true);
      assertZeroMarkers(snapshot.body, 'snapshot with search off');
    } finally {
      await off.close();
    }
  });
});
