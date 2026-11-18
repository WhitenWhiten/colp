import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { CI_JOBS, isReleaseOnly, jobsForPaths, selectCiJobs } from './select-ci-jobs.mjs';

const sort = values => [...values].sort();
const json = value => JSON.stringify(value);
const workflowPath = new URL('../.github/workflows/colp-ci.yml', import.meta.url);
const readWorkflow = () => readFileSync(workflowPath, 'utf8');

/** One top-level job block, stopping at the next job key. */
function workflowJob(workflow, name) {
  const marker = `\n  ${name}:`;
  const start = workflow.indexOf(marker);
  assert.ok(start >= 0, `workflow has a ${name} job`);
  const rest = workflow.slice(start + marker.length);
  const next = rest.search(/^\s{2}[\w-]+:\s*$/mu);
  return next < 0 ? workflow.slice(start) : workflow.slice(start, start + marker.length + next);
}

const manifest = { name: 'example', version: '0.1.0', dependencies: { sdk: '1.0.0' } };
const lock = { ...manifest, lockfileVersion: 3, packages: {
  '': manifest, 'node_modules/sdk': { version: '1.0.0', integrity: 'sha512-original' },
} };
const bump = value => ({ ...value, version: '0.1.1' });

test('documentation, changelogs, reports and issue templates select no expensive jobs', () => {
  assert.deepEqual(jobsForPaths(['README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'docs/ci.md',
    'docs/assets/generate.mjs', 'reports/run.json', 'packages/node/README.md',
    'packages/web/docs/guide.md', 'packages/extension/CHANGELOG.md', 'packages/server/CHANGELOG.md',
    '.github/ISSUE_TEMPLATE/bug_report.yml']), []);
});

test('Web changes select Web and cross-application browser checks, without SDK/server suites', () => {
  assert.deepEqual(sort(jobsForPaths(['packages/web/src/pages/Library.tsx'])),
    sort(['web', 'web-browser', 'web-acceptance', 'extension-browser', 'self-hosted-browser']));
  assert.ok(jobsForPaths(['packages/web/src/pages/automations/ruleDraft.ts']).includes('server-integration'));
});

test('SDK changes check the local SDK and conformance; apps use their frozen registry SDK', () => {
  const jobs = jobsForPaths(['packages/node/src/client.ts']);
  for (const job of ['static', 'test', 'publisher-coverage', 'security-coverage',
    'sync-core-coverage', 'package', 'dependency-audit', 'conformance']) assert.ok(jobs.includes(job), job);
  assert.ok(!jobs.includes('server'));
  assert.ok(!jobs.includes('extension-browser'));
  assert.ok(jobsForPaths(['packages/node/tests/fixtures/automation/m1-placement.json']).includes('server'));
});

test('server runtime changes exercise real clients, without SDK coverage or mocked Web browser suites', () => {
  const jobs = jobsForPaths(['packages/server/src/bootstrap/app.ts']);
  for (const job of ['server', 'server-integration', 'server-capabilities', 'web-acceptance',
    'extension', 'extension-browser', 'extension-sync-real-stack', 'self-hosted-browser']) assert.ok(jobs.includes(job), job);
  for (const job of ['test', 'publisher-coverage', 'web-browser']) assert.ok(!jobs.includes(job), job);
  assert.ok(jobsForPaths(['packages/server/openapi/colp-server-v1.yaml']).includes('web'));
});

test('extension changes keep the server integration harness and cross-package Web contracts', () => {
  const jobs = jobsForPaths(['packages/extension/src/sync-state-store.ts']);
  for (const job of ['extension', 'extension-browser', 'extension-coverage', 'extension-mv3',
    'extension-sync-real-stack', 'extension-kns-09-release', 'extension-kns-09-e2e',
    'self-hosted-browser', 'server-integration']) assert.ok(jobs.includes(job), job);
  for (const job of ['server', 'test', 'web-browser']) assert.ok(!jobs.includes(job), job);
  assert.ok(jobsForPaths(['packages/extension/tests/health-server-integration-harness.ts']).includes('server-integration'));
  assert.ok(jobsForPaths(['packages/extension/src/sync-failure-class.ts']).includes('web'));
  assert.ok(jobsForPaths(['packages/extension/popup.css']).includes('web'));
  assert.ok(jobsForPaths(['packages/extension/scripts/with-xvfb.mjs']).includes('web-browser'));
});

