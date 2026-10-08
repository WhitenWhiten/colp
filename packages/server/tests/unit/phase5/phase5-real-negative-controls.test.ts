import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import Ajv2020 from 'ajv/dist/2020.js';
import { test } from 'vitest';
import {
  FILESYSTEM_NEGATIVE_CONTROL_IDS,
  NEGATIVE_CONTROL_IDS,
  NEGATIVE_CONTROL_MODE,
  assertProductionBindingsAt,
  digestProductionBindingsAt,
  exerciseRealSourceNegativeControl,
  listProductionBindingRelativePaths,
} from '../../../scripts/phase5-real-negative-controls.mjs';

const backendRoot = resolve(import.meta.dirname, '../../..');
const repositoryRoot = resolve(backendRoot, '..');
const runnerPath = resolve(backendRoot, 'scripts/phase5-free-social-acceptance.mjs');

function readSource(relativePath: string): string {
  return readFileSync(resolve(backendRoot, relativePath), 'utf8');
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

test('R5-11 exposes supporting real-negative-controls focused gate without postgres wrapper', () => {
  const packageJson = JSON.parse(readSource('package.json')) as {
    scripts: Record<string, string>;
  };
  assert.equal(
    packageJson.scripts['test:phase5:real-negative-controls'],
    'vitest run tests/unit/phase5/phase5-real-negative-controls.test.ts',
  );
  assert.equal(
    /with-postgres/u.test(packageJson.scripts['test:phase5:real-negative-controls'] ?? ''),
    false,
  );
});

test('R5-11 closed schema freezes real temporary source corruption contract', () => {
  const schema = JSON.parse(
    readSource('tests/fixtures/phase5/remediation/r5-11-real-negative-controls.schema.json'),
  ) as {
    additionalProperties: boolean;
    required: readonly string[];
    properties: {
      format: { const: string };
      task: { const: string };
      mode: { const: string };
      controlCount: { const: number };
      filesystemControls: { prefixItems: ReadonlyArray<{ const: string }> };
      rules: { properties: Record<string, { const: boolean }> };
    };
  };
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.format.const, 'known.phase5.remediation.r5-11.v1');
  assert.equal(schema.properties.task.const, 'R5-11');
  assert.equal(schema.properties.mode.const, 'real-temporary-source-corruption');
  assert.equal(schema.properties.controlCount.const, 21);
  assert.deepEqual(
    schema.properties.filesystemControls.prefixItems.map((item) => item.const),
    [...FILESYSTEM_NEGATIVE_CONTROL_IDS],
  );
  for (const key of ['format', 'task', 'mode', 'controlCount', 'filesystemControls', 'rules']) {
    assert.ok(schema.required.includes(key), `schema must require ${key}`);
  }
  for (const rule of [
    'verifierAcceptsExplicitRepositoryRoot',
    'corruptOnTemporaryBindingCopy',
    'forbidEmptyStringSimulation',
    'forbidManualBooleanSimulation',
    'forbidCheckoutMutation',
    'forbidGitResetRecovery',
    'forbidFullBrowserStackPerControl',
    'failClosedOnIncompleteCopy',
    'failClosedOnWrongFileCorruption',
    'failClosedOnMultiBoundaryCorruption',
    'failClosedOnUnwritableTemp',
    'failClosedOnCleanupFailure',
    'failClosedOnUnexpectedPass',
    'logsMustNotLeakCorruptedContent',
  ]) {
    assert.equal(schema.properties.rules.properties[rule]?.const, true, rule);
  }
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
  assert.equal(validate({ format: 'known.phase5.remediation.r5-11.v1', task: 'R5-11' }), false);
});

