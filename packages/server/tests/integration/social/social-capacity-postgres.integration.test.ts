import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  runPhase5SocialCapacityEvidence,
  socialCapacityFanoutPlanPass,
  socialCapacityFeedPlanPass,
  SOCIAL_CAPACITY_FANOUT_FOLLOWS,
  SOCIAL_CAPACITY_FANOUT_SCANNED_FOLLOW_ROWS_MAX,
  SOCIAL_CAPACITY_FANOUT_SHARED_BUFFER_BLOCKS_MAX,
  SOCIAL_CAPACITY_FANOUT_SORTED_ROWS_MAX,
  SOCIAL_CAPACITY_FEED_ITEMS,
  SOCIAL_CAPACITY_FEED_PRIVATE_DELETED_ITEMS,
  SOCIAL_CAPACITY_FEED_UNFOLLOW_ITEMS,
  SOCIAL_CAPACITY_FEED_VALID_ITEMS,
  SOCIAL_CAPACITY_FEED_SCANNED_ROWS_MAX,
  SOCIAL_CAPACITY_FEED_SHARED_BUFFER_BLOCKS_MAX,
  SOCIAL_CAPACITY_MEASURED_ITERATIONS,
  SOCIAL_CAPACITY_WARMUP_ITERATIONS,
  type Phase5SocialCapacityEvidence,
} from '../../../scripts/evidence/phase5-social-capacity.js';
import {
  buildFanoutRecipientPageStatement,
} from '../../../src/infrastructure/social/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const schemaPath = resolve(
  import.meta.dirname,
  '../../fixtures/phase5/remediation/r5-08-social-capacity.schema.json',
);

