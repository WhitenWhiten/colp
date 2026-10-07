import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createPostgresSharedExposureFactsPort } from '../../../src/infrastructure/database/postgres-shared-exposure-facts.js';
import { assessSharedExposureScope } from '../../../src/modules/attachments/shared-exposure-facts-port.js';
import { createIsolatedPostgresRuntime, describeWithPostgres,
  type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';
import { waitForCondition } from '../../support/async-test-helpers.js';

describeWithPostgres('shared exposure reads only bounded output candidates', () => {
  let isolated: IsolatedPostgresRuntime;
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('exposure_candidates', { maxConnections: 4 });
    // Minimal SQL fixture for the real production query; no full migration suite.
    await isolated.runtime.pool.query(`
      create table blob_records(blob_id text primary key, logical_state text, current_generation_id text);
      create table blob_generations(generation_id text primary key, generation_state text);
      create table upload_intents(blob_id text, collection_id text);
      create index exposure_fixture_intent_blob on upload_intents(blob_id,collection_id);
      insert into blob_records select 'blob-' || n, 'expired', null from generate_series(1,5001) n;
      insert into upload_intents select 'blob-' || n,
        case when n=5001 then 'foreign' else 'collection' end from generate_series(1,5001) n;
    `);
  });
  afterAll(async () => isolated?.close());

  test('large collection history does not expand the selected blob IDs or cross collections', async () => {
    const port = createPostgresSharedExposureFactsPort(isolated.runtime);
    const verdicts = await assessSharedExposureScope(port, {
      collectionId: 'collection', blobIds: ['blob-1', 'blob-5001'],
    });
    assert.deepEqual(verdicts.map((entry) => entry.blobId), ['blob-1']);
    assert.ok(verdicts.every((entry) => entry.eligible === false));
  });

  test('empty output candidates do no query even while the attachment table is locked', async () => {
    const blocker = await isolated.runtime.pool.connect();
    await blocker.query('begin');
    await blocker.query('lock table blob_records in access exclusive mode');
    try {
      const port = createPostgresSharedExposureFactsPort(isolated.runtime);
      assert.deepEqual(await port.listBlobFacts({ collectionId: 'collection', blobIds: [] },
        { signal: AbortSignal.timeout(100) }), []);
    } finally {
      await blocker.query('rollback');
      blocker.release();
    }
  });

  test('the request deadline cancels a blocked facts query and frees its connection', async () => {
    const blocker = await isolated.runtime.pool.connect();
    await blocker.query('begin');
    await blocker.query('lock table blob_records in access exclusive mode');
    const port = createPostgresSharedExposureFactsPort(isolated.runtime);
    const signal = AbortSignal.timeout(50);
    const started = Date.now();
    try {
      await assert.rejects(assessSharedExposureScope(port, {
        collectionId: 'collection', blobIds: ['blob-1'],
      }, { signal }));
      assert.equal(signal.aborted, true);
      assert.ok(Date.now() - started < 2000, 'the query must honor the caller deadline');
      await waitForCondition(async () => {
        const activity = await blocker.query<{ count: string }>(`
          select count(*)::text as count from pg_stat_activity
          where application_name='known-test-exposure_candidates'
            and state='active' and wait_event_type='Lock'
            and query like '%from blob_records b%'
        `);
        return activity.rows[0]?.count === '0';
      }, { timeoutMs: 1000, description: 'the cancelled query to stop before the lock is released' });
    } finally {
      await blocker.query('rollback');
      blocker.release();
    }
    assert.equal((await port.listBlobFacts({ collectionId: 'collection', blobIds: ['blob-1'] })).length, 1);
  });
});
