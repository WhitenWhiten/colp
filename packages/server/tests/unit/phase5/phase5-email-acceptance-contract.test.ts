import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  EMAIL_ACCEPTANCE_BINDING_MODE,
  EMAIL_ACCEPTANCE_BINDINGS_MODULE,
  EMAIL_ACCEPTANCE_BROWSER_GREP,
  EMAIL_ACCEPTANCE_BUNDLE_RELATIVE_PATH,
  EMAIL_ACCEPTANCE_CALLBACK_PATH,
  EMAIL_ACCEPTANCE_EXPECTED_COMMIT_ENV,
  EMAIL_ACCEPTANCE_FAIL_CLOSED,
  EMAIL_ACCEPTANCE_FAIL_CLOSED_PREFIX,
  EMAIL_ACCEPTANCE_FIXTURE_PROBE_MODULE,
  EMAIL_ACCEPTANCE_FIXTURE_PROBE_SCRIPT,
  EMAIL_ACCEPTANCE_FORBIDDEN_RUNNER_PATTERNS,
  EMAIL_ACCEPTANCE_HANDLER_MODE,
  EMAIL_ACCEPTANCE_METRIC_NAMES,
  EMAIL_ACCEPTANCE_NEGATIVE_CONTROL_MODE,
  EMAIL_ACCEPTANCE_NOT_ATTESTED_REASON,
  EMAIL_ACCEPTANCE_NOT_ATTESTED_STATUS,
  EMAIL_ACCEPTANCE_NPM_SCRIPTS,
  EMAIL_ACCEPTANCE_REAL_STACK_RUNNER,
  EMAIL_ACCEPTANCE_RUNTIME_ROOT_ENV,
  EMAIL_ACCEPTANCE_SCHEMA_VERSION,
  EMAIL_ACCEPTANCE_TARGET_ATTESTATION_ENV,
  EMAIL_ACCEPTANCE_TARGET_PROBE_MODULE,
  EMAIL_ACCEPTANCE_TARGET_PROBE_SCRIPT,
  EMAIL_NEGATIVE_CONTROL_IDS,
  EMAIL_SUPPRESSION_MIGRATION_FILE,
  assertEmailProductionBindingsAt,
  digestEmailBindingsAt,
  exerciseEmailTemporarySourceControl,
} from '../../../scripts/phase5-email-acceptance-bindings.mjs';

const backendRoot = resolve(import.meta.dirname, '../../..');
const repositoryRoot = resolve(backendRoot, '..');
const runnerPath = resolve(backendRoot, 'scripts/phase5-email-acceptance.mjs');
const bindingsPath = resolve(backendRoot, 'scripts/phase5-email-acceptance-bindings.mjs');

