import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { createPostgresSharedExposureFactsPort, runMigrations, createAttachmentExposurePolicyAdapter } from '../../../src/infrastructure/database/index.js';
import { createPostgresSyncBootstrapSnapshotApplication } from '../../../src/infrastructure/sync/index.js';
import { materializeNodePayload, RESOURCE_PAYLOAD_SCHEMA_VERSION } from '../../../src/modules/collections/index.js';
import { SNAPSHOT_MATERIALIZATION_SORT_VERSION, snapshotMaterializationIdentity } from '../../../src/modules/sync/sync-snapshot-parent-first.js';
import { accumulateSnapshotV02Pages } from '../../../../Known-Extension/src/snapshot-v02-pages.js';
import { loadCompleteRemoteSnapshot } from '../../../../Known-Extension/src/bootstrap/remote-snapshot.js';
import { createIsolatedPostgresRuntime, describeWithPostgres, type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';
import { seedRecoveryFixture } from '../../support/sync-recovery-fixture.js';

describeWithPostgres('T-04 Snapshot parent-first materialization', () => {
  let isolated: IsolatedPostgresRuntime;
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('t04_snapshot_parent_first');
    await runMigrations(isolated.runtime.db, 'latest');
  }, 60_000);
  afterAll(async () => { await isolated?.close(); });

  test('S-01 AUD-05 103-node tree succeeds at limit=1/2/99/100/101', async () => {
    const fixture = await seedAud05Tree(isolated, 's01');
    const application = snapshotApp(isolated);
    for (const limit of [1, 2, 99, 100, 101]) {
      const pages = await readAllPages(application, fixture, limit);
      const nodes = pages.flatMap((page) => page.nodes);
      assert.equal(nodes.length, 103);
      assertParentFirst(nodes);
      const folderPage = pages.findIndex((page) => page.nodes.some((node) => node.id === fixture.folderId));
      const childPage = pages.findIndex((page) => page.nodes.some((node) => node.parentId === fixture.folderId));
      assert.ok(folderPage >= 0 && childPage >= 0);
      assert.ok(folderPage <= childPage);
      const accumulated = accumulateSnapshotV02Pages(pages.map((page) => ({
        snapshotId: page.snapshotId, revision: page.revision, collectionId: page.collection.id,
        syncCursor: page.syncCursor, pageSequence: page.page.sequence, parentRevisions: page.parentRevisions,
        nodes: page.nodes, hasMore: page.page.hasMore, nextCursor: page.page.nextCursor,
        materializationVersion: SNAPSHOT_MATERIALIZATION_SORT_VERSION,
      })));
      assert.equal(accumulated.ok, true);
      if (accumulated.ok) assert.equal(accumulated.complete, true);
    }
  }, 60_000);

  test('S-02 folder id < root id, depth 3 and 50, parent and sibling anchors cross pages', async () => {
    const deep = await seedDepthTree(isolated, 's02-deep', 50);
    const application = snapshotApp(isolated);
    const deepPages = await readAllPages(application, deep, 1);
    assert.equal(deepPages.length, 51);
    assertParentFirst(deepPages.flatMap((page) => page.nodes));
    for (let index = 1; index < deepPages.length; index += 1) {
      const child = deepPages[index]!.nodes[0]!;
      const parent = deepPages[index - 1]!.nodes[0]!;
      assert.equal(child.parentId, parent.id);
    }
    const wide = await seedSiblingTree(isolated, 's02-wide');
    const siblingPages = await readAllPages(application, wide, 1);
    assertParentFirst(siblingPages.flatMap((page) => page.nodes));
    const ids = siblingPages.flatMap((page) => page.nodes.map((node) => node.id));
    assert.ok(ids.indexOf(wide.earlierId) < ids.indexOf(wide.laterId));
    assert.ok(ids.indexOf(wide.rootId) < ids.indexOf(wide.earlierId));
  }, 60_000);

  test('S-04 aggregate tree cap refuses before durable rows; page budget stays session-negotiated', async () => {
    const tiny = await seedRecoveryFixture(isolated, 's04-tiny', undefined, false, undefined, '0.2', 8);
    const aggregateCapped = snapshotApp(isolated, { maxSnapshotBytes: 512, maxSnapshotNodes: 10_000 });
    await assert.rejects(aggregateCapped.query({ credential: tiny.credential,
      request: { sessionId: tiny.sessionId, limit: 100 } }), (error: unknown) =>
      error instanceof Error && (error as { code?: string }).code === 'payload_too_large');
    const leftover = await isolated.runtime.pool.query(
      'select 1 from sync_bootstrap_snapshots where session_id=$1', [tiny.sessionId]);
    assert.equal(leftover.rowCount, 0);
  }, 60_000);

  test('S-07 two consumers recover the same postgres Snapshot identities', async () => {
    const fixture = await seedAud05Tree(isolated, 's07');
    const application = snapshotApp(isolated);
    const pages = await readAllPages(application, fixture, 100);
    const identities = async () => {
      let index = 0;
      const loaded = await loadCompleteRemoteSnapshot({
        scope: {
          environment: 'production', serverId: 'server-t04', serverOrigin: 'https://known.example',
          accountId: fixture.accountId, browserProfileId: 'profile-t04', collectionId: fixture.collectionId,
          replicaId: fixture.replicaId, generation: 1,
        },
        endpoint: 'https://known.example/snapshot', origin: 'chrome-extension://t04',
        credential: { accessToken: 'synthetic-t04' },
        session: { sessionId: fixture.sessionId } as never,
        fetcher: async () => new Response(JSON.stringify(pages[index++]), {
          headers: { 'Content-Type': 'application/json' },
        }),
      });
      return loaded.remoteFacts.map((fact) => ({
        nodeId: fact.nodeId, parentId: fact.parentId, title: fact.title, url: fact.url,
        childrenRevision: fact.childrenRevision,
      }));
    };
    const first = await identities();
    const second = await identities();
    assert.deepEqual(first, second);
    assert.equal(first[0]?.nodeId, fixture.rootId);
    assert.equal(first[1]?.nodeId, fixture.folderId);
    assert.equal(first[1]?.childrenRevision, 'c-folder');
    assert.equal(first[0]?.childrenRevision, 'children-r1');
  }, 60_000);

  test('does not rewrite an already-issued Snapshot row when the sort version changes identity', async () => {
    const fixture = await seedRecoveryFixture(isolated, 'old-sort', undefined, false, undefined, '0.2');
    const root = await isolated.runtime.db.selectFrom('collections').select('root_node_id')
      .where('id', '=', fixture.collectionId).executeTakeFirstOrThrow();
    const oldId = `snap_${createHash('sha256').update(JSON.stringify([
      'sync-snapshot-v02', fixture.sessionId, fixture.replicaId, fixture.oldGeneration,
      'content-r43', 'policy-r1', root.root_node_id,
    ])).digest('base64url').slice(0, 32)}`;
    const newId = `snap_${snapshotMaterializationIdentity({
      protocolVersion: '0.2', sessionId: fixture.sessionId, replicaId: fixture.replicaId,
      leaseGeneration: fixture.oldGeneration, contentRevision: 'content-r43',
      policyRevision: 'policy-r1', rootNodeId: root.root_node_id,
    })}`;
    assert.notEqual(oldId, newId);
    await isolated.runtime.pool.query(`insert into resource_id_ledger(resource_id,resource_type)
      values ($1,'sync_bootstrap_snapshot')`, [oldId]);
    await isolated.runtime.pool.query(`insert into sync_bootstrap_snapshots(snapshot_id,session_id,account_id,collection_id,replica_id,
        lease_generation,policy_revision,content_revision,binding_mode,binding_root_node_id,snapshot_json,
        bootstrap_cursor,cursor_key_id,generated_at,expires_at)
      values ($1,$2,$3,$4,$5,$6,'policy-r1','legacy-c1','whole-profile',$7,'{"frozen":true}'::jsonb,'old-cursor','snapshot-v1',
        current_timestamp,current_timestamp + interval '10 minutes')`,
    [oldId, fixture.sessionId, fixture.accountId, fixture.collectionId, fixture.replicaId,
      BigInt(fixture.oldGeneration), root.root_node_id]);
    const before = await isolated.runtime.pool.query(
      'select snapshot_json, storage_version from sync_bootstrap_snapshots where snapshot_id=$1', [oldId]);
    const frozen = JSON.stringify(before.rows[0]);
    const page = await snapshotApp(isolated).query({ credential: fixture.credential,
      request: { sessionId: fixture.sessionId, limit: 100 } });
    assert.equal(page.snapshotId, newId);
    const after = await isolated.runtime.pool.query(
      'select snapshot_json, storage_version from sync_bootstrap_snapshots where snapshot_id=$1', [oldId]);
    assert.equal(JSON.stringify(after.rows[0]), frozen);
  }, 60_000);
});

