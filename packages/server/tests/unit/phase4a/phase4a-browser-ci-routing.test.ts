/**
 * FIX-M-020 static routing contract: every Phase 4A browser-bound suite must
 * be owned by EXACTLY ONE CI job that installs Chromium, and must be excluded
 * from every ordinary runner (unit/integration shards, the shared coverage
 * collects, and the local full integration gate) that would otherwise launch
 * a browser without one installed.
 *
 * The registry is validated against package.json: every
 * `test:phase4a:*:browser:inner` script declared there must be registered
 * with the include file of the Vitest config it references, and the
 * registered command set must equal the declared script set exactly — a new
 * browser suite cannot bypass the contract by adding a script without a CI
 * owner (the FIX-M-020 r06 residual).
 *
 * The contract executes the shard scripts in `--list` mode, parses the
 * coverage configs, the package scripts and the backend workflow, then
 * asserts the routing invariants. Mutation negative controls prove the
 * checker fails when a suite owner is removed, the Chromium install step
 * disappears, the owner drops out of ci-gate, a second owner appears, the
 * unit-shard exclusion is dropped, or an unregistered browser script is
 * added.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'vitest';
import { parse } from 'yaml';
import { usesAction } from '../ci/known-backend-ci-contract-support.js';
import {
  PHASE_1_3_COVERAGE_EXCLUSIONS,
  PHASE_1_3_COVERAGE_INCLUDE,
} from '../../../vitest.phase1-3-coverage-scope.js';

const backendRoot = process.cwd();
const workflowPath = resolve(backendRoot, '../.github/workflows/known-backend-ci.yml');
const setupActionPath = resolve(backendRoot, '../.github/actions/known-backend-setup/action.yml');
const unitShardPath = resolve(backendRoot, 'scripts/unit-shard.mjs');
const projectFilesPath = resolve(backendRoot, 'scripts/vitest-project-files.mjs');
const coverageConfigPath = resolve(backendRoot, 'vitest.coverage.config.ts');
const coverageTestFilesPath = resolve(backendRoot, 'scripts/phase13-coverage-test-files.mjs');

interface WorkflowStep {
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  'working-directory'?: string;
  'continue-on-error'?: unknown;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  if?: string;
  needs?: string[];
  'timeout-minutes'?: number;
  env?: Record<string, string>;
  steps?: WorkflowStep[];
}

interface Workflow {
  jobs?: Record<string, WorkflowJob>;
}

interface BrowserSuite {
  readonly file: string;
  readonly command: string;
}

interface PackageBrowserScript {
  readonly command: string;
  readonly config: string;
  readonly include: readonly string[];
}

const BROWSER_OWNER_JOB = 'phase4a-browser';

/**
 * The browser suite registry: every entry is a Playwright/Chromium-bound
 * suite with its sole CI owner command. The registry is a concrete list so
 * the workflow/shard/coverage checks can iterate it, but its command set is
 * pinned to the package-declared `test:phase4a:*:browser:inner` scripts by
 * the equality contract below — drift in either direction fails the suite.
 */
const browserSuites: readonly BrowserSuite[] = [
  {
    file: 'tests/unit/phase4a/phase4a-i03-browser-isolation.test.ts',
    command: 'npm run test:phase4a:i03:browser:inner',
  },
  {
    file: 'tests/unit/phase4a/phase4a-i11-browser-isolation.test.ts',
    command: 'npm run test:phase4a:i11:browser:inner',
  },
  {
    file: 'tests/unit/phase4a/phase4a-i12-browser-projection.test.ts',
    command: 'npm run test:phase4a:i12:browser:inner',
  },
  {
    file: 'tests/unit/phase4a/phase4a-i16-browser-delivery.test.ts',
    command: 'npm run test:phase4a:i16:browser:inner',
  },
  {
    file: 'tests/unit/phase4a/phase4a-r06-browser-projection.test.ts',
    command: 'npm run test:phase4a:r06:browser:inner',
  },
  {
    file: 'tests/integration/phase4a/phase4a-p08-browser-postgres.integration.test.ts',
    command: 'npm run test:phase4a:p08:browser:inner',
  },
  {
    file: 'tests/unit/phase4a/phase4a-p09-browser-projection.test.ts',
    command: 'npm run test:phase4a:p09:browser:inner',
  },
];

