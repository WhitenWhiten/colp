import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  NOTIFICATION_ACCEPTANCE_BINDING_FILES,
  NOTIFICATION_ACCEPTANCE_BATCH_INTENT_SQL,
  NOTIFICATION_ACCEPTANCE_BINDING_MODE,
  NOTIFICATION_ACCEPTANCE_BINDINGS_MODULE,
  NOTIFICATION_ACCEPTANCE_BUNDLE_RELATIVE_PATH,
  NOTIFICATION_ACCEPTANCE_DATABASE_CLOCK,
  NOTIFICATION_ACCEPTANCE_EVENT_TYPES,
  NOTIFICATION_ACCEPTANCE_EXPECTED_COMMIT_ENV,
  NOTIFICATION_ACCEPTANCE_FAIL_CLOSED,
  NOTIFICATION_ACCEPTANCE_FAIL_CLOSED_PREFIX,
  NOTIFICATION_ACCEPTANCE_FORBIDDEN_RUNNER_PATTERNS,
  NOTIFICATION_ACCEPTANCE_HANDLER_NAMES,
  NOTIFICATION_ACCEPTANCE_MIGRATION_FILE,
  NOTIFICATION_ACCEPTANCE_NEGATIVE_CONTROL_MODE,
  NOTIFICATION_ACCEPTANCE_NPM_SCRIPTS,
  NOTIFICATION_ACCEPTANCE_RUNTIME_ROOT_ENV,
  NOTIFICATION_ACCEPTANCE_SCHEMA_VERSION,
  NOTIFICATION_NEGATIVE_CONTROL_IDS,
  assertNotificationProductionBindingsAt,
  exerciseNotificationTemporarySourceControl,
} from '../../../scripts/phase5-notification-acceptance-bindings.mjs';

const backendRoot = resolve(import.meta.dirname, '../../..');
const repositoryRoot = resolve(backendRoot, '..');
const runnerPath = resolve(backendRoot, 'scripts/phase5-notification-acceptance.mjs');
const bindingsPath = resolve(backendRoot, 'scripts/phase5-notification-acceptance-bindings.mjs');

