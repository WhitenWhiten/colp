import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'vitest';
import {
  FOLLOW_ACCEPTANCE_BINDING_MODE,
  FOLLOW_ACCEPTANCE_BINDINGS_MODULE,
  FOLLOW_ACCEPTANCE_BUNDLE_RELATIVE_PATH,
  FOLLOW_ACCEPTANCE_DATABASE_CLOCK,
  FOLLOW_ACCEPTANCE_EXPECTED_COMMIT_ENV,
  FOLLOW_ACCEPTANCE_FAIL_CLOSED,
  FOLLOW_ACCEPTANCE_FAIL_CLOSED_PREFIX,
  FOLLOW_ACCEPTANCE_FORBIDDEN_RUNNER_PATTERNS,
  FOLLOW_ACCEPTANCE_GATE_FAILURE_TAIL_CHARS,
  FOLLOW_ACCEPTANCE_MIGRATION,
  FOLLOW_ACCEPTANCE_NEGATIVE_CONTROL_MODE,
  FOLLOW_ACCEPTANCE_NPM_SCRIPTS,
  FOLLOW_ACCEPTANCE_RUNTIME_ROOT_ENV,
  FOLLOW_ACCEPTANCE_SCHEMA_VERSION,
  FOLLOW_NEGATIVE_CONTROL_IDS,
  assertFollowProductionBindingsAt,
  exerciseFollowTemporarySourceControl,
} from '../../../scripts/phase5-follow-acceptance-bindings.mjs';
import { digestSourceTree, listTrackedSourcePaths } from '../../../scripts/phase5-source-tree.mjs';

const backendRoot = resolve(import.meta.dirname, '../../..');
const repositoryRoot = resolve(backendRoot, '..');
const runnerPath = resolve(backendRoot, 'scripts/phase5-follow-acceptance.mjs');
const bindingsPath = resolve(backendRoot, 'scripts/phase5-follow-acceptance-bindings.mjs');

