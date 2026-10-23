import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'vitest';
import { POSTGRES_EXCLUDE } from '../../../vitest.workspace-projects.js';
import { discoverProjectFiles, serverRoot } from './vitest-test-routing.js';

const packageJson = JSON.parse(readFileSync(resolve(serverRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
const workflow = readFileSync(resolve(serverRoot, '../../.github/workflows/colp-ci.yml'), 'utf8');

test('CI invokes native Vitest sharding with a complete contiguous matrix', () => {
  const job = /^  server-integration:[\s\S]*?(?=^  [\w-]+:|(?![\s\S]))/mu.exec(workflow)?.[0];
  assert.ok(job, 'server-integration must have a CI job');
  const matrix = /shard:\s*(\[[\d,\s]+\])/u.exec(job)?.[1];
  assert.ok(matrix, 'integration shard matrix must be explicit');
  const shards = JSON.parse(matrix) as number[];
  assert.deepEqual(shards, Array.from({ length: shards.length }, (_, i) => i + 1));
  assert.ok(shards.length > 1);
  assert.ok(job.includes(`npm run test:integration:inner -- --shard=${'${{ matrix.shard }}'}/${shards.length}`));
  assert.ok(job.includes('node scripts/with-postgres.mjs --isolated-owner --'));
});

test('integration commands select Postgres and retain database timeout floors', () => {
  for (const name of ['test:integration:inner', 'test:integration:file']) {
    const command = packageJson.scripts[name] ?? '';
    assert.match(command, /--project postgres/u);
    assert.match(command, /--testTimeout=60000/u);
    assert.match(command, /--hookTimeout=120000/u);
  }
});

test('every test excluded from Postgres has a real, exclusive alternate project', () => {
  const projects = discoverProjectFiles();
  for (const file of POSTGRES_EXCLUDE) {
    assert.ok(!projects.postgres?.includes(file), `${file} must not run in Postgres shards`);
    assert.equal(Object.entries(projects).filter(([name, paths]) => name !== 'postgres' && paths.includes(file)).length,
      1, `${file} must have one alternate project`);
  }
});

test('all server capability projects execute in CI and participate in the required gate', () => {
  const job = /^  server-capabilities:[\s\S]*?(?=^  [\w-]+:|(?![\s\S]))/mu.exec(workflow)?.[0];
  assert.ok(job);
  const matrix = /project:\s*\[([^\]]+)\]/u.exec(job)?.[1]?.split(',').map(value => value.trim()).sort();
  assert.deepEqual(matrix, Object.keys(discoverProjectFiles()).filter(name => !['unit', 'static', 'postgres'].includes(name)).sort());
  assert.ok(job.includes('xvfb-run --auto-servernum node scripts/with-postgres.mjs --isolated-owner --'));
  assert.ok(job.includes('run --project ${{ matrix.project }}'));
  const gate = workflow.slice(workflow.indexOf('  ci-gate:'));
  assert.match(gate, /- server-capabilities/u);
  assert.ok(gate.includes('${{ needs.server-capabilities.result }}'));
  assert.ok(gate.includes('"$SERVER_CAPABILITIES_RESULT"'));
});