test('conformance, formal models and deployment changes retain their actual consumers', () => {
  const conformance = jobsForPaths(['packages/conformance/src/sync-resilience.mjs']);
  for (const job of ['conformance', 'server-integration', 'extension']) assert.ok(conformance.includes(job), job);
  assert.deepEqual(jobsForPaths(['formal/sync/Sync.lean']), ['extension']);
  assert.deepEqual(sort(jobsForPaths(['deploy/compose.yaml'])), sort(['server', 'web-acceptance', 'self-hosted-browser']));
});

test('generated contracts in documentation and protocol prose retain drift validation', () => {
  for (const path of ['docs/automation/design/schemas/rule-input.schema.json',
    'docs/automation/design/api/automation.openapi.yaml', 'docs/automation/contract-adjustments.json']) {
    assert.deepEqual(jobsForPaths([path]), CI_JOBS);
  }
  assert.deepEqual(jobsForPaths(['protocol/docs/09-problem-registry.md']), ['static']);
  assert.deepEqual(jobsForPaths(['packages/node/docs/TRACEABILITY.md']), ['static']);
  assert.ok(jobsForPaths(['protocol/requirements-dev.txt']).includes('static'));
  assert.deepEqual(sort(jobsForPaths(['protocol/replica-health-limits.json'])), sort(CI_JOBS));
  assert.ok(jobsForPaths(['protocol/examples/sync-pull-v02.json']).includes('server'));
  assert.ok(jobsForPaths(['packages/node/tests/fixtures/document.md']).includes('test'));
  assert.ok(jobsForPaths(['packages/node/src/template.txt']).includes('package'));
  for (const name of ['server', 'web', 'extension']) {
    assert.ok(jobsForPaths([`packages/${name}/src/generated/browser-folder-roles.ts`]).includes('static'));
  }
});

test('CI, shared tooling, vendored SDKs and unknown paths use full verification', () => {
  for (const path of ['.github/workflows/colp-ci.yml', 'scripts/select-ci-jobs.mjs',
    'scripts/production-source-size.mjs', 'packages/server/vendor/know-n-colp.tgz',
    '.nvmrc', '.npmrc', 'package.json', 'new-package/source.ts']) assert.deepEqual(jobsForPaths([path]), CI_JOBS, path);
});

test('mixed changes select the union of affected jobs', () => {
  const paths = ['packages/web/src/main.tsx', 'packages/extension/src/background.ts'];
  assert.deepEqual(sort(jobsForPaths(paths)), sort(new Set(paths.flatMap(path => jobsForPaths([path])))));
});

test('only package versions and lockfile root versions are release metadata', () => {
  for (const path of ['packages/server/package.json', 'packages/server/runtime/package.json',
    'packages/extension/package.json', 'packages/node/package.json']) {
    assert.equal(isReleaseOnly(path, json(manifest), json(bump(manifest))), true, path);
    assert.equal(isReleaseOnly(path, json(manifest), json({ ...bump(manifest), scripts: { build: 'other' } })), false);
    assert.equal(isReleaseOnly(path, json(manifest), json({ ...manifest, dependencies: { sdk: '2.0.0' } })), false);
  }
  const bumpedLock = { ...bump(lock), packages: { ...lock.packages, '': bump(manifest) } };
  assert.equal(isReleaseOnly('packages/server/package-lock.json', json(lock), json(bumpedLock)), true);
  assert.equal(isReleaseOnly('packages/server/package-lock.json', json(lock), json({ ...bumpedLock,
    packages: { ...bumpedLock.packages, 'node_modules/sdk': { version: '2.0.0' } },
  })), false);
  assert.equal(isReleaseOnly('packages/server/package-lock.json', json(lock), json({ ...bumpedLock,
    packages: { ...bumpedLock.packages, 'node_modules/sdk': { version: '1.0.0', integrity: 'sha512-other' } },
  })), false);
});

