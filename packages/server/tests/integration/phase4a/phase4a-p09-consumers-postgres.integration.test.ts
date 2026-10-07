/**
 * P4A-P09 PostgreSQL suite (part 2): six consumer exclusion contracts over the
 * REAL Product fixture.
 *
 * Every shared consumer (Publication Snapshot/Directory/Metadata, Sync
 * bootstrap payload + stored snapshot_json, MCP collection/snapshot
 * resources, search candidate index + full query, public Profile, Publication
 * Manifest, shared-link registry contract) runs over the REAL owner-private
 * Product fixture (real `attachments` rows from finalize, replacement old/new,
 * retired/deleted/quarantined facts). Each consumer must:
 * - serve its visible CONTROL resource in the same fixture (an empty output
 *   is NEVER safety — anti-false-positive);
 * - carry ZERO private markers in its serialized output (the markers exist in
 *   the REAL stored bodies — anti-false-positive: no Product Attachment row
 *   means the suite is meaningless);
 * - never forward old artifacts: a stale marker-bearing sync snapshot row or
 *   a deleted node's stale indexed text must not resurface (old artifact
 *   migration);
 * - re-evaluate identically after a consumer restart/rebuild (the restart
 *   test runs LAST on purpose: it ends the shared pool, and every later
 *   consumer leg would re-open the same schema through a fresh runtime).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { createDatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import { createPostgresSearchCandidatePort } from '../../../src/infrastructure/search/index.js';
import { createPostgresSharedExposureFactsPort, createAttachmentExposurePolicyAdapter } from '../../../src/infrastructure/database/index.js';
import { createPostgresSyncBootstrapSnapshotApplication } from '../../../src/infrastructure/sync/index.js';
import { createSyncPullCursorKeyring } from '../../../src/modules/sync/index.js';
import { createI07MigrationRuntime, type I07MigrationRuntime } from '../../support/phase4a-i07-test-helpers.js';
import {
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
} from '../../support/product-http-harness.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { seedSyncSession } from '../../support/phase4a-i12-test-helpers.js';
import {
  p09BuildProductFixture,
  type P09ProductFixture,
} from '../../support/phase4a-p09-test-helpers.js';
import { p09BuildConsumers } from '../../support/phase4a-p09-consumers.js';

describeWithPostgres('P4A-P09 six consumer exclusion contracts over the real Product fixture', () => {
  let isolated: I07MigrationRuntime;
  let fixture: P09ProductFixture;
  let privateMarkers: string[];

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('phase4a_p09_consumers', { maxConnections: 14 });
    fixture = await p09BuildProductFixture({
      runtime: isolated,
      databaseUrl: isolated.databaseUrl,
      identityUnitOfWork: createIdentityMemoryUnitOfWork(createIdentityMemoryState(new Date('2026-08-08T12:00:00.000Z'))),
    });
    privateMarkers = Object.values(fixture.markers);
  }, 180_000);

  afterAll(async () => {
    try { await fixture?.bundle.app.close(); } catch { /* pool may already be closed by the restart test */ }
    try { await fixture?.bundle.store.close(); } catch { /* ignore */ }
    try { await fixture?.objectServer.close(); } catch { /* ignore */ }
    await isolated?.dropSchema();
  });

  function assertZeroMarkers(value: unknown, label: string): void {
    const serialized = JSON.stringify(value);
    assert.ok(serialized !== undefined, `${label} must be JSON-serializable`);
    for (const marker of privateMarkers) {
      assert.equal(serialized.includes(marker), false, `${label} must never contain private marker ${marker}`);
    }
  }

  test('the private markers exist in REAL stored bodies + REAL attachments rows so a zero scan is meaningful', async () => {
    for (const [key, marker] of Object.entries(fixture.markers)) {
      const blob = fixture.blobs[key as keyof typeof fixture.blobs];
      const stored = fixture.objectServer.objects.get(blob.key);
      assert.ok(stored, `${key} must exist on the object server`);
      assert.equal(stored.body.includes(marker), true, `${key} marker must live in the REAL body bytes`);
      const rows = await isolated.runtime.pool.query<{ count: string }>(
        `select count(*)::text as count from attachments a
           join blob_records b on b.blob_id = a.blob_id
          where b.blob_id = $1`,
        [blob.blobId],
      );
      assert.equal(rows.rows[0]!.count, '1', `${key} must have a REAL attachments row`);
    }
  });

  test('all six consumer legs serve their control resource with zero private marker', async () => {
    const set = p09BuildConsumers({ runtime: isolated, databaseUrl: isolated.databaseUrl, fixture });
    assert.equal(set.consumers.length, 7, 'publication/sync/mcp/search/profile/manifest/shared_link legs must exist');
    assert.ok(set.privateMarkers.length >= 6, 'the fixture must carry distinct private markers');
    for (const consumer of set.consumers) {
      const outcome = await consumer.run();
      assert.equal(outcome.controlVisible, true,
        `${consumer.kind} must serve its control resource (empty output is never safety)`);
      assertZeroMarkers(outcome.output, `${consumer.kind} output`);
    }
  });

  test('Publication snapshot attachments projection is the empty gate-closed array', async () => {
    const set = p09BuildConsumers({ runtime: isolated, databaseUrl: isolated.databaseUrl, fixture });
    const publication = set.consumers.find((consumer) => consumer.kind === 'publication');
    assert.ok(publication);
    const outcome = await publication!.run();
    const output = outcome.output as { snapshot: { attachments: readonly unknown[]; nodes: Array<{ title: string }> } };
    assert.deepEqual(output.snapshot.attachments, [], 'the gate closes the snapshot attachment projection');
    assert.ok(output.snapshot.nodes.some((node) => node.title === fixture.controlNodeTitle));
    assertZeroMarkers(outcome.output, 'publication snapshot');
  });

  test('Sync bootstrap payload AND the stored snapshot_json carry zero private marker', async () => {
    const set = p09BuildConsumers({ runtime: isolated, databaseUrl: isolated.databaseUrl, fixture });
    const sync = set.consumers.find((consumer) => consumer.kind === 'sync');
    assert.ok(sync);
    const outcome = await sync!.run();
    const output = outcome.output as { snapshotId?: string; collection: { id: string } };
    assert.equal(output.collection.id, fixture.collectionId);
    assert.equal(outcome.controlVisible, true);
    assertZeroMarkers(outcome.output, 'sync bootstrap payload');
    const snapshotId = (outcome.output as { snapshotId?: string }).snapshotId;
    if (snapshotId !== undefined) {
      const stored = await isolated.runtime.pool.query<{ snapshot_json: string }>(
        `select snapshot_json::text from sync_bootstrap_snapshots where snapshot_id = $1`,
        [snapshotId],
      );
      assert.equal(stored.rowCount, 1);
      for (const marker of privateMarkers) {
        assert.equal(stored.rows[0]!.snapshot_json.includes(marker), false,
          `stored sync snapshot_json must never contain ${marker}`);
      }
    }
  });

  test('search candidate index (raw production port) carries zero private marker', async () => {
    const candidates = createPostgresSearchCandidatePort(isolated.runtime.db);
    const rows = await candidates.listCandidates({
      projection: Object.freeze({ kind: 'anonymous' }),
      query: fixture.controlNodeTitle,
      limit: 100,
      types: ['collection', 'node', 'profile', 'annotation'],
      timeoutMs: 2_000,
      signal: new AbortController().signal,
    });
    assert.ok(rows.items.length >= 1, 'the control node must be a search candidate (link executed)');
    assertZeroMarkers(rows.items, 'search candidate index');
  });

  test('shared-link registry contract: no record table, gate denies every real product blob, real attachments rows are never shareable', async () => {
    const set = p09BuildConsumers({ runtime: isolated, databaseUrl: isolated.databaseUrl, fixture });
    const sharedLink = set.consumers.find((consumer) => consumer.kind === 'shared_link');
    assert.ok(sharedLink);
    const outcome = await sharedLink!.run();
    assert.equal(outcome.controlVisible, true, 'the shared-link gate contract must hold over the real product fixture');
    const output = outcome.output as { registryTables: number; productAttachmentRows: number };
    assert.equal(output.registryTables, 0, 'no shared-link registry table may exist while the surface is absent');
    assert.ok(output.productAttachmentRows >= 5, 'the gate must assess blobs with REAL attachments rows');
  });

  test('old artifact migration: a stale marker-bearing sync snapshot row is never served by a NEW session', async () => {
    // Simulate a pre-productization artifact: an OLD sync session whose
    // stored snapshot_json embeds a private marker (as if an old build cached
    // attachment content inside the sync snapshot). The stale row is REAL
    // fixture data (legal FKs through the production session seed); a NEW
    // session must rebuild through the gate and never serve it.
    const staleSession = await seedSyncSession(isolated.runtime, {
      collectionId: fixture.collectionId,
      suffix: randomUUID(),
    });
    const residueMarker = `p09-residue-${randomUUID()}`;
    const staleSnapshotId = `p09-stale-snapshot-${randomUUID()}`;
    await isolated.runtime.pool.query(
      `insert into resource_id_ledger (resource_id, resource_type) values ($1, 'sync_bootstrap_snapshot')
         on conflict do nothing`,
      [staleSnapshotId],
    );
    await isolated.runtime.pool.query(
      `insert into sync_bootstrap_snapshots
        (snapshot_id, session_id, account_id, collection_id, replica_id, lease_generation,
         policy_revision, content_revision, binding_mode, binding_root_node_id,
         snapshot_json, bootstrap_cursor, cursor_key_id, generated_at, expires_at)
       values ($1, $2, 'i12-sync-account', $3, $4, 1, 'p1', 'stale-c1', 'whole-profile', $5,
               $6::jsonb, 'stale-cursor', 'k1', now(), now() + interval '1 hour')`,
      [staleSnapshotId, staleSession.sessionId, fixture.collectionId, staleSession.replicaId,
        `${fixture.collectionId}-root`,
        JSON.stringify({
          collection: { id: fixture.collectionId },
          nodes: [],
          parentRevisions: [],
          attachments: [{ id: residueMarker, title: residueMarker }],
        })],
    );
    const freshSession = await seedSyncSession(isolated.runtime, {
      collectionId: fixture.collectionId,
      suffix: randomUUID(),
    });
    const pullKeys = createSyncPullCursorKeyring({
      active: { id: `p09-pull-${randomUUID()}`, secret: Buffer.alloc(32, 74).toString('base64') },
      retained: [],
      ttlMs: 300_000,
    });
    try {
      const application = createPostgresSyncBootstrapSnapshotApplication(isolated.runtime, {
        cursorSecret: Buffer.alloc(32, 74), cursorKeyId: 'p09-sync-v1', cursorTtlMs: 300_000,
        pullCursorKeyring: pullKeys,
        attachmentExposure: createAttachmentExposurePolicyAdapter(createPostgresSharedExposureFactsPort(isolated.runtime)),
      });
      const snapshot = await application.query({
        credential: freshSession.credential,
        request: { sessionId: freshSession.sessionId, limit: 100 },
      }) as { snapshotId: string; collection: { id: string }; nodes: Array<{ title: string }> };
      assert.equal(snapshot.collection.id, fixture.collectionId);
      assert.ok(snapshot.nodes.some((node) => node.title === fixture.controlNodeTitle),
        'the new session must still serve the control node');
      assert.notEqual(snapshot.snapshotId, staleSnapshotId,
        'a new session must never serve the stale marker-bearing row');
      const serialized = JSON.stringify(snapshot);
      assert.equal(serialized.includes(residueMarker), false,
        'the stale marker-bearing snapshot must never be served');
      for (const marker of privateMarkers) {
        assert.equal(serialized.includes(marker), false, `rebuild must never contain ${marker}`);
      }
      // The stale artifact still exists (it was never migrated/forwarded) but
      // remains unserved — old artifacts do not resurface after productization.
      const staleCheck = await isolated.runtime.pool.query<{ snapshot_json: string }>(
        `select snapshot_json::text from sync_bootstrap_snapshots where snapshot_id = $1`,
        [staleSnapshotId],
      );
      assert.equal(staleCheck.rows[0]!.snapshot_json.includes(residueMarker), true,
        'the stale artifact must still be present so its non-servance is meaningful');
    } finally {
      pullKeys.destroy();
    }
  });

  test('old artifact migration: a deleted node whose stale indexed text embeds the marker is never searchable', async () => {
    // Simulate a pre-gate artifact: a node whose title/description carries a
    // private marker (as if an old build indexed attachment content into node
    // text) that was later deleted. The current search surface must never
    // return it.
    const residueMarker = `p09-search-residue-${randomUUID()}`;
    const staleNodeId = `p09-stale-node-${randomUUID()}`;
    await isolated.runtime.pool.query(
      `insert into resource_id_ledger (resource_id, resource_type) values ($1, 'node')`,
      [staleNodeId],
    );
    await isolated.runtime.pool.query(
      `insert into nodes
        (id, collection_id, parent_id, kind, is_root, title, url, description, tags,
         visibility, position_token, resource_revision, children_revision, deleted_at, created_at, updated_at)
       values ($1, $2, $3, 'bookmark', false, $4, 'https://residue.example.test/p09', $4, '[]'::jsonb,
         'inherit', 'Z', 'r1', 'ch1', now(), now(), now())`,
      [staleNodeId, fixture.collectionId, `${fixture.collectionId}-root`, residueMarker],
    );
    const candidates = createPostgresSearchCandidatePort(isolated.runtime.db);
    const rows = await candidates.listCandidates({
      projection: Object.freeze({ kind: 'anonymous' }),
      query: residueMarker,
      limit: 100,
      types: ['node'],
      timeoutMs: 2_000,
      signal: new AbortController().signal,
    });
    const serialized = JSON.stringify(rows.items);
    assert.equal(serialized.includes(residueMarker), false,
      'the deleted stale-indexed node must never be searchable');
  });

  test('consumer restart/rebuild (fresh runtime, same schema) re-evaluates with control visible and zero markers', async () => {
    // Runs LAST on purpose: it ends the shared pool (closeKeepSchema), so
    // every later consumer leg would re-open the same schema through a fresh
    // runtime (restart semantics), and nothing after it needs the old pool.
    const schemaUrl = isolated.databaseUrl;
    await isolated.closeKeepSchema();
    const restarted = createDatabaseRuntime(schemaUrl, {
      maxConnections: 10,
      applicationName: 'known-p09-consumers-restart',
    });
    try {
      const restartRuntime: I07MigrationRuntime = { ...isolated, runtime: restarted };
      const set = p09BuildConsumers({ runtime: restartRuntime, databaseUrl: schemaUrl, fixture });
      for (const consumer of set.consumers) {
        const outcome = await consumer.run();
        assert.equal(outcome.controlVisible, true,
          `${consumer.kind} must still serve its control resource after restart/rebuild`);
        assertZeroMarkers(outcome.output, `${consumer.kind} restart output`);
      }
    } finally {
      await restarted.close();
    }
  });
});
