import assert from 'node:assert/strict';
import { afterAll, beforeAll, describe, test } from 'vitest';
import {
  createPostgresLibraryOrderCommandUnitOfWork,
  createPostgresLibraryOrderQueryUnitOfWork,
} from '../../../src/infrastructure/collections/index.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { queryLibraryOrder, updateLibraryOrder } from '../../../src/modules/collections/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const SUBJECT = 'library-order-subject';
const OTHER_SUBJECT = 'library-order-other';
const COLLECTION_A = 'IiIiIiIiIiIiIiIiIiIiIg';
const COLLECTION_B = 'M2NkNGU1ZjZhN2I4YzlkMG';
const COMMAND_A = '019fa956-0c4e-4190-94df-484c41fd9683';
const COMMAND_B = '02aeb967-1d5f-42a1-a5ef-595d52fe9794';
const COMMAND_C = '13bfca78-2e60-43b2-b6f0-6a6e63ff08a5';

describeWithPostgres('library order PostgreSQL authority', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('library_order', { maxConnections: 4 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 180_000);
  afterAll(async () => isolated?.close());

  test('upserts one row per subject and section, replays receipts, and reads back per subject', async () => {
    const commandUnitOfWork = createPostgresLibraryOrderCommandUnitOfWork(isolated.runtime.db);
    const queryUnitOfWork = createPostgresLibraryOrderQueryUnitOfWork(isolated.runtime.db);

    const first = await commandUnitOfWork.execute((ports) => updateLibraryOrder(ports, {
      actor: { principalId: 'principal-a', subjectId: SUBJECT },
      section: 'mine',
      collectionIds: [COLLECTION_A, COLLECTION_B],
      commandId: COMMAND_A,
    }));
    assert.equal(first.kind, 'succeeded');

    const replay = await commandUnitOfWork.execute((ports) => updateLibraryOrder(ports, {
      actor: { principalId: 'principal-a', subjectId: SUBJECT },
      section: 'mine',
      collectionIds: [COLLECTION_A, COLLECTION_B],
      commandId: COMMAND_A,
    }));
    assert.equal(replay.kind, 'replay');
    if (replay.kind === 'replay') {
      assert.deepEqual(JSON.parse(Buffer.from(replay.body).toString('utf8')), {
        section: 'mine',
        collectionIds: [COLLECTION_A, COLLECTION_B],
      });
    }

    const reordered = await commandUnitOfWork.execute((ports) => updateLibraryOrder(ports, {
      actor: { principalId: 'principal-a', subjectId: SUBJECT },
      section: 'mine',
      collectionIds: [COLLECTION_B, COLLECTION_A],
      commandId: COMMAND_B,
    }));
    assert.equal(reordered.kind, 'succeeded');

    const following = await commandUnitOfWork.execute((ports) => updateLibraryOrder(ports, {
      actor: { principalId: 'principal-a', subjectId: SUBJECT },
      section: 'following',
      collectionIds: [COLLECTION_A],
      commandId: COMMAND_C,
    }));
    assert.equal(following.kind, 'succeeded');

    const rows = await isolated.runtime.pool.query<{ section: string }>(
      'select section from library_sidebar_orders where subject_id=$1 order by section',
      [SUBJECT],
    );
    assert.deepEqual(rows.rows.map((row) => row.section), ['following', 'mine']);

    const view = await queryUnitOfWork.execute((ports) => queryLibraryOrder(ports, { subjectId: SUBJECT }));
    assert.deepEqual(view, {
      sections: {
        mine: [COLLECTION_B, COLLECTION_A],
        shared: [],
        following: [COLLECTION_A],
      },
    });

    const other = await queryUnitOfWork.execute((ports) => queryLibraryOrder(ports, { subjectId: OTHER_SUBJECT }));
    assert.deepEqual(other, { sections: { mine: [], shared: [], following: [] } });
  }, 60_000);

  test('rejects a non-array payload and an unknown section at the table boundary', async () => {
    await assert.rejects(isolated.runtime.pool.query(
      `insert into library_sidebar_orders (subject_id, section, collection_ids)
       values ($1, 'mine', '"not-an-array"'::jsonb)`,
      ['boundary-subject'],
    ), /jsonb_typeof|check constraint/i);
    await assert.rejects(isolated.runtime.pool.query(
      `insert into library_sidebar_orders (subject_id, section, collection_ids)
       values ($1, 'invitations', '[]'::jsonb)`,
      ['boundary-subject'],
    ), /section|check constraint/i);
  }, 60_000);

  // -------------------------------------------------------------------------
  // FO-06 manual-order interaction invariants. The sidebar order stays its
  // own authority: a sidebar write must never create collection/node rows,
  // and a replayed command id with a different order must be refused instead
  // of silently applying the new fingerprint (the UI reuses the same command
  // id only for identical retries of an unknown network outcome).
  // -------------------------------------------------------------------------
  test('sidebar order stays a separate authority from collection node order', async () => {
    const commandUnitOfWork = createPostgresLibraryOrderCommandUnitOfWork(isolated.runtime.db);
    const queryUnitOfWork = createPostgresLibraryOrderQueryUnitOfWork(isolated.runtime.db);

    const result = await commandUnitOfWork.execute((ports) => updateLibraryOrder(ports, {
      actor: { principalId: 'principal-a', subjectId: SUBJECT },
      section: 'mine',
      collectionIds: [COLLECTION_B, COLLECTION_A],
      commandId: '35cbfa17-2e9c-4b81-9c2d-6b797eff31b1',
    }));
    assert.equal(result.kind, 'succeeded');

    // The sidebar write persisted only to its own table: no collection or
    // node rows materialized as a side effect, so reordering the sidebar can
    // never disturb canonical node position_tokens of any collection.
    const counts = await isolated.runtime.pool.query(
      `select
         (select count(*)::integer from collections) as collections,
         (select count(*)::integer from nodes) as nodes`,
    );
    assert.equal(counts.rows[0]?.collections, 0);
    assert.equal(counts.rows[0]?.nodes, 0);

    const view = await queryUnitOfWork.execute((ports) => queryLibraryOrder(ports, { subjectId: SUBJECT }));
    assert.deepEqual(view.sections.mine, [COLLECTION_B, COLLECTION_A]);
  }, 60_000);

  test('same command id with a different order is refused as reused (no blind replay)', async () => {
    const commandUnitOfWork = createPostgresLibraryOrderCommandUnitOfWork(isolated.runtime.db);

    const first = await commandUnitOfWork.execute((ports) => updateLibraryOrder(ports, {
      actor: { principalId: 'principal-a', subjectId: 'reuse-subject' },
      section: 'mine',
      collectionIds: [COLLECTION_A, COLLECTION_B],
      commandId: '45dbfa18-2e9c-4b81-9c2d-6b797eff31b1',
    }));
    assert.equal(first.kind, 'succeeded');

    // A changed fingerprint under the same Known-Command-Id is 409
    // command_id_reused: the safe-replay rule never applies a body that
    // differs from the receipted request.
    const reused = await commandUnitOfWork.execute((ports) => updateLibraryOrder(ports, {
      actor: { principalId: 'principal-a', subjectId: 'reuse-subject' },
      section: 'mine',
      collectionIds: [COLLECTION_B, COLLECTION_A],
      commandId: COMMAND_A,
    }));
    assert.equal(reused.kind, 'reused');

    const queryUnitOfWork = createPostgresLibraryOrderQueryUnitOfWork(isolated.runtime.db);
    const view = await queryUnitOfWork.execute((ports) => queryLibraryOrder(ports, { subjectId: 'reuse-subject' }));
    // The receipted order is untouched by the rejected replay.
    assert.deepEqual(view.sections.mine, [COLLECTION_A, COLLECTION_B]);
  }, 60_000);
});