test('manifest version bumps are ignored but permissions and invalid metadata are checked', () => {
  const before = { version: '0.1.0.1', version_name: '0.1.0-rc.1', permissions: ['storage'] };
  const after = { ...before, version: '0.1.0.2', version_name: '0.1.0-rc.2' };
  const path = 'packages/extension/manifest.base.json';
  assert.equal(isReleaseOnly(path, json(before), json(after)), true);
  assert.equal(isReleaseOnly(path, json(before), json({ ...after, permissions: ['storage', 'tabs'] })), false);
  assert.equal(isReleaseOnly(path, json(before), json({ ...after, version: null })), false);
  assert.equal(isReleaseOnly(path, null, json(after)), false);
  assert.equal(isReleaseOnly(path, json(before), null), false);
  assert.equal(isReleaseOnly(path, '{invalid', json(after)), false);
});

test('generated server release version changes do not hide code or SDK/protocol changes', () => {
  const path = 'packages/server/src/version.ts';
  const before = "export const version = {\n  server: '0.1.0-rc.1',\n  colp: '0.3.0',\n  protocols: ['0.1', '0.2'],\n} as const;\n";
  const after = before.replace('rc.1', 'rc.2');
  assert.equal(isReleaseOnly(path, before, after), true);
  for (const changed of [after.replace('0.3.0', '0.4.0'), after.replace('0.2', '0.3'),
    after.replace('0.1.0-rc.2', 'invalid-version'), `${after}console.log('new code');\n`]) {
    assert.equal(isReleaseOnly(path, before, changed), false);
  }
});

function repository(t) {
  const root = mkdtempSync(join(tmpdir(), 'colp-ci-scope-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_NAME: 'CI test', GIT_AUTHOR_EMAIL: 'ci@example.test',
      GIT_COMMITTER_NAME: 'CI test', GIT_COMMITTER_EMAIL: 'ci@example.test' } }).trim();
  git('init', '--initial-branch=main');
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const commit = (files) => {
    for (const [path, text] of Object.entries(files)) write(path, text);
    git('add', '--all');
    git('commit', '--quiet', '--allow-empty', '-m', 'test change');
    return git('rev-parse', 'HEAD');
  };
  const push = (before, after) => selectCiJobs({ repository: root, eventName: 'push', event: { before, after } });
  return { root, git, commit, push };
}

test('actual Git comparison skips a release and detects dependency changes in the same files', t => {
  const repo = repository(t);
  const base = repo.commit({ 'packages/extension/package.json': json(manifest),
    'packages/extension/package-lock.json': json(lock) });
  const release = repo.commit({ 'packages/extension/package.json': json(bump(manifest)),
    'packages/extension/package-lock.json': json({ ...bump(lock), packages: { ...lock.packages, '': bump(manifest) } }),
    'packages/extension/CHANGELOG.md': 'Release notes' });
  assert.deepEqual(repo.push(base, release).jobs, []);
  const code = repo.commit({ 'packages/extension/package.json': json({ ...bump(manifest), dependencies: { sdk: '2.0.0' } }) });
  assert.ok(repo.push(release, code).jobs.includes('extension'));
  assert.ok(repo.push(release, code).jobs.includes('static'));
});

test('push detection includes every commit in the push, even when the last only edits docs', t => {
  const repo = repository(t);
  const base = repo.commit({ 'README.md': 'initial' });
  repo.commit({ 'packages/web/src/main.tsx': 'source' });
  const head = repo.commit({ 'README.md': 'documentation' });
  assert.ok(repo.push(base, head).jobs.includes('web-browser'));
});

test('PR comparison uses the merge base and excludes unrelated target-branch changes', t => {
  const repo = repository(t);
  repo.commit({ 'README.md': 'initial' });
  repo.git('checkout', '-b', 'topic');
  const head = repo.commit({ 'README.md': 'documentation' });
  repo.git('checkout', 'main');
  const base = repo.commit({ 'packages/server/src/main.ts': 'unrelated change on main' });
  assert.deepEqual(selectCiJobs({ repository: repo.root, eventName: 'pull_request',
    event: { pull_request: { base: { sha: base }, head: { sha: head } } } }).jobs, []);
});

