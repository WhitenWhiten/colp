import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'vitest';
import {
  FEED_ACCEPTANCE_BINDING_FILES,
  FEED_ACCEPTANCE_BATCH_SQL,
  FEED_ACCEPTANCE_BINDING_MODE,
  FEED_ACCEPTANCE_BINDINGS_MODULE,
  FEED_ACCEPTANCE_BUNDLE_RELATIVE_PATH,
  FEED_ACCEPTANCE_EXPECTED_COMMIT_ENV,
  FEED_ACCEPTANCE_FAIL_CLOSED,
  FEED_ACCEPTANCE_FAIL_CLOSED_PREFIX,
  FEED_ACCEPTANCE_FANOUT_MIGRATION,
  FEED_ACCEPTANCE_FEED_MIGRATION,
  FEED_ACCEPTANCE_FORBIDDEN_RUNNER_PATTERNS,
  FEED_ACCEPTANCE_GATE_FAILURE_TAIL_CHARS,
  FEED_ACCEPTANCE_NEGATIVE_CONTROL_MODE,
  FEED_ACCEPTANCE_NPM_SCRIPTS,
  FEED_ACCEPTANCE_RECIPIENT_CONTINUATION_BOUNDARY,
  FEED_ACCEPTANCE_RUNTIME_ROOT_ENV,
  FEED_ACCEPTANCE_SCHEMA_VERSION,
  FEED_NEGATIVE_CONTROL_IDS,
  assertFeedProductionBindingsAt,
  assertFreeSocialEventVersionBinding,
  exerciseFeedTemporarySourceControl,
  injectMissingEventVersionFault,
} from '../../../scripts/phase5-feed-acceptance-bindings.mjs';

const backendRoot = resolve(import.meta.dirname, '../../..');
const repositoryRoot = resolve(backendRoot, '..');
const runnerPath = resolve(backendRoot, 'scripts/phase5-feed-acceptance.mjs');
const bindingsPath = resolve(backendRoot, 'scripts/phase5-feed-acceptance-bindings.mjs');