test('P5-07 enumerates and digests raw Git paths independently of core.quotePath', () => {
  const fixturePaths = [
    'colp/docs/GROK中文.md',
    'Known-Backend/space name.ts',
    'Known-Backend/quote"name.ts',
    'Known-Backend/back\\slash.ts',
    'Known-Backend/line\nbreak.ts',
  ];
  const nulFixture = Buffer.concat(fixturePaths.map((path) => Buffer.concat([
    Buffer.from(path, 'utf8'), Buffer.from([0]),
  ])));
  const invocations: string[][] = [];
  const enumerated = listTrackedSourcePaths((args) => {
    invocations.push(args);
    return nulFixture;
  }, ['Known-Backend', 'colp']);
  assert.deepEqual(invocations, [[
    'ls-files', '-z', '--', 'Known-Backend', 'colp',
  ]]);
  assert.deepEqual(enumerated.map((path) => path.toString('utf8')),
    [...fixturePaths].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))));

  const bytesByPath = new Map(fixturePaths.map((path, index) => [
    Buffer.from(path).toString('base64'), Buffer.from(`source-${index}`),
  ]));
  const readFixture = (path: Buffer) => {
    const bytes = bytesByPath.get(path.toString('base64'));
    assert.ok(bytes, `missing fixture bytes for ${path.toString('base64')}`);
    return bytes;
  };
  const commit = '1'.repeat(40);
  const digest = digestSourceTree(commit, enumerated, readFixture);
  assert.equal(digest, digestSourceTree(commit, [...enumerated].reverse(), readFixture));
  for (const path of enumerated) {
    const key = path.toString('base64');
    const original = bytesByPath.get(key);
    assert.ok(original);
    bytesByPath.set(key, Buffer.concat([original, Buffer.from(' changed')]));
    assert.notEqual(digestSourceTree(commit, enumerated, readFixture), digest,
      `digest omitted ${path.toString('base64')}`);
    bytesByPath.set(key, original);
  }

  const repository = mkdtempSync(join(tmpdir(), 'known-p5-git-paths-'));
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: repository, windowsHide: true });
    for (const path of ['GROK中文.md', 'space name.md']) writeFileSync(join(repository, path), path);
    execFileSync('git', ['add', '--', '.'], { cwd: repository, windowsHide: true });
    const enumerate = (quotePath: boolean) => {
      execFileSync('git', ['config', 'core.quotePath', String(quotePath)], { cwd: repository, windowsHide: true });
      return listTrackedSourcePaths((args) => execFileSync('git', args, {
        cwd: repository, windowsHide: true,
      }), ['.']).map((path) => path.toString('hex'));
    };
    const expected = ['GROK中文.md', 'space name.md']
      .map((path) => Buffer.from(path).toString('hex')).sort();
    assert.deepEqual(enumerate(true), expected);
    assert.deepEqual(enumerate(false), expected);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test('R5-13 exposes one production Follow acceptance command and no test-only success adapter', () => {
  const packageJson = JSON.parse(readFileSync(resolve(backendRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(packageJson.scripts['evidence:phase5:follow'],
    'node scripts/with-postgres.mjs -- node scripts/phase5-follow-acceptance.mjs');
  assert.equal(packageJson.scripts['test:phase5:follow-acceptance:contract'],
    'vitest run tests/unit/phase5/phase5-follow-acceptance-contract.test.ts');
  const runner = readFileSync(runnerPath, 'utf8');
  const bindings = readFileSync(bindingsPath, 'utf8');
  assert.match(runner, /gitBytes\(\['status', '--porcelain=v1', '-z', '--untracked-files=all'\]\)/u);
  assert.match(runner, /listTrackedSourcePaths\(gitBytes/u);
  assert.match(runner, /from '\.\/phase5-follow-acceptance-bindings\.mjs'/u);
  assert.doesNotMatch(runner, /git\(\['ls-files'[\s\S]*?split\(\/\\r\?\\n/u);
  assert.equal(FOLLOW_ACCEPTANCE_SCHEMA_VERSION, 'known.phase5.follow-acceptance.v1');
  assert.equal(FOLLOW_ACCEPTANCE_BINDING_MODE, 'exact-commit');
  assert.equal(FOLLOW_ACCEPTANCE_BUNDLE_RELATIVE_PATH, 'p5-07/phase5-follow-acceptance.json');
  assert.equal(FOLLOW_ACCEPTANCE_NEGATIVE_CONTROL_MODE, 'real-temporary-source-corruption');
  assert.equal(FOLLOW_ACCEPTANCE_RUNTIME_ROOT_ENV, 'KNOWN_PHASE5_EVIDENCE_ROOT');
  assert.equal(FOLLOW_ACCEPTANCE_EXPECTED_COMMIT_ENV, 'KNOWN_PHASE5_FOLLOW_EXPECTED_COMMIT');
  assert.equal(FOLLOW_ACCEPTANCE_BINDINGS_MODULE, 'phase5-follow-acceptance-bindings.mjs');
  assert.equal(FOLLOW_ACCEPTANCE_MIGRATION, '202607280200_follows');
  assert.equal(FOLLOW_ACCEPTANCE_DATABASE_CLOCK, 'postgresql-current_timestamp');
  assert.equal(FOLLOW_ACCEPTANCE_FAIL_CLOSED_PREFIX, 'FAIL-CLOSED');
  assert.equal(FOLLOW_ACCEPTANCE_GATE_FAILURE_TAIL_CHARS, 8_192);
  assert.deepEqual([...FOLLOW_NEGATIVE_CONTROL_IDS], [
    'missing-migration', 'missing-repository-port', 'missing-production-route', 'missing-cursor-key',
    'generated-client-drift', 'feature-flag-not-exercised', 'browser-source-mismatch',
    'missing-append-all', 'missing-dual-unfollow-handlers', 'missing-database-clock',
  ]);
  assert.deepEqual([...FOLLOW_ACCEPTANCE_NPM_SCRIPTS], [
    'test:phase5:follow-acceptance:migration:inner', 'test:phase5:follow-command:inner',
    'test:phase5:follow-query:inner', 'openapi:ci', 'test:phase5:follow-http:inner',
    'test:phase5:follow-acceptance:privacy:inner', 'test:phase5:follow', 'build',
    'test:e2e:real-stack',
  ]);
  assert.equal(FOLLOW_ACCEPTANCE_FAIL_CLOSED.noPrecommit,
    'Follow acceptance has no precommit mode; exact-commit only');
  assert.equal(FOLLOW_ACCEPTANCE_FAIL_CLOSED.checkoutMismatch,
    'Follow acceptance checkout does not match the expected commit');
  assert.equal(FOLLOW_ACCEPTANCE_FAIL_CLOSED.sourceTreeChanged,
    'source tree changed while Follow acceptance was running');
  assert.equal(FOLLOW_ACCEPTANCE_FAIL_CLOSED.outputFreshExclusive,
    'output path must be fresh and exclusive');
  assert.equal(FOLLOW_ACCEPTANCE_FAIL_CLOSED.artifactSecretScan,
    'artifact secret-marker scan failed');
  assert.equal(FOLLOW_ACCEPTANCE_FAIL_CLOSED.missingProbe,
    'reported a missing, skipped, retried, mocked or intercepted probe');
  assert.match(bindings, /appendAll/u);
  assert.match(bindings, /social_feed_withdrawal/u);
  assert.match(bindings, /social_follow_activity/u);
  assert.match(bindings, /current_timestamp|databaseNow/u);
  assert.match(bindings, /exerciseFollowTemporarySourceControl/u);
  assert.match(runner, /sql-?seed(?:ed)?|seedFeed|INSERT\s+INTO\s+social_feed/iu);
  for (const pattern of FOLLOW_ACCEPTANCE_FORBIDDEN_RUNNER_PATTERNS) {
    assert.doesNotMatch(runner, pattern);
  }
});

test('R5-13 closed artifact schema binds exact-commit, p5-07 bundle, remediation and verified-only evidence', () => {
  const schema = JSON.parse(readFileSync(resolve(backendRoot,
    'tests/fixtures/phase5/follow-acceptance-artifact.schema.json'), 'utf8')) as Record<string, unknown>;
  const serialized = JSON.stringify(schema);
  for (const required of [
    'checkoutCommit', 'backendCommit', 'frontendCommit', 'colpCommit', 'sourceTreeDigest',
    'migration', 'migrationHead', 'followVersion', 'openapiVersion', 'openapiDigest', 'generatedClientDigest',
    'browserConfigDigest', 'browserSourceDigest',
    'activeKeyIdDigest', 'retainedKeyCount', 'ttlMilliseconds', 'configDigest',
    'postgresqlVersion', 'chromiumVersion', 'playwrightVersion', 'featureFlag', 'productionDefault',
    'gates', 'evidence', 'evidenceClass', 'negativeControls', 'followEligible', 'phase5Verified', 'deploymentProven',
    'feed', 'notifications', 'colpProfile', 'evidenceDigest',
    'bindingMode', 'exact-commit', 'evidenceBundle', 'p5-07/phase5-follow-acceptance.json',
    'KNOWN_PHASE5_EVIDENCE_ROOT', 'remediation', 'appendAll', 'dualUnfollowHandlers',
    'postgresql-current_timestamp', 'real-temporary-source-corruption',
    'missing-append-all', 'missing-dual-unfollow-handlers', 'missing-database-clock',
  ]) assert.match(serialized, new RegExp(escapeRegExp(required), 'u'), required);
  assert.match(serialized, /"minItems":9,"maxItems":9/u);
  assert.match(serialized, /"minItems":10,"maxItems":10/u);
  assert.match(serialized, /additionalProperties":false/u);
  assert.match(serialized, /"evidenceClass":\{"const":"verified"\}/u);
  assert.doesNotMatch(serialized, /"evidenceClass":\{"const":"supporting"\}/u);
  assert.doesNotMatch(serialized, /working-tree|precommit/u);
});

test('R5-13 bindings freeze appendAll, dual Unfollow handlers, database clock and temporary-source mode', () => {
  assert.equal(FOLLOW_ACCEPTANCE_BINDING_MODE, 'exact-commit');
  assert.equal(FOLLOW_ACCEPTANCE_BUNDLE_RELATIVE_PATH, 'p5-07/phase5-follow-acceptance.json');
  assert.equal(FOLLOW_ACCEPTANCE_NEGATIVE_CONTROL_MODE, 'real-temporary-source-corruption');
  assert.deepEqual([...FOLLOW_NEGATIVE_CONTROL_IDS], [
    'missing-migration', 'missing-repository-port', 'missing-production-route', 'missing-cursor-key',
    'generated-client-drift', 'feature-flag-not-exercised', 'browser-source-mismatch',
    'missing-append-all', 'missing-dual-unfollow-handlers', 'missing-database-clock',
  ]);
  assertFollowProductionBindingsAt(repositoryRoot);
  const bindings = readFileSync(bindingsPath, 'utf8');
  assert.match(bindings, /appendAll/u);
  assert.match(bindings, /social_feed_withdrawal/u);
  assert.match(bindings, /social_follow_activity/u);
  assert.match(bindings, /createSocialFeedWithdrawalWorkerRoutes/u);
  assert.match(bindings, /current_timestamp|databaseNow/u);
  assert.doesNotMatch(bindings, /injectFault|empty-string override|manual Boolean/iu);
  assert.match(bindings, /sql-?seed(?:ed)?|seedFeed|INSERT\s+INTO\s+social_feed/iu);
});

test('R5-13 temporary-source controls fail closed at owned Follow remediation boundaries', async () => {
  for (const fault of [
    'missing-append-all', 'missing-dual-unfollow-handlers', 'missing-database-clock',
  ] as const) {
    await assert.rejects(
      () => exerciseFollowTemporarySourceControl(fault, { sourceRoot: repositoryRoot }),
      (error: unknown) => error instanceof Error && error.message === fault,
    );
  }
});

test('R5-13 rejects an artifact destination inside the source checkout', () => {
  const result = spawnSync(process.execPath, [runnerPath], {
    cwd: backendRoot,
    env: { ...process.env,
      KNOWN_PHASE5_EVIDENCE_ROOT: repositoryRoot,
      KNOWN_PHASE5_FOLLOW_EXPECTED_COMMIT: '0'.repeat(40),
      KNOWN_PG_EVIDENCE_MODE: 'acceptance', DATABASE_URL: 'postgresql://invalid.invalid/unused' },
    encoding: 'utf8', timeout: 15_000, windowsHide: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /FAIL-CLOSED.*(?:outside the source checkout|evidence root)/u);
});

test('R5-13 fails closed before gates when PostgreSQL or evidence root is absent', () => {
  const environment = { ...process.env, KNOWN_PG_EVIDENCE_MODE: 'acceptance' };
  delete environment.DATABASE_URL;
  delete environment.KNOWN_TEST_DATABASE_URL;
  delete environment.KNOWN_PHASE5_FOLLOW_ACCEPTANCE_OUTPUT;
  delete environment.KNOWN_PHASE5_EVIDENCE_ROOT;
  const result = spawnSync(process.execPath, [runnerPath], {
    cwd: backendRoot, env: environment, encoding: 'utf8', timeout: 15_000, windowsHide: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /FAIL-CLOSED.*(?:DATABASE_URL|KNOWN_PHASE5_EVIDENCE_ROOT|evidence)/u);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /"accepted"\s*:\s*true/u);
});

test('R5-13 rejects precommit mode before any gate runs', () => {
  const evidenceRoot = mkdtempSync(join(tmpdir(), 'known-p5-follow-precommit-'));
  try {
    mkdirSync(join(evidenceRoot, 'p5-07'), { recursive: true });
    const result = spawnSync(process.execPath, [runnerPath], {
      cwd: backendRoot,
      env: {
        ...process.env,
        KNOWN_PHASE5_EVIDENCE_ROOT: evidenceRoot,
        KNOWN_PHASE5_FOLLOW_ACCEPTANCE_MODE: 'precommit',
        KNOWN_PHASE5_FOLLOW_EXPECTED_COMMIT: '0'.repeat(40),
        KNOWN_PG_EVIDENCE_MODE: 'acceptance',
        DATABASE_URL: 'postgresql://invalid.invalid/unused',
      },
      encoding: 'utf8', timeout: 15_000, windowsHide: true,
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /FAIL-CLOSED.*(?:precommit|exact-commit)/iu);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /"accepted"\s*:\s*true/u);
  } finally {
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

for (const fault of [
  'missing-migration', 'missing-repository-port', 'missing-production-route', 'missing-cursor-key',
  'generated-client-drift', 'feature-flag-not-exercised', 'browser-source-mismatch',
  'missing-append-all', 'missing-dual-unfollow-handlers', 'missing-database-clock',
] as const) {
  test(`R5-13 executable temporary-source negative control ${fault} exits non-zero`, () => {
    const result = spawnSync(process.execPath, [runnerPath, '--negative-control', fault], {
      cwd: backendRoot,
      env: { ...process.env, KNOWN_PHASE5_FOLLOW_ACCEPTANCE_TEST_CONTROL: 'enabled' },
      encoding: 'utf8', timeout: 30_000, windowsHide: true,
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, new RegExp(`FAIL-CLOSED.*${escapeRegExp(fault)}`, 'u'));
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /"accepted"\s*:\s*true/u);
  });
}

test('R5-13 CI selects the unique runner and uploads only its closed p5-07 artifact', () => {
  const workflow = readFileSync(resolve(repositoryRoot, '.github/workflows/known-backend-ci.yml'), 'utf8');
  const job = /\n  phase5-follow-acceptance:\s*([\s\S]*?)\n  [a-z0-9-]+:/u.exec(workflow)?.[1];
  assert.ok(job);
  assert.match(job, /npm run evidence:phase5:follow/u);
  assert.match(job, /KNOWN_PHASE5_EVIDENCE_ROOT/u);
  assert.match(job, /p5-07\/phase5-follow-acceptance\.json|p5-07/u);
  assert.match(job, /KNOWN_PHASE5_FOLLOW_EXPECTED_COMMIT:\s*\$\{\{ github\.sha \}\}/u);
  assert.match(job, /known-phase5-follow-acceptance/u);
  assert.match(job, /Playwright|playwright|Chromium/u);
  assert.doesNotMatch(job, /KNOWN_PHASE5_FOLLOW_ACCEPTANCE_MODE/u);
  assert.doesNotMatch(job, /npm run (?:test:phase5:follow|test:e2e:real-stack|test:unit)/u);
});

test('R5-13 evidence documents exact-commit replay into external p5-07 bundle', () => {
  const evidence = readFileSync(resolve(backendRoot,
    'docs/evidence/phase5-follow-acceptance-2026-07-29.md'), 'utf8');
  assert.match(evidence, /npm run evidence:phase5:follow/u);
  assert.match(evidence, /KNOWN_PHASE5_EVIDENCE_ROOT/u);
  assert.match(evidence, /p5-07/u);
  assert.match(evidence, /exact-commit/u);
  assert.match(evidence, /appendAll/u);
  assert.match(evidence, /social_feed_withdrawal|dual(?:-|\s)handler/iu);
  assert.match(evidence, /database clock|current_timestamp|postgresql-current_timestamp/iu);
  assert.match(evidence, /temporary-source|real-temporary-source-corruption/iu);
  assert.match(evidence, /verified/u);
  assert.match(evidence, /supporting/u);
  assert.match(evidence, /Follow flag[^\n]*eligible|eligible[^\n]*Follow flag/iu);
  assert.match(evidence, /does not determine the authoritative Phase 5 execution status/iu);
  assert.match(evidence, /provides no target-environment deployment proof/iu);
  assert.match(evidence, /does not accept Product[\s\S]*Feed, Notification[\s\S]*COLP Profile/iu);
  assert.doesNotMatch(evidence, /ACCEPTANCE_MODE\s*=\s*precommit|precommit mode is canonical/iu);
  assert.match(evidence, /SQL-seeded browser/iu);
  assert.match(evidence, /does not embed a hand-written passing result/iu);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
