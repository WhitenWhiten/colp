/**
 * P4A-P11 INDEPENDENT validator contract (plan §9 P11, §11 matrix:
 * clean retained revision + independent validator; §12). Pins that
 * `evidence:phase4a-owner-private:validate` is a SEPARATE artifact (zero
 * workspace imports) which recomputes every binding digest with its OWN
 * implementation, verifies the consumer/multi-instance/regression facts,
 * scans forbidden values (raw + base64 positions), pins the expected
 * revision and replays the release-gate command surface against the
 * delivery-contract document.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'vitest';
import {
  P11_AUTHORIZATION_NEGATIVE_SCENARIOS,
  P11_CONSUMER_KINDS,
  P11_DEFAULT_EVIDENCE_OUTPUT,
  P11_EVIDENCE_DOC_PATH,
  P11_LIFECYCLE_STEPS,
  P11_OPENAPI_PATH,
  P11_RUNBOOK_COMMANDS,
  P11_TASK,
  checkRunbookCommands,
  computeDigest,
  recomputeClientDigest,
  recomputeConfigDigest,
  recomputeOpenapiDigest,
  recomputeOriginBuildHash,
  recomputeRedisAlgorithmDigest,
  validateEvidenceBundle,
  validateEvidenceBundleRevisionAware,
} from '../../../scripts/phase4a-owner-private-validate-evidence.mjs';
import { computeP11ConfigDigest, computeP11RedisAlgorithmDigest } from '../../../scripts/phase4a-owner-private-evidence.js';
import { p11FixtureBundle, p11FixtureConfigFacts, p11SealedBundle } from '../../support/phase4a-p11-evidence-fixture.js';

const BACKEND_ROOT = resolve(import.meta.dirname, '../../..');

/** Injected git runner for revision-aware contract tests. */
function fakeGit(script: Record<string, string | Error>): (args: readonly string[]) => { stdout: string } {
  return (args: readonly string[]) => {
    const key = args.join(' ');
    if (Object.prototype.hasOwnProperty.call(script, key)) {
      const value = script[key];
      if (value instanceof Error) throw value;
      return { stdout: value };
    }
    throw Object.assign(new Error('git_command_failed:' + key), { exitCode: 128 });
  };
}

const FIXTURE_REVISION = 'a'.repeat(40);
const FIXTURE_TREE = 'b'.repeat(40);
const FIXTURE_MIGRATION = 'Known-Backend/migrations/202608120000_phase4a_p11_acceptance.ts';
const FIXTURE_CLIENT_PATHS = [
  'generated/openapi/product-v1.client.ts',
  'generated/openapi/product-v1.routes.json',
];

/** A git script that makes the fixture bundle pass in retained mode (files served from the working tree). */
function retainedGitScript() {
  return {
    'rev-parse --show-toplevel': '/repo',
    ['ls-tree -r --name-only ' + FIXTURE_REVISION]: FIXTURE_MIGRATION,
    ['rev-parse --verify ' + FIXTURE_REVISION + '^{commit}']: FIXTURE_REVISION,
    ['rev-parse ' + FIXTURE_REVISION + '^{tree}']: FIXTURE_TREE,
    ['merge-base --is-ancestor ' + FIXTURE_REVISION + ' HEAD']: '',
    'rev-parse HEAD': FIXTURE_REVISION,
    'rev-parse HEAD^{tree}': FIXTURE_TREE,
    'status --porcelain': '',
    ['show ' + FIXTURE_REVISION + ':Known-Backend/openapi/product-v1.yaml']: readFileSync(resolve(BACKEND_ROOT, P11_OPENAPI_PATH), 'utf8'),
    ['show ' + FIXTURE_REVISION + ':Known-Backend/generated/openapi/product-v1.client.ts']: readFileSync(resolve(BACKEND_ROOT, 'generated/openapi/product-v1.client.ts'), 'utf8'),
    ['show ' + FIXTURE_REVISION + ':Known-Backend/generated/openapi/product-v1.routes.json']: readFileSync(resolve(BACKEND_ROOT, 'generated/openapi/product-v1.routes.json'), 'utf8'),
    ['show ' + FIXTURE_REVISION + ':Known-Backend/package.json']: readFileSync(resolve(BACKEND_ROOT, 'package.json'), 'utf8'),
    ['show ' + FIXTURE_REVISION + ':Known-Backend/tsconfig.json']: readFileSync(resolve(BACKEND_ROOT, 'tsconfig.json'), 'utf8'),
  };
}

