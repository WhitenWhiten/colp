import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'vitest';
import { BROWSER_INCLUDE, EVIDENCE_INCLUDE, REDIS_INCLUDE, SYSTEM_INCLUDE } from '../../../vitest.workspace-projects.js';
import { discoverProjectFiles, ownershipProblems, serverRoot } from './vitest-test-routing.js';

const declared = { browser: BROWSER_INCLUDE, evidence: EVIDENCE_INCLUDE, redis: REDIS_INCLUDE, system: SYSTEM_INCLUDE };
const projects = discoverProjectFiles();
const onDisk = ['unit', 'integration'].flatMap(kind => readdirSync(resolve(serverRoot, 'tests', kind), { recursive: true })
  .map(String).filter(file => file.endsWith('.test.ts')).map(file => `tests/${kind}/${file.replaceAll('\\', '/')}`));

test('every server test is independently discovered by exactly one Vitest project', () => {
  assert.ok(onDisk.length > 900);
  assert.deepEqual(ownershipProblems(onDisk, projects), []);
});

test('every exclusive ownership path exists and its project discovers it', () => {
  for (const [project, paths] of Object.entries(declared)) for (const file of paths) {
    assert.ok(existsSync(resolve(serverRoot, file)), `${project} names missing file ${file}`);
    assert.ok(projects[project]?.includes(file), `${project} does not discover ${file}`);
  }
});

test('the discovery contract detects an omitted test, duplicate ownership and stale paths', () => {
  const sample = { unit: ['tests/unit/example.test.ts'] };
  assert.equal(ownershipProblems(['tests/unit/example.test.ts', 'tests/unit/forgotten.test.ts'], sample).length, 1);
  assert.equal(ownershipProblems(['tests/unit/example.test.ts'], { ...sample, system: sample.unit }).length, 1);
  assert.equal(ownershipProblems([], sample).length, 1);
});

test('CI routing contracts execute in the ordinary unit project', () => {
  for (const file of ['shard-bucket-contract.test.ts', 'integration-shard-contract.test.ts']) {
    assert.ok(projects.unit?.includes(`tests/unit/ci/${file}`));
  }
});
