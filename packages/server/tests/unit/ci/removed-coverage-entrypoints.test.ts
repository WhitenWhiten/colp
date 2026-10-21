import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'vitest';

const root = process.cwd();
const removedConfigs = [
  'vitest.coverage.config.ts',
  'vitest.focused-coverage.config.ts',
  'vitest.phase4-5-coverage.config.ts',
] as const;
const removedScripts = [
  'ci:focused-coverage',
  'test:focused-coverage',
  'test:focused-coverage:inner',
] as const;

test('broken phase coverage configs and npm entrypoints stay removed', () => {
  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  for (const name of removedScripts) assert.equal(packageJson.scripts[name], undefined, name);
  for (const file of removedConfigs) assert.equal(existsSync(resolve(root, file)), false, file);
  const scripts = Object.values(packageJson.scripts).join('\n');
  assert.doesNotMatch(scripts, /vitest\.(?:coverage|focused-coverage|phase4-5-coverage)\.config\.ts/u);
  const workflow = readFileSync(resolve(root, '../../.github/workflows/colp-ci.yml'), 'utf8');
  assert.doesNotMatch(workflow, /ci:focused-coverage|test:focused-coverage|vitest\.(?:coverage|focused-coverage|phase4-5-coverage)\.config\.ts/u);
  assert.match(workflow, /name: Unit suite\n\s+run: npm run test:unit/u);
});