test('the validator is a separate artifact with its own digest implementations', () => {
  // The validator must NOT import the runner's digest helpers: recomputing
  // with its own implementations must still agree with the runner.
  const fixture = p11SealedBundle();

  const configFacts = p11FixtureConfigFacts();
  assert.equal(recomputeConfigDigest(configFacts), computeP11ConfigDigest(configFacts),
    'config digest recompute must agree with the runner');
  const algorithmFacts = {
    luaScriptName: 'rate_limit_fixed_window_v1',
    windowSource: 'redis-server-time',
    decisionShape: ['allowed', 'count', 'remaining', 'retryAfterSeconds', 'windowStartEpochMs'],
    routeClasses: ['issue', 'complete', 'download'],
    completeEmergencyBounded: true,
  };
  assert.equal(recomputeRedisAlgorithmDigest(algorithmFacts), computeP11RedisAlgorithmDigest(algorithmFacts),
    'redis algorithm digest recompute must agree with the runner');
  assert.equal(computeDigest(fixture), fixture.canonicalDigest, 'the validator must recompute the canonical digest');
  // The canonicalize implementations must agree byte-for-byte.
  assert.equal(typeof recomputeOpenapiDigest(), 'string');
  assert.match(recomputeOpenapiDigest(), /^[a-f0-9]{64}$/u);
  assert.match(recomputeClientDigest(), /^[a-f0-9]{64}$/u);
  assert.match(recomputeOriginBuildHash(), /^[a-f0-9]{64}$/u);
  assert.match(P11_OPENAPI_PATH, /^openapi\/product-v1\.yaml$/u);
});

test('the pass fixture validates clean; every sealed fact family is enforced', () => {
  const fixture = p11SealedBundle();
  const result = validateEvidenceBundle(fixture);
  assert.equal(result.ok, true, result.errors.join(' | '));
  assert.ok(result.checks.length >= 25, 'the validator must run the full check surface');

  // Verdict/accepted enforcement.
  const pending = validateEvidenceBundle({ ...fixture, verdict: 'pending' });
  assert.equal(pending.ok, false);
  assert.ok(pending.errors.some((error) => error.startsWith('evidence_schema:verdict')));
  const unaccepted = validateEvidenceBundle({ ...fixture, accepted: false });
  assert.equal(unaccepted.ok, false);
  assert.ok(unaccepted.errors.some((error) => error.startsWith('evidence_schema:accepted')));

  // Control-catalog enforcement.
  const partialCatalog = p11SealedBundle({
    binding: {
      ...p11FixtureBundle().binding,
      negativeControlCatalog: p11FixtureBundle().binding.negativeControlCatalog.slice(0, 23),
    },
  });
  const catalogResult = validateEvidenceBundle(partialCatalog);
  assert.equal(catalogResult.ok, false);
  assert.ok(catalogResult.errors.some((error) => error.startsWith('catalog:count')));

  // I16 regression enforcement.
  const noRegression = p11SealedBundle({
    i16Regression: { ...p11FixtureBundle().i16Regression, executed: false },
  });
  const regressionResult = validateEvidenceBundle(noRegression);
  assert.equal(regressionResult.ok, false);
  assert.ok(regressionResult.errors.some((error) => error.startsWith('i16_regression')));

  // Multi-instance enforcement.
  const noMulti = p11SealedBundle({
    multiInstance: { ...p11FixtureBundle().multiInstance, issueQuotaShared: false },
  });
  const multiResult = validateEvidenceBundle(noMulti);
  assert.equal(multiResult.ok, false);
  assert.ok(multiResult.errors.some((error) => error.startsWith('multi_instance')));

  // Consumer enforcement.
  const noConsumers = p11SealedBundle({
    consumers: { ...p11FixtureBundle().consumers, kinds: ['publication'] },
  });
  const consumersResult = validateEvidenceBundle(noConsumers);
  assert.equal(consumersResult.ok, false);
  assert.ok(consumersResult.errors.some((error) => error.startsWith('consumers')));

  // Counts enforcement.
  const dirtyCounts = p11SealedBundle({
    counts: { skips: 1, mocks: 0, secrets: 0, residuals: 0 },
  });
  const countsResult = validateEvidenceBundle(dirtyCounts);
  assert.equal(countsResult.ok, false);
  assert.ok(countsResult.errors.some((error) => error.startsWith('counts')));
});

