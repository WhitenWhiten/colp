import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { posix, resolve, win32 } from 'node:path';
import { spawnSync } from 'node:child_process';
import Ajv2020 from 'ajv/dist/2020.js';
import { test } from 'vitest';
import {
  CI_LIVE_DEPENDENCY_MODE,
  DEPENDENCY_ORDER,
  LOCKED_EVIDENCE_SHA256,
  assertCiLiveDependencyClaims,
  loadCommittedEvidenceLock,
  parseDependencyMode,
  readExpectedCommitFromEnv,
  validateCiDownloadedDependencies,
  validateLockedDependencies,
} from '../../../scripts/phase5-free-social-dependencies.mjs';
import {
  FEED_OPERATIONS_BINDING_FILES,
} from '../../../scripts/phase5-feed-operations-acceptance-bindings.mjs';
import {
  NOTIFICATION_OPERATIONS_BINDING_FILES,
} from '../../../scripts/phase5-notification-operations-acceptance-bindings.mjs';
import { digestSourceBindings } from '../../../scripts/phase5-source-digest.mjs';
import {
  EXPECTED_RELATIVE_PATHS,
  backendRoot,
  ciLiveAcceptance,
  copyBundleInto,
  headCommit,
  lockPath,
  makeOutsideRoot,
  readLock,
  readSource,
  repositoryRoot,
  requireEvidenceBundleRoot,
  runCiLiveVerifier,
  sha256,
  writeCiLiveFixtureBundle,
} from '../../support/phase5-free-social-dependencies-helpers.js';

const hasProvisionedEvidence = typeof process.env.KNOWN_PHASE5_EVIDENCE_ROOT === 'string'
  && process.env.KNOWN_PHASE5_EVIDENCE_ROOT.trim() !== '';

test('operations source bindings include shared config and normalize mixed line endings', () => {
  const sharedConfig = 'Known-Backend/scripts/phase5-operations-config.ts';
  assert.ok(FEED_OPERATIONS_BINDING_FILES.includes(sharedConfig));
  assert.ok(NOTIFICATION_OPERATIONS_BINDING_FILES.includes(sharedConfig));
  const paths = ['first.ts', 'second.ts'];
  const lf = new Map([
    ['first.ts', Buffer.from('first\nsecond\nthird\n')],
    ['second.ts', Buffer.from('alpha\nbeta\n')],
  ]);
  const mixed = new Map([
    ['first.ts', Buffer.from('first\r\nsecond\nthird\r\n')],
    ['second.ts', Buffer.from('alpha\nbeta\r\n')],
  ]);
  const read = (sources: Map<string, Buffer>) => (path: string) => sources.get(path)!;
  assert.equal(digestSourceBindings(paths, read(lf)), digestSourceBindings(paths, read(mixed)));
  assert.notEqual(
    digestSourceBindings(paths, read(lf), { normalizeLineEndings: false }),
    digestSourceBindings(paths, read(mixed), { normalizeLineEndings: false }),
  );
  mixed.set('second.ts', Buffer.from('alpha\nchanged\r\n'));
  assert.notEqual(digestSourceBindings(paths, read(lf)), digestSourceBindings(paths, read(mixed)));
});

test('R5-17 exposes verify:phase5:free-social-dependencies without postgres wrapper', () => {
  const packageJson = JSON.parse(readSource('package.json')) as {
    scripts: Record<string, string>;
  };
  assert.equal(
    packageJson.scripts['verify:phase5:free-social-dependencies'],
    'node scripts/phase5-free-social-dependencies.mjs',
  );
  assert.equal(
    /with-postgres/u.test(packageJson.scripts['verify:phase5:free-social-dependencies'] ?? ''),
    false,
  );
  assert.equal(
    packageJson.scripts['test:phase5:free-social-acceptance:contract'],
    'vitest run --project evidence tests/unit/phase5/phase5-free-social-acceptance-contract.test.ts tests/unit/phase5/phase5-free-social-dependencies.test.ts',
  );
});

