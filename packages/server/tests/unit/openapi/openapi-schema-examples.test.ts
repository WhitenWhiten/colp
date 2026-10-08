import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'vitest';

const backendRoot = resolve(import.meta.dirname, '../../..');
const sourcePath = join(backendRoot, 'openapi/product-v1.yaml');

function runNodeScript(script: string, args: string[]) {
  return spawnSync(process.execPath, [join(backendRoot, script), ...args], {
    cwd: backendRoot,
    encoding: 'utf8',
    timeout: 10_000,
  });
}

test('schema example fixtures are accepted and invalid examples are rejected', () => {
  const valid = runNodeScript('scripts/validate-openapi-examples.mjs', [
    '--document', sourcePath,
    '--fixtures', join(backendRoot, 'tests/fixtures/openapi/schema-examples.json'),
  ]);
  assert.equal(valid.status, 0, valid.stderr || valid.stdout);

  const invalid = runNodeScript('scripts/validate-openapi-examples.mjs', [
    '--document', sourcePath,
    '--fixtures', join(backendRoot, 'tests/fixtures/openapi/invalid-schema-example.json'),
  ]);
  assert.notEqual(invalid.status, 0, 'an invalid schema example must fail validation');
});