const CHROMIUM_INSTALL_COMMAND = 'npx playwright install --with-deps chromium';
const CHROMIUM_INSTALL_IF = "inputs.playwright == 'backend' && steps.playwright-cache.outputs.cache-hit != 'true'";
const KNOWN_BACKEND_SETUP = './.github/actions/known-backend-setup';
const ACT_REUSE_BACKEND_INSTALL = /act-reuse-install\.py["']?\s+backend\b/u;

function hostedSetupActionSource(): string {
  const backup = resolve(backendRoot, '../.act-backup/known-backend-setup.yml');
  if (existsSync(backup)) {
    return readFileSync(backup, 'utf8');
  }
  return readFileSync(setupActionPath, 'utf8');
}

function readWorkflowSource(): string {
  return readFileSync(workflowPath, 'utf8');
}

function parseWorkflow(source: string): Workflow {
  return parse(source) as Workflow;
}

function readPackageJson(): { scripts: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(resolve(backendRoot, 'package.json'), 'utf8'));
}

/**
 * Structurally enumerate every `test:phase4a:*:browser:inner` package script
 * and map it to the include files of the Vitest config it references. This is
 * the source of truth the registry must equal — the contract must not only
 * iterate a hardcoded array.
 */
function derivePackageBrowserScripts(packageJson: ReturnType<typeof readPackageJson>): PackageBrowserScript[] {
  const derived: PackageBrowserScript[] = [];
  for (const [name, value] of Object.entries(packageJson.scripts)) {
    if (!/^test:phase4a:.*:browser:inner$/u.test(name)) continue;
    const projectMatch = /--project\s+browser\s+(\S+\.test\.ts)/u.exec(value);
    assert.ok(projectMatch, `${name} must select --project browser and one test file`);
    const include = [projectMatch[1]!];
    derived.push({ command: `npm run ${name}`, config: 'vitest.browser.config.ts', include });
  }
  return derived.sort((left, right) => left.command.localeCompare(right.command, 'en'));
}

/**
 * Exact-set equality between the package-declared `:browser:inner` scripts
 * and the registered owner commands. A script without a registry entry (an
 * owner-less browser suite) or a registry entry without a package script
 * (a phantom owner) both fail.
 */
function browserRegistryEqualityErrors(
  packageScriptCommands: readonly string[],
  registry: readonly BrowserSuite[],
): string[] {
  const errors: string[] = [];
  const registryCommands = registry.map((suite) => suite.command);
  for (const command of packageScriptCommands) {
    if (!registryCommands.includes(command)) {
      errors.push(`${command} is declared in package.json but has no browser suite registry owner`);
    }
  }
  for (const command of registryCommands) {
    if (!packageScriptCommands.includes(command)) {
      errors.push(`${command} is registered but is not a declared test:phase4a:*:browser:inner package script`);
    }
  }
  return errors;
}

function coverageExclusionErrors(source: string, suites: readonly BrowserSuite[]): string[] {
  return suites
    .filter((suite) => !source.includes(`'${suite.file}'`))
    .map((suite) => `Phase 1-3 coverage ownership must exclude ${suite.file} from the shared collects`);
}

function parseSetupAction(source = hostedSetupActionSource()): {
  source: string;
  steps: WorkflowStep[];
} {
  const parsed = parse(source) as { runs?: { steps?: WorkflowStep[] } };
  return { source, steps: parsed.runs?.steps ?? [] };
}

/**
 * Hosted runners keep `run: npm ci`. Local act rewrites that step to
 * `act-reuse-install.py backend` while leaving the step name in place.
 * Match either form so unit shards stay green under the act shim.
 */
function isFrozenBackendInstall(step: WorkflowStep): boolean {
  if (step.name !== 'Frozen backend install') return false;
  if (step['working-directory'] !== 'Known-Backend') return false;
  const run = step.run ?? '';
  return run === 'npm ci' || ACT_REUSE_BACKEND_INSTALL.test(run);
}