function snapshotApp(isolated: IsolatedPostgresRuntime, caps?: { maxSnapshotBytes?: number; maxSnapshotNodes?: number }) {
  return createPostgresSyncBootstrapSnapshotApplication(isolated.runtime, {
    cursorSecret: Buffer.alloc(32, 93), cursorKeyId: 'snapshot-v1', cursorTtlMs: 300_000,
    attachmentExposure: createAttachmentExposurePolicyAdapter(
      createPostgresSharedExposureFactsPort(isolated.runtime)),
    ...(caps ?? {}),
  });
}

async function readAllPages(
  application: ReturnType<typeof createPostgresSyncBootstrapSnapshotApplication>,
  fixture: { credential: Parameters<ReturnType<typeof createPostgresSyncBootstrapSnapshotApplication>['query']>[0]['credential']; sessionId: string },
  limit: number,
) {
  const pages = [];
  let pageCursor: string | undefined;
  do {
    const page = await application.query({ credential: fixture.credential,
      request: { sessionId: fixture.sessionId, limit, ...(pageCursor ? { pageCursor } : {}) } });
    pages.push(page);
    pageCursor = page.page.nextCursor ?? undefined;
  } while (pageCursor);
  return pages;
}

function assertParentFirst(nodes: ReadonlyArray<{ id: string; parentId: string | null }>): void {
  const index = new Map(nodes.map((node, offset) => [node.id, offset]));
  for (const node of nodes) {
    if (node.parentId === null) continue;
    assert.ok(index.has(node.parentId), `missing parent ${node.parentId}`);
    assert.ok(index.get(node.parentId)! < index.get(node.id)!,
      `parent ${node.parentId} appeared after descendant ${node.id}`);
  }
}