test('deletions and renames retain checks for the old source path, including whitespace', t => {
  const repo = repository(t);
  const base = repo.commit({ 'packages/web/src/old name.tsx': 'source', 'packages/extension/popup.css': 'css' });
  repo.git('mv', 'packages/web/src/old name.tsx', 'README.md');
  repo.git('rm', 'packages/extension/popup.css');
  const head = repo.commit({});
  const jobs = repo.push(base, head).jobs;
  assert.ok(jobs.includes('web-browser'));
  assert.ok(jobs.includes('extension'));
});

test('manual runs, new branches, missing history and unsupported events run all jobs', t => {
  const repo = repository(t);
  const head = repo.commit({ 'README.md': 'initial' });
  assert.deepEqual(repo.push('0'.repeat(40), head).jobs, CI_JOBS);
  assert.deepEqual(repo.push('f'.repeat(40), head).jobs, CI_JOBS);
  assert.deepEqual(selectCiJobs({ repository: repo.root, eventName: 'workflow_dispatch', event: {} }).jobs, CI_JOBS);
  assert.deepEqual(selectCiJobs({ repository: repo.root, eventName: 'unknown', event: {} }).jobs, CI_JOBS);
});

test('every selectable workflow job has a matching condition and participates in ci-gate', () => {
  const workflow = readWorkflow();
  const jobNames = [...workflow.matchAll(/^  ([\w-]+):\n    (?:needs|if|runs-on):/gmu)].map(match => match[1]);
  assert.deepEqual(sort(jobNames), sort(['changes', 'contract', 'secret-scan', ...CI_JOBS, 'ci-gate']));
  const gate = workflowJob(workflow, 'ci-gate');
  for (const job of CI_JOBS) {
    assert.ok(workflow.includes(`  ${job}:\n    needs: changes\n    if: contains(fromJSON(needs.changes.outputs.jobs), '${job}')`), job);
    assert.ok(gate.includes(`      - ${job}\n`), job);
    assert.ok(gate.includes(`needs.${job}.result`), job);
  }
  // The contract and base-trusted scan are unconditional, so the gate requires
  // them directly rather than through the changed-path selector.
  for (const job of ['contract', 'secret-scan']) {
    assert.ok(gate.includes(`      - ${job}\n`), job);
    assert.ok(gate.includes(`needs.${job}.result`), job);
    assert.doesNotMatch(workflowJob(workflow, job), /^\s{4}if:/mu, job);
  }
  assert.ok(workflow.includes('github.event.pull_request.number || github.run_id'));
  assert.ok(workflow.includes("cancel-in-progress: ${{ github.event_name == 'pull_request' }}"));
});

test('CI selection checks out only the trusted base and runs no PR code', () => {
  const workflow = readWorkflow();
  const changes = workflowJob(workflow, 'changes');
  assert.ok(changes.includes('PR_BASE_SHA: ${{ github.event.pull_request.base.sha }}'));
  assert.ok(changes.includes('ref: ${{ steps.base.outputs.ref }}'));
  assert.ok(changes.includes('fetch-depth: 0'));
  assert.ok(changes.includes('node scripts/select-ci-jobs.mjs'));
  assert.ok(changes.includes('git rev-parse HEAD'));
  // PR-authored tests and README checks must not run before selection.
  assert.doesNotMatch(changes, /node --test/u);
  assert.doesNotMatch(changes, /check-readmes/u);
  assert.ok(!changes.includes('scripts/.select-ci-jobs.base.mjs'));

  const contract = workflowJob(workflow, 'contract');
  assert.ok(contract.includes('node --test scripts/select-ci-jobs.test.mjs scripts/check-sdk-pins.test.mjs scripts/check-readmes.test.mjs'));
  assert.ok(contract.includes('run: node scripts/check-readmes.mjs'));
});

