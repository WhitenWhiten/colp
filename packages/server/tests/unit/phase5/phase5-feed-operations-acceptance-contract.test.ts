import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  FEED_OPERATIONS_ACCEPTANCE_BINDING_MODE,
  FEED_OPERATIONS_ACCEPTANCE_BINDINGS_MODULE,
  FEED_OPERATIONS_ACCEPTANCE_BUNDLE_RELATIVE_PATH,
  FEED_OPERATIONS_ACCEPTANCE_EXPECTED_COMMIT_ENV,
  FEED_OPERATIONS_ACCEPTANCE_FAIL_CLOSED,
  FEED_OPERATIONS_ACCEPTANCE_FAIL_CLOSED_PREFIX,
  FEED_OPERATIONS_ACCEPTANCE_FANOUT_MIGRATION,
  FEED_OPERATIONS_ACCEPTANCE_FEED_MIGRATION,
  FEED_OPERATIONS_ACCEPTANCE_FORBIDDEN_RUNNER_PATTERNS,
  FEED_OPERATIONS_ACCEPTANCE_GATE_FAILURE_TAIL_CHARS,
  FEED_OPERATIONS_ACCEPTANCE_NEGATIVE_CONTROL_MODE,
  FEED_OPERATIONS_ACCEPTANCE_NPM_SCRIPTS,
  FEED_OPERATIONS_ACCEPTANCE_READINESS_REASONS,
  FEED_OPERATIONS_ACCEPTANCE_RUNTIME_ROOT_ENV,
  FEED_OPERATIONS_ACCEPTANCE_SCHEMA_VERSION,
  FEED_OPERATIONS_NEGATIVE_CONTROL_IDS,
  assertFeedOperationsProductionBindingsAt,
  exerciseFeedOperationsTemporarySourceControl,
} from '../../../scripts/phase5-feed-operations-acceptance-bindings.mjs';

const backendRoot = resolve(import.meta.dirname, '../../..');
const repositoryRoot = resolve(backendRoot, '..');
const runnerPath = resolve(backendRoot, 'scripts/phase5-feed-operations-acceptance.mjs');
const bindingsPath = resolve(backendRoot, 'scripts/phase5-feed-operations-acceptance-bindings.mjs');

