import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  NOTIFICATION_OPERATIONS_ACCEPTANCE_BINDING_MODE,
  NOTIFICATION_OPERATIONS_ACCEPTANCE_BINDINGS_MODULE,
  NOTIFICATION_OPERATIONS_ACCEPTANCE_BUNDLE_RELATIVE_PATH,
  NOTIFICATION_OPERATIONS_ACCEPTANCE_EXPECTED_COMMIT_ENV,
  NOTIFICATION_OPERATIONS_ACCEPTANCE_FAIL_CLOSED,
  NOTIFICATION_OPERATIONS_ACCEPTANCE_FAIL_CLOSED_PREFIX,
  NOTIFICATION_OPERATIONS_ACCEPTANCE_FORBIDDEN_RUNNER_PATTERNS,
  NOTIFICATION_OPERATIONS_ACCEPTANCE_GATE_FAILURE_TAIL_CHARS,
  NOTIFICATION_OPERATIONS_ACCEPTANCE_MIGRATION,
  NOTIFICATION_OPERATIONS_ACCEPTANCE_NEGATIVE_CONTROL_MODE,
  NOTIFICATION_OPERATIONS_ACCEPTANCE_NPM_SCRIPTS,
  NOTIFICATION_OPERATIONS_ACCEPTANCE_RUNTIME_ROOT_ENV,
  NOTIFICATION_OPERATIONS_ACCEPTANCE_SCHEMA_VERSION,
  NOTIFICATION_OPERATIONS_EMAIL_PROVIDER_SKIP_PATTERN,
  NOTIFICATION_OPERATIONS_NEGATIVE_CONTROL_IDS,
  assertNotificationOperationsProductionBindingsAt,
  exerciseNotificationOperationsTemporarySourceControl,
} from '../../../scripts/phase5-notification-operations-acceptance-bindings.mjs';

const backendRoot = resolve(import.meta.dirname, '../../..');
const repositoryRoot = resolve(backendRoot, '..');
const runnerPath = resolve(backendRoot, 'scripts/phase5-notification-operations-acceptance.mjs');
const bindingsPath = resolve(backendRoot,
  'scripts/phase5-notification-operations-acceptance-bindings.mjs');