test('R5-14 exposes one production Feed acceptance command and no test-only success adapter', () => {
  const packageJson = JSON.parse(readFileSync(resolve(backendRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(packageJson.scripts['evidence:phase5:feed'],
    'node scripts/with-postgres.mjs -- node scripts/phase5-feed-acceptance.mjs');
  assert.equal(packageJson.scripts['test:phase5:feed-acceptance:contract'],
    'vitest run tests/unit/phase5/phase5-feed-acceptance-contract.test.ts');
  const runner = readFileSync(runnerPath, 'utf8');
  const bindings = readFileSync(bindingsPath, 'utf8');
  assert.match(runner, /gitBytes\(\['status', '--porcelain=v1', '-z', '--untracked-files=all'\]\)/u);
  assert.match(runner, /listTrackedSourcePaths\(gitBytes/u);
  assert.match(runner, /from '\.\/phase5-feed-acceptance-bindings\.mjs'/u);
  assert.equal(FEED_ACCEPTANCE_SCHEMA_VERSION, 'known.phase5.feed-acceptance.v1');
  assert.equal(FEED_ACCEPTANCE_BINDING_MODE, 'exact-commit');
  assert.equal(FEED_ACCEPTANCE_BUNDLE_RELATIVE_PATH, 'p5-15/phase5-feed-acceptance.json');
  assert.equal(FEED_ACCEPTANCE_NEGATIVE_CONTROL_MODE, 'real-temporary-source-corruption');
  assert.equal(FEED_ACCEPTANCE_RUNTIME_ROOT_ENV, 'KNOWN_PHASE5_EVIDENCE_ROOT');
  assert.equal(FEED_ACCEPTANCE_EXPECTED_COMMIT_ENV, 'KNOWN_PHASE5_FEED_EXPECTED_COMMIT');
  assert.equal(FEED_ACCEPTANCE_BINDINGS_MODULE, 'phase5-feed-acceptance-bindings.mjs');
  assert.equal(FEED_ACCEPTANCE_FEED_MIGRATION, '202607290100_social_feed_projections');
  assert.equal(FEED_ACCEPTANCE_FANOUT_MIGRATION, '202607311000_social_feed_fanout_continuation');
  assert.equal(FEED_ACCEPTANCE_RECIPIENT_CONTINUATION_BOUNDARY, 10007);
  assert.equal(FEED_ACCEPTANCE_BATCH_SQL, 'unnest');
  assert.equal(FEED_ACCEPTANCE_FAIL_CLOSED_PREFIX, 'FAIL-CLOSED');
  assert.equal(FEED_ACCEPTANCE_GATE_FAILURE_TAIL_CHARS, 8_192);
  assert.deepEqual([...FEED_NEGATIVE_CONTROL_IDS], [
    'missing-handler-registration', 'missing-event-version', 'missing-migration',
    'missing-watermark-cas', 'missing-production-route', 'generated-client-drift',
    'feature-flag-not-exercised', 'browser-source-mismatch', 'missing-rebuild-control',
    'missing-crash-control', 'missing-withdrawal-control', 'missing-recipient-continuation',
    'missing-batch-sql', 'missing-sparse-plans',
  ]);
  assert.deepEqual([...FEED_ACCEPTANCE_NPM_SCRIPTS], [
    'verify:phase5:social-events', 'test:phase5:social-route:inner',
    'test:phase5:feed-projection:inner', 'test:phase5:feed-worker:inner',
    'test:phase5:fanout-continuation:inner', 'test:phase5:fanout-batch:inner',
    'evidence:phase5:social-capacity:inner', 'test:phase5:feed-query:inner',
    'openapi:ci', 'test:phase5:feed-http:inner', 'test:phase5:feed', 'build',
    'test:e2e:real-stack',
  ]);
  assert.equal(FEED_ACCEPTANCE_FAIL_CLOSED.noPrecommit,
    'Feed acceptance has no precommit mode; exact-commit only');
  assert.equal(FEED_ACCEPTANCE_FAIL_CLOSED.checkoutMismatch,
    'Feed acceptance checkout does not match the expected commit');
  assert.equal(FEED_ACCEPTANCE_FAIL_CLOSED.sourceTreeChanged,
    'source tree changed while Feed acceptance was running');
  assert.equal(FEED_ACCEPTANCE_FAIL_CLOSED.outputFreshExclusive,
    'output path must be fresh and exclusive');
  assert.equal(FEED_ACCEPTANCE_FAIL_CLOSED.artifactSecretScan,
    'artifact secret-marker scan failed');
  assert.equal(FEED_ACCEPTANCE_FAIL_CLOSED.missingProbe,
    'reported a missing, skipped, retried, mocked or intercepted probe');
  assert.equal(FEED_ACCEPTANCE_FAIL_CLOSED.gateFailureOutput, 'gate failure output');
  assert.match(bindings, /fanout_after_recipient_profile_id/u);
  assert.match(bindings, /withdrawVisiblePage|social_feed_withdrawal/u);
  assert.match(bindings, /100000|sparse/u);
  assert.match(bindings, /exerciseFeedTemporarySourceControl/u);
  assert.match(bindings, /sql-?seed(?:ed)?|seedFeed|INSERT\s+INTO\s+social_feed/iu);
  for (const pattern of FEED_ACCEPTANCE_FORBIDDEN_RUNNER_PATTERNS) {
    assert.doesNotMatch(runner, pattern);
  }
});

test('R5-14 closed artifact schema binds exact-commit, p5-15 bundle, remediation and verified-only evidence', () => {
  const schema = JSON.parse(readFileSync(resolve(backendRoot,
    'tests/fixtures/phase5/feed-acceptance-artifact.schema.json'), 'utf8')) as Record<string, unknown>;
  const serialized = JSON.stringify(schema);
  for (const required of [
    'checkoutCommit', 'backendCommit', 'frontendCommit', 'colpCommit', 'sourceTreeDigest',
    'eventType', 'producerVersion', 'consumerVersions', 'eventContractDigest',
    'producerDigest', 'workerRegistryDigest', 'workerRouteDigest', 'migrationHead',
    'openapiDigest', 'generatedClientDigest', 'browserSourceDigest', 'gateDigest',
    'rebuild', 'crashRecovery', 'withdrawal', 'watermarkCas', 'fullPagination',
    'authorizationTightening', 'nAndNMinusOne', 'evidenceClass', 'feedEligible', 'followEligible',
    'phase5Verified', 'deployment', 'deploymentProven', 'notifications',
    'colpFeedProfile', 'colpProfile', 'evidenceDigest',
    'bindingMode', 'exact-commit', 'evidenceBundle', 'p5-15/phase5-feed-acceptance.json',
    'KNOWN_PHASE5_EVIDENCE_ROOT', 'remediation', 'recipientContinuation', '10007',
    'batchSql', 'unnest', 'crashWindow', 'sparsePlans', 'real-temporary-source-corruption',
    'missing-recipient-continuation', 'missing-batch-sql', 'missing-sparse-plans',
    'missing-crash-control', 'missing-withdrawal-control', 'browser-source-mismatch',
    'recipientContinuation', 'fanout-continuation', 'fanout-batch', 'sparse-capacity',
  ]) assert.match(serialized, new RegExp(escapeRegExp(required), 'u'), required);
  assert.match(serialized, /"minItems":13,"maxItems":13/u);
  assert.match(serialized, /"minItems":14,"maxItems":14/u);
  assert.match(serialized, /additionalProperties":false/u);
  assert.match(serialized, /"evidenceClass":\{"const":"verified"\}/u);
  assert.doesNotMatch(serialized, /working-tree|precommit/u);
});

test('R5-14 missing-event-version control structurally removes consumer version 2', () => {
  const source = readFileSync(resolve(backendRoot,
    'tests/fixtures/phase5/free-social-contract.v1.json'), 'utf8');
  assert.doesNotThrow(() => assertFreeSocialEventVersionBinding(source));

  const mutated = injectMissingEventVersionFault(source);
  const contract = JSON.parse(mutated) as {
    events: {
      catalog: Array<{ eventType: string; consumerVersions: number[] }>;
      collectionChangeContract: { consumerVersions: number[] };
    };
  };
  assert.deepEqual(contract.events.collectionChangeContract.consumerVersions, [1]);
  assert.deepEqual(contract.events.catalog.find(({ eventType }) =>
    eventType === 'social.collection-change')?.consumerVersions, [1]);
  assert.throws(() => assertFreeSocialEventVersionBinding(mutated),
    /^Error: missing-event-version$/u);
});

test('R5-14 missing-event-version control is formatting independent and guards no-op mutation', () => {
  const source = readFileSync(resolve(backendRoot,
    'tests/fixtures/phase5/free-social-contract.v1.json'), 'utf8');
  for (const reformatted of [JSON.stringify(JSON.parse(source)),
    JSON.stringify(JSON.parse(source), null, 4)]) {
    const mutated = injectMissingEventVersionFault(reformatted);
    assert.throws(() => assertFreeSocialEventVersionBinding(mutated),
      /^Error: missing-event-version$/u);
  }

  const mutated = injectMissingEventVersionFault(source);
  assert.throws(() => injectMissingEventVersionFault(mutated),
    /^Error: missing-event-version fault injection made no change$/u);

  for (const target of ['catalog', 'collectionChangeContract'] as const) {
    const contract = JSON.parse(source) as {
      events: {
        catalog: Array<{ eventType: string; consumerVersions: number[] }>;
        collectionChangeContract: { consumerVersions: number[] };
      };
    };
    const binding = target === 'catalog'
      ? contract.events.catalog.find(({ eventType }) => eventType === 'social.collection-change')
      : contract.events.collectionChangeContract;
    assert.ok(binding);
    binding.consumerVersions = [1];
    assert.throws(() => injectMissingEventVersionFault(JSON.stringify(contract)),
      /^Error: missing-event-version fault injection made no change$/u);
  }
});

test('R5-14 bindings freeze 10007 continuation, UNNEST batch, crash, withdrawal, sparse plans and temporary-source mode', () => {
  assert.equal(FEED_ACCEPTANCE_BINDING_MODE, 'exact-commit');
  assert.equal(FEED_ACCEPTANCE_BUNDLE_RELATIVE_PATH, 'p5-15/phase5-feed-acceptance.json');
  assert.equal(FEED_ACCEPTANCE_NEGATIVE_CONTROL_MODE, 'real-temporary-source-corruption');
  assert.equal(FEED_ACCEPTANCE_RECIPIENT_CONTINUATION_BOUNDARY, 10007);
  assert.equal(FEED_ACCEPTANCE_BATCH_SQL, 'unnest');
  assert.deepEqual([...FEED_NEGATIVE_CONTROL_IDS], [
    'missing-handler-registration', 'missing-event-version', 'missing-migration',
    'missing-watermark-cas', 'missing-production-route', 'generated-client-drift',
    'feature-flag-not-exercised', 'browser-source-mismatch', 'missing-rebuild-control',
    'missing-crash-control', 'missing-withdrawal-control', 'missing-recipient-continuation',
    'missing-batch-sql', 'missing-sparse-plans',
  ]);
  assertFeedProductionBindingsAt(repositoryRoot);
  const bindings = readFileSync(bindingsPath, 'utf8');
  assert.match(bindings, /maxRecipients \+ 1|maxRecipients\s*\+\s*1/u);
  assert.match(bindings, /withdrawVisiblePage/u);
  assert.match(bindings, /for update skip locked/u);
  assert.match(bindings, /limit 2147483647/u);
  assert.match(bindings, /withdrawalDeltas, \[500, 500, 1\]/u);
  assert.match(bindings, /after - before <= PAGE_SIZE/u);
  assert.match(bindings, /100k|100_000|100000/u);
  assert.match(bindings, /follows_target_actor_fanout_idx/u);
  assert.doesNotMatch(bindings, /injectFault|empty-string override|manual Boolean/iu);
  assert.match(bindings, /sql-?seed(?:ed)?|seedFeed|INSERT\s+INTO\s+social_feed/iu);
  assert.match(bindings, /createSocialFeedWorkerRoutes|projectSocialCollectionChange/u);
});

test('R5-14 temporary-source controls fail closed at owned Feed remediation boundaries', async () => {
  for (const fault of [
    'missing-recipient-continuation', 'missing-batch-sql', 'missing-sparse-plans',
    'missing-crash-control', 'missing-withdrawal-control',
  ] as const) {
    await assert.rejects(
      () => exerciseFeedTemporarySourceControl(fault, { sourceRoot: repositoryRoot }),
      (error: unknown) => error instanceof Error && error.message === fault,
    );
  }
});

test('R5-14 rejects an artifact destination inside the source checkout', () => {
  const result = spawnSync(process.execPath, [runnerPath], {
    cwd: backendRoot,
    env: { ...process.env,
      KNOWN_PHASE5_EVIDENCE_ROOT: repositoryRoot,
      KNOWN_PHASE5_FEED_EXPECTED_COMMIT: '0'.repeat(40),
      KNOWN_PG_EVIDENCE_MODE: 'acceptance', DATABASE_URL: 'postgresql://invalid.invalid/unused' },
    encoding: 'utf8', timeout: 15_000, windowsHide: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /FAIL-CLOSED.*(?:outside the source checkout|evidence root)/u);
});

test('R5-14 fails closed before gates when PostgreSQL or evidence root is absent', () => {
  const environment = { ...process.env, KNOWN_PG_EVIDENCE_MODE: 'acceptance' };
  delete environment.DATABASE_URL;
  delete environment.KNOWN_TEST_DATABASE_URL;
  delete environment.KNOWN_PHASE5_FEED_ACCEPTANCE_OUTPUT;
  delete environment.KNOWN_PHASE5_EVIDENCE_ROOT;
  const result = spawnSync(process.execPath, [runnerPath], {
    cwd: backendRoot, env: environment, encoding: 'utf8', timeout: 15_000, windowsHide: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /FAIL-CLOSED.*(?:DATABASE_URL|KNOWN_PHASE5_EVIDENCE_ROOT|evidence)/u);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /"accepted"\s*:\s*true/u);
});

test('R5-14 rejects precommit mode and legacy output override before any gate runs', () => {
  const evidenceRoot = mkdtempSync(join(tmpdir(), 'known-p5-feed-precommit-'));
  try {
    mkdirSync(join(evidenceRoot, 'p5-15'), { recursive: true });
    const precommit = spawnSync(process.execPath, [runnerPath], {
      cwd: backendRoot,
      env: {
        ...process.env,
        KNOWN_PHASE5_EVIDENCE_ROOT: evidenceRoot,
        KNOWN_PHASE5_FEED_ACCEPTANCE_MODE: 'precommit',
        KNOWN_PHASE5_FEED_EXPECTED_COMMIT: '0'.repeat(40),
        KNOWN_PG_EVIDENCE_MODE: 'acceptance',
        DATABASE_URL: 'postgresql://invalid.invalid/unused',
      },
      encoding: 'utf8', timeout: 15_000, windowsHide: true,
    });
    assert.notEqual(precommit.status, 0);
    assert.match(`${precommit.stdout}${precommit.stderr}`, /FAIL-CLOSED.*(?:precommit|exact-commit)/iu);
    assert.doesNotMatch(`${precommit.stdout}${precommit.stderr}`, /"accepted"\s*:\s*true/u);

    const legacy = spawnSync(process.execPath, [runnerPath], {
      cwd: backendRoot,
      env: {
        ...process.env,
        KNOWN_PHASE5_EVIDENCE_ROOT: evidenceRoot,
        KNOWN_PHASE5_FEED_ACCEPTANCE_OUTPUT: join(evidenceRoot, 'legacy.json'),
        KNOWN_PHASE5_FEED_EXPECTED_COMMIT: '0'.repeat(40),
        KNOWN_PG_EVIDENCE_MODE: 'acceptance',
        DATABASE_URL: 'postgresql://invalid.invalid/unused',
      },
      encoding: 'utf8', timeout: 15_000, windowsHide: true,
    });
    assert.notEqual(legacy.status, 0);
    assert.match(`${legacy.stdout}${legacy.stderr}`, /FAIL-CLOSED.*(?:FEED_ACCEPTANCE_OUTPUT|exact-commit|p5-15)/iu);
    assert.doesNotMatch(`${legacy.stdout}${legacy.stderr}`, /"accepted"\s*:\s*true/u);
  } finally {
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

for (const fault of [
  'missing-handler-registration', 'missing-event-version', 'missing-migration',
  'missing-watermark-cas', 'missing-production-route', 'generated-client-drift',
  'feature-flag-not-exercised', 'browser-source-mismatch', 'missing-rebuild-control',
  'missing-crash-control', 'missing-withdrawal-control', 'missing-recipient-continuation',
  'missing-batch-sql', 'missing-sparse-plans',
] as const) {
  test(`R5-14 executable temporary-source negative control ${fault} exits non-zero`, () => {
    const result = spawnSync(process.execPath, [runnerPath, '--negative-control', fault], {
      cwd: backendRoot,
      env: { ...process.env, KNOWN_PHASE5_FEED_ACCEPTANCE_TEST_CONTROL: 'enabled' },
      encoding: 'utf8', timeout: 30_000, windowsHide: true,
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, new RegExp(`FAIL-CLOSED.*${escapeRegExp(fault)}`, 'u'));
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /"accepted"\s*:\s*true/u);
  });
}

test('R5-14 CI selects the unique runner and uploads only its closed p5-15 artifact', () => {
  const workflow = readFileSync(resolve(repositoryRoot, '.github/workflows/known-backend-ci.yml'), 'utf8');
  const job = /\n  phase5-feed-acceptance:\s*([\s\S]*?)\n  [a-z0-9-]+:/u.exec(workflow)?.[1];
  assert.ok(job);
  assert.match(job, /npm run evidence:phase5:feed/u);
  assert.match(job, /KNOWN_PHASE5_EVIDENCE_ROOT/u);
  assert.match(job, /p5-15\/phase5-feed-acceptance\.json|p5-15/u);
  assert.match(job, /KNOWN_PHASE5_FEED_EXPECTED_COMMIT:\s*\$\{\{ github\.sha \}\}/u);
  assert.match(job, /known-phase5-feed-acceptance/u);
  assert.match(job, /Playwright|playwright|Chromium/u);
  assert.doesNotMatch(job, /KNOWN_PHASE5_FEED_ACCEPTANCE_MODE/u);
  assert.doesNotMatch(job, /KNOWN_PHASE5_FEED_ACCEPTANCE_OUTPUT/u);
  assert.doesNotMatch(job, /npm run (?:test:phase5:feed|test:e2e:real-stack|test:unit)/u);
});

test('R5-14 evidence documents exact-commit replay into external p5-15 bundle', () => {
  const evidence = readFileSync(resolve(backendRoot,
    'docs/evidence/phase5-feed-acceptance-2026-07-29.md'), 'utf8');
  assert.match(evidence, /npm run evidence:phase5:feed/u);
  assert.match(evidence, /KNOWN_PHASE5_EVIDENCE_ROOT/u);
  assert.match(evidence, /p5-15/u);
  assert.match(evidence, /exact-commit/u);
  assert.match(evidence, /10007/u);
  assert.match(evidence, /unnest|UNNEST|batch SQL/iu);
  assert.match(evidence, /crash/iu);
  assert.match(evidence, /withdrawal|Unfollow/iu);
  assert.match(evidence, /sparse/iu);
  assert.match(evidence, /temporary-source|real-temporary-source-corruption/iu);
  assert.match(evidence, /verified/u);
  assert.match(evidence, /supporting/u);
  assert.match(evidence, /default[^\n]*false|默认[^\n]*false/iu);
  assert.match(evidence, /does not[^\n]*(?:Follow|Phase 5[^\n]*Verified|Deployment|Notification|COLP)/iu);
  assert.doesNotMatch(evidence, /ACCEPTANCE_MODE\s*=\s*precommit|precommit mode is canonical/iu);
  assert.match(evidence, /SQL-seeded browser|SQL 插 Feed|direct handler/iu);
  assert.match(evidence, /1001/u);
  assert.match(evidence, /does not embed a hand-written passing result/iu);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

// A stale import must not stand in for an executable production call.
for (const [relativePath, call] of [
  ['Known-Backend/src/infrastructure/collections/canonical-mutation-postgres-ports.ts',
    'await appendCanonicalSecondaryOutbox('],
  ['Known-Backend/src/infrastructure/collections/canonical-secondary-outbox.ts',
    'await appendSocialCollectionChangeOutbox('],
  ['Known-Backend/src/transport/app.ts', 'registerProductSurfaces(app,'],
  ['Known-Backend/src/transport/register-product-surfaces.ts', 'registerFeedRoutes(app,'],
] as const) {
  test(`CI-P5-01 Feed rejects a disconnected production call in ${relativePath}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'known-feed-disconnected-'));
    try {
      for (const path of FEED_ACCEPTANCE_BINDING_FILES) {
        mkdirSync(dirname(resolve(root, path)), { recursive: true });
        cpSync(resolve(repositoryRoot, path), resolve(root, path));
      }
      assertFeedProductionBindingsAt(root);
      const file = resolve(root, relativePath);
      const original = readFileSync(file, 'utf8');
      assert.ok(original.includes(call));
      writeFileSync(file, original.replace(call, call.replace('(', 'Removed(')));
      assert.throws(() => assertFeedProductionBindingsAt(root), /^Error: missing-production-route$/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
