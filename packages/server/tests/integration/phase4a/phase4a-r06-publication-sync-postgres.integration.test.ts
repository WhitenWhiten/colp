/**
 * P4A-R06 PostgreSQL integration: per-consumer private exclusion — Publication
 * and Sync legs.
 *
 * Black-box proof over the PRODUCTION migration + real PostgreSQL:
 * - a REAL private blob per state (`stored_private`, `attached_private`,
 *   retired old/new generation, `expired`, `quarantined`) whose UNIQUE marker
 *   lives in the physical generation-key rows and in the seed body bytes;
 * - one visible CONTROL resource (collection/node/sync operation) in the SAME
 *   fixture so an empty output can never count as safety
 *   (anti-false-positive: empty lists / disabled capability / missing schema
 *   field are never sufficient);
 * - every consumer public entry (Publication Snapshot/Directory/Metadata,
 *   Sync bootstrap/pull) serves the control resource and carries ZERO private
 *   markers; consumer restart and stale-projection residue keep the marker
 *   absent; the Publication cache envelope/key/value never carries a marker
 *   and a warm cache hit still serves a marker-free snapshot;
 * - feature-flag combinations (include[]/types/pageSize shapes) never create
 *   exposure;
 * - consumer OUTAGE (PostgreSQL unavailable) is a distinct failure from the
 *   deny verdict: outage throws, deny serves control + zero markers.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { createDatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import {
  createPostgresPublicationEntrySnapshotQueryPorts,
} from '../../../scripts/evidence/postgres-publication-entry.js';
import {
  createPostgresPublicationDirectoryReadPort,
  createPostgresPublicationMetadataReadPort,
} from '../../../src/infrastructure/publication/index.js';
import {
  createPublicationCursorKeyring,
  getPublicationCollectionMetadata,
  getPublicationDirectoryPage,
  getPublicationSnapshotPage,
  isValidPublicationSnapshot,
} from '../../../src/modules/publication/index.js';
import {
  createPostgresSyncBootstrapSnapshotApplication,
  createPostgresSyncPullReadPort,
} from '../../../src/infrastructure/sync/index.js';
import { createPostgresSharedExposureFactsPort, createAttachmentExposurePolicyAdapter } from '../../../src/infrastructure/database/index.js';
import { insertTestOperation } from '../../support/ledger-split-writes.js';
import { createSyncPullCursorKeyring } from '../../../src/modules/sync/index.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { FakeCacheStore } from '../../support/cache-test-fixtures.js';
import { createPublicationSnapshotCache } from '../../../src/infrastructure/publication/index.js';
import {
  CacheBulkhead,
  CacheCircuitBreaker,
  CacheSingleflight,
  createCacheFailurePolicy,
} from '../../../src/infrastructure/cache/index.js';
import {
  I12_COLLECTION,
  assertControlVisible,
  assertMarkerAbsentFromJson,
  controlMarker,
  i12BlobIdentity,
  privateMarker,
  seedAttachedPrivate,
  seedControlCollection,
  seedExpiredBlob,
  seedQuarantinedGeneration,
  seedRetiredGeneration,
  seedStoredPrivate,
  seedSyncSession,
} from '../../support/phase4a-i12-test-helpers.js';
import {
  createI07MigrationRuntime,
  type I07MigrationRuntime,
} from '../../support/phase4a-i07-test-helpers.js';

const ANONYMOUS = Object.freeze({ kind: 'anonymous' as const });
const CACHE_POLICY = Object.freeze({
  domain: 'publication-snapshot',
  softTtlMs: 10_000,
  hardTtlMs: 30_000,
  jitterMs: 0,
  serveStale: false,
  maxEntryBytes: 512 * 1024,
  lockTtlMs: 1_500,
  lockWaitCount: 3,
});

describeWithPostgres('P4A-R06 Publication + Sync per-consumer exclusion', () => {
  let isolated: I07MigrationRuntime;
  let controlNodeTitle: string;
  let controlOperationMarker: string;
  const privateMarkers = {
    stored: privateMarker('r06-pub-stored'),
    attached: privateMarker('r06-pub-attached'),
    retiredOld: privateMarker('r06-pub-retired-old'),
    retiredNew: privateMarker('r06-pub-retired-new'),
    expired: privateMarker('r06-pub-expired'),
    quarantined: privateMarker('r06-pub-quarantined'),
  };
  const allMarkers = () => Object.values(privateMarkers);

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('phase4a_r06_publication_sync', { maxConnections: 12 });
    const seeded = await seedControlCollection(isolated.runtime, {
      collectionId: I12_COLLECTION,
      controlNodeTitle: controlMarker('r06-pub-control'),
    });
    controlNodeTitle = seeded.controlNodeTitle;
    controlOperationMarker = controlMarker('r06-sync-control-op');

    let slot = 0;
    const next = () => { slot += 1; return slot; };
    // Markers live in the physical key rows AND in the seed body bytes.
    const seedOptions = { body: new TextEncoder().encode(`r06-private-body-${randomUUID()}`) };
    await seedStoredPrivate(isolated.runtime, i12BlobIdentity(next(), privateMarkers.stored), seedOptions);
    await seedAttachedPrivate(isolated.runtime, i12BlobIdentity(next(), privateMarkers.attached), seedOptions);
    await seedRetiredGeneration(
      isolated.runtime,
      i12BlobIdentity(next(), privateMarkers.retiredOld),
      i12BlobIdentity(next(), privateMarkers.retiredNew),
      seedOptions,
    );
    await seedExpiredBlob(isolated.runtime, i12BlobIdentity(next(), privateMarkers.expired), seedOptions);
    await seedQuarantinedGeneration(isolated.runtime, i12BlobIdentity(next(), privateMarkers.quarantined), seedOptions);
  }, 120_000);

  afterAll(async () => {
    await isolated?.dropSchema();
  });

  function snapshotPorts() {
    const key = createPublicationCursorKeyring({
      active: { id: `r06-pub-${randomUUID()}`, secret: Buffer.alloc(32, 61).toString('base64') },
      retained: [],
    });
    return { key, ports: createPostgresPublicationEntrySnapshotQueryPorts(isolated.runtime, key) };
  }

  function directoryMetadataPorts() {
    const key = createPublicationCursorKeyring({
      active: { id: `r06-dir-${randomUUID()}`, secret: Buffer.alloc(32, 62).toString('base64') },
      retained: [],
    });
    return {
      key,
      directory: {
        reads: createPostgresPublicationDirectoryReadPort(isolated.runtime),
        cursors: key,
        origin: 'https://known.example',
        maxPageSize: 100,
      },
      metadata: {
        reads: createPostgresPublicationMetadataReadPort(isolated.runtime),
        origin: 'https://known.example',
        now: () => new Date('2026-08-08T12:00:00.000Z'),
      },
    };
  }

  test('the seeded private markers are REAL (rows + body) so absence in projections is meaningful', async () => {
    for (const marker of allMarkers()) {
      const rows = await isolated.runtime.pool.query<{ count: string }>(
        `select count(*)::text as count from generation_keys where key like '%' || $1 || '%'`,
        [marker],
      );
      assert.equal(rows.rows[0]?.count, '1', `marker ${marker} must exist in a real generation_keys row`);
      const inBlobs = await isolated.runtime.pool.query<{ count: string }>(
        `select count(*)::text as count from blob_records b
           join blob_generations g on g.blob_id = b.blob_id
          where g.key like '%' || $1 || '%' and b.logical_state is not null`,
        [marker],
      );
      assert.equal(inBlobs.rows[0]?.count, '1', `marker ${marker} must belong to a real blob`);
    }
    const states = await isolated.runtime.pool.query<{ logical_state: string; generation_state: string }>(
      `select b.logical_state, g.generation_state
         from blob_records b join blob_generations g on g.generation_id = b.current_generation_id
        where g.key like '%r06-pub-%' order by b.logical_state, g.generation_state`,
    );
    const seen = new Set(states.rows.map((row) => `${row.logical_state}/${row.generation_state}`));
    assert.ok(seen.has('stored_private/active'));
    assert.ok(seen.has('attached_private/active'));
    assert.ok(seen.has('expired/active'));
    assert.ok(seen.has('stored_private/quarantined'));
    const retired = await isolated.runtime.pool.query<{ count: string }>(
      `select count(*)::text as count from blob_generations
        where generation_state='retired' and key like '%r06-pub-retired-old%'`,
    );
    assert.equal(retired.rows[0]?.count, '1', 'the old generation is retired after the replacement CAS');
  });

  test('Publication Snapshot serves the control resource with zero private marker', async () => {
    const { key, ports } = snapshotPorts();
    try {
      const page = await getPublicationSnapshotPage(ports, {
        collectionId: I12_COLLECTION,
        principal: ANONYMOUS,
        query: { include: ['attachments'], limit: 100 },
      });
      assert.equal(page.projection, 'public');
      assert.equal(isValidPublicationSnapshot(page.snapshot), true);
      assert.deepEqual(page.snapshot.attachments, [], 'the gate denies every blob so the attachment projection is empty');
      assert.ok(page.snapshot.nodes.some((node) => node.title === controlNodeTitle),
        'control node must be served (link executed)');
      for (const marker of allMarkers()) {
        assertMarkerAbsentFromJson(page.snapshot, marker, `snapshot (${marker})`);
      }
    } finally {
      key.destroy();
    }
  });

  test('Publication Directory + Metadata serve the control resource with zero private marker', async () => {
    const built = directoryMetadataPorts();
    try {
      const page = await getPublicationDirectoryPage(built.directory, {
        principal: ANONYMOUS,
        query: { limit: 100 },
      });
      const directoryJson = JSON.stringify(page.directory);
      assert.equal(directoryJson.includes(I12_COLLECTION), true, 'control collection must be served');
      for (const marker of allMarkers()) assert.equal(directoryJson.includes(marker), false, marker);
      const result = await getPublicationCollectionMetadata(built.metadata, {
        collectionId: I12_COLLECTION,
        principal: ANONYMOUS,
      });
      assert.equal(result.kind, 'metadata');
      if (result.kind === 'metadata') {
        assert.equal(result.metadata.collection.id, I12_COLLECTION);
        assertMarkerAbsentFromJson(result.metadata, privateMarkers.stored, 'metadata');
      }
    } finally {
      built.key.destroy();
    }
  });

  test('Publication cache envelope/key/value never carries a private marker and a warm hit still serves it', async () => {
    const store = new FakeCacheStore();
    const reader = createPublicationSnapshotCache({
      policy: CACHE_POLICY,
      deps: {
        store,
        singleflight: new CacheSingleflight(),
        bulkhead: new CacheBulkhead(4),
        failurePolicy: createCacheFailurePolicy(
          new CacheCircuitBreaker({ failureThreshold: 3, cooldownMs: 1_000 }),
          new CacheBulkhead(4),
        ),
        clock: () => Date.now(),
      },
      key: { environment: 'test', keyPrefix: 'r06' },
    });
    const { key, ports } = snapshotPorts();
    try {
      // Warm miss through the REAL gate-wired loader: the stored envelope and
      // its keys must never contain any private marker.
      const first = await reader(ports, {
        collectionId: I12_COLLECTION,
        principal: ANONYMOUS,
        query: { limit: 200 },
      });
      assert.ok(first.snapshot.nodes.some((node) => node.title === controlNodeTitle),
        'control node must be served on the cold miss (link executed)');
      assert.equal(store.data.size > 0, true, 'a miss must write cache entries');
      for (const [cacheKey, encoded] of store.data) {
        for (const marker of allMarkers()) {
          assert.equal(cacheKey.includes(marker), false, `cache key must never contain ${marker}`);
          assert.equal(encoded.includes(marker), false, `cache value must never contain ${marker}`);
        }
      }
      // Warm hit: served from the marker-free envelope, no reload, still no marker.
      const second = await reader(ports, {
        collectionId: I12_COLLECTION,
        principal: ANONYMOUS,
        query: { limit: 200 },
      });
      assert.deepEqual(second.snapshot, first.snapshot, 'warm hit serves the same gate-derived snapshot');
      assert.ok(second.snapshot.nodes.some((node) => node.title === controlNodeTitle));
      for (const marker of allMarkers()) {
        assertMarkerAbsentFromJson(second.snapshot, marker, `warm cache hit (${marker})`);
      }
    } finally {
      key.destroy();
    }
  });

  test('old projection residue never survives a gate-wired rebuild', async () => {
    const residue = privateMarker('r06-pub-residue');
    const staleCache = { [I12_COLLECTION]: `{"leaked": "${residue}"}` };
    assert.equal(staleCache[I12_COLLECTION]!.includes(residue), true, 'stale residue must exist before purge');

    const { key, ports } = snapshotPorts();
    try {
      const page = await getPublicationSnapshotPage(ports, {
        collectionId: I12_COLLECTION,
        principal: ANONYMOUS,
        query: { include: ['attachments'], limit: 100 },
      });
      const serialized = JSON.stringify(page.snapshot);
      assert.equal(serialized.includes(residue), false, 'rebuilt snapshot must not forward stale residue');
      assert.equal(serialized.includes(controlNodeTitle), true, 'control node still served after rebuild');
    } finally {
      key.destroy();
    }
  });

  test('feature-flag shapes never create exposure (include[] combinations)', async () => {
    for (const include of [[], ['attachments'], ['annotations', 'attachments', 'relations']] as const) {
      const { key, ports } = snapshotPorts();
      try {
        const page = await getPublicationSnapshotPage(ports, {
          collectionId: I12_COLLECTION,
          principal: ANONYMOUS,
          query: { include: [...include] as never, limit: 100 },
        });
        assert.ok(page.snapshot.nodes.some((node) => node.title === controlNodeTitle),
          `control node must be served for include=${JSON.stringify(include)}`);
        assert.deepEqual(page.snapshot.attachments, []);
        for (const marker of allMarkers()) {
          assertMarkerAbsentFromJson(page.snapshot, marker, `include=${JSON.stringify(include)} (${marker})`);
        }
      } finally {
        key.destroy();
      }
    }
  });

  test('Sync bootstrap serves the control collection/node with zero private marker', async () => {
    const session = await seedSyncSession(isolated.runtime, {
      collectionId: I12_COLLECTION, suffix: randomUUID(),
    });
    const pullKeys = createSyncPullCursorKeyring({
      active: { id: `r06-pull-${randomUUID()}`, secret: Buffer.alloc(32, 64).toString('base64') },
      retained: [], ttlMs: 300_000,
    });
    try {
      const application = createPostgresSyncBootstrapSnapshotApplication(isolated.runtime, {
        cursorSecret: Buffer.alloc(32, 65), cursorKeyId: 'r06-snapshot-v1', cursorTtlMs: 300_000,
        pullCursorKeyring: pullKeys,
        attachmentExposure: createAttachmentExposurePolicyAdapter(createPostgresSharedExposureFactsPort(isolated.runtime)),
      });
      const snapshot = await application.query({
        credential: session.credential,
        request: { sessionId: session.sessionId, limit: 100 },
      }) as { mode: string; collection: { id: string }; nodes: Array<{ title: string }>;
        attachments: readonly unknown[]; snapshotId: string };
      assert.equal(snapshot.mode, 'sync');
      assert.equal(snapshot.collection.id, I12_COLLECTION, 'control collection must be served');
      assert.ok(snapshot.nodes.some((node) => node.title === controlNodeTitle),
        'control node must be served (link executed)');
      assert.deepEqual(snapshot.attachments, [], 'sync snapshot attachment projection is empty (gate denied)');
      for (const marker of allMarkers()) {
        assertMarkerAbsentFromJson(snapshot, marker, `sync bootstrap snapshot (${marker})`);
      }
      const stored = await isolated.runtime.pool.query<{ snapshot_json: string }>(
        `select snapshot_json::text from sync_bootstrap_snapshots where snapshot_id=$1`,
        [snapshot.snapshotId],
      );
      assert.equal(stored.rowCount, 1);
      for (const marker of allMarkers()) {
        assert.equal(stored.rows[0]!.snapshot_json.includes(marker), false,
          `stored snapshot_json must not contain ${marker}`);
      }
    } finally {
      pullKeys.destroy();
    }
  });

  test('Sync pull serves a control operation and carries zero private marker', async () => {
    const session = await seedSyncSession(isolated.runtime, {
      collectionId: I12_COLLECTION, suffix: randomUUID(),
    });
    const operationId = `r06-pull-op-${randomUUID()}`;
    await isolated.runtime.pool.query(
      `insert into resource_id_ledger (resource_id, resource_type) values ($1, 'operation')`,
      [operationId],
    );
    await insertTestOperation(isolated.runtime.db, {
      operationId, collectionId: I12_COLLECTION, commitOrdinal: 1n,
      operationType: 'sync.node.update', payloadJson: {},
      actorPrincipalId: session.credential.subject,
      syncWireJson: {
        opId: operationId,
        replicaId: session.replicaId,
        sequence: 1,
        collectionId: I12_COLLECTION,
        type: 'update_node_content',
        targetId: `r06-pull-target-${randomUUID()}`,
        baseRevision: 'target-r1',
        occurredAt: '2026-08-08T12:00:00.000Z',
        payload: { base: { title: 'Root' }, value: { title: controlOperationMarker } },
      },
    });
    const keys = createSyncPullCursorKeyring({
      active: { id: `r06-pull-read-${randomUUID()}`, secret: Buffer.alloc(32, 66).toString('base64') },
      retained: [], ttlMs: 300_000,
    });
    try {
      const port = createPostgresSyncPullReadPort(isolated.runtime.db, keys);
      const page = await port.read({
        credential: session.credential,
        sessionId: session.sessionId,
        collectionId: I12_COLLECTION,
        replicaId: session.replicaId,
        cursor: null,
        limit: 100,
      });
      const serialized = JSON.stringify(page.events);
      assert.equal(serialized.includes(controlOperationMarker), true,
        'control operation must be pulled (link executed)');
      for (const marker of allMarkers()) {
        assert.equal(serialized.includes(marker), false, `pull events must never contain ${marker}`);
        assert.equal(JSON.stringify(page).includes(marker), false, `pull page must never contain ${marker}`);
      }
    } finally {
      keys.destroy();
    }
  });

  test('consumer outage is a DISTINCT failure from the deny verdict', async () => {
    // Outage: the consumer entry runs against an unavailable database and must
    // FAIL (throw) — it can never be mistaken for a successful deny.
    const deadUrl = new URL(isolated.databaseUrl);
    deadUrl.searchParams.set('options', '-c search_path=does_not_exist_r06');
    const dead = createDatabaseRuntime(deadUrl.toString(), {
      maxConnections: 1,
      connectionTimeoutMs: 500,
      idleTimeoutMs: 100,
    });
    const key = createPublicationCursorKeyring({
      active: { id: `r06-outage-${randomUUID()}`, secret: Buffer.alloc(32, 67).toString('base64') },
      retained: [],
    });
    try {
      const ports = createPostgresPublicationEntrySnapshotQueryPorts(dead, key);
      await assert.rejects(
        () => getPublicationSnapshotPage(ports, {
          collectionId: I12_COLLECTION,
          principal: ANONYMOUS,
          query: { include: ['attachments'], limit: 100 },
        }),
        /consumer|outage|connection|ECONNREFUSED|does_not_exist|Postgres|error/i,
        'consumer outage must surface as an error, never as an empty-but-safe output',
      );
    } finally {
      key.destroy();
      await dead.close();
    }
    // Policy deny is the same call shape with a HEALTHY database: control
    // visible + zero markers (the rest of this suite is the deny proof).
    const { key: healthyKey, ports: healthyPorts } = snapshotPorts();
    try {
      const page = await getPublicationSnapshotPage(healthyPorts, {
        collectionId: I12_COLLECTION,
        principal: ANONYMOUS,
        query: { include: ['attachments'], limit: 100 },
      });
      assert.ok(page.snapshot.nodes.some((node) => node.title === controlNodeTitle));
    } finally {
      healthyKey.destroy();
    }
  });

  test('consumer restart re-evaluates the projection with the marker still absent', async () => {
    // Runs LAST on purpose: it ends the shared pool (closeKeepSchema), so
    // every later consumer leg re-opens the same schema through a fresh
    // runtime (restart semantics), and nothing after it needs the old pool.
    const schemaUrl = isolated.databaseUrl;
    await isolated.closeKeepSchema();
    const restarted = createDatabaseRuntime(schemaUrl, {
      maxConnections: 6,
      applicationName: 'known-r06-publication-restart',
    });
    try {
      const key = createPublicationCursorKeyring({
        active: { id: `r06-restart-${randomUUID()}`, secret: Buffer.alloc(32, 63).toString('base64') },
        retained: [],
      });
      try {
        const page = await getPublicationSnapshotPage(
          createPostgresPublicationEntrySnapshotQueryPorts(restarted, key),
          { collectionId: I12_COLLECTION, principal: ANONYMOUS, query: { include: ['attachments'], limit: 100 } },
        );
        assert.ok(page.snapshot.nodes.some((node) => node.title === controlNodeTitle),
          'control node still served after restart');
        for (const marker of allMarkers()) {
          assertMarkerAbsentFromJson(page.snapshot, marker, `restart snapshot (${marker})`);
        }
      } finally {
        key.destroy();
      }
    } finally {
      await restarted.close();
    }
  });
});