async function seedAud05Tree(isolated: IsolatedPostgresRuntime, suffix: string) {
  const fixture = await seedRecoveryFixture(isolated, suffix, undefined, false, undefined, '0.2', 102);
  const collection = await isolated.runtime.db.selectFrom('collections').selectAll()
    .where('id', '=', fixture.collectionId).executeTakeFirstOrThrow();
  const folderId = `aaaa-${suffix}-parent`;
  const createdAt = new Date('2026-07-26T12:00:00.000Z');
  const payload = materializeNodePayload({
    id: folderId, collectionId: fixture.collectionId, parentId: collection.root_node_id,
    kind: 'folder', isRoot: false, title: 'Audit parent', url: null, description: null, tags: [],
    visibility: 'inherit', positionToken: 'A', resourceRevision: 'r-folder', childrenRevision: 'c-folder',
    createdAt, updatedAt: createdAt, deletedAt: null, deletedCommitOrdinal: null,
  });
  assert.ok(payload.ok);
  await isolated.runtime.db.transaction().execute(async (tx) => {
    await tx.insertInto('resource_id_ledger').values({ resource_id: folderId, resource_type: 'node' }).execute();
    await tx.insertInto('nodes').values({
      id: folderId, collection_id: fixture.collectionId, parent_id: collection.root_node_id,
      kind: 'folder', is_root: false, title: 'Audit parent', url: null, visibility: 'inherit', position_token: 'A',
      resource_revision: 'r-folder', children_revision: 'c-folder', created_at: createdAt, updated_at: createdAt,
      deleted_at: null, payload_json: payload.ok ? payload.payload : {},
      payload_schema_version: RESOURCE_PAYLOAD_SCHEMA_VERSION, payload_authority_status: 'backfilled',
    }).execute();
    const children = await tx.selectFrom('nodes').selectAll().where('collection_id', '=', fixture.collectionId)
      .where('kind', '=', 'bookmark').execute();
    for (const node of children) {
      await tx.updateTable('nodes').set({
        parent_id: folderId, payload_json: { ...node.payload_json, parentId: folderId },
      }).where('id', '=', node.id).execute();
    }
  });
  return { ...fixture, folderId, rootId: collection.root_node_id };
}

