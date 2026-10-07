import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, resolve, win32 } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'vitest';

const backendRoot = resolve(import.meta.dirname, '../../..');
const repositoryRoot = resolve(backendRoot, '..');
const runnerPath = resolve(backendRoot, 'scripts/phase5-free-social-acceptance.mjs');

test('P5-26 exposes one final fail-closed runner and a focused command', () => {
  const packageJson = JSON.parse(readFileSync(resolve(backendRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(packageJson.scripts['test:phase5:free-social-acceptance:contract'],
    'vitest run --project evidence tests/unit/phase5/phase5-free-social-acceptance-contract.test.ts tests/unit/phase5/phase5-free-social-dependencies.test.ts');
  assert.equal(packageJson.scripts['evidence:phase5:free-social'],
    'node scripts/with-postgres.mjs -- node scripts/phase5-free-social-acceptance.mjs');
  assert.equal(packageJson.scripts['verify:phase5:free-social-dependencies'],
    'node scripts/phase5-free-social-dependencies.mjs');
  assert.match(packageJson.scripts['test:phase5:free-social:frontend:inner'] ?? '',
    /test:e2e:real-stack:free-social/u);
  const frontendPackage = JSON.parse(readFileSync(resolve(repositoryRoot,
    'Known-Frontend/web/package.json'), 'utf8')) as { scripts: Record<string, string> };
  assert.match(frontendPackage.scripts['test:e2e:real-stack:free-social'] ?? '', /--grep P5-/u);
  const runner = readFileSync(runnerPath, 'utf8');
  const dependenciesModule = readFileSync(resolve(backendRoot,
    'scripts/phase5-free-social-dependencies.mjs'), 'utf8');
  for (const required of [
    'known.phase5.free-social-acceptance.v1', 'KNOWN_PHASE5_FREE_SOCIAL_EXPECTED_COMMIT',
    'KNOWN_PHASE5_FREE_SOCIAL_ACCEPTANCE_OUTPUT', 'KNOWN_PHASE5_EVIDENCE_ROOT',
    'free-social-evidence-lock.v1.json', 'phase5-evidence-root.mjs',
    'phase5-free-social-dependencies.mjs',
    '202608011000_nodes_live_sibling_position_c_idx',
    '2efa433f3154d891fbe4c62c657b9e4c78aac6bdec2cbf62d69a16fdfc797178',
    'openapiDigest', 'generatedClientDigest',
    'eventContractDigest', 'runtimeConfigDigest', 'sourceTreeDigest', 'gateDigest',
    'dependencyDigest', 'negativeControlDigest', 'claimDigest', 'evidenceDigest',
    'PostgreSQL', 'Fastify', 'production Worker', 'Chromium', 'generated client',
    'reported a missing, skipped, retried, mocked, faked, in-memory or intercepted probe',
    'output path must be fresh and exclusive', 'source tree changed', 'FAIL-CLOSED',
    'KNOWN_PHASE5_FREE_SOCIAL_ACCEPTANCE_MODE', 'working-tree', 'workingTreeStateDigest',
    'process.execPath', 'npm_execpath', 'npmArguments',
    'gate failure output', 'phase5-real-negative-controls.mjs',
  ]) assert.match(runner, new RegExp(escapeRegExp(required), 'u'), required);
  assert.doesNotMatch(runner,
    /(?:from\s+['"][^'"]*tests\/support|import\s*\([^)]*tests\/support|new\s+(?:InMemory|MemoryRepository)|\b(?:page|context)\.route\s*\(|route\.fulfill\s*\()/iu);
  for (const required of [
    'resolveLockedArtifactPath', 'readLockRelativePath', 'assertResolvedArtifactStable',
    'sha256(bytes) !== binding.fileSha256', 'validateUpstreamAcceptance',
    'validateOperationsEvidence', 'assertAncestor',
  ]) {
    assert.match(dependenciesModule, new RegExp(escapeRegExp(required), 'u'), required);
  }
});

test('P5-26 closed schema binds complete proof chains and only the MVP claim is true', () => {
  const schema = JSON.parse(readFileSync(resolve(backendRoot,
    'tests/fixtures/phase5/free-social-acceptance-artifact.schema.json'), 'utf8')) as Record<string, unknown>;
  const production = (schema as {
    properties: { production: { properties: Record<string, unknown> } };
  }).properties.production.properties;
  assert.deepEqual(production.migrationHead,
    { const: '202608011000_nodes_live_sibling_position_c_idx' });
  assert.deepEqual(production.migrationDigest,
    { const: '2efa433f3154d891fbe4c62c657b9e4c78aac6bdec2cbf62d69a16fdfc797178' });
  const serialized = JSON.stringify(schema);
  for (const required of [
    'checkoutCommit', 'backendCommit', 'frontendCommit', 'colpCommit', 'sourceTreeDigest',
    'bindingMode', 'workingTreeStateDigest', 'cleanCheckout',
    'sourceTreeDigestStart', 'sourceTreeDigestEnd', 'workingTreeStateDigestStart',
    'workingTreeStateDigestEnd', 'cleanStart', 'cleanEnd',
    'migrationHead', 'migrationDigest', 'openapiDigest', 'generatedClientDigest',
    'eventContractVersion', 'eventContractDigest', 'runtimeConfigDigest',
    'postgresqlVersion', 'fastifyVersion', 'playwrightVersion', 'chromiumVersion',
    'followAcceptance', 'feedAcceptance', 'notificationAcceptance', 'feedOperations',
    'notificationOperations', 'dependencyDigest', 'gates', 'gateDigest', 'proofs',
    'evidenceClass', 'negativeControls', 'negativeControlDigest', 'proofDigest', 'claims', 'claimDigest', 'evidenceDigest',
    'freeSocialMvpEligible', 'phase5Verified', 'deploymentProven', 'colpProfile',
    'monetization', 'phase4', 'email', 'attachments', 'advancedDiscovery', 'mcpWrite',
    'billing', 'paidSubscription', 'productFeedWritesManifest',
  ]) assert.match(serialized, new RegExp(escapeRegExp(required), 'u'), required);
  assert.match(serialized, /"freeSocialMvpEligible":\{"const":true\}/u);
  for (const claim of ['phase5Verified', 'deploymentProven', 'colpProfile', 'monetization',
    'phase4', 'email', 'attachments', 'advancedDiscovery', 'mcpWrite', 'billing',
    'paidSubscription', 'productFeedWritesManifest']) {
    assert.match(serialized, new RegExp(`"${claim}":\\{"const":false\\}`, 'u'), claim);
  }
  assert.match(serialized, /additionalProperties":false/u);
  const negativeControls = (schema as {
    properties: { negativeControls: { minItems: number; maxItems: number } };
  }).properties.negativeControls;
  assert.deepEqual(negativeControls, {
    type: 'array', minItems: 21, maxItems: 21,
    items: { $ref: '#/$defs/negative' },
  });
});

test('P5-26 evidence lock contains five exact independently verifiable bindings', () => {
  const lockFile = resolve(backendRoot, 'tests/fixtures/phase5/free-social-evidence-lock.v1.json');
  const normalizedLock = readFileSync(lockFile, 'utf8').replaceAll('\r\n', '\n');
  const lock = JSON.parse(normalizedLock) as {
      dependencies: Record<string, {
        task: string;
        commit: string;
        relativePath: string;
        path?: string;
        fileSha256: string;
      }>;
    };
  const runner = readFileSync(runnerPath, 'utf8');
  const dependenciesModule = readFileSync(resolve(backendRoot,
    'scripts/phase5-free-social-dependencies.mjs'), 'utf8');
  const lockDigest = createHash('sha256').update(normalizedLock).digest('hex');
  assert.match(dependenciesModule, new RegExp(lockDigest, 'u'));
  assert.match(runner, /LOCKED_EVIDENCE_SHA256|phase5-free-social-dependencies\.mjs/u);
  for (const required of [
    'KNOWN_PHASE5_EVIDENCE_ROOT', 'resolveEvidenceRootFromEnv', 'resolveLockedArtifactPath',
    'readLockRelativePath', 'assertResolvedArtifactStable',
    'sha256(bytes) !== binding.fileSha256', 'validateUpstreamAcceptance',
    'validateOperationsEvidence', 'assertAncestor',
    'phase5-real-negative-controls.mjs', 'exerciseRealSourceNegativeControl',
    'assertProductionBindingsAt',
  ]) {
    const haystack = `${runner}\n${dependenciesModule}`;
    assert.match(haystack, new RegExp(escapeRegExp(required), 'u'), required);
  }
  assert.doesNotMatch(runner, /binding\.path\b/u);
  assert.doesNotMatch(runner, /assertProductionBindings\(\s*\{/u);
  assert.doesNotMatch(runner, /followRoute:\s*['"`]\s*['"`]/u);
  assert.deepEqual(Object.values(lock.dependencies).map(({ task }) => task),
    ['P5-07', 'P5-15', 'P5-23', 'P5-24', 'P5-25']);
  for (const dependency of Object.values(lock.dependencies)) {
    assert.match(dependency.commit, /^[0-9a-f]{40}$/u);
    assert.match(dependency.fileSha256, /^[0-9a-f]{64}$/u);
    assert.equal(dependency.path, undefined);
    assert.equal(posix.isAbsolute(dependency.relativePath)
      || win32.isAbsolute(dependency.relativePath), false);
  }
});

for (const fault of [
  'missing-follow-route', 'missing-feed-handler', 'missing-notification-migration',
  'generated-client-drift', 'missing-browser-artifact', 'monetization-present',
  'manifest-write-present', 'colp-profile-claim', 'phase4-claim', 'source-mismatch',
  'dependency-digest-mismatch', 'artifact-digest-mismatch', 'stale-artifact',
  'reused-output-path', 'skip-marker', 'mock-or-in-memory-marker', 'unexplained-retry',
  'operations-capacity-digest-mismatch', 'operations-migration-digest-mismatch',
  'operations-source-digest-mismatch',
  'sensitive-value-leak',
] as const) {
  test(`P5-26 executable negative control ${fault} exits non-zero`, () => {
    const result = spawnSync(process.execPath, [runnerPath, '--negative-control', fault], {
      cwd: backendRoot,
      env: { ...process.env, KNOWN_PHASE5_FREE_SOCIAL_ACCEPTANCE_TEST_CONTROL: 'enabled' },
      encoding: 'utf8', timeout: 15_000, windowsHide: true,
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, new RegExp(`FAIL-CLOSED.*${escapeRegExp(fault)}`, 'u'));
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /"accepted"\s*:\s*true/u);
  });
}

test('P5-26 refuses an existing output and never overwrites it', () => {
  const directory = mkdtempSync(join(tmpdir(), 'known-p526-existing-'));
  const output = join(directory, 'artifact.json');
  writeFileSync(output, 'stale-evidence');
  try {
    const result = spawnSync(process.execPath, [runnerPath], { cwd: backendRoot,
      env: { ...process.env, KNOWN_PHASE5_FREE_SOCIAL_ACCEPTANCE_OUTPUT: output,
        KNOWN_PHASE5_FREE_SOCIAL_EXPECTED_COMMIT: '0'.repeat(40),
        KNOWN_PG_EVIDENCE_MODE: 'acceptance', DATABASE_URL: 'postgresql://invalid.invalid/unused' },
      encoding: 'utf8', timeout: 15_000, windowsHide: true });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /FAIL-CLOSED.*fresh and exclusive/u);
    assert.equal(readFileSync(output, 'utf8'), 'stale-evidence');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('P5-26 evidence document and authoritative status preserve the accepted claim boundary', () => {
  const evidence = readFileSync(resolve(backendRoot,
    'docs/evidence/phase5-free-social-acceptance-2026-07-29.md'), 'utf8');
  assert.match(evidence, /npm run evidence:phase5:free-social/u);
  assert.match(evidence, /keeps `phase5Verified=false`/iu);
  assert.match(evidence, /R5-18 seals authoritative Phase 5 status/iu);
  assert.match(evidence, /leaves target-environment deployment proof[\s\S]*outside its\s+claim/iu);
  assert.match(evidence, /clean exact-commit replay/iu);
  assert.match(evidence, /precommit[\s\S]*not the canonical/iu);
  const status = readFileSync(resolve(backendRoot, 'docs/09-phase-execution-status.md'), 'utf8');
  assert.match(status, /Phase 5[^\n]*\|\s*\*\*Verified\*\*\s*\|/iu);
  for (const field of [
    'Accepted checkout tip', 'Canonical relative path', 'File SHA-256',
    'evidenceDigest', 'gateDigest', 'proofDigest',
  ]) {
    const value = markdownTableValue(evidence, field);
    assert.ok(status.includes(value), `authoritative status misses ${field}`);
  }
  assert.match(status, /bindingMode=exact-commit/u);
  assert.match(status, /cleanCheckout=true/u);
  assert.match(status, /freeSocialMvpEligible=true/u);
  assert.match(status, /phase5Verified=false/u);
  assert.match(status, /(?:不是|非) `Deployment-proven`/u);
  assert.equal(existsSync(resolve(repositoryRoot, 'colp/manifest.json')), false);
});

function markdownTableValue(document: string, field: string): string {
  const row = document.split(/\r?\n/u).find((line) => line.startsWith(`| ${field} |`));
  assert.ok(row, `evidence table misses ${field}`);
  const value = row.split('|')[2]?.trim() ?? '';
  return /^`[^`]+`$/u.test(value) ? value.slice(1, -1) : value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