function validateBrowserRouting(
  workflow: Workflow,
  setupAction: ReturnType<typeof parseSetupAction> = parseSetupAction(),
): string[] {
  const errors: string[] = [];
  const jobs = workflow.jobs ?? {};

  // Every browser suite must be owned by exactly one job, and that job must
  // be the dedicated Chromium-installing owner.
  for (const suite of browserSuites) {
    const owningJobs = Object.entries(jobs)
      .filter(([, job]) => (job.steps ?? []).some((step) => step.run === suite.command))
      .map(([name]) => name);
    if (owningJobs.length !== 1) {
      errors.push(`${suite.command} must be owned by exactly one job (found ${owningJobs.length}: ${owningJobs.join(', ') || 'none'})`);
    } else if (owningJobs[0] !== BROWSER_OWNER_JOB) {
      errors.push(`${suite.command} must be owned by ${BROWSER_OWNER_JOB} (found ${owningJobs[0]})`);
    }
  }

  const owner = jobs[BROWSER_OWNER_JOB];
  if (!owner) {
    errors.push(`${BROWSER_OWNER_JOB} job must exist`);
    return errors;
  }
  const steps = owner.steps ?? [];

  if (typeof owner['timeout-minutes'] !== 'number' || owner['timeout-minutes'] <= 0) {
    errors.push(`${BROWSER_OWNER_JOB} must declare an explicit positive timeout-minutes`);
  }
  if (!(owner.if ?? '').includes("needs.changes.outputs.backend == 'true'")) {
    errors.push(`${BROWSER_OWNER_JOB} must run when backend sources change`);
  }

  const setup = steps.find((step) => step.uses === KNOWN_BACKEND_SETUP);
  if (!setup) {
    errors.push(`${BROWSER_OWNER_JOB} must use ${KNOWN_BACKEND_SETUP}`);
  } else if (setup.with?.playwright !== 'backend') {
    errors.push(`${BROWSER_OWNER_JOB} must install Chromium with '${CHROMIUM_INSTALL_COMMAND}'`);
  }
  if (setup && setup.with?.postgres !== true && setup.with?.postgres !== 'true') {
    errors.push(`${BROWSER_OWNER_JOB} must provision PostgreSQL explicitly (the p08 suite needs it)`);
  }
  if (owner.env?.KNOWN_PG_EVIDENCE_MODE !== 'acceptance') {
    errors.push(`${BROWSER_OWNER_JOB} must run PostgreSQL suites in fail-closed acceptance mode`);
  }

  const installIndex = setupAction.steps.findIndex((step) => step.run === CHROMIUM_INSTALL_COMMAND);
  if (installIndex < 0) {
    errors.push(`${BROWSER_OWNER_JOB} must install Chromium with '${CHROMIUM_INSTALL_COMMAND}'`);
  } else {
    if (setupAction.steps[installIndex]?.if !== CHROMIUM_INSTALL_IF) {
      errors.push(`${BROWSER_OWNER_JOB} Chromium install must be gated only on the Playwright cache miss`);
    }
    const ciIndex = setupAction.steps.findIndex(isFrozenBackendInstall);
    if (ciIndex < 0 || ciIndex >= installIndex) {
      errors.push(`${BROWSER_OWNER_JOB} must run npm ci before installing Chromium`);
    }
    if (!setupAction.steps.some((step) => step.run === 'npx playwright install-deps chromium')) {
      errors.push(`${BROWSER_OWNER_JOB} must install Chromium system dependencies on every run (cache hits included)`);
    }
  }
  if (!setupAction.steps.some((step) => step.uses === '../setup-postgres' || step.uses === './.github/actions/setup-postgres')) {
    errors.push(`${BROWSER_OWNER_JOB} must provision PostgreSQL explicitly (the p08 suite needs it)`);
  }

  const cacheStep = setupAction.steps.find((step) => step.id === 'playwright-cache');
  const cacheKey = String(cacheStep?.with?.key ?? '');
  if (!cacheKey.includes('playwright-chromium-${{ runner.os }}')) {
    errors.push(`${BROWSER_OWNER_JOB} Playwright cache key must use the shared playwright-chromium- prefix`);
  }
  if (/\d+\.\d+\.\d+/u.test(cacheKey)) {
    errors.push(`${BROWSER_OWNER_JOB} Playwright cache key must not hardcode a Playwright version; the lockfile hash implies it`);
  }
  if (!cacheKey.includes("hashFiles('Known-Backend/package-lock.json')")) {
    errors.push(`${BROWSER_OWNER_JOB} Playwright cache key must pin the backend lockfile`);
  }

  for (const suite of browserSuites) {
    const suiteStep = steps.find((step) => step.run === suite.command);
    if (suiteStep?.if !== undefined) {
      errors.push(`${suite.command} must run unconditionally (no browser-missing skip)`);
    }
    // A soft failure protects nothing: `continue-on-error` turns a red Chromium
    // suite green, so the six healthy members would carry the job while this one
    // asserted nothing.
    if (suiteStep && Object.hasOwn(suiteStep, 'continue-on-error')) {
      errors.push(`${suite.command} must not swallow its failure with continue-on-error`);
    }
  }

  // The p08 suite embeds capability tokens in assertion messages (the
  // admitted.body DTO), so failure diagnostics must stay in ephemeral job
  // logs and must never be retained as long-lived artifacts.
  if (steps.some((step) => usesAction(step.uses, 'actions/upload-artifact'))) {
    errors.push(`${BROWSER_OWNER_JOB} must not upload artifacts: failure diagnostics can embed capability tokens`);
  }

  const gate = jobs['ci-gate'];
  if (!gate?.needs?.includes(BROWSER_OWNER_JOB)) {
    errors.push(`ci-gate must require ${BROWSER_OWNER_JOB}`);
  }
  if (!(gate?.steps ?? []).some((step) => /PHASE4A_BROWSER_RESULT/u.test(step.run ?? ''))) {
    errors.push('ci-gate must include PHASE4A_BROWSER_RESULT in the pass loop');
  }

  return errors;
}