function readSource(relativePath: string): string {
  return readFileSync(resolve(backendRoot, relativePath), 'utf8');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

test('P5-31 exposes one production email acceptance command and no test-only success adapter', () => {
  const packageJson = JSON.parse(readSource('package.json')) as { scripts: Record<string, string> };
  assert.equal(packageJson.scripts['evidence:phase5:email'],
    'node scripts/with-postgres.mjs -- node scripts/phase5-email-acceptance.mjs');
  assert.equal(packageJson.scripts['test:phase5:email-acceptance:contract'],
    'vitest run tests/unit/phase5/phase5-email-acceptance-contract.test.ts');
  assert.equal(packageJson.scripts['probe:email-capability'],
    'node scripts/with-postgres.mjs -- npm run probe:email-capability:inner');
  assert.equal(packageJson.scripts['probe:email-capability:inner'],
    'tsx scripts/email-capability-probe.ts');
  const runner = readFileSync(runnerPath, 'utf8');
  const bindings = readFileSync(bindingsPath, 'utf8');
  assert.match(runner, /gitBytes\(\['status', '--porcelain=v1', '-z', '--untracked-files=all'\]\)/u);
  assert.match(runner, /listTrackedSourcePaths\(gitBytes/u);
  assert.match(runner, /from '\.\/phase5-email-acceptance-bindings\.mjs'/u);
  assert.equal(EMAIL_ACCEPTANCE_SCHEMA_VERSION, 'known.phase5.email-acceptance.v1');
  assert.equal(EMAIL_ACCEPTANCE_BINDING_MODE, 'exact-commit');
  assert.equal(EMAIL_ACCEPTANCE_BUNDLE_RELATIVE_PATH, 'p5-31/phase5-email-acceptance.json');
  assert.equal(EMAIL_ACCEPTANCE_NEGATIVE_CONTROL_MODE, 'real-temporary-source-corruption');
  assert.equal(EMAIL_ACCEPTANCE_RUNTIME_ROOT_ENV, 'KNOWN_PHASE5_EVIDENCE_ROOT');
  assert.equal(EMAIL_ACCEPTANCE_EXPECTED_COMMIT_ENV, 'KNOWN_PHASE5_EMAIL_EXPECTED_COMMIT');
  assert.equal(EMAIL_ACCEPTANCE_TARGET_ATTESTATION_ENV, 'EMAIL_DM_TARGET_ATTESTATION');
  assert.equal(EMAIL_ACCEPTANCE_BINDINGS_MODULE, 'phase5-email-acceptance-bindings.mjs');
  assert.equal(EMAIL_SUPPRESSION_MIGRATION_FILE, '202608020800_notification_email_suppressions.ts');
  assert.equal(EMAIL_ACCEPTANCE_CALLBACK_PATH, '/api/v1/email/callbacks/delivery');
  assert.equal(EMAIL_ACCEPTANCE_HANDLER_MODE, 'delivery_each_event');
  assert.equal(EMAIL_ACCEPTANCE_NOT_ATTESTED_STATUS, 'not-attested');
  assert.equal(EMAIL_ACCEPTANCE_NOT_ATTESTED_REASON, 'credentials not provisioned');
  assert.equal(EMAIL_ACCEPTANCE_BROWSER_GREP, 'P5-30');
  assert.equal(EMAIL_ACCEPTANCE_REAL_STACK_RUNNER, 'real-stack-e2e.mjs');
  assert.equal(EMAIL_ACCEPTANCE_FIXTURE_PROBE_SCRIPT, 'probe:email-delivery-target:fixture');
  assert.equal(EMAIL_ACCEPTANCE_TARGET_PROBE_SCRIPT, 'probe:email-adapter:target');
  assert.equal(EMAIL_ACCEPTANCE_FIXTURE_PROBE_MODULE,
    'scripts/evidence/phase5-email-delivery-target-probe.ts');
  assert.equal(EMAIL_ACCEPTANCE_TARGET_PROBE_MODULE,
    'scripts/evidence/phase5-email-adapter-target-probe.ts');
  assert.equal(EMAIL_ACCEPTANCE_FAIL_CLOSED_PREFIX, 'FAIL-CLOSED');
  assert.deepEqual([...EMAIL_ACCEPTANCE_METRIC_NAMES], [
    'notifications.email_delivery.suppression_facts',
    'notifications.email_delivery.callback.accepted',
    'notifications.email_delivery.probe.status',
  ]);
  assert.deepEqual([...EMAIL_NEGATIVE_CONTROL_IDS], [
    'missing-adapter-contract-module', 'missing-worker-registration',
    'missing-suppression-migration', 'missing-preference-route',
    'generated-client-drift', 'feature-flag-not-exercised', 'browser-source-mismatch',
    'missing-target-attestation', 'missing-replay-digest', 'secret-marker-leakage',
    'callback-surface-missing',
  ]);
  assert.deepEqual([...EMAIL_ACCEPTANCE_NPM_SCRIPTS], [
    'test:phase5:email-worker:integration:inner', 'test:phase5:notification-preference:inner',
    'test:phase5:notification-http:inner', 'openapi:ci',
  ]);
  assert.equal(EMAIL_ACCEPTANCE_FAIL_CLOSED.noPrecommit,
    'email acceptance has no precommit mode; exact-commit only');
  assert.equal(EMAIL_ACCEPTANCE_FAIL_CLOSED.checkoutMismatch,
    'email acceptance checkout does not match the expected commit');
  assert.equal(EMAIL_ACCEPTANCE_FAIL_CLOSED.sourceTreeChanged,
    'source tree changed while email acceptance was running');
  assert.equal(EMAIL_ACCEPTANCE_FAIL_CLOSED.outputFreshExclusive,
    'output path must be fresh and exclusive');
  assert.equal(EMAIL_ACCEPTANCE_FAIL_CLOSED.artifactSecretScan,
    'artifact secret-marker scan failed');
  assert.equal(EMAIL_ACCEPTANCE_FAIL_CLOSED.missingProbe,
    'reported a missing, skipped, retried, mocked or intercepted probe');
  assert.match(bindings, /EMAIL_ACCEPTANCE_TARGET_ATTESTATION_ENV/u);
  assert.match(bindings, /exerciseEmailTemporarySourceControl/u);
  assert.match(bindings, /digestEmailBindingsAt/u);
  assert.match(runner, /requireFromBackend\('playwright'\)/u);
  assert.match(runner, /requireFromBackend\('playwright\/package\.json'\)/u);
  assert.match(runner, /secretScanView\(artifact\)/u);
  assert.match(runner, /artifact-leakage-control/u);
  assert.doesNotMatch(runner, /await import\(playwrightModule\)/u);
  for (const pattern of EMAIL_ACCEPTANCE_FORBIDDEN_RUNNER_PATTERNS) {
    assert.doesNotMatch(runner, pattern);
  }
});

test('P5-31 loads the pinned CommonJS Playwright package with a real Chromium surface', () => {
  const requireFromBackend = createRequire(resolve(backendRoot, 'package.json'));
  const playwright = requireFromBackend('playwright') as {
    chromium?: { executablePath(): string };
  };
  const packageJson = requireFromBackend('playwright/package.json') as { version?: string };
  assert.equal(typeof playwright.chromium?.executablePath, 'function');
  assert.match(String(packageJson.version), /^\d+\.\d+\.\d+$/u);
});

test('P5-31 closed artifact schema binds exact-commit, p5-31 bundle, target attestation and verified-only proofs', () => {
  const schema = JSON.parse(readSource('tests/fixtures/phase5/email-acceptance-artifact.schema.json')) as object;
  const serialized = JSON.stringify(schema);
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  assert.doesNotThrow(() => ajv.compile(schema));
  for (const required of [
    'checkoutCommit', 'backendCommit', 'frontendCommit', 'colpCommit', 'sourceTreeDigestStart',
    'sourceTreeDigestEnd', 'cleanStart', 'cleanEnd', 'adapterContract', 'fixtureReplayDigest',
    'replayManifestDigest', 'suppressionMigrationFile', 'migrationHead', 'migrationDigest',
    'workerRegistryDigest', 'handlerMode', 'delivery_each_event', 'callbackRoute',
    '/api/v1/email/callbacks/delivery', 'openapiVersion', 'openapiDigest', 'generatedClientDigest',
    'productionDefault', 'targetAttestation', 'not-attested', 'attested', 'fixtureReplayDigest',
    'sourceBoundOnly', 'verifiedSenderAccountDigest', 'probeOutputDigest', 'metricNames',
    'cardinality', 'emailDeliveryEligible', 'emailCapabilityIndependent', 'phase5Verified',
    'deploymentProven', 'targetAttested', 'marketingAutomation', 'billingEmail', 'colpProfile',
    'evidenceDigest', 'bindingMode', 'exact-commit', 'evidenceBundle', 'p5-31/phase5-email-acceptance.json',
    'KNOWN_PHASE5_EVIDENCE_ROOT', 'real-temporary-source-corruption',
    'missing-adapter-contract-module', 'missing-worker-registration', 'missing-suppression-migration',
    'missing-preference-route', 'generated-client-drift', 'feature-flag-not-exercised',
    'browser-source-mismatch', 'missing-target-attestation', 'missing-replay-digest',
    'secret-marker-leakage', 'callback-surface-missing',
  ]) assert.match(serialized, new RegExp(escapeRegExp(required), 'u'), required);
  assert.match(serialized, /"minItems":8,"maxItems":8/u);
  assert.match(serialized, /"minItems":11,"maxItems":11/u);
  assert.match(serialized, /additionalProperties":false/u);
  assert.doesNotMatch(serialized, /working-tree|precommit/u);
  assert.match(serialized, /Deployment-proven|deploymentProven/iu);
});

test('P5-31 bindings freeze exact-commit bundle, temporary-source mode and the negative control catalog', () => {
  assert.equal(EMAIL_ACCEPTANCE_BINDING_MODE, 'exact-commit');
  assert.equal(EMAIL_ACCEPTANCE_BUNDLE_RELATIVE_PATH, 'p5-31/phase5-email-acceptance.json');
  assert.equal(EMAIL_ACCEPTANCE_NEGATIVE_CONTROL_MODE, 'real-temporary-source-corruption');
  assert.equal(EMAIL_ACCEPTANCE_RUNTIME_ROOT_ENV, 'KNOWN_PHASE5_EVIDENCE_ROOT');
  assert.equal(EMAIL_ACCEPTANCE_TARGET_ATTESTATION_ENV, 'EMAIL_DM_TARGET_ATTESTATION');
  assert.deepEqual([...EMAIL_NEGATIVE_CONTROL_IDS], [
    'missing-adapter-contract-module',
    'missing-worker-registration',
    'missing-suppression-migration',
    'missing-preference-route',
    'generated-client-drift',
    'feature-flag-not-exercised',
    'browser-source-mismatch',
    'missing-target-attestation',
    'missing-replay-digest',
    'secret-marker-leakage',
    'callback-surface-missing',
  ]);
  const fixture = JSON.parse(readSource('tests/fixtures/phase5/email-acceptance-negative-controls.v1.json')) as {
    schemaVersion: string; controls: string[];
  };
  assert.equal(fixture.schemaVersion, 'known.phase5.email-acceptance-negative-controls.v1');
  assert.deepEqual(fixture.controls, [...EMAIL_NEGATIVE_CONTROL_IDS]);
});

test('P5-31 live checkout production bindings verify (source-bound evidence gate)', () => {
  assert.doesNotThrow(() => assertEmailProductionBindingsAt(repositoryRoot));
  const digest = digestEmailBindingsAt(repositoryRoot);
  assert.match(digest, /^[0-9a-f]{64}$/u);
});

test('P5-31 target attestation semantics: fixture evidence is never target-passing evidence', () => {
  const runner = readFileSync(runnerPath, 'utf8');
  assert.equal(EMAIL_ACCEPTANCE_NOT_ATTESTED_STATUS, 'not-attested');
  assert.equal(EMAIL_ACCEPTANCE_NOT_ATTESTED_REASON, 'credentials not provisioned');
  assert.equal(EMAIL_ACCEPTANCE_TARGET_ATTESTATION_ENV, 'EMAIL_DM_TARGET_ATTESTATION');
  assert.equal(EMAIL_ACCEPTANCE_TARGET_PROBE_SCRIPT, 'probe:email-adapter:target');
  assert.match(runner, /from '\.\/phase5-email-acceptance-bindings\.mjs'/u);
  assert.match(runner, /EMAIL_ACCEPTANCE_NOT_ATTESTED_STATUS/u);
  assert.match(runner, /EMAIL_ACCEPTANCE_NOT_ATTESTED_REASON/u);
  assert.match(runner, /fixtureReplayDigest/u);
  assert.match(runner, /sourceBoundOnly/u);
  assert.match(runner, /EMAIL_ACCEPTANCE_TARGET_ATTESTATION_ENV|EMAIL_ACCEPTANCE_TARGET_PROBE_MODULE/u);
  assert.match(runner, /verifiedSenderAccountDigest/u);
  assert.match(runner, /probeOutputDigest/u);
  const evidenceDoc = readSource('docs/evidence/phase5-email-acceptance-2026-08-02.md');
  assert.match(evidenceDoc, /NOT target-passing evidence|not target-passing evidence|NOT target-passing/iu);
  assert.match(evidenceDoc, /local SMTP mock|SMTP mock|not an SMTP mock/iu);
  assert.match(evidenceDoc, /credentials not provisioned/iu);
});

test('P5-31 CI selects the unique runner and uploads only its closed p5-31 artifact', () => {
  const workflow = readFileSync(resolve(repositoryRoot, '.github/workflows/known-backend-ci.yml'), 'utf8');
  const job = /\n  phase5-email-acceptance:\s*([\s\S]*?)\n  [a-z0-9-]+:/u.exec(workflow)?.[1];
  assert.ok(job);
  assert.match(job, /npm run evidence:phase5:email/u);
  assert.match(job, /KNOWN_PHASE5_EVIDENCE_ROOT/u);
  assert.match(job, /p5-31\/phase5-email-acceptance\.json|p5-31/u);
  assert.match(job, /KNOWN_PHASE5_EMAIL_EXPECTED_COMMIT:\s*\$\{\{ github\.sha \}\}/u);
  assert.match(job, /known-phase5-email-acceptance/u);
  assert.match(job, /Playwright|playwright|Chromium/u);
  assert.doesNotMatch(job, /KNOWN_PHASE5_EMAIL_ACCEPTANCE_MODE/u);
  assert.doesNotMatch(job, /KNOWN_PHASE5_EMAIL_ACCEPTANCE_OUTPUT/u);
  assert.doesNotMatch(job, /npm run (?:test:phase5:email|test:e2e:real-stack|test:unit)/u);
});

test('P5-31 negative controls are real temporary-source corruptions that fail at their owned boundary', async () => {
  // The strengthened controls (missing-worker-registration,
  // callback-surface-missing) additionally re-compile the real module graph
  // (N9), so this loop needs a generous timeout.
  for (const controlId of EMAIL_NEGATIVE_CONTROL_IDS) {
    await assert.rejects(
      () => exerciseEmailTemporarySourceControl(controlId, { sourceRoot: repositoryRoot }),
      (error: unknown) => error instanceof Error && error.message === controlId,
      `${controlId} must fail at its owned boundary`,
    );
  }
}, 120_000);
