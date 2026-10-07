import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createPostgresEmailDeliveryWorkerRepository,
  createPostgresEmailSuppressionOpsRepository,
} from '../../../src/infrastructure/notifications/index.js';
import { reconcileEmailCallback } from '../../../src/modules/notifications/index.js';
import { createIsolatedPostgresRuntime, describeWithPostgres,
  type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';
import { seedProfileAndCollection } from '../../support/social-feed-fixture.js';

describeWithPostgres('P5-31 suppression ops surface through the production repository', () => {
  const RECIPIENT_A = 'EREREREREREREREREREREQ';
  const RECIPIENT_B = 'ERERERERERERERERERERFQ';
  const ACTOR = 'IiIiIiIiIiIiIiIiIiIiIg';
  const ACTOR_B = 'IiIiIiIiIiIiIiIiIiIiIw';
  const COLLECTION = 'FBQUFBQUFBQUFBQUFBQUFA';
  const COLLECTION_B = 'FBQUFBQUFBQUFBQUFBQUFB';
  let isolated!: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase5_email_suppression_ops',
      { maxConnections: 8 });
    await runMigrations(isolated.runtime.db, 'latest');
    await seedProfileAndCollection(isolated, RECIPIENT_A, ACTOR, COLLECTION);
    await seedProfileAndCollection(isolated, RECIPIENT_B, ACTOR_B, COLLECTION_B);
    await isolated.runtime.pool.query(
      `update accounts set email='p531-a@example.invalid' where id=$1`, [RECIPIENT_A]);
    await isolated.runtime.pool.query(
      `update accounts set email='p531-b@example.invalid' where id=$1`, [RECIPIENT_B]);
  }, 120_000);

  afterAll(async () => { await isolated?.close(); });

  test('inspection counts a large fixture using one aggregate result', async () => {
    const pool = isolated.runtime.pool;
    await pool.query(`insert into accounts(id,subject_id,status)
      select 'suppression-count-' || n, 'suppression-count-subject-' || n, 'active' from generate_series(1,10000) n`);
    await pool.query(`insert into notification_email_suppressions(recipient_account_id,source,occurred_at)
      select 'suppression-count-' || n, 'bounce', current_timestamp from generate_series(1,10000) n`);
    const ops = createPostgresEmailSuppressionOpsRepository(pool);
    assert.equal(await ops.countSuppressionFacts(), 10000);
    await pool.query("delete from notification_email_suppressions where recipient_account_id like 'suppression-count-%'");
    assert.equal(await ops.countSuppressionFacts(), 0);
  });

  test('ops view lists durable suppression facts scrubbed to account ids and clear resubscribes', async () => {
    const repository = createPostgresEmailDeliveryWorkerRepository(isolated.runtime.pool);
    await reconcileEmailCallback({
      fact: { kind: 'bounced', recipient: 'p531-a@example.invalid', occurredAt: '2026-08-02T00:00:00.000Z' },
      repository,
      tagPrefix: 'p531-',
    });
    await reconcileEmailCallback({
      fact: { kind: 'unsubscribed', recipient: 'p531-b@example.invalid', occurredAt: '2026-08-02T00:00:00.000Z' },
      repository,
      tagPrefix: 'p531-',
    });
    const ops = createPostgresEmailSuppressionOpsRepository(isolated.runtime.pool);
    const views = await ops.listSuppressionFacts();
    assert.equal(views.length, 2);
    for (const view of views) {
      assert.equal(Object.hasOwn(view, 'recipientAccountId'), true);
      assert.equal(Object.hasOwn(view, 'email'), false);
      assert.doesNotMatch(JSON.stringify(view), /@/u);
      assert.doesNotMatch(JSON.stringify(view), /example\.invalid/u);
    }
    const byRecipient = new Map(views.map((view) => [view.recipientAccountId, view.source]));
    assert.equal(byRecipient.get(RECIPIENT_A), 'bounce');
    assert.equal(byRecipient.get(RECIPIENT_B), 'unsubscribe');

    const cleared = await ops.clearSuppressionFact(RECIPIENT_A);
    assert.equal(cleared, true);
    const after = await ops.listSuppressionFacts();
    assert.equal(after.length, 1);
    assert.equal(after[0]!.recipientAccountId, RECIPIENT_B);
    const clearedAgain = await ops.clearSuppressionFact(RECIPIENT_A);
    assert.equal(clearedAgain, false, 'clearing an absent fact reports not-cleared');
  });

  test('FIX-L-062: an older suppression fact never overwrites a newer fact (monotonic upsert)', async () => {
    const repository = createPostgresEmailDeliveryWorkerRepository(isolated.runtime.pool);
    const newer = new Date('2026-08-02T12:00:00.000Z');
    const older = new Date('2026-08-01T12:00:00.000Z');
    try {
      // New fact first, then the late-arriving OLD fact: the old fact must not
      // roll back the audit fact (source AND occurred_at stay the newer one).
      await repository.recordSuppressionFact(RECIPIENT_A, 'unsubscribe', newer);
      await repository.recordSuppressionFact(RECIPIENT_A, 'bounce', older);
      const row = (await isolated.runtime.pool.query<{ source: string; occurred_at: Date }>(
        `select source, occurred_at from notification_email_suppressions
         where recipient_account_id=$1`, [RECIPIENT_A])).rows[0];
      assert.equal(row?.source, 'unsubscribe',
        'a late-arriving older bounce must not overwrite the newer unsubscribe fact');
      assert.equal(row?.occurred_at.getTime(), newer.getTime(),
        'the stored occurred_at must stay the newer fact time');
      assert.equal((await repository.readSuppressionFacts(RECIPIENT_A)).suppression, 'unsubscribe',
        'the surviving newer fact still blocks sending (safety semantic preserved)');

      // Reverse order (older first, newer second) converges to the same fact.
      await repository.recordSuppressionFact(RECIPIENT_B, 'bounce', older);
      await repository.recordSuppressionFact(RECIPIENT_B, 'unsubscribe', newer);
      const rowB = (await isolated.runtime.pool.query<{ source: string; occurred_at: Date }>(
        `select source, occurred_at from notification_email_suppressions
         where recipient_account_id=$1`, [RECIPIENT_B])).rows[0];
      assert.equal(rowB?.source, 'unsubscribe', 'the newer fact must win in either arrival order');
      assert.equal(rowB?.occurred_at.getTime(), newer.getTime());
    } finally {
      await isolated.runtime.pool.query(`delete from notification_email_suppressions
        where recipient_account_id in ($1,$2)`, [RECIPIENT_A, RECIPIENT_B]);
    }
  });

  test('FIX-L-062: equal-time suppression facts converge by deterministic source precedence', async () => {
    const repository = createPostgresEmailDeliveryWorkerRepository(isolated.runtime.pool);
    const tie = new Date('2026-08-02T12:00:00.000Z');
    try {
      // Same instant, different sources: a deterministic source priority must
      // pick the same winner in BOTH arrival orders (complaint > unsubscribe >
      // bounce), so concurrent callbacks cannot flip the audit fact.
      await repository.recordSuppressionFact(RECIPIENT_A, 'bounce', tie);
      await repository.recordSuppressionFact(RECIPIENT_A, 'complaint', tie);
      await repository.recordSuppressionFact(RECIPIENT_B, 'complaint', tie);
      await repository.recordSuppressionFact(RECIPIENT_B, 'bounce', tie);
      const rowA = (await isolated.runtime.pool.query<{ source: string }>(
        `select source from notification_email_suppressions where recipient_account_id=$1`,
        [RECIPIENT_A])).rows[0];
      const rowB = (await isolated.runtime.pool.query<{ source: string }>(
        `select source from notification_email_suppressions where recipient_account_id=$1`,
        [RECIPIENT_B])).rows[0];
      assert.equal(rowA?.source, 'complaint',
        'bounce then complaint must converge to complaint (tie source priority)');
      assert.equal(rowB?.source, 'complaint',
        'complaint then bounce must ALSO converge to complaint (arrival-order independent)');
    } finally {
      await isolated.runtime.pool.query(`delete from notification_email_suppressions
        where recipient_account_id in ($1,$2)`, [RECIPIENT_A, RECIPIENT_B]);
    }
  });
});
