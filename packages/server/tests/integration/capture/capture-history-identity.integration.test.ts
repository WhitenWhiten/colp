import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { sql } from 'kysely';
import { beforeAll, afterAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createCaptureHistory } from '../../../src/infrastructure/collections/capture-history.js';
import { seedCanonicalClassificationFixture } from '../../support/classification-database-fixture.js';
import { createIsolatedPostgresRuntime, describeWithPostgres, type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';

describeWithPostgres('capture immutable identity admission', () => {
  let isolated: IsolatedPostgresRuntime;
  beforeAll(async () => { isolated = await createIsolatedPostgresRuntime('capture_identity'); await runMigrations(isolated.runtime.db, 'latest'); }, 120000);
  afterAll(async () => isolated?.close());
  async function fixture() {
    const seed = await seedCanonicalClassificationFixture(isolated.runtime);
    const actor = { principalId: seed.collectionId, subjectId: seed.ownerSubjectId };
    const report = { captureId: randomUUID(), deviceId: randomUUID(), collectionId: seed.collectionId, nodeId: null,
      revision: 1, startedAt: '2026-09-20T00:00:00.000Z', title: 'First', url: 'https://example.test/one', localPath: ['Root'],
      source: 'action-popup' as const, disposition: 'new' as const, save: 'local-saved' as const,
      automaticIntent: false, sync: 'confirmed' as const, reason: null };
    return { seed, actor, report };
  }
  test('concurrent first reports serialize before inspecting immutable identity', async () => {
    const { actor, report } = await fixture();
    let entered!: () => void, release!: () => void;
    const enteredGate = new Promise<void>(resolve => { entered = resolve; });
    const releaseGate = new Promise<void>(resolve => { release = resolve; });
    const watched = new Set<object>();
    let first = true;
    const db = isolated.runtime.db.withPlugin({
      transformQuery(args) {
        if (JSON.stringify(args.node).includes('pg_advisory_xact_lock')) watched.add(args.queryId);
        return args.node;
      },
      async transformResult(args) {
        if (watched.delete(args.queryId) && first) { first = false; entered(); await releaseGate; }
        return args.result;
      },
    });
    const history = createCaptureHistory(db);
    const original = history.report(actor, randomUUID(), report);
    await enteredGate;
    const conflict = history.report(actor, randomUUID(), { ...report, revision: 2, startedAt: '2026-09-20T01:00:00.000Z' })
      .then(value => ({ value, error: undefined }), (error: { code?: string }) => ({ value: undefined, error }));
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const result = await isolated.runtime.pool.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted");
        if (result.rows.length) { waiting = true; break; }
        await delay(10);
      }
      assert.equal(waiting, true, 'second identity must wait before a nonexistent-row lookup');
    } finally { release(); }
    assert.equal((await original).revision, 1);
    assert.equal((await conflict).error?.code, 'command_id_reused');
    const stored = await isolated.runtime.db.selectFrom('bookmark_capture_tasks').selectAll()
      .where('account_id', '=', actor.principalId).where('capture_id', '=', report.captureId).executeTakeFirstOrThrow();
    // CAP-01 residual: identity lives in the columns only. report_json keeps
    // mutable progress, so there is no second copy that can disagree.
    for (const field of ['captureId', 'deviceId', 'collectionId', 'revision', 'startedAt']) {
      assert.equal(Object.hasOwn(stored.report_json as object, field), false,
        `report_json must not persist the identity field ${field}`);
    }
    assert.equal(stored.report_json.title, report.title);
    assert.equal(stored.started_at.toISOString(), new Date(report.startedAt).toISOString());
    assert.equal(stored.device_id, report.deviceId);
    assert.equal(stored.revision, 1);
    assert.equal((await isolated.runtime.db.selectFrom('product_command_receipts').select('command_id')
      .where('principal_id', '=', actor.principalId).where('command_scope', '=', 'capture:report:v1').execute()).length, 1);
  });
  test('concurrent progress stays monotonic and command replay preserves its accepted result', async () => {
    const { actor, report } = await fixture();
    const history = createCaptureHistory(isolated.runtime.db), command = randomUUID();
    const initial = await history.report(actor, command, report);
    await Promise.all([2, 4, 3].map(revision => history.report(actor, randomUUID(), { ...report, revision })));
    assert.equal((await history.report(actor, randomUUID(), report)).revision, 4);
    assert.deepEqual(await history.report(actor, command, report), initial);
    const result = await history.history(actor, { from: Date.parse(report.startedAt) - 1, to: Date.parse(report.startedAt) + 1, timezone: 'UTC' });
    assert.equal(result.items[0]?.report.revision, 4);
  });
  test('reads, filters, ordering and cursors use the column identity, never report_json', async () => {
    // A legacy row whose report_json disagrees with its columns in every
    // identity field. The read path, the filters, the ordering and the next
    // cursor must all follow the columns; a divergence must never surface.
    const { seed, actor, report } = await fixture();
    const db = isolated.runtime.db;
    const base = Date.parse('2026-09-01T00:00:00.000Z');
    const stored = Array.from({ length: 51 }, (_, index) => ({
      capture_id: randomUUID(), collection_id: seed.collectionId,
      device_id: index === 0 ? 'device-column-authority' : 'device-other',
      revision: 1, started_at: new Date(base + index * 1000),
    }));
    const progress = (index: number) => ({ nodeId: null, title: `Title ${index}`,
      url: `https://example.test/capture/${index}`, localPath: [] as readonly string[],
      source: 'action-popup' as const, disposition: 'new' as const, save: 'local-saved' as const,
      automaticIntent: false, sync: 'confirmed' as const, reason: null });
    await db.insertInto('bookmark_capture_tasks').values(stored.map((row, index) => ({
      account_id: actor.principalId, ...row, received_at: new Date(), report_json: progress(index),
    }))).execute();

    const divergent = stored[0]!;
    const divergentIdentity = { captureId: '00000000-0000-0000-0000-0000000000ff',
      deviceId: 'device-report-json', collectionId: 'collection-report-json', revision: 999,
      startedAt: '2000-01-01T00:00:00.000Z' };
    await sql`UPDATE bookmark_capture_tasks SET report_json = report_json || ${JSON.stringify(divergentIdentity)}::jsonb
      WHERE account_id = ${actor.principalId} AND capture_id = ${divergent.capture_id}`.execute(db);
    const persisted = await sql<{ report_capture_id: string }>`SELECT report_json->>'captureId' AS report_capture_id
      FROM bookmark_capture_tasks WHERE account_id = ${actor.principalId} AND capture_id = ${divergent.capture_id}`.execute(db);
    assert.equal(persisted.rows[0]?.report_capture_id, divergentIdentity.captureId,
      'the test must actually persist a divergent identity inside report_json');

    const history = createCaptureHistory(db);
    const query = { from: base - 1000, to: base + 60_000, timezone: 'UTC' } as const;
    const ordered = [...stored].sort((a, b) => b.started_at.getTime() - a.started_at.getTime()
      || b.capture_id.localeCompare(a.capture_id));

    // Ordering: descending (started_at, capture_id) from the columns.
    const page = await history.history(actor, query);
    assert.equal(page.items.length, 50);
    assert.deepEqual(page.items.map(item => item.report.captureId),
      ordered.slice(0, 50).map(row => row.capture_id));
    // Cursor: the column identity of the 50th item, not its divergent JSON.
    assert.deepEqual(page.next, [ordered[49]!.started_at.toISOString(), ordered[49]!.capture_id]);

    // Replaying the cursor returns the remaining row with column identity.
    const second = await history.history(actor, { ...query, before: page.next! });
    assert.equal(second.items.length, 1);
    const replayed = second.items[0]!;
    assert.equal(replayed.report.captureId, divergent.capture_id);
    assert.equal(replayed.report.deviceId, divergent.device_id);
    assert.equal(replayed.report.collectionId, divergent.collection_id);
    assert.equal(replayed.report.revision, 1);
    assert.equal(replayed.report.startedAt, divergent.started_at.toISOString());
    assert.equal(replayed.report.title, 'Title 0');

    // Filters: every identity filter reads the columns; the JSON copies match
    // nothing.
    assert.equal((await history.history(actor, { ...query, captureId: divergent.capture_id })).items.length, 1);
    assert.equal((await history.history(actor, { ...query, captureId: divergentIdentity.captureId })).items.length, 0);
    assert.equal((await history.history(actor, { ...query, deviceId: divergent.device_id })).items.length, 1);
    assert.equal((await history.history(actor, { ...query, deviceId: divergentIdentity.deviceId })).items.length, 0);
    assert.ok((await history.history(actor, { ...query, collectionId: divergent.collection_id })).items.length > 0);
    assert.equal((await history.history(actor, { ...query, collectionId: divergentIdentity.collectionId })).items.length, 0);

    // A changed deviceId for the same capture is a conflicting identity, not
    // progress: it must be rejected instead of silently coerced to the stored
    // column value (the write path must not create a second authority either).
    const conflicting = { ...report, captureId: randomUUID(), revision: 2 };
    await history.report(actor, randomUUID(), conflicting);
    const rejection = await history.report(actor, randomUUID(), { ...conflicting, revision: 3, deviceId: randomUUID() })
      .then(() => undefined, (error: { code?: string }) => error);
    assert.equal(rejection?.code, 'command_id_reused');
    const storedRow = await db.selectFrom('bookmark_capture_tasks').select(['device_id', 'revision', 'report_json'])
      .where('account_id', '=', actor.principalId).where('capture_id', '=', conflicting.captureId).executeTakeFirstOrThrow();
    assert.equal(storedRow.device_id, report.deviceId);
    assert.equal(storedRow.revision, 2);
    for (const field of ['captureId', 'deviceId', 'collectionId', 'revision', 'startedAt']) {
      assert.equal(Object.hasOwn(storedRow.report_json as object, field), false,
        `report_json must not persist the identity field ${field}`);
    }
  });
});
