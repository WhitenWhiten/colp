import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  runPostgresSearchBranchEvidence,
  type PostgresSearchBranchEvidence,
} from '../../../scripts/evidence/search-postgres-baseline.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

describeWithPostgres('P2B-22 target-scale Profile and Annotation branch evidence', () => {
  let isolated: IsolatedPostgresRuntime;
  let evidence: PostgresSearchBranchEvidence;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('search_profile_annotation_plan', {
      maxConnections: 1,
      applicationName: 'known-search-profile-annotation-evidence',
    });
    await runMigrations(isolated.runtime.db, 'latest');
    evidence = await runPostgresSearchBranchEvidence(isolated.runtime);
    console.info(JSON.stringify(evidence, null, 2));
  // Bulk-loads 200k+ target-scale rows before measuring independently capped
  // 500ms plans. This hook budget covers fixture construction on slower CI
  // filesystems; it does not relax any query-performance threshold.
  }, 600_000);

  afterAll(async () => isolated?.close());

  test('records target scale, fixed thresholds, and all branch/position combinations', () => {
    assert.ok(evidence.environment.rowsPerBranch >= 10_000);
    assert.equal(evidence.method.parallelWorkers, 0);
    assert.deepEqual([...new Set(evidence.plans.map((plan) => plan.branch))].sort(), [
      'annotation', 'collection', 'node', 'profile',
    ]);
    for (const branch of ['annotation', 'collection', 'node', 'profile'] as const) {
      assert.deepEqual(evidence.plans.filter((plan) => plan.branch === branch).map((plan) => plan.location), [
        'first', 'middle', 'final',
      ]);
    }
  });

  test('uses a branch search index without branch-table sequential scans or over-budget sorts', () => {
    for (const plan of evidence.plans) {
      assert.ok(plan.indexNames.some((name) => name.includes('search')), `${plan.branch}/${plan.location}`);
      assert.equal(plan.hasBranchSequentialScan, false, `${plan.branch}/${plan.location}`);
      assert.equal(plan.hasSortAboveBudget, false, `${plan.branch}/${plan.location}`);
      assert.ok(plan.executionMs <= evidence.thresholds.planExecutionMs, `${plan.branch}/${plan.location}`);
    }
    assert.deepEqual(evidence.indexProbes.map((probe) => probe.probe), [
      'profile-handle-exact', 'profile-handle-prefix', 'profile-handle-trigram',
      'annotation-subject-authority',
    ]);
    const required = new Map([
      ['profile-handle-exact', 'profile_handles_search_exact_prefix_idx'],
      ['profile-handle-prefix', 'profile_handles_search_exact_prefix_idx'],
      ['profile-handle-trigram', 'profile_handles_search_trgm_idx'],
      ['annotation-subject-authority', 'annotations_search_authority_order_idx'],
    ]);
    for (const probe of evidence.indexProbes) {
      assert.ok(probe.indexNames.includes(required.get(probe.probe)!), probe.probe);
      assert.equal(probe.hasTargetSequentialScan, false, probe.probe);
      assert.ok(probe.executionMs <= evidence.thresholds.planExecutionMs, probe.probe);
    }
    assert.equal(evidence.pass.plans, true);
    assert.equal(evidence.pass.latency, true);
    assert.equal(evidence.pass.overall, true);
  });
});