test('R5-17 closed schema freezes remediated dependency binding contract', () => {
  const schema = JSON.parse(
    readSource('tests/fixtures/phase5/remediation/r5-17-dependency-binding.schema.json'),
  ) as {
    additionalProperties: boolean;
    required: readonly string[];
    properties: {
      format: { const: string };
      task: { const: string };
      runtimeRootEnv: { const: string };
      lockPathField: { const: string };
      publicCommand: { const: string };
      dependencies: {
        required: readonly string[];
        properties: Record<string, {
          properties: { task: { const: string }; relativePath: { const: string } };
        }>;
      };
      rules: { properties: Record<string, { const: boolean }> };
    };
  };
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.format.const, 'known.phase5.remediation.r5-17.v1');
  assert.equal(schema.properties.task.const, 'R5-17');
  assert.equal(schema.properties.runtimeRootEnv.const, 'KNOWN_PHASE5_EVIDENCE_ROOT');
  assert.equal(schema.properties.lockPathField.const, 'relativePath');
  assert.equal(
    schema.properties.publicCommand.const,
    'npm run verify:phase5:free-social-dependencies',
  );
  assert.deepEqual(schema.properties.dependencies.required, [...DEPENDENCY_ORDER]);
  assert.equal(
    schema.properties.dependencies.properties.followAcceptance.properties.relativePath.const,
    'p5-07/phase5-follow-acceptance.json',
  );
  assert.equal(
    schema.properties.dependencies.properties.feedAcceptance.properties.relativePath.const,
    'p5-15/phase5-feed-acceptance.json',
  );
  assert.equal(
    schema.properties.dependencies.properties.notificationAcceptance.properties.relativePath.const,
    'p5-23/phase5-notification-acceptance.json',
  );
  assert.equal(
    schema.properties.dependencies.properties.feedOperations.properties.relativePath.const,
    'p5-24/phase5-feed-operations-status.json',
  );
  assert.equal(
    schema.properties.dependencies.properties.notificationOperations.properties.relativePath.const,
    'p5-25/phase5-notification-operations-status.json',
  );
  for (const rule of [
    'fiveDependenciesRequired',
    'relativePathOnly',
    'hardBoundLockDigest',
    'failClosedOnMissingDependency',
    'failClosedOnReplacedDependency',
    'failClosedOnDigestMismatch',
    'failClosedOnWrongAncestry',
    'failClosedOnWrongSourceBinding',
    'pathIndependentAcrossEvidenceRoots',
    'forbidPersonalAbsolutePaths',
    'forbidAuthoritativeStatusUpdate',
  ]) {
    assert.equal(schema.properties.rules.properties[rule]?.const, true, rule);
  }
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
  assert.equal(validate({ format: 'known.phase5.remediation.r5-17.v1', task: 'R5-17' }), false);
});

test('R5-17 lock binds remediated relative paths, commits, and digests', () => {
  const normalized = readFileSync(lockPath, 'utf8').replaceAll('\r\n', '\n');
  const lock = JSON.parse(normalized) as {
    dependencies: Record<string, {
      task: string;
      commit: string;
      relativePath: string;
      path?: string;
      fileSha256: string;
      evidenceDigest?: string;
      capacityDigest?: string;
      migrationDigest?: string;
      migrationHead?: string;
      feedOperationsSourceDigest?: string;
      notificationAcceptanceSourceDigest?: string;
    }>;
  };
  assert.equal(sha256(normalized), LOCKED_EVIDENCE_SHA256);
  assert.deepEqual(Object.keys(lock.dependencies), [...DEPENDENCY_ORDER]);
  assert.deepEqual(Object.values(lock.dependencies).map(({ task }) => task),
    ['P5-07', 'P5-15', 'P5-23', 'P5-24', 'P5-25']);
  for (const [name, expectedPath] of Object.entries(EXPECTED_RELATIVE_PATHS)) {
    const binding = lock.dependencies[name];
    assert.equal(binding.relativePath, expectedPath, name);
    assert.equal(binding.path, undefined, name);
    assert.match(binding.commit, /^[0-9a-f]{40}$/u, name);
    assert.match(binding.fileSha256, /^[0-9a-f]{64}$/u, name);
    assert.equal(posix.isAbsolute(binding.relativePath)
      || win32.isAbsolute(binding.relativePath), false, name);
    assert.equal(existsSync(resolve(backendRoot, binding.relativePath)), false, name);
    assert.equal(existsSync(resolve(repositoryRoot, binding.relativePath)), false, name);
  }
  assert.match(lock.dependencies.followAcceptance.evidenceDigest ?? '', /^[0-9a-f]{64}$/u);
  assert.match(lock.dependencies.feedAcceptance.evidenceDigest ?? '', /^[0-9a-f]{64}$/u);
  assert.match(lock.dependencies.notificationAcceptance.evidenceDigest ?? '', /^[0-9a-f]{64}$/u);
  assert.match(lock.dependencies.feedOperations.capacityDigest ?? '', /^[0-9a-f]{64}$/u);
  assert.match(lock.dependencies.feedOperations.migrationDigest ?? '', /^[0-9a-f]{64}$/u);
  assert.match(lock.dependencies.feedOperations.feedOperationsSourceDigest ?? '', /^[0-9a-f]{64}$/u);
  assert.match(lock.dependencies.notificationOperations.capacityDigest ?? '', /^[0-9a-f]{64}$/u);
  assert.match(lock.dependencies.notificationOperations.migrationDigest ?? '', /^[0-9a-f]{64}$/u);
  assert.equal(
    lock.dependencies.notificationOperations.migrationHead,
    '202608011000_nodes_live_sibling_position_c_idx',
  );
  assert.match(
    lock.dependencies.notificationOperations.notificationAcceptanceSourceDigest ?? '',
    /^[0-9a-f]{64}$/u,
  );
  const committed = loadCommittedEvidenceLock({ backendDirectory: backendRoot });
  assert.equal(committed.lockDigest, LOCKED_EVIDENCE_SHA256);
});