test('CI scans tracked files with the base blobs for PRs and the checked-out HEAD for pushes', () => {
  const workflow = readWorkflow();
  const secretScan = workflowJob(workflow, 'secret-scan');
  assert.ok(secretScan.includes('fetch-depth: 0'));
  assert.ok(secretScan.includes('BASE_SHA: ${{ needs.changes.outputs.base }}'));
  assert.ok(secretScan.includes('case "${GITHUB_EVENT_NAME}" in'));

  const prStart = secretScan.indexOf('            pull_request)');
  const headStart = secretScan.indexOf('            push|workflow_dispatch)');
  const rejectStart = secretScan.indexOf('            *)');
  assert.ok(prStart >= 0 && headStart > prStart && rejectStart > headStart,
    'the scan must branch on pull_request, push/workflow_dispatch, then reject other events');
  const prBranch = secretScan.slice(prStart, headStart);
  const headBranch = secretScan.slice(headStart, rejectStart);
  const rejectBranch = secretScan.slice(rejectStart);

  // A PR is judged by the base commit's scanner and allowlist, so it cannot
  // add an exemption for a literal it introduced or rewrite its own scanner.
  assert.ok(prBranch.includes('git show "${BASE_SHA}:scripts/scan-tracked-secrets.mjs" > .trusted-base/scan-tracked-secrets.mjs'));
  assert.ok(prBranch.includes('git show "${BASE_SHA}:scripts/secret-scan-allowlist.json" > scripts/secret-scan-allowlist.json'));
  assert.ok(prBranch.includes('node --check .trusted-base/scan-tracked-secrets.mjs'));
  assert.ok(prBranch.includes('node .trusted-base/scan-tracked-secrets.mjs'));
  const allowlistFetch = prBranch.indexOf('git show "${BASE_SHA}:scripts/secret-scan-allowlist.json"');
  const baseScan = prBranch.indexOf('node .trusted-base/scan-tracked-secrets.mjs');
  assert.ok(allowlistFetch >= 0 && allowlistFetch < baseScan,
    'the base allowlist must replace the PR allowlist before the scan runs');
  assert.ok(prBranch.includes('no trusted base commit for the tracked secret scan'));

  // A push or manual run scans the trusted HEAD with its own scanner and
  // allowlist: the pre-push base predates the pushed fixture exemptions.
  assert.ok(headBranch.includes('node --check scripts/scan-tracked-secrets.mjs'));
  assert.ok(headBranch.includes('node scripts/scan-tracked-secrets.mjs'));
  assert.ok(!headBranch.includes('.trusted-base'));
  assert.ok(!headBranch.includes('git show "${BASE_SHA}'));
  assert.ok(headBranch.includes('no usable head commit for the tracked secret scan'));
  assert.ok(headBranch.includes('not on the commit it must verify'));

  // An unusable event must fail closed instead of skipping the tracked scan.
  assert.ok(rejectBranch.includes('unsupported event for the tracked secret scan'));
  assert.ok(rejectBranch.includes('exit 1'));
  assert.equal(secretScan.match(/node scripts\/scan-tracked-secrets\.mjs$/gmu)?.length, 1);

  // The tracked scan is no longer inside a path-selected job; the package job
  // keeps only the generated-artifact scan for output that is not in git.
  const packageJob = workflowJob(workflow, 'package');
  assert.ok(!packageJob.includes('run: node scripts/scan-tracked-secrets.mjs\n'));
  assert.ok(packageJob.includes('run: node scripts/scan-tracked-secrets.mjs --artifact packages/node/dist'));

  // Export-surface tests skip themselves when dist/ is absent. CI must build
  // packages/node before the full suite instead of silently skipping them.
  const testJob = workflowJob(workflow, 'test');
  const build = testJob.indexOf('- name: Build package artifacts for the export-surface tests');
  const fullSuite = testJob.indexOf('node scripts/generate-conformance-evidence.mjs');
  assert.ok(build >= 0, 'test job must build packages/node before vitest');
  assert.ok(fullSuite >= 0, 'test job must still run the full suite');
  assert.ok(build < fullSuite, 'the package build must precede the full test suite');
  const buildStep = testJob.slice(build, fullSuite);
  assert.ok(buildStep.includes('run: npm run build\n'), 'the build step must run the package build');
  assert.ok(buildStep.includes('working-directory: packages/node'), 'the build step must run in packages/node');
});