test('R5-11 module freezes mode and forbids empty-string / boolean simulation helpers', () => {
  assert.equal(NEGATIVE_CONTROL_MODE, 'real-temporary-source-corruption');
  assert.equal(NEGATIVE_CONTROL_IDS.length, 21);
  assert.equal(new Set(NEGATIVE_CONTROL_IDS).size, 21);
  assert.deepEqual([...FILESYSTEM_NEGATIVE_CONTROL_IDS], [
    'missing-follow-route',
    'missing-feed-handler',
    'missing-notification-migration',
    'generated-client-drift',
    'missing-browser-artifact',
    'monetization-present',
    'manifest-write-present',
  ]);
  const moduleSource = readSource('scripts/phase5-real-negative-controls.mjs');
  const runner = readSource('scripts/phase5-free-social-acceptance.mjs');
  for (const source of [moduleSource, runner]) {
    assert.doesNotMatch(source, /assertProductionBindings\(\s*\{\s*\w+\s*:\s*['`]{0,2}\s*['`]/u);
    assert.doesNotMatch(source, /assertProductionBindings\(\s*\{\s*[^}]*:\s*''\s*/u);
    assert.doesNotMatch(source, /followRoute:\s*['"`]\s*['"`]/u);
    assert.doesNotMatch(source, /feedHandler:\s*['"`]\s*['"`]/u);
    assert.doesNotMatch(source, /generatedClient:\s*['"`]\s*['"`]/u);
    assert.doesNotMatch(source, /notificationMigration:\s*['"`]\s*['"`]/u);
    assert.doesNotMatch(source, /monetizationSurface:\s*['"`]billing/u);
    assert.doesNotMatch(source, /\bmanual(?:ly)?\s+passed\b/iu);
    assert.doesNotMatch(source, /git\s+reset\b|gitReset|reset\s+--hard/iu);
  }
  // Source controls must not disguise themselves as 21 full browser-stack runs.
  assert.doesNotMatch(moduleSource, /test:e2e:real-stack|playwright\.real-stack|chromium\.launch/iu);
  assert.match(moduleSource, /assertProductionBindingsAt/u);
  assert.match(moduleSource, /mkdtemp|temporary/iu);
  assert.match(runner, /phase5-real-negative-controls\.mjs/u);
  assert.match(runner, /assertProductionBindingsAt|exerciseRealSourceNegativeControl/u);
  assert.match(runner, /FILESYSTEM_NEGATIVE_CONTROL_IDS/u);
});

test('R5-11 filesystem verifier accepts an explicit repository root and passes a clean checkout copy', () => {
  assert.doesNotThrow(() => assertProductionBindingsAt(repositoryRoot));
  const paths = listProductionBindingRelativePaths();
  assert.ok(paths.includes('Known-Backend/src/transport/product/follow-routes.ts'));
  assert.ok(paths.includes('Known-Backend/src/infrastructure/social/feed-worker-route.ts'));
  assert.ok(paths.includes('Known-Backend/migrations/202607290200_notification_authority.ts'));
  assert.ok(paths.includes('Known-Backend/generated/openapi/product-v1.client.ts'));
  assert.ok(paths.includes('Known-Frontend/web/e2e-real-stack/follow-workflows.spec.ts'));
  assert.ok(paths.includes('Known-Backend/src/transport/product/feed-routes.ts'));
});

test('R5-11 detects monetization in social OpenAPI and a migration named for another feature', () => {
  const copy = mkdtempSync(join(tmpdir(), 'known-r5-11-social-scope-'));
  try {
    for (const relativePath of listProductionBindingRelativePaths()) {
      const destination = resolve(copy, relativePath);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(resolve(repositoryRoot, relativePath), destination, { recursive: true });
    }
    const openApiPath = resolve(copy, 'Known-Backend/openapi/product-v1.yaml');
    const openApi = readFileSync(openApiPath, 'utf8');
    const changed = openApi.replace(
      'summary: Follow a live discoverable Profile exactly once',
      'summary: paid_subscription Follow a live discoverable Profile exactly once',
    );
    assert.notEqual(changed, openApi);
    writeFileSync(openApiPath, changed);
    assert.throws(() => assertProductionBindingsAt(copy), /monetization-present/u);

    writeFileSync(openApiPath, openApi);
    const migration = resolve(copy, 'Known-Backend/migrations/202612010000_access_mode.ts');
    writeFileSync(migration, 'CREATE TABLE follows (paid_subscription text);\n');
    assert.throws(() => assertProductionBindingsAt(copy), /monetization-present/u);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

test('R5-11 real source control deletes the Follow route on a temp copy and preserves checkout digest', async () => {
  const start = digestProductionBindingsAt(repositoryRoot);
  await assert.rejects(
    () => exerciseRealSourceNegativeControl('missing-follow-route', { sourceRoot: repositoryRoot }),
    (error: unknown) => error instanceof Error && error.message === 'missing-follow-route',
  );
  const end = digestProductionBindingsAt(repositoryRoot);
  assert.equal(end, start);
  assert.equal(
    existsSync(resolve(repositoryRoot, 'Known-Backend/src/transport/product/follow-routes.ts')),
    true,
  );
});

for (const controlId of FILESYSTEM_NEGATIVE_CONTROL_IDS) {
  test(`R5-11 filesystem control ${controlId} fails closed on a temporary binding copy`, async () => {
    const start = digestProductionBindingsAt(repositoryRoot);
    await assert.rejects(
      () => exerciseRealSourceNegativeControl(controlId, { sourceRoot: repositoryRoot }),
      (error: unknown) => error instanceof Error && error.message === controlId,
    );
    assert.equal(digestProductionBindingsAt(repositoryRoot), start);
  });
}

for (const fault of NEGATIVE_CONTROL_IDS) {
  test(`R5-11 executable negative control ${fault} exits non-zero with unique id and no acceptance`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'known-r5-11-out-'));
    const forbiddenOutput = join(directory, 'acceptance.json');
    try {
      const start = digestProductionBindingsAt(repositoryRoot);
      const result = spawnSync(process.execPath, [runnerPath, '--negative-control', fault], {
        cwd: backendRoot,
        env: {
          ...process.env,
          KNOWN_PHASE5_FREE_SOCIAL_ACCEPTANCE_TEST_CONTROL: 'enabled',
          KNOWN_PHASE5_FREE_SOCIAL_ACCEPTANCE_OUTPUT: forbiddenOutput,
        },
        encoding: 'utf8',
        timeout: 60_000,
        windowsHide: true,
      });
      const combined = `${result.stdout}${result.stderr}`;
      assert.notEqual(result.status, 0, fault);
      assert.match(combined, new RegExp(`FAIL-CLOSED.*${escapeRegExp(fault)}`, 'u'), fault);
      assert.doesNotMatch(combined, /"accepted"\s*:\s*true/u);
      assert.equal(existsSync(forbiddenOutput), false, fault);
      assert.equal(digestProductionBindingsAt(repositoryRoot), start, fault);
      // Corrupted payload markers must not leak into control logs.
      assert.doesNotMatch(combined, /billing subscription entitlement paywall/iu);
      assert.doesNotMatch(combined, /assertProfileClaims manifestMutation/iu);
      assert.doesNotMatch(combined, /private-marker-p526-leak/iu);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('R5-11 fails closed when the temporary binding copy is incomplete', async () => {
  await assert.rejects(
    () => exerciseRealSourceNegativeControl('missing-follow-route', {
      sourceRoot: repositoryRoot,
      omitRelativePaths: ['Known-Backend/src/transport/app.ts'],
    }),
    (error: unknown) => error instanceof Error
      && /incomplete|copy|binding/iu.test(error.message)
      && error.message !== 'missing-follow-route',
  );
});

test('R5-11 fails closed when the wrong binding file is corrupted', async () => {
  await assert.rejects(
    () => exerciseRealSourceNegativeControl('missing-follow-route', {
      sourceRoot: repositoryRoot,
      corruptRelativePaths: ['Known-Backend/generated/openapi/product-v1.client.ts'],
    }),
    (error: unknown) => error instanceof Error
      && error.message !== 'missing-follow-route'
      && /wrong|boundary|unexpectedly remained valid|did not fail|owned/iu.test(error.message),
  );
});

test('R5-11 fails closed when two owned boundaries are corrupted together', async () => {
  await assert.rejects(
    () => exerciseRealSourceNegativeControl('missing-follow-route', {
      sourceRoot: repositoryRoot,
      corruptRelativePaths: [
        'Known-Backend/src/transport/product/follow-routes.ts',
        'Known-Backend/src/infrastructure/social/feed-worker-route.ts',
      ],
    }),
    (error: unknown) => error instanceof Error
      && error.message !== 'missing-follow-route'
      && /multi|multiple|boundary|owned|unique/iu.test(error.message),
  );
});

test('R5-11 fails closed when the temporary directory is not writable', async () => {
  await assert.rejects(
    () => exerciseRealSourceNegativeControl('missing-follow-route', {
      sourceRoot: repositoryRoot,
      tempRootFactory: () => {
        throw new Error('temporary binding root is not writable');
      },
    }),
    (error: unknown) => error instanceof Error
      && /not writable|temporary/iu.test(error.message)
      && error.message !== 'missing-follow-route',
  );
});

test('R5-11 fails closed when temporary copy cleanup fails after an expected control failure', async () => {
  await assert.rejects(
    () => exerciseRealSourceNegativeControl('missing-follow-route', {
      sourceRoot: repositoryRoot,
      cleanup: async () => {
        throw new Error('temporary binding cleanup failed');
      },
    }),
    (error: unknown) => error instanceof Error
      && /cleanup/iu.test(error.message)
      && error.message !== 'missing-follow-route',
  );
});

test('R5-11 fails closed when a filesystem control unexpectedly remains valid', async () => {
  await assert.rejects(
    () => exerciseRealSourceNegativeControl('missing-follow-route', {
      sourceRoot: repositoryRoot,
      corruptRelativePaths: [],
    }),
    (error: unknown) => error instanceof Error
      && /unexpectedly remained valid/iu.test(error.message),
  );
});

test('R5-11 remediation contract freezes real-temporary-source-corruption mode', () => {
  const contract = JSON.parse(readSource('tests/fixtures/phase5/free-social-contract.v1.json')) as {
    remediation: {
      evidence: {
        negativeControls: {
          mode: string;
          forbidEmptyStringSimulation: boolean;
          forbidManualBooleanSimulation: boolean;
        };
      };
      tasks: ReadonlyArray<{ id: string; publicCommands: string[] }>;
    };
  };
  assert.equal(contract.remediation.evidence.negativeControls.mode, 'real-temporary-source-corruption');
  assert.equal(contract.remediation.evidence.negativeControls.forbidEmptyStringSimulation, true);
  assert.equal(contract.remediation.evidence.negativeControls.forbidManualBooleanSimulation, true);
  const task = contract.remediation.tasks.find((entry) => entry.id === 'R5-11');
  assert.ok(task);
  assert.deepEqual(task?.publicCommands, ['npm run test:phase5:real-negative-controls']);
});

test('R5-11 evidence document records real temporary source corruption for owned layers', () => {
  const evidence = readSource('docs/evidence/phase5-free-social-acceptance-2026-07-29.md');
  assert.match(evidence, /real.?temporary|temporary.?source|binding copy|owned layer/iu);
  assert.match(evidence, /missing-follow-route|negative control/iu);
  assert.doesNotMatch(evidence, /assertProductionBindings\(\{\s*field:\s*''\}\)/u);
});

test('R5-11 control logs redact corrupted payload and keep checkout bindings byte-stable', async () => {
  const beforeFollow = readFileSync(
    resolve(repositoryRoot, 'Known-Backend/src/transport/product/follow-routes.ts'),
  );
  const beforeDigest = sha256(beforeFollow);
  let thrown: Error | undefined;
  try {
    await exerciseRealSourceNegativeControl('monetization-present', { sourceRoot: repositoryRoot });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }
  assert.ok(thrown);
  assert.equal(thrown?.message, 'monetization-present');
  assert.doesNotMatch(thrown?.message ?? '', /billing|subscription|entitlement|paywall/iu);
  assert.equal(
    sha256(readFileSync(resolve(repositoryRoot, 'Known-Backend/src/transport/product/follow-routes.ts'))),
    beforeDigest,
  );
});
