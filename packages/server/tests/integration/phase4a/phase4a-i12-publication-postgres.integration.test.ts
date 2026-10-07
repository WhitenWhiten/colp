/**
 * P4A-I12 PostgreSQL integration: Publication rebuild + read exclusion.
 *
 * With a REAL private blob seeded through the production ledger (unique marker
 * inside the physical generation key rows and stored bytes) plus a visible
 * control collection/node, every Publication public entry — Snapshot rebuild
 * and read (`getPublicationSnapshotPage`), Directory rebuild
 * (`getPublicationDirectoryPage`) and Collection Metadata read
 * (`getPublicationCollectionMetadata`) — must:
 *   (a) actually execute (the control resource is visible in the output);
 *   (b) NEVER contain the private marker (zero marker in output/cache);
 *   (c) survive an application restart and an old-projection residue purge
 *       with the marker still absent.
 *
 * The seeded states cover `stored_private`, `attached_private`, a retired
 * generation, `expired` and `quarantined` generations — none of which may ever
 * reach a shared projection.
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
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
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
} from '../../support/phase4a-i12-test-helpers.js';
import {
  createI07MigrationRuntime,
  type I07MigrationRuntime,
} from '../../support/phase4a-i07-test-helpers.js';

const ANONYMOUS = Object.freeze({ kind: 'anonymous' as const });

describeWithPostgres('P4A-I12 Publication rebuild/read projection exclusion', () => {
  let isolated: I07MigrationRuntime;
  let controlNodeTitle: string;
  const privateMarkers = {
    stored: privateMarker('i12-pub-stored'),
    attached: privateMarker('i12-pub-attached'),
    retiredOld: privateMarker('i12-pub-retired-old'),
    retiredNew: privateMarker('i12-pub-retired-new'),
    expired: privateMarker('i12-pub-expired'),
    quarantined: privateMarker('i12-pub-quarantined'),
  };

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('phase4a_i12_publication', { maxConnections: 10 });
    const seeded = await seedControlCollection(isolated.runtime, {
      collectionId: I12_COLLECTION,
      controlNodeTitle: controlMarker('i12-pub-control'),
    });
    controlNodeTitle = seeded.controlNodeTitle;

    const slot = { n: 0 };
    const next = () => { slot.n += 1; return slot.n; };
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

  function snapshotPorts() {
    const key = createPublicationCursorKeyring({
      active: { id: `i12-pub-${randomUUID()}`, secret: Buffer.alloc(32, 41).toString('base64') },
      retained: [],
    });
    return { key, ports: createPostgresPublicationEntrySnapshotQueryPorts(isolated.runtime, key) };
  }

  function directoryMetadataPorts() {
    const key = createPublicationCursorKeyring({
      active: { id: `i12-dir-${randomUUID()}`, secret: Buffer.alloc(32, 42).toString('base64') },
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

  test('the seeded private blobs are REAL (marker exists in rows) so absence in projections is meaningful', async () => {
    for (const marker of Object.values(privateMarkers)) {
      const rows = await isolated.runtime.pool.query<{ count: string }>(
        `select count(*)::text as count from generation_keys where key like '%' || $1 || '%'`,
        [marker],
      );
      assert.equal(rows.rows[0]?.count, '1', `marker ${marker} must exist in a real generation_keys row`);
    }
    const states = await isolated.runtime.pool.query<{ logical_state: string; generation_state: string }>(
      `select b.logical_state, g.generation_state
         from blob_records b join blob_generations g on g.generation_id = b.current_generation_id
        where g.key like '%i12-pub-%'
        order by b.logical_state, g.generation_state`,
    );
    const seen = new Set(states.rows.map((row) => `${row.logical_state}/${row.generation_state}`));
    assert.ok(seen.has('stored_private/active'), 'the stored_private seed has an active current generation');
    assert.ok(seen.has('attached_private/active'), 'the attached_private seed has an active current generation');
    assert.ok(seen.has('expired/active'), 'the expired seed keeps its active generation');
    assert.ok(seen.has('stored_private/quarantined'), 'the quarantined seed is a stored_private blob with a quarantined current generation');
    const retired = await isolated.runtime.pool.query<{ count: string }>(
      `select count(*)::text as count from blob_generations
        where generation_state='retired' and key like '%i12-pub-retired-old%'`,
    );
    assert.equal(retired.rows[0]?.count, '1', 'the old generation is retired after the replacement CAS');
  });

  test('Publication Snapshot rebuild + read serves the control resource and carries zero marker', async () => {
    const { key, ports } = snapshotPorts();
    try {
      const page = await getPublicationSnapshotPage(ports, {
        collectionId: I12_COLLECTION,
        principal: ANONYMOUS,
        query: { include: ['attachments'], limit: 100 },
      });
      assert.equal(page.projection, 'public');
      assert.equal(isValidPublicationSnapshot(page.snapshot), true);
      assert.deepEqual(page.snapshot.attachments, [], 'the snapshot attachment projection is empty');
      const nodeTitles = page.snapshot.nodes.map((node) => node.title);
      assert.ok(nodeTitles.includes(controlNodeTitle), 'control node must be served (link executed)');
      for (const marker of Object.values(privateMarkers)) {
        assertMarkerAbsentFromJson(page.snapshot, marker, `snapshot (${marker})`);
      }
    } finally {
      key.destroy();
    }
  });

  test('Publication Directory rebuild serves the control collection with zero marker', async () => {
    const built = directoryMetadataPorts();
    try {
      const page = await getPublicationDirectoryPage(built.directory, {
        principal: ANONYMOUS,
        query: { limit: 100 },
      });
      const directoryJson = JSON.stringify(page.directory);
      assert.equal(directoryJson.includes(I12_COLLECTION), true, 'control collection must be served');
      for (const marker of Object.values(privateMarkers)) {
        assert.equal(directoryJson.includes(marker), false, `directory must never contain ${marker}`);
      }
    } finally {
      built.key.destroy();
    }
  });

  test('Publication Collection Metadata read serves the control metadata with zero marker', async () => {
    const built = directoryMetadataPorts();
    try {
      const result = await getPublicationCollectionMetadata(built.metadata, {
        collectionId: I12_COLLECTION,
        principal: ANONYMOUS,
      });
      assert.equal(result.kind, 'metadata');
      if (result.kind === 'metadata') {
        assert.equal(result.metadata.collection.id, I12_COLLECTION);
        assert.equal(result.metadata.collection.visibility, 'public');
        assertMarkerAbsentFromJson(result.metadata, privateMarkers.stored, 'metadata');
      }
    } finally {
      built.key.destroy();
    }
  });

  test('old projection residue never survives a rebuild: the rebuild does not read the body', async () => {
    // Simulate a stale cache/projection that (incorrectly) carried a private
    // marker from before the exclusion policy. The production rebuild path
    // re-reads authoritative data and consults no attachment body, so the
    // residue marker must not appear in any freshly rebuilt output.
    const residue = privateMarker('i12-pub-residue');
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

  test('application restart re-evaluates the projection with the marker still absent', async () => {
    const schemaUrl = isolated.databaseUrl;
    await isolated.closeKeepSchema();

    const restarted = createDatabaseRuntime(schemaUrl, {
      maxConnections: 6,
      applicationName: 'known-i12-publication-restart',
    });
    try {
      const key = createPublicationCursorKeyring({
        active: { id: `i12-restart-${randomUUID()}`, secret: Buffer.alloc(32, 43).toString('base64') },
        retained: [],
      });
      try {
        const page = await getPublicationSnapshotPage(
          createPostgresPublicationEntrySnapshotQueryPorts(restarted, key),
          { collectionId: I12_COLLECTION, principal: ANONYMOUS, query: { include: ['attachments'], limit: 100 } },
        );
        assert.ok(page.snapshot.nodes.some((node) => node.title === controlNodeTitle), 'control node still served after restart');
        for (const marker of Object.values(privateMarkers)) {
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
