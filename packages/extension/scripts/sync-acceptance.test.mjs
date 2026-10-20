import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { acceptanceNeedsWebProduct, acceptanceSpecs, requiredReleaseJobs, syncAcceptanceGroups } from './sync-acceptance-manifest.mjs';
import { verifyCiAcceptance } from './verify-ci-acceptance.mjs';

const sha = 'a'.repeat(40), repository = 'WhitenWhiten/colp';
const run = { id: 1, head_sha: sha, head_branch: 'main', event: 'push', status: 'completed',
  conclusion: 'success', html_url: 'https://github.com/WhitenWhiten/colp/actions/runs/1' };
const successfulJobs = () => requiredReleaseJobs.map(name => ({ name, status: 'completed', conclusion: 'success' }));
const lookup = (runs, jobs) => path => Promise.resolve(path.includes('/jobs?') ? { jobs } : { workflow_runs: runs });

test('every declared lifecycle group contains distinct, existing browser specs', () => {
  const specs = Object.keys(syncAcceptanceGroups).flatMap(acceptanceSpecs);
  assert.equal(new Set(specs).size, specs.length);
  for (const spec of specs) assert.ok(existsSync(resolve(import.meta.dirname, '..', spec)), spec);
  assert.throws(() => acceptanceSpecs(''), /Unknown/);
  assert.throws(() => acceptanceSpecs('toString'), /Unknown/);
  // The one required CI matrix executes the same manifest through the wrapper.
  const workflow = readFileSync(resolve(import.meta.dirname, '../../..', '.github/workflows/colp-ci.yml'), 'utf8');
  const matrix = workflow.match(/sync-group: \[([^\]]+)\]/u)?.[1].split(',').map(value => value.trim());
  assert.deepEqual(matrix, Object.keys(syncAcceptanceGroups));
});

test('cross-product recovery and web lanes declare their build dependency before launching browsers', () => {
  for (const [group, needed] of [['onboarding', false], ['recovery', true], ['web', true]]) {
    assert.equal(acceptanceNeedsWebProduct(group), needed);
  }
  const workflow = readFileSync(resolve(import.meta.dirname, '../../..', '.github/workflows/colp-ci.yml'), 'utf8');
  assert.match(workflow, /id: acceptance\n\s+run: node scripts\/run-sync-lifecycle\.mjs --build-requirements >> "\$GITHUB_OUTPUT"/u);
  assert.match(workflow, /if: steps\.acceptance\.outputs\.web-product == 'true'\n\s+run: npm ci && npm run build\n\s+working-directory: packages\/web/u);
});

test('release accepts a fully passed run on exactly the tagged main commit', async () => {
  assert.equal((await verifyCiAcceptance({ repository, sha,
    fetchJson: lookup([run], successfulJobs()) })).id, 1);
});

for (const changed of [
  { head_sha: 'b'.repeat(40) }, { head_branch: 'unreviewed' }, { event: 'pull_request' },
  { status: 'in_progress' }, { conclusion: 'failure' },
]) test(`release rejects unsuitable runs: ${JSON.stringify(changed)}`, async () => {
  await assert.rejects(verifyCiAcceptance({ repository, sha,
    fetchJson: lookup([{ ...run, ...changed }], successfulJobs()) }), /No complete sync acceptance/);
});

for (const conclusion of ['skipped', 'cancelled', 'failure']) {
  test(`release rejects a ${conclusion} lifecycle job despite a green aggregate`, async () => {
    const jobs = successfulJobs();
    jobs.find(job => job.name === 'extension-sync-lifecycle (recovery)').conclusion = conclusion;
    await assert.rejects(verifyCiAcceptance({ repository, sha, fetchJson: lookup([run], jobs) }), /No complete/);
  });
}

test('release rejects a missing integration shard or missing browser lane', async () => {
  for (const missing of ['server-integration (6)', 'extension-sync-lifecycle (web)']) {
    await assert.rejects(verifyCiAcceptance({ repository, sha,
      fetchJson: lookup([run], successfulJobs().filter(job => job.name !== missing)) }), /No complete/);
  }
});

for (const state of ['missing', 'skipped', 'in_progress']) {
  test(`release rejects ${state} server audit coverage even when the aggregate CI gate is green`, async () => {
    const jobs = successfulJobs().filter(job => state !== 'missing' || job.name !== 'server-sync-audit-coverage');
    const coverage = jobs.find(job => job.name === 'server-sync-audit-coverage');
    if (state === 'skipped') coverage.conclusion = 'skipped';
    if (state === 'in_progress') { coverage.status = 'in_progress'; coverage.conclusion = null; }
    assert.equal(jobs.find(job => job.name === 'ci-gate').conclusion, 'success');
    await assert.rejects(verifyCiAcceptance({ repository, sha, fetchJson: lookup([run], jobs) }), /No complete/);
  });
}

test('release follows job pagination and ignores stale attempts', async () => {
  const calls = [];
  const result = await verifyCiAcceptance({ repository, sha, fetchJson: async path => {
    calls.push(path);
    if (!path.includes('/jobs?')) return { workflow_runs: [run] };
    return { jobs: path.endsWith('&page=1') ? Array.from({ length: 100 }, () => ({ name: 'unrelated' })) : successfulJobs() };
  } });
  assert.equal(result.id, 1);
  assert.ok(calls.some(path => path.includes('filter=latest') && path.endsWith('page=2')));
});

test('acceptance lookup errors and malformed responses fail closed', async () => {
  await assert.rejects(verifyCiAcceptance({ repository, sha, fetchJson: async () => ({}) }), /Invalid GitHub/);
  await assert.rejects(verifyCiAcceptance({ repository, sha, fetchJson: async () => { throw new Error('offline'); } }), /offline/);
  await assert.rejects(verifyCiAcceptance({ repository, sha: 'main', fetchJson: lookup([run], []) }), /full release commit SHA/);
});

test('required browser journeys and all PostgreSQL shards cannot silently leave the gate', () => {
  const specs = Object.values(syncAcceptanceGroups).flat();
  for (const name of ['mv3-first-sync-from-ui', 'mv3-first-sync-promises', 'mv3-advanced-first-run',
    'mv3-boundary-settings', 'mv3-bookmark-roots', 'mv3-ongoing-sync-recovery',
    'mv3-personal-sync-lifecycle', 'mv3-personal-sync-reconnect', 'mv3-library-web-flow',
    'mv3-sync-resilience', 'mv3-first-sync-recovery', 'mv3-rejoin-local-deletion']) assert.ok(specs.includes(`e2e/${name}.spec.ts`), name);
  for (const shard of [1, 2, 3, 4, 5, 6]) assert.ok(requiredReleaseJobs.includes(`server-integration (${shard})`));
  assert.ok(requiredReleaseJobs.includes('server-sync-audit-coverage'));
});

test('release cannot use an earlier successful attempt when latest jobs are incomplete', async () => {
  const calls = [];
  await assert.rejects(verifyCiAcceptance({ repository, sha, fetchJson: async path => {
    calls.push(path);
    if (!path.includes('/jobs?')) return { workflow_runs: [run] };
    assert.ok(path.includes('filter=latest'));
    return { jobs: successfulJobs().map(job => job.name === 'extension-coverage'
      ? { ...job, status: 'in_progress', conclusion: null } : job) };
  } }), /No complete/);
  assert.equal(calls.filter(path => path.includes('/jobs?')).length, 1);
});
