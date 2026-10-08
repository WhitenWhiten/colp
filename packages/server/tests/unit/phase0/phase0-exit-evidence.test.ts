import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import Fastify, { type FastifyBaseLogger } from 'fastify';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, test } from 'vitest';
import { inspectColpContractEvidence } from '../../../src/infrastructure/colp/contract-evidence.js';
import { runPerformanceBaseline } from '../../../scripts/evidence/performance-baseline.js';
import { createLogger, redactSensitiveText } from '../../../src/infrastructure/telemetry/index.js';

const root = resolve(import.meta.dirname, '../../..');

function runNodeScript(script: string, arguments_: readonly string[]) {
  return spawnSync(process.execPath, [resolve(root, script), ...arguments_], {
    cwd: root,
    encoding: 'utf8',
  });
}

test('COLP evidence uses only public conformance exports and claims no deployment profile', () => {
  const evidence = inspectColpContractEvidence();
  assert.equal(evidence.evidence, 'colp_public_contract');
  assert.equal(evidence.publicEntrypoint, '@know-n/colp/conformance');
  assert.ok(evidence.bundledEvidenceAvailable);
  assert.ok(evidence.requirementCount > 0);
  assert.ok(evidence.deploymentProbeCount > 0);
  assert.deepEqual(evidence.claimedProfiles, []);
});

test('performance baseline is repeatable and emits scale plus percentile evidence', () => {
  const result = runPerformanceBaseline({ iterations: 20, warmupIterations: 2, payloadItems: 3 });
  assert.equal(result.evidence, 'phase0_performance_baseline');
  assert.equal(result.dataScale.iterations, 20);
  assert.equal(result.dataScale.warmupIterations, 2);
  assert.equal(result.dataScale.payloadItems, 3);
  assert.ok(Number.isFinite(result.latencyMilliseconds.p50));
  assert.ok(Number.isFinite(result.latencyMilliseconds.p95));
  assert.ok(result.latencyMilliseconds.p95 >= result.latencyMilliseconds.p50);
});

test('structured logs redact credentials and raw request secrets', () => {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  createLogger('info', stream).info({
    req: { headers: { authorization: 'Bearer should-not-appear', cookie: 'session=hidden' } },
    databaseUrl: 'postgres://user:password@host/db',
    token: 'secret-token', // secret-scan: allow 'secret-token' -- intentional redaction sentinel
    rawHeaderPairs: [
      ['Authorization', 'Bearer raw-auth-value'],
      ['Cookie', 'session=raw-cookie-value'],
      ['X-CSRF-Token', 'raw-csrf-value'],
      ['Origin', 'https://known.example'],
    ],
  }, 'probe');
  const line = Buffer.concat(chunks).toString('utf8');
  assert.doesNotMatch(line, /should-not-appear|session=hidden|postgres:\/\/user:password|secret-token|raw-auth-value|raw-cookie-value|raw-csrf-value/);
  assert.match(line, /https:\/\/known\.example/);
  assert.ok((line.match(/\[REDACTED\]/g) ?? []).length >= 3);
});

test('Fastify request logs omit OIDC callback query secrets', async () => {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  const app = Fastify({
    loggerInstance: createLogger('info', stream) as FastifyBaseLogger,
  });
  app.get('/api/v1/auth/oidc/callback', async () => ({ ok: true }));

  await app.inject({
    method: 'GET',
    url: '/api/v1/auth/oidc/callback?state=raw-state-secret&code=raw-authorization-code',
  });
  await app.close();

  const output = Buffer.concat(chunks).toString('utf8');
  assert.doesNotMatch(output, /raw-state-secret|raw-authorization-code/);
  assert.match(output, /"url":"\/api\/v1\/auth\/oidc\/callback"/);
  assert.doesNotMatch(output, /"url":"[^"]*\?/);
});

test('handler error text redaction covers credentials before logging or persistence', () => {
  const cause = Object.assign(new Error(
    'postgres://known:db-password@localhost/known Authorization=Bearer handler-token',
  ), { code: 'ECONNREFUSED' });
  const redacted = redactSensitiveText(new TypeError('fetch failed', { cause }));
  assert.doesNotMatch(redacted, /db-password|handler-token/);
  assert.match(redacted, /\[REDACTED\]/);
  assert.match(redacted, /TypeError: fetch failed; cause: Error \[ECONNREFUSED\]/);
});