test('R5-17 runner and docs stay portable and hard-bind the lock digest', () => {
  const runner = readSource('scripts/phase5-free-social-acceptance.mjs');
  const dependencies = readSource('scripts/phase5-free-social-dependencies.mjs');
  const evidence = readSource('docs/evidence/phase5-free-social-acceptance-2026-07-29.md');
  for (const source of [runner, dependencies, evidence]) {
    assert.match(source, /KNOWN_PHASE5_EVIDENCE_ROOT/u);
    assert.doesNotMatch(source, /Users\\\\white\\\\Desktop/u);
    assert.doesNotMatch(source, /AppData\\\\Local\\\\Temp/u);
    assert.doesNotMatch(source, /C:\\\\Users\\\\white/u);
  }
  // relativePath binding lives in the shared verifier + docs; runner delegates to it.
  assert.match(dependencies, /relativePath/u);
  assert.match(evidence, /relativePath/u);
  assert.match(dependencies, new RegExp(LOCKED_EVIDENCE_SHA256, 'u'));
  assert.match(runner, /phase5-free-social-dependencies\.mjs/u);
  assert.match(evidence, /verify:phase5:free-social-dependencies/u);
  assert.match(evidence, /p5-07\/phase5-follow-acceptance\.json/u);
  assert.match(evidence, /p5-15\/phase5-feed-acceptance\.json/u);
  assert.match(evidence, /p5-23\/phase5-notification-acceptance\.json/u);
  assert.match(evidence, /p5-24\/phase5-feed-operations-status\.json/u);
  assert.match(evidence, /p5-25\/phase5-notification-operations-status\.json/u);
  assert.match(evidence, /202608011000_nodes_live_sibling_position_c_idx/u);
  const status = readSource('docs/09-phase-execution-status.md');
  assert.doesNotMatch(status, /a60270927496e6e5c1ce0bd10d8a416024de3691/u);
});