test('R5-16 exposes one production Feed operations acceptance command and no precommit adapter', () => {
  const packageJson = JSON.parse(readFileSync(resolve(backendRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(packageJson.scripts['evidence:phase5:feed-operations'],
    'node scripts/with-postgres.mjs -- node scripts/phase5-feed-operations-acceptance.mjs');
  assert.equal(packageJson.scripts['test:phase5:feed-operations-acceptance:contract'],
    'vitest run tests/unit/phase5/phase5-feed-operations-acceptance-contract.test.ts');
  const runner = readFileSync(runnerPath, 'utf8');
  const bindings = readFileSync(bindingsPath, 'utf8');
  assert.match(runner, /gitBytes\(\['status', '--porcelain=v1', '-z', '--untracked-files=all'\]\)/u);
  assert.match(runner, /from '\.\/phase5-feed-operations-acceptance-bindings\.mjs'/u);
  assert.equal(FEED_OPERATIONS_ACCEPTANCE_SCHEMA_VERSION, 'known.phase5.feed-operations/v1');
  assert.equal(FEED_OPERATIONS_ACCEPTANCE_BINDING_MODE, 'exact-commit');
  assert.equal(FEED_OPERATIONS_ACCEPTANCE_BUNDLE_RELATIVE_PATH,
    'p5-24/phase5-feed-operations-status.json');
  assert.equal(FEED_OPERATIONS_ACCEPTANCE_NEGATIVE_CONTROL_MODE, 'real-temporary-source-corruption');
  assert.equal(FEED_OPERATIONS_ACCEPTANCE_RUNTIME_ROOT_ENV, 'KNOWN_PHASE5_EVIDENCE_ROOT');
  assert.equal(FEED_OPERATIONS_ACCEPTANCE_EXPECTED_COMMIT_ENV,
    'KNOWN_PHASE5_FEED_OPERATIONS_EXPECTED_COMMIT');
  assert.equal(FEED_OPERATIONS_ACCEPTANCE_BINDINGS_MODULE,
    'phase5-feed-operations-acceptance-bindings.mjs');
  assert.equal(FEED_OPERATIONS_ACCEPTANCE_FEED_MIGRATION, '202607290100_social_feed_projections');
  assert.equal(FEED_OPERATIONS_ACCEPTANCE_FANOUT_MIGRATION,
    '202607311000_social_feed_fanout_continuation');
  assert.equal(FEED_OPERATIONS_ACCEPTANCE_FAIL_CLOSED_PREFIX, 'FAIL-CLOSED');
  assert.equal(FEED_OPERATIONS_ACCEPTANCE_GATE_FAILURE_TAIL_CHARS, 8_192);
  assert.deepEqual([...FEED_OPERATIONS_ACCEPTANCE_READINESS_REASONS], [
    'stale_progress', 'withdrawal_backlog', 'dead_letter', 'fanout_inconsistency',
  ]);
  assert.deepEqual([...FEED_OPERATIONS_NEGATIVE_CONTROL_IDS], [
    'missing-feed-projections-migration', 'missing-fanout-continuation-migration',
    'missing-stale-progress-threshold', 'missing-withdrawal-backlog-threshold',
    'missing-dead-letter-replay', 'missing-purge-boundary', 'missing-rebuild-boundary',
    'missing-fanout-metrics', 'missing-runbook-binding', 'missing-operations-repository',
  ]);
  assert.deepEqual([...FEED_OPERATIONS_ACCEPTANCE_NPM_SCRIPTS], [
    'test:phase5:feed-operations:inner', 'test:phase5:fanout-operations:inner',
    'scan:secrets', 'db:migrate', 'ops:phase5:feed',
  ]);
  assert.equal(FEED_OPERATIONS_ACCEPTANCE_FAIL_CLOSED.noPrecommit,
    'Feed operations acceptance has no precommit mode; exact-commit only');
  assert.equal(FEED_OPERATIONS_ACCEPTANCE_FAIL_CLOSED.sourceTreeChanged,
    'source tree changed while Feed operations acceptance was running');
  assert.equal(FEED_OPERATIONS_ACCEPTANCE_FAIL_CLOSED.outputFreshExclusive,
    'output path must be fresh and exclusive');
  assert.equal(FEED_OPERATIONS_ACCEPTANCE_FAIL_CLOSED.artifactSecretScan,
    'artifact secret-marker scan failed');
  assert.equal(FEED_OPERATIONS_ACCEPTANCE_FAIL_CLOSED.gateFailureOutput, 'gate failure output');
  assert.match(runner, /FEED_OPERATIONS_ACCEPTANCE_GATE_FAILURE_TAIL_CHARS/u);
  assert.match(runner, /progressBacklog/u);
  assert.match(runner, /oldestProgressAgeMs/u);
  assert.match(bindings, /stale_progress|fanoutProgressAgeNotReadyMs/u);
  assert.match(bindings, /withdrawal_backlog|withdrawalBacklogNotReady/u);
  assert.match(bindings, /replayDeadLetters|replay-dead-letter/u);
  assert.match(bindings, /purgeFeedRetentionForOperations|purge/u);
  assert.match(bindings, /rebuildFeedScopeForOperations|rebuild/u);
  assert.match(bindings, /feed\.fanout\.(?:progress_backlog|oldest_progress_age_ms|continued)/u);
  assert.match(bindings, /exerciseFeedOperationsTemporarySourceControl/u);
  for (const pattern of FEED_OPERATIONS_ACCEPTANCE_FORBIDDEN_RUNNER_PATTERNS) {
    assert.doesNotMatch(runner, pattern);
  }
});

test('R5-16 closed Feed operations evidence schema binds status, fanout, digests and migration head', () => {
  const schema = JSON.parse(readFileSync(resolve(backendRoot,
    'tests/fixtures/phase5/feed-operations-evidence.schema.json'), 'utf8')) as object;
  const serialized = JSON.stringify(schema);
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  assert.doesNotThrow(() => ajv.compile(schema));
  for (const required of [
    'known.phase5.feed-operations/v1', 'sourceRevision', 'capturedAt', 'command', 'status',
    'capacity', 'capacityDigest', 'feedOperationsSourceDigest', 'runbookDigest',
    'migrationHead', 'migrationDigest', 'nodeVersion', 'postgresVersion', 'result',
    'progressBacklog', 'oldestProgressAgeMs', 'withdrawalBacklog', 'orphanProgressCount',
    'reverseInconsistencyCount', 'stale_progress', 'withdrawal_backlog', 'dead_letter',
    'fanout_inconsistency', 'additionalProperties":false',
  ]) assert.match(serialized, new RegExp(escapeRegExp(required), 'u'), required);
  assert.doesNotMatch(serialized, /working-tree|precommit/u);
});

test('R5-16 remediation schema freezes p5-24 and p5-25 bundle paths under evidence root', () => {
  const schema = JSON.parse(readFileSync(resolve(backendRoot,
    'tests/fixtures/phase5/remediation/r5-16-social-operations.schema.json'), 'utf8')) as object;
  const serialized = JSON.stringify(schema);
  for (const required of [
    'known.phase5.remediation.r5-16.v1', 'R5-16', 'exact-commit',
    'KNOWN_PHASE5_EVIDENCE_ROOT', 'real-temporary-source-corruption',
    'p5-24/phase5-feed-operations-status.json',
    'p5-25/phase5-notification-operations-status.json',
    'known.phase5.feed-operations/v1', 'known.phase5.notification-operations/v1',
  ]) assert.match(serialized, new RegExp(escapeRegExp(required), 'u'), required);
});

test('R5-16 Feed operations bindings freeze continuation, withdrawal, recovery and temporary-source mode', () => {
  assert.equal(FEED_OPERATIONS_ACCEPTANCE_BINDING_MODE, 'exact-commit');
  assert.equal(FEED_OPERATIONS_ACCEPTANCE_BUNDLE_RELATIVE_PATH,
    'p5-24/phase5-feed-operations-status.json');
  assert.equal(FEED_OPERATIONS_ACCEPTANCE_RUNTIME_ROOT_ENV, 'KNOWN_PHASE5_EVIDENCE_ROOT');
  assert.equal(FEED_OPERATIONS_ACCEPTANCE_NEGATIVE_CONTROL_MODE,
    'real-temporary-source-corruption');
  assert.deepEqual([...FEED_OPERATIONS_NEGATIVE_CONTROL_IDS], [
    'missing-feed-projections-migration', 'missing-fanout-continuation-migration',
    'missing-stale-progress-threshold', 'missing-withdrawal-backlog-threshold',
    'missing-dead-letter-replay', 'missing-purge-boundary', 'missing-rebuild-boundary',
    'missing-fanout-metrics', 'missing-runbook-binding', 'missing-operations-repository',
  ]);
  assertFeedOperationsProductionBindingsAt(repositoryRoot);
  const bindings = readFileSync(bindingsPath, 'utf8');
  assert.match(bindings, /202607311000_social_feed_fanout_continuation/u);
  assert.match(bindings, /fanoutProgressAgeNotReadyMs|stale_progress/u);
  assert.match(bindings, /withdrawalBacklogNotReady|withdrawal_backlog/u);
  assert.match(bindings, /replayDeadLetters/u);
  assert.match(bindings, /purgeFeedRetentionForOperations|purgeBatchSize/u);
  assert.match(bindings, /rebuildFeedScopeForOperations|rebuildMaxEvents/u);
  assert.match(bindings, /feed\.fanout\.progress_backlog/u);
  assert.doesNotMatch(bindings, /injectFault|empty-string override|manual Boolean/iu);
});

test('R5-16 temporary-source controls fail closed at owned Feed operations boundaries', async () => {
  for (const fault of [
    'missing-fanout-continuation-migration', 'missing-stale-progress-threshold',
    'missing-withdrawal-backlog-threshold', 'missing-dead-letter-replay',
    'missing-fanout-metrics',
  ] as const) {
    await assert.rejects(
      () => exerciseFeedOperationsTemporarySourceControl(fault, { sourceRoot: repositoryRoot }),
      (error: unknown) => error instanceof Error && error.message === fault,
    );
  }
});

test('R5-16 rejects a Feed operations artifact destination inside the source checkout', () => {
  const result = spawnSync(process.execPath, [runnerPath], {
    cwd: backendRoot,
    env: {
      ...process.env,
      KNOWN_PHASE5_EVIDENCE_ROOT: repositoryRoot,
      KNOWN_PHASE5_FEED_OPERATIONS_EXPECTED_COMMIT: '0'.repeat(40),
      KNOWN_PG_EVIDENCE_MODE: 'acceptance',
      DATABASE_URL: 'postgresql://invalid.invalid/unused',
    },
    encoding: 'utf8', timeout: 15_000, windowsHide: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`,
    /FAIL-CLOSED.*(?:outside the source checkout|evidence root)/u);
});

test('R5-16 fails closed before gates when PostgreSQL or evidence root is absent', () => {
  const environment = { ...process.env, KNOWN_PG_EVIDENCE_MODE: 'acceptance' };
  delete environment.DATABASE_URL;
  delete environment.KNOWN_TEST_DATABASE_URL;
  delete environment.KNOWN_PHASE5_FEED_OPERATIONS_ACCEPTANCE_OUTPUT;
  delete environment.KNOWN_PHASE5_EVIDENCE_ROOT;
  const result = spawnSync(process.execPath, [runnerPath], {
    cwd: backendRoot, env: environment, encoding: 'utf8', timeout: 15_000, windowsHide: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`,
    /FAIL-CLOSED.*(?:DATABASE_URL|KNOWN_PHASE5_EVIDENCE_ROOT|evidence)/u);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /"accepted"\s*:\s*true/u);
});

test('R5-16 rejects Feed operations precommit mode and legacy output override before any gate runs', () => {
  const evidenceRoot = mkdtempSync(join(tmpdir(), 'known-p5-feed-ops-precommit-'));
  try {
    mkdirSync(join(evidenceRoot, 'p5-24'), { recursive: true });
    const precommit = spawnSync(process.execPath, [runnerPath], {
      cwd: backendRoot,
      env: {
        ...process.env,
        KNOWN_PHASE5_EVIDENCE_ROOT: evidenceRoot,
        KNOWN_PHASE5_FEED_OPERATIONS_ACCEPTANCE_MODE: 'precommit',
        KNOWN_PHASE5_FEED_OPERATIONS_EXPECTED_COMMIT: '0'.repeat(40),
        KNOWN_PG_EVIDENCE_MODE: 'acceptance',
        DATABASE_URL: 'postgresql://invalid.invalid/unused',
      },
      encoding: 'utf8', timeout: 15_000, windowsHide: true,
    });
    assert.notEqual(precommit.status, 0);
    assert.match(`${precommit.stdout}${precommit.stderr}`,
      /FAIL-CLOSED.*(?:precommit|exact-commit)/iu);

    const legacy = spawnSync(process.execPath, [runnerPath], {
      cwd: backendRoot,
      env: {
        ...process.env,
        KNOWN_PHASE5_EVIDENCE_ROOT: evidenceRoot,
        KNOWN_PHASE5_FEED_OPERATIONS_ACCEPTANCE_OUTPUT: join(evidenceRoot, 'legacy.json'),
        KNOWN_PHASE5_FEED_OPERATIONS_EXPECTED_COMMIT: '0'.repeat(40),
        KNOWN_PG_EVIDENCE_MODE: 'acceptance',
        DATABASE_URL: 'postgresql://invalid.invalid/unused',
      },
      encoding: 'utf8', timeout: 15_000, windowsHide: true,
    });
    assert.notEqual(legacy.status, 0);
    assert.match(`${legacy.stdout}${legacy.stderr}`,
      /FAIL-CLOSED.*(?:FEED_OPERATIONS_ACCEPTANCE_OUTPUT|exact-commit|p5-24)/iu);
  } finally {
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

for (const fault of [
  'missing-feed-projections-migration', 'missing-fanout-continuation-migration',
  'missing-stale-progress-threshold', 'missing-withdrawal-backlog-threshold',
  'missing-dead-letter-replay', 'missing-purge-boundary', 'missing-rebuild-boundary',
  'missing-fanout-metrics', 'missing-runbook-binding', 'missing-operations-repository',
] as const) {
  test(`R5-16 executable temporary-source negative control ${fault} exits non-zero`, () => {
    const result = spawnSync(process.execPath, [runnerPath, '--negative-control', fault], {
      cwd: backendRoot,
      env: { ...process.env, KNOWN_PHASE5_FEED_OPERATIONS_ACCEPTANCE_TEST_CONTROL: 'enabled' },
      encoding: 'utf8', timeout: 30_000, windowsHide: true,
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`,
      new RegExp(`FAIL-CLOSED.*${escapeRegExp(fault)}`, 'u'));
  });
}

test('R5-16 CI selects the unique Feed operations runner and uploads only p5-24', () => {
  const workflow = readFileSync(resolve(repositoryRoot, '.github/workflows/known-backend-ci.yml'), 'utf8');
  const job = /\n  phase5-feed-operations-acceptance:\s*([\s\S]*?)\n  [a-z0-9-]+:/u.exec(workflow)?.[1];
  assert.ok(job);
  assert.match(job, /npm run evidence:phase5:feed-operations/u);
  assert.match(job, /KNOWN_PHASE5_EVIDENCE_ROOT/u);
  assert.match(job, /p5-24\/phase5-feed-operations-status\.json|p5-24/u);
  assert.match(job, /KNOWN_PHASE5_FEED_OPERATIONS_EXPECTED_COMMIT:\s*\$\{\{ github\.sha \}\}/u);
  assert.match(job, /known-phase5-feed-operations-acceptance/u);
  // known-backend-setup's `playwright: 'none'` opt-out is the one allowed
  // mention; any real Playwright/Chromium usage stays banned.
  assert.doesNotMatch(job, /playwright(?!: 'none')|Chromium/iu);
  assert.doesNotMatch(job, /KNOWN_PHASE5_FEED_OPERATIONS_ACCEPTANCE_MODE/u);
  assert.doesNotMatch(job, /KNOWN_PHASE5_FEED_OPERATIONS_ACCEPTANCE_OUTPUT/u);
});

test('R5-16 evidence documents exact-commit Feed operations replay into external p5-24 bundle', () => {
  const evidence = readFileSync(resolve(backendRoot,
    'docs/evidence/phase5-feed-operations-acceptance-2026-07-29.md'), 'utf8');
  assert.match(evidence, /npm run evidence:phase5:feed-operations/u);
  assert.match(evidence, /KNOWN_PHASE5_EVIDENCE_ROOT/u);
  assert.match(evidence, /p5-24/u);
  assert.match(evidence, /exact-commit/u);
  assert.match(evidence, /stale continuation|stale_progress|fanoutProgressAge/iu);
  assert.match(evidence, /withdrawal|withdrawal_backlog/iu);
  assert.match(evidence, /dead-letter|requeue|replay/iu);
  assert.match(evidence, /purge/iu);
  assert.match(evidence, /crash/iu);
  assert.match(evidence, /metrics/iu);
  assert.match(evidence, /secret/iu);
  assert.match(evidence, /temporary-source|real-temporary-source-corruption/iu);
  assert.match(evidence, /202607311000_social_feed_fanout_continuation/u);
  assert.match(evidence, /runbook/iu);
  assert.doesNotMatch(evidence, /ACCEPTANCE_MODE\s*=\s*precommit|precommit mode is canonical/iu);
  assert.match(evidence, /does not embed a hand-written passing result/iu);
  assert.doesNotMatch(evidence, /reuse[^\n]*absolute path|hand[- ]edit JSON/iu);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