describe('Phase 0 evidence fixtures', () => {
  test('performance threshold fixture is versioned for PostgreSQL/Testcontainers evidence', () => {
    const fixture = JSON.parse(readFileSync(resolve(root, 'tests/fixtures/phase0/performance-baseline.json'), 'utf8')) as {
      environment: { runtime: string; database: string; measuredIterations: number };
      thresholds: Record<string, number>;
    };
    assert.equal(fixture.environment.runtime, 'node-22');
    assert.equal(fixture.environment.database, 'postgresql-testcontainers');
    assert.ok(fixture.environment.measuredIterations >= 20);
    for (const value of Object.values(fixture.thresholds)) assert.ok(value > 0);

    const schema = JSON.parse(readFileSync(resolve(root, 'tests/fixtures/phase0/performance-baseline.schema.json'), 'utf8'));
    const validate = new Ajv2020({ strict: true }).compile(schema);
    assert.equal(validate(fixture), true, JSON.stringify(validate.errors));
  });

  test('fixture directories include both allowed and rejected boundary examples', () => {
    for (const path of [
      'tests/fixtures/phase0/imports/safe/modules/application.ts',
      'tests/fixtures/phase0/imports/unsafe/modules/application.ts',
      'tests/fixtures/phase0/secrets/safe/README.txt',
      'tests/fixtures/phase0/secrets/unsafe/README.txt',
    ]) assert.ok(readFileSync(resolve(root, path), 'utf8').length > 0, path);
  });

  test('import boundary checker accepts the safe fixture and rejects framework leakage', () => {
    const safe = runNodeScript('scripts/check-import-boundaries.mjs', [
      '--root', resolve(root, 'tests/fixtures/phase0/imports/safe'),
    ]);
    assert.equal(safe.status, 0, safe.stderr);

    const unsafe = runNodeScript('scripts/check-import-boundaries.mjs', [
      '--root', resolve(root, 'tests/fixtures/phase0/imports/unsafe'),
    ]);
    assert.notEqual(unsafe.status, 0);
    assert.match(unsafe.stderr, /framework\/database package/);

    for (const fixture of ['indirect', 'deep']) {
      const result = runNodeScript('scripts/check-import-boundaries.mjs', [
        '--root', resolve(root, `tests/fixtures/phase0/imports/${fixture}`),
      ]);
      assert.notEqual(result.status, 0, `${fixture} fixture must be rejected`);
    }
  });

  test('secret scanner accepts documentation and rejects credential material', () => {
    const safe = runNodeScript('scripts/scan-secrets.mjs', [
      '--root', resolve(root, 'tests/fixtures/phase0/secrets/safe'),
    ]);
    assert.equal(safe.status, 0, safe.stderr);

    const unsafeDir = mkdtempSync(join(tmpdir(), 'phase0-secrets-unsafe-'));
    const scopedDir = mkdtempSync(join(tmpdir(), 'phase0-secrets-scoped-'));
    try {
      const privateKeyHeader = '-----BEGIN ' + 'PRIVATE KEY-----';
      writeFileSync(
        join(unsafeDir, 'README.txt'),
        `${privateKeyHeader}\nfixture-only-secret-material-that-must-be-rejected\n-----END PRIVATE KEY-----\n`,
      );
      const unsafe = runNodeScript('scripts/scan-secrets.mjs', ['--root', unsafeDir]);
      assert.notEqual(unsafe.status, 0);
      assert.match(unsafe.stderr, /possible secrets detected/);

      writeFileSync(
        join(scopedDir, 'probe.txt'),
        "password = 'fixture-value-that-is-explicitly-allowed' // secret-scan: allow 'fixture-value-that-is-explicitly-allowed'\napi_key = 'adjacent-fixture-value-must-still-be-rejected'\n",
      );
      const scopedAllow = runNodeScript('scripts/scan-secrets.mjs', ['--root', scopedDir]);
      assert.notEqual(scopedAllow.status, 0);
      assert.match(scopedAllow.stderr, /probe\.txt:2/);
    } finally {
      rmSync(unsafeDir, { recursive: true, force: true });
      rmSync(scopedDir, { recursive: true, force: true });
    }
  });

  test('CI exposes containerized database, migration, fault, scan and COLP evidence commands', () => {
    const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    assert.equal(packageJson.devDependencies['@testcontainers/postgresql'], '12.0.4');
    for (const command of [
      'test:integration', 'db:migration-smoke', 'probe:transaction-faults',
      'probe:runtime', 'check:colp-contract', 'check:ledger-authority', 'scan:dependencies', 'scan:secrets',
      'benchmark:phase0', 'ci:static', 'ci:docker',
    ]) assert.ok(packageJson.scripts[command], command);
    assert.equal(
      packageJson.scripts['ci:docker'],
      'node scripts/with-postgres.mjs -- npm run ci:docker:inner',
    );
    const inner = packageJson.scripts['ci:docker:inner'];
    assert.match(inner, /test:integration:inner/);
    assert.match(inner, /test:unit:coverage:inner/);
    assert.match(packageJson.scripts['test:unit:coverage:inner'] ?? '', /test:integration:coverage:collect:inner/);
    assert.match(inner, /ci:probes:inner/);
    const probes = packageJson.scripts['ci:probes:inner'];
    assert.match(probes, /db:migration-smoke:inner/);
    assert.match(probes, /probe:transaction-faults:inner/);
    assert.match(probes, /probe:startup-readiness:inner/);
  });
});