describeWithPostgres('R5-08 sparse Feed and fan-out capacity evidence', () => {
  let isolated: IsolatedPostgresRuntime;
  let evidence: Phase5SocialCapacityEvidence;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase5_social_capacity', {
      maxConnections: 8,
      statementTimeoutMs: 600_000,
      applicationName: 'known-phase5-social-capacity',
    });
    await runMigrations(isolated.runtime.db, 'latest');
    evidence = await runPhase5SocialCapacityEvidence(isolated.runtime);
    console.info(JSON.stringify({
      format: evidence.format,
      task: evidence.task,
      seed: evidence.seed,
      pass: evidence.pass,
      fanoutP95Ms: evidence.fanout.latency.p95Ms,
      feedP95Ms: evidence.feed.latency.p95Ms,
      fanoutPlans: evidence.fanout.plans.map(summarizePlan),
      feedPlans: evidence.feed.plans.map(summarizePlan),
    }, null, 2));
  }, 1_200_000);

  afterAll(async () => {
    await isolated?.close();
  });

  test('artifact validates against the closed R5-08 schema', () => {
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as object;
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
    assert.equal(validate(evidence), true, JSON.stringify(validate.errors));
    assert.equal(evidence.format, 'known.phase5.remediation.r5-08.v1');
    assert.equal(evidence.task, 'R5-08');
  });

  test('seeds fixed 100k fan-out and sparse Feed corpora with late/inactive follows', () => {
    assert.ok(evidence.seed.fanoutFollows >= SOCIAL_CAPACITY_FANOUT_FOLLOWS);
    assert.ok(evidence.seed.fanoutEligibleBeforeEvent >= 500);
    assert.ok(evidence.seed.fanoutLateFollows >= 1);
    assert.ok(evidence.seed.fanoutInactiveFollows >= 1);
    assert.equal(evidence.seed.feedItems, SOCIAL_CAPACITY_FEED_ITEMS);
    assert.equal(evidence.seed.feedUnfollowItems, SOCIAL_CAPACITY_FEED_UNFOLLOW_ITEMS);
    assert.equal(evidence.seed.feedPrivateDeletedItems, SOCIAL_CAPACITY_FEED_PRIVATE_DELETED_ITEMS);
    assert.equal(evidence.seed.feedValidItems, SOCIAL_CAPACITY_FEED_VALID_ITEMS);
    assert.equal(evidence.pass.seed, true);
  });

  test('fan-out first/middle/final/empty plans use fan-out index without Sort or Follows Seq Scan', () => {
    assert.equal(evidence.method.warmupIterations, SOCIAL_CAPACITY_WARMUP_ITERATIONS);
    assert.equal(evidence.method.measuredIterations, SOCIAL_CAPACITY_MEASURED_ITERATIONS);
    assert.equal(evidence.method.jit, 'off');
    assert.equal(evidence.method.analyze, true);
    assert.equal(evidence.fanout.latency.samplesMs.length, SOCIAL_CAPACITY_MEASURED_ITERATIONS);
    assert.ok(Number.isFinite(evidence.fanout.latency.p95Ms));
    assert.ok(evidence.fanout.latency.p95Ms > 0);

    for (const plan of evidence.fanout.plans) {
      assert.ok(
        plan.indexNames.includes('follows_target_actor_fanout_idx'),
        `${plan.label}: ${plan.indexNames.join(',')}`,
      );
      // Union recipients: a bounded top-N sort over the two per-arm keyset
      // pages is expected; a corpus-wide sort must stay rejected.
      assert.ok(plan.sortedRowsMax <= SOCIAL_CAPACITY_FANOUT_SORTED_ROWS_MAX, plan.label);
      assert.equal(plan.hasFollowsSequentialScan, false, plan.label);
      assert.equal(plan.hasFeedSequentialScan, false, plan.label);
      assert.deepEqual(plan.actualResultIds, plan.expectedResultIds, plan.label);
      assert.ok(plan.scannedFollowRows >= plan.resultRows, plan.label);
      assert.ok(
        plan.scannedFollowRows <= SOCIAL_CAPACITY_FANOUT_SCANNED_FOLLOW_ROWS_MAX,
        plan.label,
      );
      assert.ok(
        plan.sharedBufferBlocks <= SOCIAL_CAPACITY_FANOUT_SHARED_BUFFER_BLOCKS_MAX,
        plan.label,
      );
    }
    assert.equal(evidence.pass.fanoutPlans, true);
  });

  test('sparse Feed first/middle/final/kind/empty plans use recipient indexes and full result sets', () => {
    assert.equal(evidence.feed.latency.samplesMs.length, SOCIAL_CAPACITY_MEASURED_ITERATIONS);
    assert.ok(Number.isFinite(evidence.feed.latency.p95Ms));
    assert.ok(evidence.feed.latency.p95Ms > 0);

    for (const plan of evidence.feed.plans) {
      assert.ok(
        plan.indexNames.includes('social_feed_items_recipient_page_idx')
        || plan.indexNames.includes('social_feed_items_recipient_kind_page_idx'),
        `${plan.label}: ${plan.indexNames.join(',')}`,
      );
      assert.equal(plan.hasSort, false, plan.label);
      assert.equal(plan.hasFeedSequentialScan, false, plan.label);
      assert.equal(plan.hasFollowsSequentialScan, false, plan.label);
      assert.deepEqual(plan.actualResultIds, plan.expectedResultIds, plan.label);
      assert.ok(plan.scannedFeedRows <= SOCIAL_CAPACITY_FEED_SCANNED_ROWS_MAX, plan.label);
      assert.ok(
        plan.sharedBufferBlocks <= SOCIAL_CAPACITY_FEED_SHARED_BUFFER_BLOCKS_MAX,
        plan.label,
      );
    }

    const first = evidence.feed.plans.find((plan) => plan.label === 'feed-first');
    assert.ok(first);
    assert.equal(first.resultRows, 100);
    assert.ok(
      first.actualResultIds.every((id) => id.startsWith('valid-')),
      'sparse recheck must return only currently authorized rows',
    );
    // Interleaved 5% density must scan more Feed candidates than it returns.
    assert.ok(
      first.scannedFeedRows > first.resultRows,
      `sparse first page must scan past stale rows: scanned=${first.scannedFeedRows}`,
    );
    assert.ok(
      first.scannedFeedRows < SOCIAL_CAPACITY_FEED_ITEMS,
      'sparse first page must not sequentially read the whole Feed corpus',
    );

    const empty = evidence.feed.plans.find((plan) => plan.label === 'feed-empty');
    assert.ok(empty);
    assert.equal(empty.resultRows, 0);
    assert.deepEqual(empty.actualResultIds, []);

    assert.equal(evidence.pass.feedPlans, true);
    assert.equal(evidence.pass.resultSets, true);
  });

  test('withdrawal removes visible projection rows and keeps post-withdrawal plan healthy', () => {
    assert.ok(evidence.withdrawal.beforeVisibleCount >= 1);
    assert.ok(evidence.withdrawal.withdrawnCount >= 1);
    assert.ok(evidence.withdrawal.afterVisibleCount < evidence.withdrawal.beforeVisibleCount);
    assert.ok(evidence.withdrawal.beforeQueryIds.length > 0);
    assert.deepEqual(evidence.withdrawal.afterQueryIds, []);
    assert.equal(evidence.withdrawal.afterPlan.hasFeedSequentialScan, false);
    assert.equal(evidence.withdrawal.afterPlan.hasSort, false);
    assert.deepEqual(
      evidence.withdrawal.afterPlan.actualResultIds,
      evidence.withdrawal.afterPlan.expectedResultIds,
    );
    assert.equal(evidence.pass.withdrawal, true);
  });

  test('corner cases cover page-tail valid rows, all-stale, single valid, boundary withdrawal, ANALYZE', () => {
    const { corners } = evidence;
    assert.ok(corners.validAtPageTail.resultIds.every((id) => id.startsWith('corner-valid-')));
    assert.ok(corners.validAtPageTail.plan.scannedFeedRows > corners.validAtPageTail.resultIds.length);
    assert.deepEqual(corners.allStale.resultIds, []);
    assert.ok(corners.allStale.plan.scannedFeedRows >= 1);
    assert.deepEqual(corners.singleValid.resultIds, ['single-valid']);
    assert.deepEqual(corners.cursorBoundaryWithdrawal.resultIds, ['boundary-after']);
    assert.equal(corners.analyzeBefore.label, 'fanout-analyze-before');
    assert.equal(corners.analyzeAfter.label, 'fanout-analyze-after');
    // Pre-ANALYZE plan is recorded; post-ANALYZE plan must be the stable indexed shape.
    assert.ok(corners.analyzeAfter.indexNames.includes('follows_target_actor_fanout_idx'));
    assert.ok(corners.analyzeAfter.sortedRowsMax <= SOCIAL_CAPACITY_FANOUT_SORTED_ROWS_MAX);
    assert.equal(corners.analyzeAfter.hasFollowsSequentialScan, false);
    assert.deepEqual(
      corners.analyzeAfter.actualResultIds,
      corners.analyzeAfter.expectedResultIds,
    );
    assert.equal(evidence.pass.corners, true);
    assert.equal(evidence.pass.overall, true);
  });

  test('scan and buffer budgets fail closed one unit beyond their fixed limits', () => {
    const fanout = evidence.fanout.plans.find((plan) => plan.label === 'fanout-first');
    const feed = evidence.feed.plans.find((plan) => plan.label === 'feed-first');
    assert.ok(fanout);
    assert.ok(feed);
    assert.equal(socialCapacityFanoutPlanPass({
      ...fanout,
      scannedFollowRows: SOCIAL_CAPACITY_FANOUT_SCANNED_FOLLOW_ROWS_MAX + 1,
    }), false);
    assert.equal(socialCapacityFanoutPlanPass({
      ...fanout,
      sharedBufferBlocks: SOCIAL_CAPACITY_FANOUT_SHARED_BUFFER_BLOCKS_MAX + 1,
    }), false);
    assert.equal(socialCapacityFeedPlanPass({
      ...feed,
      scannedFeedRows: SOCIAL_CAPACITY_FEED_SCANNED_ROWS_MAX + 1,
    }), false);
    assert.equal(socialCapacityFeedPlanPass({
      ...feed,
      sharedBufferBlocks: SOCIAL_CAPACITY_FEED_SHARED_BUFFER_BLOCKS_MAX + 1,
    }), false);
  });

  test('negative control: dropping the fan-out index forces a real fallback rejected by the plan gate', async () => {
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query('drop index follows_target_actor_fanout_idx');
      const statement = buildFanoutRecipientPageStatement({
        ownerProfileId: 'cap-fanout-actor',
        collectionId: 'cap-feed-valid-collection',
        occurredAt: new Date('2026-06-15T12:00:00.000Z'),
        afterRecipientProfileId: null,
        limit: 500,
      });
      const explained = await client.query<{ 'QUERY PLAN': unknown }>(
        `explain (analyze, buffers, format json) ${statement.text}`,
        [...statement.values],
      );
      const serialized = JSON.stringify(explained.rows[0]?.['QUERY PLAN']);
      assert.notEqual(serialized, undefined);
      assert.equal(serialized.includes('follows_target_actor_fanout_idx'), false);
      assert.match(serialized, /"Node Type":/u, 'PostgreSQL must execute and expose a fallback plan');

      const passing = evidence.fanout.plans.find((plan) => plan.label === 'fanout-first');
      assert.ok(passing);
      assert.equal(socialCapacityFanoutPlanPass({
        ...passing,
        indexNames: passing.indexNames.filter(
          (name) => name !== 'follows_target_actor_fanout_idx',
        ),
      }), false);
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
  });
});

function summarizePlan(plan: Phase5SocialCapacityEvidence['fanout']['plans'][number]) {
  return {
    label: plan.label,
    indexes: plan.indexNames,
    resultRows: plan.resultRows,
    scannedFeedRows: plan.scannedFeedRows,
    scannedFollowRows: plan.scannedFollowRows,
    rowsRemovedByFilter: plan.rowsRemovedByFilter,
    sharedBufferBlocks: plan.sharedBufferBlocks,
    executionMs: plan.executionMs,
    hasSort: plan.hasSort,
    hasFeedSequentialScan: plan.hasFeedSequentialScan,
    hasFollowsSequentialScan: plan.hasFollowsSequentialScan,
  };
}