test('R5-15 exposes one production Notification acceptance command and no test-only success adapter', () => {
  const packageJson = JSON.parse(readFileSync(resolve(backendRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(packageJson.scripts['evidence:phase5:notification'],
    'node scripts/with-postgres.mjs -- node scripts/phase5-notification-acceptance.mjs');
  assert.equal(packageJson.scripts['test:phase5:notification-acceptance:contract'],
    'vitest run --project evidence tests/unit/phase5/phase5-notification-acceptance-contract.test.ts');
  const runner = readFileSync(runnerPath, 'utf8');
  const bindings = readFileSync(bindingsPath, 'utf8');
  assert.match(runner, /gitBytes\(\['status', '--porcelain=v1', '-z', '--untracked-files=all'\]\)/u);
  assert.match(runner, /listTrackedSourcePaths\(gitBytes/u);
  assert.match(runner, /from '\.\/phase5-notification-acceptance-bindings\.mjs'/u);
  assert.equal(NOTIFICATION_ACCEPTANCE_SCHEMA_VERSION, 'known.phase5.notification-acceptance.v1');
  assert.equal(NOTIFICATION_ACCEPTANCE_BINDING_MODE, 'exact-commit');
  assert.equal(NOTIFICATION_ACCEPTANCE_BUNDLE_RELATIVE_PATH,
    'p5-23/phase5-notification-acceptance.json');
  assert.equal(NOTIFICATION_ACCEPTANCE_NEGATIVE_CONTROL_MODE, 'real-temporary-source-corruption');
  assert.equal(NOTIFICATION_ACCEPTANCE_RUNTIME_ROOT_ENV, 'KNOWN_PHASE5_EVIDENCE_ROOT');
  assert.equal(NOTIFICATION_ACCEPTANCE_EXPECTED_COMMIT_ENV, 'KNOWN_PHASE5_NOTIFICATION_EXPECTED_COMMIT');
  assert.equal(NOTIFICATION_ACCEPTANCE_BINDINGS_MODULE, 'phase5-notification-acceptance-bindings.mjs');
  assert.equal(NOTIFICATION_ACCEPTANCE_MIGRATION_FILE, '202607290200_notification_authority.ts');
  assert.equal(NOTIFICATION_ACCEPTANCE_BATCH_INTENT_SQL, 'unnest');
  assert.equal(NOTIFICATION_ACCEPTANCE_DATABASE_CLOCK, 'postgresql-current_timestamp');
  assert.equal(NOTIFICATION_ACCEPTANCE_FAIL_CLOSED_PREFIX, 'FAIL-CLOSED');
  assert.deepEqual([...NOTIFICATION_ACCEPTANCE_EVENT_TYPES], [
    'social.follow-created', 'social.feed-item-published',
  ]);
  assert.deepEqual([...NOTIFICATION_ACCEPTANCE_HANDLER_NAMES], [
    'social_follow_activity', 'social_feed_item_notification',
  ]);
  assert.deepEqual([...NOTIFICATION_NEGATIVE_CONTROL_IDS], [
    'missing-migration', 'missing-handler-registration', 'missing-dedupe-key',
    'missing-production-route', 'generated-client-drift', 'feature-flag-not-exercised',
    'browser-source-mismatch', 'missing-authority-proof', 'missing-retry-proof',
    'preference-bypass', 'duplicate-side-effect', 'missing-bulk-boundary-proof',
    'missing-cross-account-proof', 'missing-real-follow-feed-intents',
    'missing-dual-handler-isolation', 'missing-batch-intent-exact-once',
    'missing-database-clock',
  ]);
  assert.deepEqual([...NOTIFICATION_ACCEPTANCE_NPM_SCRIPTS], [
    'verify:phase5:social-events',
    'test:phase5:notification-authority:inner',
    'test:phase5:notification-worker:inner',
    'test:phase5:notification-query:inner',
    'test:phase5:notification-command:inner',
    'test:phase5:notification-preference:inner',
    'test:phase5:notification-http:inner',
    'openapi:ci',
    'test:phase5:notifications',
  ]);
  assert.equal(NOTIFICATION_ACCEPTANCE_FAIL_CLOSED.noPrecommit,
    'Notification acceptance has no precommit mode; exact-commit only');
  assert.equal(NOTIFICATION_ACCEPTANCE_FAIL_CLOSED.checkoutMismatch,
    'Notification acceptance checkout does not match the expected commit');
  assert.equal(NOTIFICATION_ACCEPTANCE_FAIL_CLOSED.sourceTreeChanged,
    'source tree changed while Notification acceptance was running');
  assert.equal(NOTIFICATION_ACCEPTANCE_FAIL_CLOSED.outputFreshExclusive,
    'output path must be fresh and exclusive');
  assert.equal(NOTIFICATION_ACCEPTANCE_FAIL_CLOSED.artifactSecretScan,
    'artifact secret-marker scan failed');
  assert.equal(NOTIFICATION_ACCEPTANCE_FAIL_CLOSED.missingProbe,
    'reported a missing, skipped, retried, mocked or intercepted probe');
  assert.match(bindings, /social_feed_withdrawal/u);
  assert.match(bindings, /current_timestamp|databaseNow/u);
  assert.match(bindings, /exerciseNotificationTemporarySourceControl/u);
  assert.match(bindings, /sql-?seed(?:ed)?|INSERT\s+INTO\s+notifications|direct (?:repository|handler)/iu);
  for (const pattern of NOTIFICATION_ACCEPTANCE_FORBIDDEN_RUNNER_PATTERNS) {
    assert.doesNotMatch(runner, pattern);
  }
  const frontendPackage = JSON.parse(readFileSync(resolve(backendRoot,
    '../Known-Frontend/web/package.json'), 'utf8')) as { scripts: Record<string, string> };
  assert.equal(typeof frontendPackage.scripts['test:phase5:notifications'], 'string');
});

test('R5-15 closed artifact schema binds exact-commit, p5-23 bundle, remediation and verified-only proofs', () => {
  const schema = JSON.parse(readFileSync(resolve(backendRoot,
    'tests/fixtures/phase5/notification-acceptance-artifact.schema.json'), 'utf8')) as object;
  const serialized = JSON.stringify(schema);
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  assert.doesNotThrow(() => ajv.compile(schema));
  for (const required of [
    'checkoutCommit', 'backendCommit', 'frontendCommit', 'colpCommit', 'sourceTreeDigestStart',
    'sourceTreeDigestEnd', 'cleanStart', 'cleanEnd', 'eventTypes', 'eventVersions',
    'producerVersions', 'consumerVersions', 'eventContractDigest', 'producerDigest',
    'consumerDigest', 'migrationFile', 'migrationHead', 'migrationDigest',
    'workerRegistryDigest', 'workerRouteDigest', 'dedupeKeyDigest', 'openapiVersion',
    'openapiDigest', 'generatedClientDigest', 'featureConfigDigest', 'featureSourceDigest',
    'browserSpecDigest', 'browserConfigDigest', 'browserArtifactDigest', 'artifactSchemaDigest',
    'eventFactDigest', 'recipientFactDigest', 'sourceFactDigest', 'outboxFactDigest',
    'authorityFactDigest', 'applicationFactDigest', 'httpFactDigest', 'clientFactDigest',
    'browserFactDigest', 'preferenceDisabled', 'preferenceRestored', 'duplicate',
    'crashRollback', 'retry', 'leaseTakeover', 'bulkBoundary', 'crossAccount', 'secretScan',
    'rawPayloadAbsent', 'providerFactsAbsent', 'deliveryFactsAbsent', 'emailFactsAbsent',
    'evidenceClass', 'notificationEligible', 'phase5Verified', 'deploymentProven',
    'emailDelivery', 'mcpWrite', 'colpProfile', 'evidenceDigest',
    'bindingMode', 'exact-commit', 'evidenceBundle', 'p5-23/phase5-notification-acceptance.json',
    'KNOWN_PHASE5_EVIDENCE_ROOT', 'remediation', 'realFollowFeedIntents', 'dualHandlerIsolation',
    'batchIntentExactOnce', 'postgresql-current_timestamp', 'real-temporary-source-corruption',
    'missing-real-follow-feed-intents', 'missing-dual-handler-isolation',
    'missing-batch-intent-exact-once', 'missing-database-clock', 'browser-source-mismatch',
  ]) assert.match(serialized, new RegExp(escapeRegExp(required), 'u'), required);
  assert.match(serialized, /"minItems":12,"maxItems":12/u);
  assert.match(serialized, /"minItems":17,"maxItems":17/u);
  assert.match(serialized, /additionalProperties":false/u);
  assert.match(serialized, /"evidenceClass":\{"const":"verified"\}/u);
  assert.doesNotMatch(serialized, /working-tree|precommit/u);
});

test('R5-15 bindings freeze real Follow/Feed intents, dual handler isolation, batch exact-once, database clock and temporary-source mode', () => {
  assert.equal(NOTIFICATION_ACCEPTANCE_BINDING_MODE, 'exact-commit');
  assert.equal(NOTIFICATION_ACCEPTANCE_BUNDLE_RELATIVE_PATH,
    'p5-23/phase5-notification-acceptance.json');
  assert.equal(NOTIFICATION_ACCEPTANCE_NEGATIVE_CONTROL_MODE, 'real-temporary-source-corruption');
  assert.deepEqual([...NOTIFICATION_NEGATIVE_CONTROL_IDS], [
    'missing-migration', 'missing-handler-registration', 'missing-dedupe-key',
    'missing-production-route', 'generated-client-drift', 'feature-flag-not-exercised',
    'browser-source-mismatch', 'missing-authority-proof', 'missing-retry-proof',
    'preference-bypass', 'duplicate-side-effect', 'missing-bulk-boundary-proof',
    'missing-cross-account-proof', 'missing-real-follow-feed-intents',
    'missing-dual-handler-isolation', 'missing-batch-intent-exact-once',
    'missing-database-clock',
  ]);
  assertNotificationProductionBindingsAt(repositoryRoot);
  const bindings = readFileSync(bindingsPath, 'utf8');
  assert.match(bindings, /social\.follow-created/u);
  assert.match(bindings, /social\.feed-item-published/u);
  assert.match(bindings, /social_follow_activity/u);
  assert.match(bindings, /social_feed_item_notification/u);
  assert.match(bindings, /social_feed_withdrawal/u);
  assert.match(bindings, /unnest|UNNEST/iu);
  assert.match(bindings, /current_timestamp|databaseNow/u);
  assert.match(bindings, /recover independently|handler isolation/iu);
  assert.match(bindings, /exact-once intents/u);
  assert.doesNotMatch(bindings, /injectFault|empty-string override|manual Boolean/iu);
  assert.match(bindings, /sql-?seed(?:ed)?|INSERT\s+INTO\s+notifications/iu);
  assert.match(bindings, /createPostgresNotificationAuthorityRepository|direct (?:repository|handler)/iu);
});

test('R5-15 temporary-source controls fail closed at owned Notification remediation boundaries', async () => {
  for (const fault of [
    'missing-real-follow-feed-intents', 'missing-dual-handler-isolation',
    'missing-batch-intent-exact-once', 'missing-database-clock', 'browser-source-mismatch',
  ] as const) {
    await assert.rejects(
      () => exerciseNotificationTemporarySourceControl(fault, { sourceRoot: repositoryRoot }),
      (error: unknown) => error instanceof Error && error.message === fault,
    );
  }
});

test('R5-15 rejects an artifact destination inside the source checkout', () => {
  const result = spawnSync(process.execPath, [runnerPath], {
    cwd: backendRoot,
    env: { ...process.env,
      KNOWN_PHASE5_EVIDENCE_ROOT: repositoryRoot,
      KNOWN_PHASE5_NOTIFICATION_EXPECTED_COMMIT: '0'.repeat(40),
      KNOWN_PG_EVIDENCE_MODE: 'acceptance', DATABASE_URL: 'postgresql://invalid.invalid/unused' },
    encoding: 'utf8', timeout: 15_000, windowsHide: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`,
    /FAIL-CLOSED.*(?:outside the source checkout|evidence root)/u);
});

test('R5-15 fails closed before gates when PostgreSQL or evidence root is absent', () => {
  const environment = { ...process.env, KNOWN_PG_EVIDENCE_MODE: 'acceptance' };
  delete environment.DATABASE_URL;
  delete environment.KNOWN_TEST_DATABASE_URL;
  delete environment.KNOWN_PHASE5_NOTIFICATION_ACCEPTANCE_OUTPUT;
  delete environment.KNOWN_PHASE5_EVIDENCE_ROOT;
  const result = spawnSync(process.execPath, [runnerPath], {
    cwd: backendRoot, env: environment, encoding: 'utf8', timeout: 15_000, windowsHide: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`,
    /FAIL-CLOSED.*(?:DATABASE_URL|KNOWN_PHASE5_EVIDENCE_ROOT|evidence)/u);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /"accepted"\s*:\s*true/u);
});

test('R5-15 rejects precommit mode and legacy output override before any gate runs', () => {
  const evidenceRoot = mkdtempSync(join(tmpdir(), 'known-p5-notification-precommit-'));
  try {
    mkdirSync(join(evidenceRoot, 'p5-23'), { recursive: true });
    const precommit = spawnSync(process.execPath, [runnerPath], {
      cwd: backendRoot,
      env: {
        ...process.env,
        KNOWN_PHASE5_EVIDENCE_ROOT: evidenceRoot,
        KNOWN_PHASE5_NOTIFICATION_ACCEPTANCE_MODE: 'precommit',
        KNOWN_PHASE5_NOTIFICATION_EXPECTED_COMMIT: '0'.repeat(40),
        KNOWN_PG_EVIDENCE_MODE: 'acceptance',
        DATABASE_URL: 'postgresql://invalid.invalid/unused',
      },
      encoding: 'utf8', timeout: 15_000, windowsHide: true,
    });
    assert.notEqual(precommit.status, 0);
    assert.match(`${precommit.stdout}${precommit.stderr}`,
      /FAIL-CLOSED.*(?:precommit|exact-commit)/iu);
    assert.doesNotMatch(`${precommit.stdout}${precommit.stderr}`, /"accepted"\s*:\s*true/u);

    const legacy = spawnSync(process.execPath, [runnerPath], {
      cwd: backendRoot,
      env: {
        ...process.env,
        KNOWN_PHASE5_EVIDENCE_ROOT: evidenceRoot,
        KNOWN_PHASE5_NOTIFICATION_ACCEPTANCE_OUTPUT: join(evidenceRoot, 'legacy.json'),
        KNOWN_PHASE5_NOTIFICATION_EXPECTED_COMMIT: '0'.repeat(40),
        KNOWN_PG_EVIDENCE_MODE: 'acceptance',
        DATABASE_URL: 'postgresql://invalid.invalid/unused',
      },
      encoding: 'utf8', timeout: 15_000, windowsHide: true,
    });
    assert.notEqual(legacy.status, 0);
    assert.match(`${legacy.stdout}${legacy.stderr}`,
      /FAIL-CLOSED.*(?:NOTIFICATION_ACCEPTANCE_OUTPUT|exact-commit|p5-23)/iu);
    assert.doesNotMatch(`${legacy.stdout}${legacy.stderr}`, /"accepted"\s*:\s*true/u);
  } finally {
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

for (const fault of [
  'missing-migration', 'missing-handler-registration', 'missing-dedupe-key',
  'missing-production-route', 'generated-client-drift', 'feature-flag-not-exercised',
  'browser-source-mismatch', 'missing-authority-proof', 'missing-retry-proof',
  'preference-bypass', 'duplicate-side-effect', 'missing-bulk-boundary-proof',
  'missing-cross-account-proof', 'missing-real-follow-feed-intents',
  'missing-dual-handler-isolation', 'missing-batch-intent-exact-once',
  'missing-database-clock',
] as const) {
  test(`R5-15 executable temporary-source negative control ${fault} exits non-zero`, () => {
    const result = spawnSync(process.execPath, [runnerPath, '--negative-control', fault], {
      cwd: backendRoot,
      env: { ...process.env, KNOWN_PHASE5_NOTIFICATION_ACCEPTANCE_TEST_CONTROL: 'enabled' },
      encoding: 'utf8', timeout: 30_000, windowsHide: true,
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`,
      new RegExp(`FAIL-CLOSED.*${escapeRegExp(fault)}`, 'u'));
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /"accepted"\s*:\s*true/u);
  });
}

test('R5-15 CI selects the unique runner and uploads only its closed p5-23 artifact', () => {
  const workflow = readFileSync(resolve(repositoryRoot, '.github/workflows/known-backend-ci.yml'), 'utf8');
  const job = /\n  phase5-notification-acceptance:\s*([\s\S]*?)\n  [a-z0-9-]+:/u.exec(workflow)?.[1];
  assert.ok(job);
  assert.match(job, /npm run evidence:phase5:notification/u);
  assert.match(job, /KNOWN_PHASE5_EVIDENCE_ROOT/u);
  assert.match(job, /p5-23\/phase5-notification-acceptance\.json|p5-23/u);
  assert.match(job, /KNOWN_PHASE5_NOTIFICATION_EXPECTED_COMMIT:\s*\$\{\{ github\.sha \}\}/u);
  assert.match(job, /known-phase5-notification-acceptance/u);
  assert.match(job, /Playwright|playwright|Chromium/u);
  assert.doesNotMatch(job, /KNOWN_PHASE5_NOTIFICATION_ACCEPTANCE_MODE/u);
  assert.doesNotMatch(job, /KNOWN_PHASE5_NOTIFICATION_ACCEPTANCE_OUTPUT/u);
  assert.doesNotMatch(job, /npm run (?:test:phase5:notification|test:e2e:real-stack|test:unit)/u);
});

test('R5-15 evidence documents exact-commit replay into external p5-23 bundle', () => {
  const evidence = readFileSync(resolve(backendRoot,
    'docs/evidence/phase5-notification-acceptance-2026-07-29.md'), 'utf8');
  assert.match(evidence, /npm run evidence:phase5:notification/u);
  assert.match(evidence, /KNOWN_PHASE5_EVIDENCE_ROOT/u);
  assert.match(evidence, /p5-23/u);
  assert.match(evidence, /exact-commit/u);
  assert.match(evidence, /real Follow|Follow\/Feed intent|social\.follow-created/iu);
  assert.match(evidence, /dual handler|handler isolation|social_follow_activity/iu);
  assert.match(evidence, /batch intent|exact-once|unnest/iu);
  assert.match(evidence, /database clock|current_timestamp|databaseNow/iu);
  assert.match(evidence, /temporary-source|real-temporary-source-corruption/iu);
  assert.match(evidence, /verified/u);
  assert.match(evidence, /supporting/u);
  assert.match(evidence, /default[^\n]*false|默认[^\n]*false/iu);
  assert.match(evidence, /does not[^\n]*(?:Follow|Feed|Phase 5[^\n]*Verified|Deployment|email|COLP)/iu);
  assert.doesNotMatch(evidence, /ACCEPTANCE_MODE\s*=\s*precommit|precommit mode is canonical/iu);
  assert.match(evidence, /SQL[^\n]*Notification|direct (?:repository|handler)|email capability/iu);
  assert.match(evidence, /does not embed a hand-written passing result/iu);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

const workerBindingPath = 'Known-Backend/src/infrastructure/notifications/social-notification-worker-postgres.ts';
const leaseBindingPath = 'Known-Backend/src/infrastructure/outbox/lease-fence.ts';
for (const [label, relativePath, from, to] of [
  ['entry lease clock', workerBindingPath,
    'locked_until > clock_timestamp()', 'locked_until > current_timestamp'],
  ['final helper lease clock', leaseBindingPath,
    'locked_until > clock_timestamp()', 'locked_until > current_timestamp'],
  ['helper row lock', leaseBindingPath,
    'for update', 'for share'],
  ['worker call to final helper', workerBindingPath,
    'const owned = await fenceOutboxLease(', 'const owned = await disconnectedFence('],
  ['projection final fence', workerBindingPath,
    "await fenceAttempt(client, input, faultInjector);\n  return { disposition: inserted.rowCount",
    "return { disposition: inserted.rowCount"],
  ['natural expiry regression gate', 'Known-Backend/package.json',
    ' tests/integration/social/projection-lease-wall-clock.integration.test.ts', ''],
] as const) {
  test(`CI-P5-02 Notification rejects disconnected ${label}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'known-notification-lease-clock-'));
    try {
      for (const path of NOTIFICATION_ACCEPTANCE_BINDING_FILES) {
        mkdirSync(dirname(resolve(root, path)), { recursive: true });
        cpSync(resolve(repositoryRoot, path), resolve(root, path));
      }
      assertNotificationProductionBindingsAt(root);
      const file = resolve(root, relativePath);
      const original = readFileSync(file, 'utf8');
      assert.ok(original.includes(from));
      writeFileSync(file, original.replace(from, to));
      assert.throws(() => assertNotificationProductionBindingsAt(root), /^Error: missing-retry-proof$/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