test('shared unit and integration shards never select a browser-bound suite', () => {
  const unitShards = [1, 2, 3, 4].map((index) => execFileSync(process.execPath, [
    resolve(backendRoot, 'scripts/unit-shard.mjs'),
    `--shard=${index}/4`,
    '--list',
  ], { cwd: backendRoot, encoding: 'utf8' }).trim().split(/\r?\n/u));
  const integrationShards = [1, 2, 3, 4].map((index) => execFileSync(process.execPath, [
    resolve(backendRoot, 'scripts/integration-shard.mjs'),
    `--shard=${index}/4`,
    '--list',
  ], { cwd: backendRoot, encoding: 'utf8' }).trim().split(/\r?\n/u));
  const selected = new Set([...unitShards.flat(), ...integrationShards.flat()]);

  assert.ok(unitShards.every((files) => files.length > 0));
  assert.ok(integrationShards.every((files) => files.length > 0));
  for (const suite of browserSuites) {
    assert.ok(
      readFileSync(resolve(backendRoot, suite.file), 'utf8').length > 0,
      `${suite.file} must exist for the contract to be non-vacuous`,
    );
    assert.equal(
      selected.has(suite.file),
      false,
      `${suite.file} must never be selected by a shared unit/integration shard`,
    );
  }
});

test('the browser suite registry equals the package-declared browser:inner script set', () => {
  const packageJson = readPackageJson();
  const derived = derivePackageBrowserScripts(packageJson);
  const derivedCommands = derived.map((entry) => entry.command);

  assert.deepEqual(
    browserRegistryEqualityErrors(derivedCommands, browserSuites),
    [],
    'every test:phase4a:*:browser:inner package script must be registered and the registry must not carry phantom commands',
  );

  // Every registered command must own exactly the include file of the Vitest
  // config its package script references — a suite cannot hide a second file
  // or drift from its declared scope.
  const byCommand = new Map(derived.map((entry) => [entry.command, entry] as const));
  for (const suite of browserSuites) {
    const entry = byCommand.get(suite.command);
    assert.ok(entry, `${suite.command} must be a package-declared test:phase4a:*:browser:inner script`);
    assert.deepEqual(
      entry.include,
      [suite.file],
      `${suite.command} (${entry.config}) must own exactly its declared include file`,
    );
  }
});

test('coverage collects and the local full integration gate never select a browser-bound suite', () => {
  const coverageConfig = readFileSync(resolve(backendRoot, 'vitest.coverage.config.ts'), 'utf8');
  const coverageTestFiles = readFileSync(coverageTestFilesPath, 'utf8');
  assert.match(
    coverageConfig,
    /from '\.\/scripts\/phase13-coverage-test-files\.mjs'/u,
    'the Vitest collector must consume the centralized Phase 1-3 test ownership list',
  );
  assert.deepEqual(
    coverageExclusionErrors(coverageTestFiles, browserSuites),
    [],
    'the centralized Phase 1-3 ownership list must exclude every browser suite from shared collects',
  );
  const packageJson = readPackageJson();
  assert.ok(
    (packageJson.scripts['test:integration:inner'] ?? '').includes(
      '--exclude tests/integration/phase4a/phase4a-p08-browser-postgres.integration.test.ts',
    ),
    'local test:integration:inner must exclude the p08 browser suite',
  );

  // The Chromium scenario modules orchestrate an external browser; they are
  // exercised by the dedicated browser job and the evidence CLIs, never by
  // the shared coverage collects. Leaving them in the coverage universe would
  // hold unexecuted harness code to per-file coverage floors.
  for (const module of [
    'scripts/evidence/phase4a-i03-browser-scenario.ts',
    'scripts/evidence/phase4a-i11-browser-scenario.ts',
  ]) {
    assert.equal(
      PHASE_1_3_COVERAGE_INCLUDE.includes(module),
      false,
      `${module} must stay outside the shared coverage universe`,
    );
    const exclusion = PHASE_1_3_COVERAGE_EXCLUSIONS.find((entry) => entry.path === module);
    assert.equal(
      exclusion,
      undefined,
      `${module} is no longer production src, so it must not linger as a coverage exclusion`,
    );
  }
});

