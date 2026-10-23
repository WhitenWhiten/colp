import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations, createPostgresSharedExposureFactsPort,
  createAttachmentExposurePolicyAdapter } from '../../../src/infrastructure/database/index.js';
import { createPostgresSyncBootstrapSnapshotApplication } from '../../../src/infrastructure/sync/index.js';
import { createIsolatedPostgresRuntime, describeWithPostgres,
  type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';
import { seedRecoveryFixture } from '../../support/sync-recovery-fixture.js';
import { SyncBootstrapSnapshotError } from '../../../src/modules/sync/index.js';

const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

describeWithPostgres('large immutable Snapshot materialization', () => {
  let isolated: IsolatedPostgresRuntime;
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('snapshot_streaming', { maxConnections: 4 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);
  afterAll(async () => { await isolated?.close(); });

  test('a library beyond 10,000 nodes and 2 MiB bootstraps through bounded, resumable pages', async () => {
    const count = 12_001;
    const fixture = await seedRecoveryFixture(isolated, 'streaming-large', undefined, false, undefined, '0.2', count);
    let largestNodeRead = 0;
    const pool = new Proxy(isolated.runtime.pool, { get(target, property) {
      if (property !== 'connect') return Reflect.get(target, property);
      return async () => {
        const client = await target.connect();
        return new Proxy(client, { get(connection, key) {
          if (key !== 'query') return Reflect.get(connection, key);
          return async (...args: unknown[]) => {
            const result = await Reflect.apply(connection.query, connection, args);
            if (typeof args[0] === 'string' && /\b(?:nodes|fetch)\b/iu.test(args[0])) {
              largestNodeRead = Math.max(largestNodeRead, result.rows.length);
            }
            return result;
          };
        } });
      };
    } });
    const application = () => createPostgresSyncBootstrapSnapshotApplication({ pool }, {
      cursorSecret: Buffer.alloc(32, 93), cursorKeyId: 'snapshot-v1', cursorTtlMs: 300_000,
      attachmentExposure: createAttachmentExposurePolicyAdapter(createPostgresSharedExposureFactsPort(isolated.runtime)),
    });
    const query = (pageCursor?: string) => application().query({ origin: ORIGIN, credential: fixture.credential,
      request: { sessionId: fixture.sessionId, limit: 500, ...(pageCursor ? { pageCursor } : {}) } });
    const seen = new Set<string>();
    let page = await query(); let bytes = 0; let pages = 0;
    const snapshotId = page.snapshotId; const cursor = page.syncCursor;
    while (true) {
      assert.equal(page.snapshotId, snapshotId); assert.equal(page.syncCursor, cursor);
      assert.ok(page.nodes.length > 0 && page.nodes.length <= 500);
      assert.equal(page.page.sequence, ++pages);
      bytes += Buffer.byteLength(JSON.stringify(page));
      for (const node of page.nodes) {
        assert.equal(seen.has(node.id), false);
        if (node.parentId !== null) assert.ok(seen.has(node.parentId));
        seen.add(node.id);
      }
      if (!page.page.hasMore) break;
      assert.ok(page.page.nextCursor);
      const continuation = page.page.nextCursor;
      page = await query(continuation);
      if (pages === 1) {
        const replay = await query(continuation);
        assert.deepEqual(replay.nodes, page.nodes, 'a restarted reader replays the frozen nodes');
        assert.equal(replay.snapshotId, page.snapshotId); assert.equal(replay.syncCursor, page.syncCursor);
      }
    }
    assert.equal(seen.size, count);
    assert.ok(bytes > 2 * 1024 * 1024);
    assert.ok(pages > 20);
    assert.ok(largestNodeRead <= 500, `materialization transferred ${largestNodeRead} rows in one query`);
    const persisted = await isolated.runtime.pool.query(
      'select node_count, completed_at from sync_bootstrap_snapshots where snapshot_id=$1', [snapshotId]);
    assert.equal(persisted.rows[0]?.node_count, count);
    assert.ok(persisted.rows[0]?.completed_at);
  }, 120_000);

  const application = (limits: { maxSnapshotNodes?: number; maxSnapshotBytes?: number } = {}) =>
    createPostgresSyncBootstrapSnapshotApplication(isolated.runtime, {
      cursorSecret: Buffer.alloc(32, 93), cursorKeyId: 'snapshot-v1', cursorTtlMs: 300_000, ...limits,
      attachmentExposure: createAttachmentExposurePolicyAdapter(createPostgresSharedExposureFactsPort(isolated.runtime)),
    });

  test.each(['0.1', '0.2'] as const)('legacy inline %s Snapshot rows remain pageable', async (version) => {
    const fixture = await seedRecoveryFixture(isolated, `legacy-${version}`, undefined, true, undefined, version);
    const query = (pageCursor?: string) => application().query({ origin: ORIGIN, credential: fixture.credential,
      request: { sessionId: fixture.sessionId, limit: 100, ...(pageCursor ? { pageCursor } : {}) } });
    const first = await query();
    assert.equal(first.nodes.length, 100); assert.ok(first.page.nextCursor);
    const next = await query(first.page.nextCursor);
    assert.equal(next.nodes.length, 100); assert.equal(next.page.sequence, 2);
    assert.equal(next.snapshotId, first.snapshotId);
    if (first.protocolVersion === '0.2') assert.equal(first.parentRevisions.length, 1);
  });

  test('legacy paged rows recover their parent revision from the immutable header', async () => {
    const fixture = await seedRecoveryFixture(isolated, 'legacy-paged', undefined, false, undefined, '0.2', 3);
    const query = () => application().query({ origin: ORIGIN, credential: fixture.credential,
      request: { sessionId: fixture.sessionId, limit: 100 } });
    const original = await query();
    await isolated.runtime.pool.query('update sync_bootstrap_snapshot_nodes set children_revision=null where snapshot_id=$1',
      [original.snapshotId]);
    const replay = await query();
    assert.equal(replay.protocolVersion, '0.2');
    if (replay.protocolVersion === '0.2' && original.protocolVersion === '0.2') {
      assert.deepEqual(replay.parentRevisions, original.parentRevisions);
    }
    assert.deepEqual(replay.nodes, original.nodes);
  });

  test('a disconnected cycle rejects and rolls back the complete materialization', async () => {
    const fixture = await seedRecoveryFixture(isolated, 'cycle', undefined, false, undefined, '0.2', 3);
    await isolated.runtime.pool.query(`update nodes set kind='folder',url=null,
      parent_id=case when id like '%-0' then 'recovery-paged-node-cycle-1' else 'recovery-paged-node-cycle-0' end,
      payload_json=(payload_json-'url') || jsonb_build_object('kind','folder','parentId',
        case when id like '%-0' then 'recovery-paged-node-cycle-1' else 'recovery-paged-node-cycle-0' end)
      where collection_id=$1 and not is_root`, [fixture.collectionId]);
    await assert.rejects(application().query({ origin: ORIGIN, credential: fixture.credential,
      request: { sessionId: fixture.sessionId, limit: 100 } }), /not a rooted tree/);
    assert.equal((await isolated.runtime.pool.query('select count(*)::int as count from sync_bootstrap_snapshots where session_id=$1',
      [fixture.sessionId])).rows[0]?.count, 0);
  });

  test.each([{ maxSnapshotNodes: 1 }, { maxSnapshotBytes: 100 }])('explicit operator quota %j remains atomic', async limits => {
    const fixture = await seedRecoveryFixture(isolated, `quota-${Object.keys(limits)[0]!.toLowerCase()}`, undefined, false, undefined, '0.2', 3);
    await assert.rejects(application(limits).query({ origin: ORIGIN, credential: fixture.credential,
      request: { sessionId: fixture.sessionId, limit: 100 } }),
    (error: unknown) => error instanceof SyncBootstrapSnapshotError && error.code === 'payload_too_large');
    assert.equal((await isolated.runtime.pool.query('select count(*)::int as count from sync_bootstrap_snapshots where session_id=$1',
      [fixture.sessionId])).rows[0]?.count, 0);
  });
});