test('the validator scans forbidden values in raw and base64 positions without echoing them', () => {
  const fixture = p11SealedBundle();
  const marker = 'p11-validator-secret-marker-0123456789abcdef';
  const clean = validateEvidenceBundle(fixture, { forbiddenValues: [marker] });
  assert.equal(clean.ok, true);
  assert.ok(clean.checks.some((check) => check === 'secret_scan'));

  const rawLeak = p11SealedBundle({
    limitations: [...fixture.limitations, marker],
  });
  const rawResult = validateEvidenceBundle(rawLeak, { forbiddenValues: [marker] });
  assert.equal(rawResult.ok, false);
  assert.ok(rawResult.errors.some((error) => error.startsWith('secret_scan')));

  const base64Leak = p11SealedBundle({
    limitations: [...fixture.limitations, Buffer.from(marker, 'utf8').toString('base64')],
  });
  const base64Result = validateEvidenceBundle(base64Leak, { forbiddenValues: [marker] });
  assert.equal(base64Result.ok, false);
  assert.ok(base64Result.errors.some((error) => error.startsWith('secret_scan')));
  // The failure must never echo the marker value.
  for (const error of [...rawResult.errors, ...base64Result.errors]) {
    assert.ok(!error.includes(marker), 'validator must not echo marker values');
  }
});

test('the validator pins the expected revision and recomputes the repository-bound digests', () => {
  const fixture = p11SealedBundle();
  const pinned = validateEvidenceBundle(fixture, { expectedRevision: 'a'.repeat(40) });
  assert.equal(pinned.ok, true);
  const wrongPin = validateEvidenceBundle(fixture, { expectedRevision: 'b'.repeat(40) });
  assert.equal(wrongPin.ok, false);
  assert.ok(wrongPin.errors.some((error) => error.startsWith('binding:expected_revision')));

  // A tampered openapi digest is caught by the independent recompute.
  const tampered = p11SealedBundle({
    binding: { ...p11FixtureBundle().binding, openapiDigest: 'e'.repeat(64) },
  });
  const tamperedResult = validateEvidenceBundle(tampered);
  assert.equal(tamperedResult.ok, false);
  assert.ok(tamperedResult.errors.some((error) => error.startsWith('binding:openapi_digest')));
});

test('revision-aware retained mode replays a coherent artifact from git at its bound revision', () => {
  const fixture = p11SealedBundle();
  const result = validateEvidenceBundleRevisionAware(fixture, { git: fakeGit(retainedGitScript()) });
  assert.equal(result.ok, true, result.errors.join(' | '));
  assert.ok(result.checks.includes('revision_exists'));
  assert.ok(result.checks.includes('revision_tree_binding'));
  assert.ok(result.checks.includes('revision_ancestry'));
  assert.ok(result.checks.includes('migration_head_recomputed'));
  assert.ok(result.checks.includes('binding:openapi_digest'));
  assert.ok(result.checks.includes('binding:client_digest'));
  assert.ok(result.checks.includes('binding:origin_build_hash'));
});

test('revision-aware retained mode detects historical binding file drift against the bound revision', () => {
  // The artifact records an openapi digest that does not match the file at
  // its OWN bound revision -> fail closed with the digest recompute error.
  const drifted = p11SealedBundle({
    binding: {
      ...p11FixtureBundle().binding,
      openapiDigest: '0'.repeat(64),
    },
  });
  const driftResult = validateEvidenceBundleRevisionAware(drifted, { git: fakeGit(retainedGitScript()) });
  assert.equal(driftResult.ok, false);
  assert.ok(driftResult.errors.some((error) => error.startsWith('binding:openapi_digest')));

  // Serving DIFFERENT bound-revision file content must also be caught (the
  // recompute reads the git blob, not the current working tree).
  const changedContent = fakeGit({
    ...retainedGitScript(),
    ['show ' + FIXTURE_REVISION + ':Known-Backend/tsconfig.json']: '{"different":true}\n',
  });
  const changedResult = validateEvidenceBundleRevisionAware(p11SealedBundle(), { git: changedContent });
  assert.equal(changedResult.ok, false);
  assert.ok(changedResult.errors.some((error) => error.startsWith('binding:origin_build_hash')));
});

