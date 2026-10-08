import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'vitest';

const backendRoot = resolve(import.meta.dirname, '../../..');
const repositoryRoot = resolve(backendRoot, '..');
const acceptancePath = resolve(backendRoot, 'docs/evidence/phase2-acceptance-2026-07-24.md');

const orderedTasks = [
  'phase2: establish publication manifest contract',
  'phase2: add restart-safe publication cursor keys',
  'phase2: persist publication locators and settings',
  'phase2: expose collection publication settings',
  'phase2: implement postgres publication snapshot reads',
  'phase2: assemble revision-fenced publication pages',
  'phase2: expose publication snapshot endpoint',
  'phase2: implement publication directory paging',
  'phase2: expose publication directory endpoint',
  'phase2: expose publication collection metadata',
  'phase2: expose publication manifest discovery',
  'phase2: expose public collection product read',
  'phase2: add collection publication controls',
  'phase2: connect public collection page',
  'phase2: deliver observable publication cache purge',
  'phase2: prove publication black-box compatibility',
] as const;

test('P2-01 through P2-16 are distinct ordered commits rather than one closeout claim', () => {
  const log = execFileSync('git', ['log', '--format=%H%x09%s', '--reverse', '--all'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true,
  }).trim().split(/\r?\n/u).map((line) => {
    const [revision, ...subject] = line.split('\t');
    return { revision, subject: subject.join('\t') };
  });

  const commits = orderedTasks.map((subject) => {
    const matches = log.filter((entry) => entry.subject === subject);
    assert.equal(matches.length, 1, `${subject} must have exactly one independent commit`);
    return matches[0]!;
  });
  assert.equal(new Set(commits.map(({ revision }) => revision)).size, orderedTasks.length);
  for (let index = 1; index < commits.length; index += 1) {
    assert.ok(
      log.indexOf(commits[index - 1]!) < log.indexOf(commits[index]!),
      `${orderedTasks[index - 1]} must precede ${orderedTasks[index]}`,
    );
  }
});

test('the final acceptance record owns every non-skippable release gate', () => {
  const evidence = readFileSync(acceptancePath, 'utf8');
  for (const command of [
    'npm run ci:static',
    'npm run test:integration',
    'npm run test:coverage',
    'npm run evidence:phase2-publication',
    'npm run test:e2e:real-stack',
    'npm run generate:evidence',
    'git diff --check',
  ]) {
    assert.match(evidence, new RegExp(escapeRegExp(command), 'u'), command);
  }
  assert.match(evidence, /P2-01[^\n]*P2-16|P2-01[\s\S]*P2-16/u);
  assert.match(evidence, /74\s*\/\s*74/u);
  assert.match(evidence, /clean[^\n]*HEAD|exact[^\n]*HEAD/iu);
  assert.match(evidence, /outside[^\n]*(?:repository|worktree)|仓库外/u);
  assert.match(evidence, /core[^\n]*publication|publication[^\n]*core/u);
  assert.match(evidence, /not[^\n]*production[^\n]*Deployment-proven|不是[^\n]*生产[^\n]*Deployment-proven/iu);
  assert.doesNotMatch(evidence, /\bskip(?:ped|s|ping)?\b[^\n]*(?:pass|green|accepted)/iu);
});

test('the release CLI composes the official evidence and compatibility claim gates', () => {
  const source = readFileSync(resolve(backendRoot, 'scripts/check-phase2-release.mjs'), 'utf8');
  for (const required of [
    'createPhase2ReleaseRequirementMapping',
    'readPhase2PublicationEvidenceFile',
    'runDeploymentConformanceProbes',
    'PHASE2_DEPLOYMENT_CONFORMANCE_SCOPE',
    'createPhase2ProfileConformanceDeployment',
    'claimPhase2PublicationProfiles',
    'evaluatePhase2ReleaseGate',
    'FAIL-CLOSED',
  ]) assert.match(source, new RegExp(escapeRegExp(required), 'u'), required);
  assert.doesNotMatch(source, /profileDeploymentConformanceProbes|passedRequirementIds/u);
  assert.doesNotMatch(source, /(?:allow|accept|count)[A-Za-z_]*(?:skip|missing)|skip[A-Za-z_]*(?:pass|success)/iu);
});

test('the release CLI exits non-zero without evidence and never reports a skip as success', () => {
  const environment = { ...process.env };
  delete environment.KNOWN_PHASE2_ACCEPTANCE_EVIDENCE;
  delete environment.KNOWN_PHASE2_PROFILE_CONFORMANCE_ADAPTER;
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', resolve(backendRoot, 'scripts/check-phase2-release.mjs')],
    { cwd: backendRoot, env: environment, encoding: 'utf8', timeout: 15_000, windowsHide: true },
  );
  const output = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, 0);
  assert.match(output, /requires --evidence and --adapter|FAIL-CLOSED/u);
  assert.doesNotMatch(output, /\bskip(?:ped)?\b/iu);
}, 20_000);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
