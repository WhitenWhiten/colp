import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { test } from 'vitest';
import {
  backendRoot,
  createGeneratorFixture,
  operations,
  currentBreakingBaselinePath,
  readDocument,
  runGeneratorFixture,
  runNodeScript,
  type OpenApiDocument,
} from './openapi-contract-support.js';

test('OpenAPI CI exposes the immutable baseline, generated artifacts, and drift gates', () => {
  const packageJson = JSON.parse(readFileSync(join(backendRoot, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  for (const script of [
    'openapi:lint',
    'openapi:catalog',
    'openapi:examples',
    'openapi:generate',
    'openapi:drift',
    'openapi:breaking',
    'openapi:ci',
  ]) {
    assert.ok(packageJson.scripts?.[script], `missing CI command ${script}`);
  }

  for (const artifact of [
    'openapi/baselines/product-v1.0.1.0-draft.yaml',
    'openapi/baselines/product-v1.1.1.0.yaml',
    'openapi/baselines/product-v1.1.3.0.yaml',
    'openapi/baselines/product-v1.1.4.0.yaml',
    'openapi/baselines/product-v1.1.5.0.yaml',
    'openapi/baselines/product-v1.1.6.0.yaml',
    'openapi/baselines/product-v1.1.7.0.yaml',
    'openapi/baselines/product-v1.1.8.0.yaml',
    'openapi/baselines/product-v1.1.9.0.yaml',
    'openapi/baselines/product-v1.1.10.0.yaml',
    'openapi/baselines/product-v1.1.11.0.yaml',
    'openapi/baselines/product-v1.1.12.0.yaml',
    'openapi/baselines/product-v1.1.13.0.yaml',
    'openapi/baselines/product-v1.1.14.0.yaml',
    'openapi/baselines/product-v1.1.15.0.yaml',
    'openapi/baselines/product-v1.1.16.0.yaml',
    'openapi/baselines/product-v1.1.17.0.yaml',
    'openapi/baselines/product-v1.1.18.0.yaml',
    'openapi/baselines/product-v1.1.19.0.yaml',
    'openapi/baselines/product-v1.1.20.0.yaml',
    'openapi/baselines/product-v1.1.21.0.yaml',
    'openapi/baselines/product-v1.1.22.0.yaml',
    'openapi/baselines/product-v1.1.23.0.yaml',
    'openapi/baselines/product-v1.1.24.0.yaml',
    'openapi/baselines/product-v1.1.25.0.yaml',
    'openapi/baselines/product-v1.1.26.0.yaml',
    'openapi/baselines/product-v1.1.27.0.yaml',
    'openapi/baselines/product-v1.1.28.0.yaml',
    'openapi/baselines/product-v1.1.29.0.yaml',
    'openapi/baselines/product-v1.1.30.0.yaml',
    'openapi/baselines/product-v1.1.31.0.yaml',
    'openapi/baselines/product-v1.1.32.0.yaml',
    'openapi/baselines/product-v1.1.33.0.yaml',
    'openapi/baselines/product-v1.1.34.0.yaml',
    'openapi/baselines/product-v1.1.35.0.yaml',
    'openapi/baselines/product-v1.1.36.0.yaml',
    'openapi/baselines/product-v1.1.37.0.yaml',
    'openapi/baselines/product-v1.1.38.0.yaml',
    'openapi/baselines/product-v1.1.39.0.yaml',
    'openapi/baselines/product-v1.1.40.0.yaml',
    'openapi/baselines/product-v1.1.41.0.yaml',
    'openapi/baselines/product-v1.1.42.0.yaml',
    'openapi/baselines/product-v1.1.43.0.yaml',
    currentBreakingBaselinePath(),
    'generated/openapi/product-v1.bundle.yaml',
    'generated/openapi/product-v1.ts',
    'generated/openapi/product-v1.routes.json',
    'generated/openapi/product-v1.routes.ts',
    'generated/openapi/product-v1.client.ts',
  ]) {
    assert.equal(existsSync(join(backendRoot, artifact)), true, `missing ${artifact}`);
  }
});

test('manifest generation and catalog checks reject malformed sources and generated drift', () => {
  const fixtureRoot = createGeneratorFixture();
  const fixtureSource = join(fixtureRoot, 'openapi/product-v1.yaml');
  const fixtureDocument = readDocument(fixtureSource);
  const fixtureOperations = operations(fixtureDocument);
  const originalSource = readFileSync(fixtureSource, 'utf8');

  try {
    for (const artifact of ['product-v1.routes.json', 'product-v1.routes.ts', 'product-v1.client.ts']) {
      const artifactPath = join(fixtureRoot, 'generated/openapi', artifact);
      const originalArtifact = readFileSync(artifactPath, 'utf8');
      writeFileSync(artifactPath, `${originalArtifact}\n// drift`, 'utf8');
      const drift = runGeneratorFixture(fixtureRoot, ['--check']);
      assert.notEqual(drift.status, 0, `${artifact} drift must fail --check`);
      assert.match(`${drift.stderr}${drift.stdout}`, new RegExp(artifact.replace('.', '\\.')));
      writeFileSync(artifactPath, originalArtifact, 'utf8');
    }

    assert.ok(fixtureOperations[0]?.operation.operationId);
    assert.ok(fixtureOperations[1]);
    fixtureOperations[1].operation.operationId = fixtureOperations[0].operation.operationId;
    writeFileSync(fixtureSource, stringify(fixtureDocument), 'utf8');
    const duplicateGeneration = runGeneratorFixture(fixtureRoot, []);
    assert.notEqual(duplicateGeneration.status, 0);
    assert.match(
      `${duplicateGeneration.stderr}${duplicateGeneration.stdout}`,
      /Duplicate operationId|unique `operationId`/,
    );
    const duplicateCatalog = runNodeScript('scripts/check-openapi-catalog.mjs', [fixtureSource]);
    assert.notEqual(duplicateCatalog.status, 0);
    assert.match(`${duplicateCatalog.stderr}${duplicateCatalog.stdout}`, /Duplicate operationId/);

    const missingOperationDocument = parse(originalSource) as OpenApiDocument;
    const missingOperation = operations(missingOperationDocument)[0];
    assert.ok(missingOperation);
    delete missingOperation.operation.operationId;
    writeFileSync(fixtureSource, stringify(missingOperationDocument), 'utf8');
    const missingOperationGeneration = runGeneratorFixture(fixtureRoot, []);
    assert.notEqual(missingOperationGeneration.status, 0);
    assert.match(`${missingOperationGeneration.stderr}${missingOperationGeneration.stdout}`, /has no operationId/);
    const missingOperationCatalog = runNodeScript('scripts/check-openapi-catalog.mjs', [fixtureSource]);
    assert.notEqual(missingOperationCatalog.status, 0);
    assert.match(`${missingOperationCatalog.stderr}${missingOperationCatalog.stdout}`, /has no operationId/);

    const missingRouteDocument = parse(originalSource) as OpenApiDocument;
    const missingRoute = Object.keys(missingRouteDocument.paths)[0];
    assert.ok(missingRoute);
    delete missingRouteDocument.paths[missingRoute];
    writeFileSync(fixtureSource, stringify(missingRouteDocument), 'utf8');
    const missingRouteCatalog = runNodeScript('scripts/check-openapi-catalog.mjs', [fixtureSource]);
    assert.notEqual(missingRouteCatalog.status, 0);
    assert.match(`${missingRouteCatalog.stderr}${missingRouteCatalog.stdout}`, /Expected .* to use operationId/);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}, 120_000);

test('breaking diff rejects path, requiredness, enum, status, and header regressions', () => {
  const fixtureRoot = join(backendRoot, 'tests/fixtures/openapi/breaking');
  const baseline = join(fixtureRoot, 'baseline.yaml');
  const unchanged = runNodeScript('scripts/check-openapi-breaking.mjs', ['--baseline', baseline, '--candidate', baseline]);
  assert.equal(unchanged.status, 0, unchanged.stderr || unchanged.stdout);

  for (const fixture of [
    'deleted-path.yaml',
    'requiredness.yaml',
    'enum.yaml',
    'status.yaml',
    'header.yaml',
  ]) {
    const result = runNodeScript('scripts/check-openapi-breaking.mjs', [
      '--baseline', baseline,
      '--candidate', join(fixtureRoot, fixture),
    ]);
    assert.notEqual(result.status, 0, `${fixture} must be rejected as breaking`);
  }
});