test('exactly one Chromium-installing CI job owns every browser suite', () => {
  const workflow = parseWorkflow(readWorkflowSource());
  assert.deepEqual(validateBrowserRouting(workflow), []);

  // act-apply-shim.py replaces Frozen backend install's `npm ci` with the
  // reuse helper. The composite still installs dependencies before Chromium.
  // Cache-key checks read the hosted composite (`.act-backup` under act).
  const shimmedSetup = parseSetupAction();
  const frozen = shimmedSetup.steps.find((step) => step.name === 'Frozen backend install');
  assert.ok(frozen, 'known-backend-setup must keep Frozen backend install');
  frozen.run = [
    'unset GIT_DIR GIT_WORK_TREE',
    'python3 "${GITHUB_WORKSPACE}/scripts/act-reuse-install.py" backend',
  ].join('\n');
  assert.deepEqual(validateBrowserRouting(workflow, shimmedSetup), []);
});

test('browser suites never soft-skip on a missing browser', () => {
  for (const suite of browserSuites) {
    const source = readFileSync(resolve(backendRoot, suite.file), 'utf8');
    assert.doesNotMatch(source, /describe\.skip|\btest\.skip\(|\.skip\(/u, `${suite.file} must not skip on a missing browser`);
    assert.doesNotMatch(
      source,
      /executablePath|PLAYWRIGHT_BROWSERS_PATH|chromium\.executablePath/u,
      `${suite.file} must not probe for a browser binary before launching`,
    );
  }
  for (const scenario of [
    'scripts/evidence/phase4a-i03-browser-scenario.ts',
    'scripts/evidence/phase4a-i11-browser-scenario.ts',
  ]) {
    const source = readFileSync(resolve(backendRoot, scenario), 'utf8');
    assert.match(
      source,
      /chromium\.launch\(\{ headless: true \}\)/u,
      `${scenario} must launch Chromium unconditionally`,
    );
  }
});

test('mutation negative controls: the routing contract fails when ownership breaks', async () => {
  const base = parseWorkflow(readWorkflowSource());
  const errors = (workflow: Workflow): string => validateBrowserRouting(workflow).join('\n');

  const withoutSuite = structuredClone(base);
  const ownerSteps = withoutSuite.jobs![BROWSER_OWNER_JOB]!.steps!;
  ownerSteps.splice(
    ownerSteps.findIndex((step) => step.run === 'npm run test:phase4a:i03:browser:inner'),
    1,
  );
  assert.match(
    errors(withoutSuite),
    /i03:browser:inner.*exactly one job/u,
  );

  const withoutR06 = structuredClone(base);
  const r06Steps = withoutR06.jobs![BROWSER_OWNER_JOB]!.steps!;
  r06Steps.splice(
    r06Steps.findIndex((step) => step.run === 'npm run test:phase4a:r06:browser:inner'),
    1,
  );
  assert.match(
    errors(withoutR06),
    /r06:browser:inner.*exactly one job/u,
  );

  const withoutChromium = structuredClone(base);
  const chromiumSetup = withoutChromium.jobs![BROWSER_OWNER_JOB]!.steps!.find(
    (step) => step.uses === KNOWN_BACKEND_SETUP,
  );
  chromiumSetup!.with = { ...chromiumSetup!.with, playwright: 'none' };
  assert.match(
    errors(withoutChromium),
    /must install Chromium/u,
  );

  // A SINGLE Chromium suite that is skipped or whose failure is swallowed must
  // fail the contract: the other six protecting theirs does not make this one
  // run, and `continue-on-error` used to be accepted here while `if` was not.
  for (const [label, patch] of [
    ['if: false', { if: 'false' }],
    ['continue-on-error: true', { 'continue-on-error': true }],
  ] as const) {
    const softened = structuredClone(base);
    const i03 = softened.jobs![BROWSER_OWNER_JOB]!.steps!.find(
      (step) => step.run === 'npm run test:phase4a:i03:browser:inner',
    )!;
    Object.assign(i03, patch);
    assert.match(
      errors(softened),
      /i03:browser:inner must (run unconditionally|not swallow its failure)/u,
      label,
    );
  }

  const withoutGate = structuredClone(base);
  withoutGate.jobs!['ci-gate']!.needs = withoutGate.jobs!['ci-gate']!.needs!.filter(
    (name) => name !== BROWSER_OWNER_JOB,
  );
  assert.match(
    errors(withoutGate),
    /ci-gate must require/u,
  );

  const twoOwners = structuredClone(base);
  const postgresJob = twoOwners.jobs!['postgres-integration']!;
  postgresJob.steps = [
    ...(postgresJob.steps ?? []),
    { name: 'leaked p08 browser suite', run: 'npm run test:phase4a:p08:browser:inner', 'working-directory': 'Known-Backend' },
  ];
  assert.match(
    errors(twoOwners),
    /p08:browser:inner.*exactly one job/u,
  );

  // Removing the r06 entry from the centralized browser ownership list must
  // route the Chromium suite back into a shared unit shard, so the transfer is
  // a real, non-vacuous part of the contract.
  const projectFilesSource = readFileSync(projectFilesPath, 'utf8');
  const projectFilesWithoutR06 = projectFilesSource.replace(
    "  'tests/unit/phase4a/phase4a-r06-browser-projection.test.ts',\n",
    '',
  );
  assert.doesNotMatch(
    projectFilesWithoutR06,
    /phase4a-r06-browser-projection\.test\.ts/u,
    'mutation must remove the r06 exclusion from the centralized ownership list',
  );
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'unit-shard-mutation-'));
  try {
    const mutatedShardPath = join(temporaryDirectory, 'unit-shard.mjs');
    await copyFile(unitShardPath, mutatedShardPath);
    await writeFile(
      join(temporaryDirectory, 'vitest-project-files.mjs'),
      projectFilesWithoutR06,
    );
    await copyFile(
      resolve(backendRoot, 'scripts/shard-buckets.mjs'),
      join(temporaryDirectory, 'shard-buckets.mjs'),
    );
    const shardLists = [1, 2, 3, 4].map((index) => execFileSync(process.execPath, [
      mutatedShardPath,
      `--shard=${index}/4`,
      '--list',
    ], { cwd: backendRoot, encoding: 'utf8' }).trim().split(/\r?\n/u));
    assert.ok(
      shardLists.some((files) => files.includes('tests/unit/phase4a/phase4a-r06-browser-projection.test.ts')),
      'removing the r06 unit-shard exclusion must select the Chromium suite again',
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }

  // Removing the r06 exclusion from the centralized coverage ownership list must fail the
  // coverage routing check.
  const coverageConfig = readFileSync(coverageConfigPath, 'utf8');
  assert.match(coverageConfig, /phase13-coverage-test-files\.mjs/u);
  const coverageSource = readFileSync(coverageTestFilesPath, 'utf8');
  const coverageWithoutR06 = coverageSource.replace("'tests/unit/phase4a/phase4a-r06-browser-projection.test.ts',\n", '');
  assert.doesNotMatch(
    coverageWithoutR06,
    /phase4a-r06-browser-projection\.test\.ts/u,
    'mutation must remove the r06 exclusion from the centralized coverage ownership list',
  );
  assert.ok(
    coverageExclusionErrors(coverageWithoutR06, browserSuites).some((message) => message.includes('r06-browser-projection')),
    'removing the r06 coverage exclusion must fail the coverage routing check',
  );

  // An unregistered browser script (declared in package.json without a
  // registry owner) must fail the registry equality contract.
  const packageJson = readPackageJson();
  const derivedCommands = derivePackageBrowserScripts(packageJson).map((entry) => entry.command);
  assert.match(
    browserRegistryEqualityErrors([...derivedCommands, 'npm run test:phase4a:zz:browser:inner'], browserSuites).join('\n'),
    /test:phase4a:zz:browser:inner.*no browser suite registry owner/u,
  );
});