test('revision-aware retained mode fails closed on missing revision and wrong ancestry', () => {
  const fixture = p11SealedBundle();
  const missing = fakeGit({
    ...retainedGitScript(),
    ['rev-parse --verify ' + FIXTURE_REVISION + '^{commit}']: new Error('git exploded'),
  });
  const missingResult = validateEvidenceBundleRevisionAware(fixture, { git: missing });
  assert.equal(missingResult.ok, false);
  assert.ok(missingResult.errors.includes('revision_missing'));

  const notAncestor = fakeGit({
    ...retainedGitScript(),
    ['merge-base --is-ancestor ' + FIXTURE_REVISION + ' HEAD']: Object.assign(new Error('not ancestor'), { exitCode: 1 }),
  });
  const ancestryResult = validateEvidenceBundleRevisionAware(fixture, { git: notAncestor });
  assert.equal(ancestryResult.ok, false);
  assert.ok(ancestryResult.errors.includes('revision_not_ancestor'));

  const treeMismatch = fakeGit({
    ...retainedGitScript(),
    ['rev-parse ' + FIXTURE_REVISION + '^{tree}']: 'c'.repeat(40),
  });
  const treeResult = validateEvidenceBundleRevisionAware(fixture, { git: treeMismatch });
  assert.equal(treeResult.ok, false);
  assert.ok(treeResult.errors.includes('revision_tree_mismatch'));
});

test('revision-aware current mode requires HEAD equality and a clean worktree', () => {
  const fixture = p11SealedBundle();
  const atHead = validateEvidenceBundleRevisionAware(fixture, { mode: 'current', git: fakeGit(retainedGitScript()) });
  assert.equal(atHead.ok, true, atHead.errors.join(' | '));
  assert.ok(atHead.checks.includes('current_revision_is_head'));
  assert.ok(atHead.checks.includes('current_worktree_clean'));

  const oldRevision = validateEvidenceBundleRevisionAware(fixture, {
    mode: 'current',
    git: fakeGit({ ...retainedGitScript(), 'rev-parse HEAD': 'c'.repeat(40) }),
  });
  assert.equal(oldRevision.ok, false);
  assert.ok(oldRevision.errors.includes('current_revision_not_head'));

  const dirtyTree = validateEvidenceBundleRevisionAware(fixture, {
    mode: 'current',
    git: fakeGit({ ...retainedGitScript(), 'status --porcelain': ' M docs/evidence/phase4a-owner-private.json\n' }),
  });
  assert.equal(dirtyTree.ok, false);
  assert.ok(dirtyTree.errors.includes('current_worktree_dirty'));
});

test('revision-aware invalid mode fails with the stable code', () => {
  const fixture = p11SealedBundle();
  const result = validateEvidenceBundleRevisionAware(fixture, { mode: 'bogus' });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ['invalid_mode:bogus']);
});

test('the fixed catalogs (lifecycle, negatives, consumers, runbook commands) stay pinned', () => {
  assert.equal(P11_TASK, 'phase4a-owner-private');
  assert.equal(P11_DEFAULT_EVIDENCE_OUTPUT, 'docs/evidence/phase4a-owner-private.json');
  assert.equal(P11_EVIDENCE_DOC_PATH, 'docs/evidence/phase4a-owner-private.md');
  assert.deepEqual(P11_LIFECYCLE_STEPS, ['issue', 'put', 'complete', 'verify', 'status', 'finalize', 'download', 'replacement', 'cleanup']);
  assert.equal(P11_AUTHORIZATION_NEGATIVE_SCENARIOS.length, 7);
  assert.deepEqual(P11_CONSUMER_KINDS, ['publication', 'sync', 'mcp', 'search', 'profile', 'manifest', 'shared_link']);
  assert.ok(P11_RUNBOOK_COMMANDS.includes('npm run evidence:phase4a-owner-private'));
  assert.ok(P11_RUNBOOK_COMMANDS.includes('npm run evidence:phase4a-owner-private:validate'));
  assert.ok(P11_RUNBOOK_COMMANDS.includes('npm run local:phase4a-r2:run -- p11 confirm-real-r2'));
  // The runbook replay contract: a document missing any command token fails.
  const missing = checkRunbookCommands('no commands here');
  assert.notEqual(missing, null);
  assert.ok(missing!.length >= P11_RUNBOOK_COMMANDS.length);
  assert.equal(checkRunbookCommands(P11_RUNBOOK_COMMANDS.join('\n')), null);
});