if (hasProvisionedEvidence) {
test('R5-17 validates all five remediated dependencies from a temporary evidence root', () => {
  const sourceRoot = requireEvidenceBundleRoot();
  const evidenceRoot = makeOutsideRoot('known-r5-17-success-');
  try {
    copyBundleInto(evidenceRoot, sourceRoot);
    const records = validateLockedDependencies({
      expectedCommit: headCommit(),
      evidenceRoot,
      repositoryDirectory: repositoryRoot,
      backendDirectory: backendRoot,
    });
    assert.equal(records.length, 5);
    assert.deepEqual(records.map((item) => item.task),
      ['P5-07', 'P5-15', 'P5-23', 'P5-24', 'P5-25']);
    for (const record of records) {
      assert.match(record.fileSha256, /^[0-9a-f]{64}$/u);
      assert.match(record.contentDigest, /^[0-9a-f]{64}$/u);
      assert.match(record.sourceBindingDigest, /^[0-9a-f]{64}$/u);
      assert.equal('absolutePath' in record, false);
    }
  } finally {
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

test('R5-17 replays identical dependency validation from a second temporary evidence root', () => {
  const sourceRoot = requireEvidenceBundleRoot();
  const rootA = makeOutsideRoot('known-r5-17-replay-a-');
  const rootB = makeOutsideRoot('known-r5-17-replay-b-');
  try {
    copyBundleInto(rootA, sourceRoot);
    copyBundleInto(rootB, sourceRoot);
    const expectedCommit = headCommit();
    const recordsA = validateLockedDependencies({
      expectedCommit, evidenceRoot: rootA,
      repositoryDirectory: repositoryRoot, backendDirectory: backendRoot,
    });
    const recordsB = validateLockedDependencies({
      expectedCommit, evidenceRoot: rootB,
      repositoryDirectory: repositoryRoot, backendDirectory: backendRoot,
    });
    assert.deepEqual(recordsA, recordsB);
  } finally {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
}, 30_000);

for (const [name, relativePath] of Object.entries(EXPECTED_RELATIVE_PATHS)) {
  test(`R5-17 fails closed when ${name} is missing`, () => {
    const sourceRoot = requireEvidenceBundleRoot();
    const evidenceRoot = makeOutsideRoot(`known-r5-17-missing-${name}-`);
    try {
      copyBundleInto(evidenceRoot, sourceRoot);
      rmSync(resolve(evidenceRoot, ...relativePath.split('/')), { force: true });
      assert.throws(() => validateLockedDependencies({
        expectedCommit: headCommit(),
        evidenceRoot,
        repositoryDirectory: repositoryRoot,
        backendDirectory: backendRoot,
      }), /missing|not found|does not exist/iu);
    } finally {
      rmSync(evidenceRoot, { recursive: true, force: true });
    }
  });
}

test('R5-17 fails closed when a dependency artifact is replaced', () => {
  const sourceRoot = requireEvidenceBundleRoot();
  const evidenceRoot = makeOutsideRoot('known-r5-17-replaced-');
  try {
    copyBundleInto(evidenceRoot, sourceRoot);
    writeFileSync(
      resolve(evidenceRoot, ...EXPECTED_RELATIVE_PATHS.followAcceptance.split('/')),
      `${JSON.stringify({ format: 'known.phase5.follow-acceptance.v1', accepted: false }, null, 2)}\n`,
    );
    assert.throws(() => validateLockedDependencies({
      expectedCommit: headCommit(),
      evidenceRoot,
      repositoryDirectory: repositoryRoot,
      backendDirectory: backendRoot,
    }), /SHA-256 mismatch|digest mismatch|replaced/iu);
  } finally {
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

test('R5-17 fails closed on dependency file digest mismatch', () => {
  const sourceRoot = requireEvidenceBundleRoot();
  const evidenceRoot = makeOutsideRoot('known-r5-17-digest-');
  try {
    copyBundleInto(evidenceRoot, sourceRoot);
    const target = resolve(evidenceRoot, ...EXPECTED_RELATIVE_PATHS.feedAcceptance.split('/'));
    const original = readFileSync(target);
    writeFileSync(target, Buffer.concat([original, Buffer.from('\n')]));
    assert.throws(() => validateLockedDependencies({
      expectedCommit: headCommit(),
      evidenceRoot,
      repositoryDirectory: repositoryRoot,
      backendDirectory: backendRoot,
    }), /SHA-256 mismatch|digest mismatch/iu);
  } finally {
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

test('R5-17 fails closed on wrong dependency ancestry', () => {
  const sourceRoot = requireEvidenceBundleRoot();
  const evidenceRoot = makeOutsideRoot('known-r5-17-ancestry-');
  try {
    copyBundleInto(evidenceRoot, sourceRoot);
    const nonDescendant = '0000000000000000000000000000000000000001';
    assert.throws(() => validateLockedDependencies({
      expectedCommit: nonDescendant,
      evidenceRoot,
      repositoryDirectory: repositoryRoot,
      backendDirectory: backendRoot,
    }), /ancestor/iu);
  } finally {
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

test('R5-17 fails closed on wrong operations source binding', () => {
  const sourceRoot = requireEvidenceBundleRoot();
  const evidenceRoot = makeOutsideRoot('known-r5-17-source-');
  try {
    copyBundleInto(evidenceRoot, sourceRoot);
    const relativePath = EXPECTED_RELATIVE_PATHS.feedOperations;
    const target = resolve(evidenceRoot, ...relativePath.split('/'));
    const artifact = JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>;
    artifact.feedOperationsSourceDigest = '0'.repeat(64);
    const mutated = `${JSON.stringify(artifact, null, 2)}\n`;
    writeFileSync(target, mutated);
    const lock = readLock();
    const binding = { ...lock.dependencies.feedOperations };
    binding.fileSha256 = sha256(mutated);
    lock.dependencies.feedOperations = binding;
    assert.throws(() => validateLockedDependencies({
      expectedCommit: headCommit(),
      evidenceRoot,
      repositoryDirectory: repositoryRoot,
      backendDirectory: backendRoot,
      lock,
      skipLockDigestCheck: true,
    }), /operations-source-digest-mismatch|source/iu);
  } finally {
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

test('R5-17 fails closed on wrong capacity digest binding', () => {
  const sourceRoot = requireEvidenceBundleRoot();
  const evidenceRoot = makeOutsideRoot('known-r5-17-capacity-');
  try {
    copyBundleInto(evidenceRoot, sourceRoot);
    const relativePath = EXPECTED_RELATIVE_PATHS.notificationOperations;
    const target = resolve(evidenceRoot, ...relativePath.split('/'));
    const artifact = JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>;
    artifact.capacityDigest = '1'.repeat(64);
    const mutated = `${JSON.stringify(artifact, null, 2)}\n`;
    writeFileSync(target, mutated);
    const lock = readLock();
    const binding = { ...lock.dependencies.notificationOperations };
    binding.fileSha256 = sha256(mutated);
    lock.dependencies.notificationOperations = binding;
    assert.throws(() => validateLockedDependencies({
      expectedCommit: headCommit(),
      evidenceRoot,
      repositoryDirectory: repositoryRoot,
      backendDirectory: backendRoot,
      lock,
      skipLockDigestCheck: true,
    }), /operations-capacity-digest-mismatch|capacity/iu);
  } finally {
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});
}

test('CI-live mode reads Phase 5 expected-commit env vars and rejects unknown modes', () => {
  assert.equal(parseDependencyMode(undefined), 'lock');
  assert.equal(parseDependencyMode(''), 'lock');
  assert.equal(parseDependencyMode(CI_LIVE_DEPENDENCY_MODE), CI_LIVE_DEPENDENCY_MODE);
  assert.throws(() => parseDependencyMode('lock-bypass'), /ci-live when set/u);
  assert.equal(
    readExpectedCommitFromEnv({ KNOWN_PHASE5_FOLLOW_EXPECTED_COMMIT: 'b'.repeat(40) }, repositoryRoot),
    'b'.repeat(40),
  );
  assert.equal(
    readExpectedCommitFromEnv({
      KNOWN_PHASE5_FREE_SOCIAL_EXPECTED_COMMIT: 'c'.repeat(40),
      KNOWN_PHASE5_FOLLOW_EXPECTED_COMMIT: 'b'.repeat(40),
    }, repositoryRoot),
    'c'.repeat(40),
  );
});

test('CI-live fixture mode accepts a complete five-artifact claim bundle', () => {
  const evidenceRoot = makeOutsideRoot('known-r5-17-ci-live-ok-');
  try {
    writeCiLiveFixtureBundle(evidenceRoot);
    const records = validateCiDownloadedDependencies({
      expectedCommit: 'a'.repeat(40),
      evidenceRoot,
      repositoryDirectory: repositoryRoot,
      backendDirectory: backendRoot,
      fixtureMode: true,
    });
    assert.equal(records.length, 5);
    assert.deepEqual(records.map((item) => item.task),
      ['P5-07', 'P5-15', 'P5-23', 'P5-24', 'P5-25']);
  } finally {
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

test('CI-live fixture mode fails closed when followEligible claim is missing', () => {
  const evidenceRoot = makeOutsideRoot('known-r5-17-ci-live-claim-');
  try {
    writeCiLiveFixtureBundle(evidenceRoot, { omitFollowEligible: true });
    assert.throws(() => validateCiDownloadedDependencies({
      expectedCommit: 'a'.repeat(40),
      evidenceRoot,
      repositoryDirectory: repositoryRoot,
      backendDirectory: backendRoot,
      fixtureMode: true,
    }), /followAcceptance dependency claim is missing/u);
    assert.throws(() => assertCiLiveDependencyClaims(
      ciLiveAcceptance('followAcceptance', { phase5Verified: false }),
      'followAcceptance',
    ), /followAcceptance dependency claim is missing/u);
    const result = runCiLiveVerifier(evidenceRoot);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /FAIL-CLOSED.*dependency claim is missing/iu);
  } finally {
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

test('CI-live fixture mode fails closed when a dependency artifact is missing', () => {
  const evidenceRoot = makeOutsideRoot('known-r5-17-ci-live-missing-');
  try {
    writeCiLiveFixtureBundle(evidenceRoot, { omitFeedFile: true });
    assert.throws(() => validateCiDownloadedDependencies({
      expectedCommit: 'a'.repeat(40),
      evidenceRoot,
      repositoryDirectory: repositoryRoot,
      backendDirectory: backendRoot,
      fixtureMode: true,
    }), /missing|does not exist/iu);
    const result = runCiLiveVerifier(evidenceRoot);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /FAIL-CLOSED.*(?:missing|does not exist)/iu);
  } finally {
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

test('lock-mode verify fail-closes without a provisioned evidence root', () => {
  const result = spawnSync(process.execPath, ['scripts/phase5-free-social-dependencies.mjs'], {
    cwd: backendRoot,
    env: Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key !== 'KNOWN_PHASE5_EVIDENCE_ROOT'),
    ),
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /FAIL-CLOSED.*KNOWN_PHASE5_EVIDENCE_ROOT/u);
});