async function seedDepthTree(isolated: IsolatedPostgresRuntime, suffix: string, depth: number) {
  const fixture = await seedRecoveryFixture(isolated, suffix, undefined, false, undefined, '0.2', 1);
  const collection = await isolated.runtime.db.selectFrom('collections').selectAll()
    .where('id', '=', fixture.collectionId).executeTakeFirstOrThrow();
  const createdAt = new Date('2026-07-26T12:00:00.000Z');
  let parentId = collection.root_node_id;
  await isolated.runtime.db.transaction().execute(async (tx) => {
    for (let level = 1; level <= depth; level += 1) {
      const id = `aaa-depth-${suffix}-${level.toString().padStart(2, '0')}`;
      const payload = materializeNodePayload({
        id, collectionId: fixture.collectionId, parentId, kind: 'folder', isRoot: false,
        title: `D${level}`, url: null, description: null, tags: [], visibility: 'inherit',
        positionToken: 'A', resourceRevision: `r-${level}`, childrenRevision: `c-${level}`,
        createdAt, updatedAt: createdAt, deletedAt: null, deletedCommitOrdinal: null,
      });
      assert.ok(payload.ok);
      await tx.insertInto('resource_id_ledger').values({ resource_id: id, resource_type: 'node' }).execute();
      await tx.insertInto('nodes').values({
        id, collection_id: fixture.collectionId, parent_id: parentId, kind: 'folder', is_root: false,
        title: `D${level}`, url: null, visibility: 'inherit', position_token: 'A',
        resource_revision: `r-${level}`, children_revision: `c-${level}`, created_at: createdAt,
        updated_at: createdAt, deleted_at: null, payload_json: payload.ok ? payload.payload : {},
        payload_schema_version: RESOURCE_PAYLOAD_SCHEMA_VERSION, payload_authority_status: 'backfilled',
      }).execute();
      parentId = id;
    }
  });
  return { ...fixture, rootId: collection.root_node_id };
}

async function seedSiblingTree(isolated: IsolatedPostgresRuntime, suffix: string) {
  const fixture = await seedRecoveryFixture(isolated, suffix, undefined, false, undefined, '0.2', 1);
  const collection = await isolated.runtime.db.selectFrom('collections').selectAll()
    .where('id', '=', fixture.collectionId).executeTakeFirstOrThrow();
  const createdAt = new Date('2026-07-26T12:00:00.000Z');
  const earlierId = `zzz-early-${suffix}`;
  const laterId = `aaa-late-${suffix}`;
  await isolated.runtime.db.transaction().execute(async (tx) => {
    for (const [id, token, title] of [[earlierId, 'A', 'Early'], [laterId, 'B', 'Late']] as const) {
      const payload = materializeNodePayload({
        id, collectionId: fixture.collectionId, parentId: collection.root_node_id, kind: 'folder',
        isRoot: false, title, url: null, description: null, tags: [], visibility: 'inherit',
        positionToken: token, resourceRevision: `r-${token}`, childrenRevision: `c-${token}`,
        createdAt, updatedAt: createdAt, deletedAt: null, deletedCommitOrdinal: null,
      });
      assert.ok(payload.ok);
      await tx.insertInto('resource_id_ledger').values({ resource_id: id, resource_type: 'node' }).execute();
      await tx.insertInto('nodes').values({
        id, collection_id: fixture.collectionId, parent_id: collection.root_node_id, kind: 'folder',
        is_root: false, title, url: null, visibility: 'inherit', position_token: token,
        resource_revision: `r-${token}`, children_revision: `c-${token}`, created_at: createdAt,
        updated_at: createdAt, deleted_at: null, payload_json: payload.ok ? payload.payload : {},
        payload_schema_version: RESOURCE_PAYLOAD_SCHEMA_VERSION, payload_authority_status: 'backfilled',
      }).execute();
    }
  });
  return { ...fixture, rootId: collection.root_node_id, earlierId, laterId };
}