test('R5-16 exposes one production Notification operations acceptance command and no precommit adapter', () => {
  const packageJson = JSON.parse(readFileSync(resolve(backendRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(packageJson.scripts['evidence:phase5:notification-operations'],
    'node scripts/with-postgres.mjs -- node scripts/phase5-notification-operations-acceptance.mjs');
  assert.equal(packageJson.scripts['test:phase5:notification-operations-acceptance:contract'],
    'vitest run tests/unit/phase5/phase5-notification-operations-acceptance-contract.test.ts');
  const runner = readFileSync(runnerPath, 'utf8');
  const bindings = readFileSync(bindingsPath, 'utf8');
  assert.match(runner, /gitBytes\(\['status', '--porcelain=v1', '-z', '--untracked-files=all'\]\)/u);
  assert.match(runner, /from '\.\/phase5-notification-operations-acceptance-bindings\.mjs'/u);
  assert.equal(NOTIFICATION_OPERATIONS_ACCEPTANCE_SCHEMA_VERSION,
    'known.phase5.notification-operations/v1');
  assert.equal(NOTIFICATION_OPERATIONS_ACCEPTANCE_BINDING_MODE, 'exact-commit');
  assert.equal(NOTIFICATION_OPERATIONS_ACCEPTANCE_BUNDLE_RELATIVE_PATH,
    'p5-25/phase5-notification-operations-status.json');
  assert.equal(NOTIFICATION_OPERATIONS_ACCEPTANCE_NEGATIVE_CONTROL_MODE,
    'real-temporary-source-corruption');
  assert.equal(NOTIFICATION_OPERATIONS_ACCEPTANCE_RUNTIME_ROOT_ENV, 'KNOWN_PHASE5_EVIDENCE_ROOT');
  assert.equal(NOTIFICATION_OPERATIONS_ACCEPTANCE_EXPECTED_COMMIT_ENV,
    'KNOWN_PHASE5_NOTIFICATION_OPERATIONS_EXPECTED_COMMIT');
  assert.equal(NOTIFICATION_OPERATIONS_ACCEPTANCE_BINDINGS_MODULE,
    'phase5-notification-operations-acceptance-bindings.mjs');
  assert.equal(NOTIFICATION_OPERATIONS_ACCEPTANCE_MIGRATION,
    '202607291500_notification_operations');
  assert.equal(NOTIFICATION_OPERATIONS_ACCEPTANCE_FAIL_CLOSED_PREFIX, 'FAIL-CLOSED');
  assert.equal(NOTIFICATION_OPERATIONS_ACCEPTANCE_GATE_FAILURE_TAIL_CHARS, 8_192);
  assert.deepEqual([...NOTIFICATION_OPERATIONS_NEGATIVE_CONTROL_IDS], [
    'missing-notification-operations-migration', 'missing-dead-letter-replay',
    'missing-recover-boundary', 'missing-purge-boundary', 'missing-runbook-binding',
    'missing-operations-repository', 'missing-readiness-isolation',
    'missing-operations-metrics', 'missing-source-binding',
  ]);
  assert.deepEqual([...NOTIFICATION_OPERATIONS_ACCEPTANCE_NPM_SCRIPTS], [
    'test:phase5:notification-operations:inner', 'scan:secrets', 'db:migrate',
    'ops:phase5:notifications',
  ]);
  assert.equal(NOTIFICATION_OPERATIONS_ACCEPTANCE_FAIL_CLOSED.noPrecommit,
    'Notification operations acceptance has no precommit mode; exact-commit only');
  assert.equal(NOTIFICATION_OPERATIONS_ACCEPTANCE_FAIL_CLOSED.sourceTreeChanged,
    'source tree changed while Notification operations acceptance was running');
  assert.equal(NOTIFICATION_OPERATIONS_ACCEPTANCE_FAIL_CLOSED.outputFreshExclusive,
    'output path must be fresh and exclusive');
  assert.equal(NOTIFICATION_OPERATIONS_ACCEPTANCE_FAIL_CLOSED.artifactSecretScan,
    'artifact secret-marker scan failed');
  assert.equal(NOTIFICATION_OPERATIONS_ACCEPTANCE_FAIL_CLOSED.gateFailureOutput,
    'gate failure output');
  assert.match(NOTIFICATION_OPERATIONS_EMAIL_PROVIDER_SKIP_PATTERN.source,
    /email provider|skip/u);
  assert.match(runner, /NOTIFICATION_OPERATIONS_EMAIL_PROVIDER_SKIP_PATTERN/u);
  assert.match(runner, /NOTIFICATION_OPERATIONS_ACCEPTANCE_GATE_FAILURE_TAIL_CHARS/u);
  assert.match(runner, /optionalDelivery/u);
  assert.match(runner, /inApp/u);
  assert.match(bindings, /replayDeadLetters|replay-dead-letter/u);
  assert.match(bindings, /recoverMissingSources|recover/u);
  assert.match(bindings, /purgeNotificationRetentionForOperations|purge/u);
  assert.match(bindings, /optionalDelivery|inApp/u);
  assert.match(bindings, /providerUnavailable|email/iu);
  assert.match(bindings, /exerciseNotificationOperationsTemporarySourceControl/u);
  assert.match(bindings, /must not[^\n]*skip|cannot[^\n]*skip|not[^\n]*skip/iu);
  for (const pattern of NOTIFICATION_OPERATIONS_ACCEPTANCE_FORBIDDEN_RUNNER_PATTERNS) {
    assert.doesNotMatch(runner, pattern);
  }
});

test('R5-16 closed Notification operations evidence schema binds readiness isolation and digests', () => {
  const schema = JSON.parse(readFileSync(resolve(backendRoot,
    'tests/fixtures/phase5/notification-operations-evidence.schema.json'), 'utf8')) as object;
  const serialized = JSON.stringify(schema);
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  assert.doesNotThrow(() => ajv.compile(schema));
  for (const required of [
    'known.phase5.notification-operations/v1', 'sourceRevision', 'capturedAt', 'command',
    'status', 'capacity', 'capacityDigest', 'notificationAcceptanceSourceDigest',
    'runbookDigest', 'migrationHead', 'migrationDigest', 'nodeVersion', 'postgresVersion',
    'result', 'inApp', 'optionalDelivery', 'ready', 'degraded', 'dead_letter', 'backlog',
    'additionalProperties":false',
  ]) assert.match(serialized, new RegExp(escapeRegExp(required), 'u'), required);
  assert.doesNotMatch(serialized, /working-tree|precommit/u);
});

test('R5-16 Notification operations bindings freeze recovery, readiness isolation and temporary-source mode', () => {
  assert.equal(NOTIFICATION_OPERATIONS_ACCEPTANCE_BINDING_MODE, 'exact-commit');
  assert.equal(NOTIFICATION_OPERATIONS_ACCEPTANCE_BUNDLE_RELATIVE_PATH,
    'p5-25/phase5-notification-operations-status.json');
  assert.equal(NOTIFICATION_OPERATIONS_ACCEPTANCE_RUNTIME_ROOT_ENV, 'KNOWN_PHASE5_EVIDENCE_ROOT');
  assert.equal(NOTIFICATION_OPERATIONS_ACCEPTANCE_NEGATIVE_CONTROL_MODE,
    'real-temporary-source-corruption');
  assert.deepEqual([...NOTIFICATION_OPERATIONS_NEGATIVE_CONTROL_IDS], [
    'missing-notification-operations-migration', 'missing-dead-letter-replay',
    'missing-recover-boundary', 'missing-purge-boundary', 'missing-runbook-binding',
    'missing-operations-repository', 'missing-readiness-isolation',
    'missing-operations-metrics', 'missing-source-binding',
  ]);
  assertNotificationOperationsProductionBindingsAt(repositoryRoot);
  const bindings = readFileSync(bindingsPath, 'utf8');
  assert.match(bindings, /202607291500_notification_operations/u);
  assert.match(bindings, /replayDeadLetters/u);
  assert.match(bindings, /recoverMissingSources/u);
  assert.match(bindings, /purgeNotificationRetentionForOperations/u);
  assert.match(bindings, /optionalDelivery/u);
  assert.match(bindings, /inApp/u);
  assert.match(bindings, /notifications\.queue\.dead_letter/u);
  assert.doesNotMatch(bindings, /injectFault|empty-string override|manual Boolean/iu);
});

test('R5-16 temporary-source controls fail closed at owned Notification operations boundaries', async () => {
  for (const fault of [
    'missing-notification-operations-migration', 'missing-dead-letter-replay',
    'missing-recover-boundary', 'missing-readiness-isolation', 'missing-source-binding',
  ] as const) {
    await assert.rejects(
      () => exerciseNotificationOperationsTemporarySourceControl(fault,
        { sourceRoot: repositoryRoot }),
      (error: unknown) => error instanceof Error && error.message === fault,
    );
  }
});

test('R5-16 rejects a Notification operations artifact destination inside the source checkout', () => {
  const result = spawnSync(process.execPath, [runnerPath], {
    cwd: backendRoot,
    env: {
      ...process.env,
      KNOWN_PHASE5_EVIDENCE_ROOT: repositoryRoot,
      KNOWN_PHASE5_NOTIFICATION_OPERATIONS_EXPECTED_COMMIT: '0'.repeat(40),
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
  delete environment.KNOWN_PHASE5_NOTIFICATION_OPERATIONS_ACCEPTANCE_OUTPUT;
  delete environment.KNOWN_PHASE5_EVIDENCE_ROOT;
  const result = spawnSync(process.execPath, [runnerPath], {
    cwd: backendRoot, env: environment, encoding: 'utf8', timeout: 15_000, windowsHide: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`,
    /FAIL-CLOSED.*(?:DATABASE_URL|KNOWN_PHASE5_EVIDENCE_ROOT|evidence)/u);
});

test('R5-16 rejects Notification operations precommit mode and legacy output override', () => {
  const evidenceRoot = mkdtempSync(join(tmpdir(), 'known-p5-notification-ops-precommit-'));
  try {
    mkdirSync(join(evidenceRoot, 'p5-25'), { recursive: true });
    const precommit = spawnSync(process.execPath, [runnerPath], {
      cwd: backendRoot,
      env: {
        ...process.env,
        KNOWN_PHASE5_EVIDENCE_ROOT: evidenceRoot,
        KNOWN_PHASE5_NOTIFICATION_OPERATIONS_ACCEPTANCE_MODE: 'precommit',
        KNOWN_PHASE5_NOTIFICATION_OPERATIONS_EXPECTED_COMMIT: '0'.repeat(40),
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
        KNOWN_PHASE5_NOTIFICATION_OPERATIONS_ACCEPTANCE_OUTPUT:
          join(evidenceRoot, 'legacy.json'),
        KNOWN_PHASE5_NOTIFICATION_OPERATIONS_EXPECTED_COMMIT: '0'.repeat(40),
        KNOWN_PG_EVIDENCE_MODE: 'acceptance',
        DATABASE_URL: 'postgresql://invalid.invalid/unused',
      },
      encoding: 'utf8', timeout: 15_000, windowsHide: true,
    });
    assert.notEqual(legacy.status, 0);
    assert.match(`${legacy.stdout}${legacy.stderr}`,
      /FAIL-CLOSED.*(?:NOTIFICATION_OPERATIONS_ACCEPTANCE_OUTPUT|exact-commit|p5-25)/iu);
  } finally {
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

for (const fault of [
  'missing-notification-operations-migration', 'missing-dead-letter-replay',
  'missing-recover-boundary', 'missing-purge-boundary', 'missing-runbook-binding',
  'missing-operations-repository', 'missing-readiness-isolation',
  'missing-operations-metrics', 'missing-source-binding',
] as const) {
  test(`R5-16 executable temporary-source negative control ${fault} exits non-zero`, () => {
    const result = spawnSync(process.execPath, [runnerPath, '--negative-control', fault], {
      cwd: backendRoot,
      env: {
        ...process.env,
        KNOWN_PHASE5_NOTIFICATION_OPERATIONS_ACCEPTANCE_TEST_CONTROL: 'enabled',
      },
      encoding: 'utf8', timeout: 30_000, windowsHide: true,
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`,
      new RegExp(`FAIL-CLOSED.*${escapeRegExp(fault)}`, 'u'));
  });
}

test('R5-16 CI selects the unique Notification operations runner and uploads only p5-25', () => {
  const workflow = readFileSync(resolve(repositoryRoot, '.github/workflows/known-backend-ci.yml'),
    'utf8');
  const job = /\n  phase5-notification-operations-acceptance:\s*([\s\S]*?)\n  [a-z0-9-]+:/u
    .exec(workflow)?.[1];
  assert.ok(job);
  assert.match(job, /npm run evidence:phase5:notification-operations/u);
  assert.match(job, /KNOWN_PHASE5_EVIDENCE_ROOT/u);
  assert.match(job, /p5-25\/phase5-notification-operations-status\.json|p5-25/u);
  assert.match(job,
    /KNOWN_PHASE5_NOTIFICATION_OPERATIONS_EXPECTED_COMMIT:\s*\$\{\{ github\.sha \}\}/u);
  assert.match(job, /known-phase5-notification-operations-acceptance/u);
  // known-backend-setup's `playwright: 'none'` opt-out is the one allowed
  // mention; any real Playwright/Chromium usage stays banned.
  assert.doesNotMatch(job, /playwright(?!: 'none')|Chromium/iu);
  assert.doesNotMatch(job, /KNOWN_PHASE5_NOTIFICATION_OPERATIONS_ACCEPTANCE_MODE/u);
  assert.doesNotMatch(job, /KNOWN_PHASE5_NOTIFICATION_OPERATIONS_ACCEPTANCE_OUTPUT/u);
});

test('R5-16 evidence documents exact-commit Notification operations replay into external p5-25 bundle', () => {
  const evidence = readFileSync(resolve(backendRoot,
    'docs/evidence/phase5-notification-operations-acceptance-2026-07-29.md'), 'utf8');
  assert.match(evidence, /npm run evidence:phase5:notification-operations/u);
  assert.match(evidence, /KNOWN_PHASE5_EVIDENCE_ROOT/u);
  assert.match(evidence, /p5-25/u);
  assert.match(evidence, /exact-commit/u);
  assert.match(evidence, /dead-letter|requeue|replay/iu);
  assert.match(evidence, /recover/iu);
  assert.match(evidence, /purge/iu);
  assert.match(evidence, /crash/iu);
  assert.match(evidence, /metrics/iu);
  assert.match(evidence, /secret/iu);
  assert.match(evidence, /in-app|optional delivery|readiness/iu);
  assert.match(evidence, /temporary-source|real-temporary-source-corruption/iu);
  assert.match(evidence, /202607291500_notification_operations/u);
  assert.match(evidence, /runbook/iu);
  assert.match(evidence, /email provider[^\n]*not[^\n]*skip|must not[^\n]*skip[^\n]*email|does not[^\n]*skip[^\n]*email/iu);
  assert.doesNotMatch(evidence, /ACCEPTANCE_MODE\s*=\s*precommit|precommit mode is canonical/iu);
  assert.match(evidence, /does not embed a hand-written passing result/iu);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
