import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test } from 'vitest';
import { parse } from 'yaml';
import {
  ACTIONS_CHECKOUT,
  KNOWN_BACKEND_SETUP,
  backendRoot,
  findBackendSetupStep,
  findCallerCheckoutBeforeSetup,
  inputIsFalse,
  inputIsTrue,
  inputIsZero,
  jobsMissingCallerCheckout,
  usesAction,
  type Workflow,
} from './known-backend-ci-contract-support.js';

describe('known-backend CI regression contract', () => {
  test('local full CI shares one PostgreSQL lifecycle and does not replay unit tests', () => {
    const packageJson = JSON.parse(readFileSync(resolve(backendRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const scripts = packageJson.scripts ?? {};

    assert.match(scripts['ci:docker'] ?? '', /with-postgres\.mjs/u);
    assert.match(scripts['ci:docker'] ?? '', /ci:docker:inner/u);
    assert.match(scripts['ci:docker:inner'] ?? '', /test:integration:inner/);
    assert.match(scripts['ci:docker:inner'] ?? '', /test:unit:coverage:inner/);
    assert.match(scripts['test:unit:coverage:inner'] ?? '', /test:integration:coverage:collect:inner/);
    assert.match(scripts['test:unit:coverage:inner'] ?? '', /test:unit:coverage:merge:inner/);
    assert.match(scripts['ci:docker:inner'] ?? '', /ci:probes:inner/);
    for (const suite of [
      'sync-sequence-postgres',
      'canonical-resource-payload',
      'editor-keyset-index',
      'phase1-schema',
      'sync-pull-postgres',
      'phase3-sync-push-acceptance',
    ]) {
      assert.doesNotMatch(
        scripts['test:integration:inner'] ?? '',
        new RegExp(`--exclude tests/integration/${suite}\\.integration\\.test\\.ts`, 'u'),
        `${suite} must remain in the local integration correctness gate`,
      );
    }
    assert.doesNotMatch(scripts['ci:static'] ?? '', /test:unit/);
    assert.match(scripts.ci ?? '', /ci:static/u);
    assert.match(scripts.ci ?? '', /ci:docker/u);
  });

  test('pull_request and push share backend trigger invariants; forced runs stay unfiltered', () => {
    const workflow = readFileSync(
      resolve(backendRoot, '../.github/workflows/known-backend-ci.yml'),
      'utf8',
    );
    const parsedWorkflow = parse(workflow) as {
      on?: {
        pull_request?: { paths?: string[] };
        push?: { branches?: string[]; paths?: string[] };
        workflow_dispatch?: unknown;
        schedule?: Array<{ cron?: string; paths?: unknown }>;
      };
    };
    const pullRequestPaths = parsedWorkflow.on?.pull_request?.paths ?? [];
    const pushPaths = parsedWorkflow.on?.push?.paths ?? [];
    assert.deepEqual(pushPaths, pullRequestPaths, 'push and pull_request must use one trigger surface');
    for (const requiredPath of [
      'Known-Backend/**',
      'scripts/**',
      '.github/workflows/known-backend-ci.yml',
      '.github/actions/**',
    ] as const) {
      assert.ok(pullRequestPaths.includes(requiredPath), `trigger surface must include ${requiredPath}`);
    }
    assert.ok(
      pullRequestPaths.some((path) => path.startsWith('Known-Frontend/')),
      'frontend product consumers must be able to select backend compatibility jobs',
    );
    assert.ok(
      pullRequestPaths.some((path) => path.startsWith('Known-Extension/')),
      'extension consumers must be able to select backend compatibility jobs',
    );
    assert.equal(
      pullRequestPaths.some((path) => path.startsWith('!')),
      false,
      'top-level event paths must not negate a changes-filter input',
    );
    assert.deepEqual(parsedWorkflow.on?.push?.branches, ['main']);
    assert.ok(
      parsedWorkflow.on !== undefined && Object.hasOwn(parsedWorkflow.on, 'workflow_dispatch'),
      'workflow_dispatch must remain so operators can force full=true',
    );
    assert.equal(
      parsedWorkflow.on?.workflow_dispatch !== null
        && typeof parsedWorkflow.on?.workflow_dispatch === 'object'
        && Object.hasOwn(parsedWorkflow.on.workflow_dispatch, 'paths'),
      false,
      'workflow_dispatch must stay unfiltered so it forces full=true',
    );
    assert.deepEqual(
      parsedWorkflow.on?.schedule,
      [{ cron: '17 3 * * *' }],
      'nightly schedule must keep cron 17 3 * * * with no path filter',
    );
    assert.equal(
      parsedWorkflow.on?.schedule?.[0] !== undefined
        && Object.hasOwn(parsedWorkflow.on.schedule[0], 'paths'),
      false,
      'schedule must stay unfiltered so it forces full=true',
    );
  });

  test('changes to the workflow select the full verification scope', () => {
    const workflow = readFileSync(
      resolve(backendRoot, '../.github/workflows/known-backend-ci.yml'),
      'utf8',
    );
    const parsedWorkflow = parse(workflow) as Workflow;
    const steps = parsedWorkflow.jobs?.changes?.steps ?? [];
    const filterIndex = steps.findIndex((step) => step.id === 'filter');
    const scopeIndex = steps.findIndex((step) => step.id === 'scope');
    const filter = steps[filterIndex];
    const scope = steps[scopeIndex];

    assert.ok(filterIndex >= 0 && filterIndex < scopeIndex, 'path filtering must precede scope selection');
    assert.equal(
      filter?.if,
      "github.event_name != 'workflow_dispatch' && github.event_name != 'schedule'",
    );
    assert.equal(typeof filter?.with?.filters, 'string');
    assert.match(
      filter.with.filters as string,
      /workflow:\s*\n\s+- '\.github\/workflows\/known-backend-ci\.yml'/,
    );
    assert.match(
      filter.with.filters as string,
      /\.github\/actions\/known-backend-setup\/\*\*/,
    );
    assert.match(scope?.run ?? '', /github\.event_name.*workflow_dispatch/);
    assert.match(scope?.run ?? '', /github\.event_name.*schedule/);
    assert.match(scope?.run ?? '', /steps\.filter\.outputs\.workflow.*true/);
    assert.match(scope?.run ?? '', /full=true/);
  });

  test('headed Phase 3 browser evidence runs under a virtual X server', () => {
    const workflow = readFileSync(
      resolve(backendRoot, '../.github/workflows/known-backend-ci.yml'),
      'utf8',
    );
    const parsedWorkflow = parse(workflow) as Workflow;
    const steps = parsedWorkflow.jobs?.['phase3-evidence']?.steps ?? [];

    for (const [name, script] of [
      ['Phase 3 extension authorization evidence', 'evidence:phase3-extension-auth'],
      ['Phase 3 IndexedDB durability evidence', 'evidence:phase3-indexeddb-entry'],
    ] as const) {
      const step = steps.find((candidate) => candidate.name === name);
      assert.equal(
        step?.run,
        `xvfb-run --auto-servernum npm run ${script}`,
        `${name} must provide a virtual X server for headed Chromium`,
      );
      assert.equal(step?.['working-directory'], 'Known-Backend');
    }

    const setup = parse(readFileSync(
      resolve(backendRoot, '../.github/actions/known-backend-setup/action.yml'),
      'utf8',
    )) as { runs?: { steps?: Array<{ name?: string; if?: string; run?: string }> } };
    const permissionDriver = setup.runs?.steps?.find(
      (step) => step.name === 'Install X11 extension permission driver',
    );
    assert.equal(permissionDriver?.if, "inputs.playwright == 'backend-extension'");
    assert.match(permissionDriver?.run ?? '', /apt-get install.*xdotool/u);
  });

  test('phase3-evidence sync-claim tail stays gated off auth-only and IndexedDB-only PRs', () => {
    const workflow = readFileSync(
      resolve(backendRoot, '../.github/workflows/known-backend-ci.yml'),
      'utf8',
    );
    const parsedWorkflow = parse(workflow) as Workflow;
    const steps = parsedWorkflow.jobs?.['phase3-evidence']?.steps ?? [];
    const syncTailIf =
      "needs.changes.outputs.full == 'true' || needs.changes.outputs.phase3_sync_http == 'true'";
    for (const name of [
      'Build current backend artifact for final claim binding',
      'Phase 3 server Sync acceptance artifact',
      'Phase 3 authoritative Pull acceptance artifact',
      'Phase 3 real extension recovery artifact',
      'Phase 3 final Sync Profile claim',
      'Upload Phase 3 final claim artifact',
    ] as const) {
      const step = steps.find((candidate) => candidate.name === name);
      assert.equal(step?.if, syncTailIf, `${name} must skip unless full or phase3_sync_http`);
    }
  });

  test('keeps expensive verification isolated, sharded and scoped to runtime COLP changes', () => {
    const workflow = readFileSync(
      resolve(backendRoot, '../.github/workflows/known-backend-ci.yml'),
      'utf8',
    );
    const parsedWorkflow = parse(workflow) as Workflow;
    const jobs = parsedWorkflow.jobs ?? {};
    const filters = jobs.changes?.steps?.find((step) => step.id === 'filter')?.with?.filters;

    assert.equal(jobs.verify, undefined);
    for (const job of [
      'fast-gates',
      'quality',
      'unit',
      'sync-budget-contract',
      'archive-memory',
      'system-contracts',
      'static-contracts',
      'focused-coverage',
      'phase1-3-coverage-collect',
      'phase1-3-coverage',
      'postgres-integration',
      'postgres-probes',
      'phase4a-browser',
      'openapi',
    ]) {
      assert.ok(jobs[job], `${job} job must exist`);
    }
    const fastGates = jobs['fast-gates'];
    assert.deepEqual(fastGates?.needs, ['changes']);
    const fastRuns = (fastGates?.steps ?? []).map((step) => step.run ?? '').join('\n');
    assert.match(fastRuns, /check-test-granularity/);
    assert.match(fastRuns, /check-ci-routing/);
    assert.match(fastRuns, /scan-tracked-secrets/);
    assert.match(fastRuns, /run-gitleaks/);
    assert.match(fastRuns, /check-actions-pinned/);
    assert.match(fastRuns, /check-import-boundaries/);
    assert.doesNotMatch(fastRuns, /npm ci/);
    assert.equal(
      (fastGates?.steps ?? []).some((step) => usesAction(step.uses, 'actions/download-artifact')),
      false,
      'fast-gates must not depend on the COLP artifact',
    );
    const qualityRuns = (jobs.quality?.steps ?? []).map((step) => step.run ?? '').join('\n');
    const qualitySetup = findBackendSetupStep(jobs.quality?.steps);
    assert.equal(qualitySetup?.uses, KNOWN_BACKEND_SETUP);
    assert.ok(inputIsTrue(qualitySetup?.with?.['backend-install']));
    assert.match(qualityRuns, /ci:quality/);
    assert.doesNotMatch(qualityRuns, /check-test-granularity|check:test-granularity/);
    assert.equal(jobs['colp-package'], undefined);
    for (const jobName of [
      'phase5-feed-operations-acceptance',
      'phase5-notification-operations-acceptance',
    ]) {
      const operationsJob = jobs[jobName];
      assert.deepEqual(operationsJob?.needs, ['changes']);
      const setup = findBackendSetupStep(operationsJob?.steps);
      assert.equal(setup?.uses, KNOWN_BACKEND_SETUP);
      assert.ok(inputIsTrue(setup?.with?.postgres), `${jobName} setup must start PostgreSQL`);
      assert.ok(inputIsTrue(setup?.with?.['backend-install']), `${jobName} setup must frozen-install backend`);
      const evidenceName = jobName === 'phase5-feed-operations-acceptance'
        ? 'Phase 5 source-bound Feed operations acceptance'
        : 'Phase 5 source-bound Notification operations acceptance';
      const evidence = operationsJob?.steps?.find((step) => step.name === evidenceName);
      assert.ok(evidence?.run, `${jobName} must keep its evidence command`);
    }
    const integrationSetup = findBackendSetupStep(jobs['postgres-integration']?.steps);
    assert.equal(integrationSetup?.uses, KNOWN_BACKEND_SETUP);
    assert.ok(inputIsTrue(integrationSetup?.with?.postgres));
    assert.deepEqual(jobs['postgres-integration']?.strategy?.matrix?.shard, [1, 2, 3, 4]);
    assert.match(
      jobs['postgres-integration']?.steps?.find((step) => step.name?.startsWith('PostgreSQL integration shard'))?.run ?? '',
      /test:integration:shard.*matrix\.shard/u,
    );
    assert.deepEqual(jobs.unit?.strategy?.matrix?.shard, [1, 2, 3, 4]);
    assert.match(
      jobs.unit?.steps?.find((step) => step.name?.startsWith('Unit shard'))?.run ?? '',
      /test:unit:shard.*matrix\.shard/u,
    );
    const unitSetup = findBackendSetupStep(jobs.unit?.steps);
    assert.equal(unitSetup?.uses, KNOWN_BACKEND_SETUP);
    const unitCheckout = findCallerCheckoutBeforeSetup(jobs.unit?.steps);
    assert.equal(unitCheckout?.uses, ACTIONS_CHECKOUT);
    assert.ok(inputIsZero(unitCheckout?.with?.['fetch-depth']));
    const systemSetup = findBackendSetupStep(jobs['system-contracts']?.steps);
    assert.equal(systemSetup?.uses, KNOWN_BACKEND_SETUP);
    assert.ok(inputIsTrue(systemSetup?.with?.postgres));
    assert.equal(
      jobs['system-contracts']?.env?.DATABASE_URL,
      'postgres://known:known_test_only@127.0.0.1:5432/known_test',
    );
    assert.match(
      jobs['system-contracts']?.steps?.find(
        (step) => step.name === 'Subprocess and PostgreSQL system contracts',
      )?.run ?? '',
      /test:system:inner/u,
    );
    const coverageStep = jobs['focused-coverage']?.steps?.find(
      (step) => step.name === 'Focused coverage thresholds',
    );
    assert.equal(coverageStep?.run, 'npm run ci:focused-coverage');
    const focusedConfig = readFileSync(resolve(backendRoot, 'vitest.focused-coverage.config.ts'), 'utf8');
    assert.match(
      focusedConfig,
      /['"]tests\/integration\/product\/product-command-receipt\.integration\.test\.ts['"]/u,
      'focused-coverage must keep the receipt integration suite in its include list',
    );
    assert.match(
      focusedConfig,
      /['"]tests\/unit\/auth\/session-cookie\.test\.ts['"]/u,
      'focused-coverage must keep FIX-L-003 cookie admission in its include list',
    );
    assert.match(
      focusedConfig,
      /['"]tests\/unit\/product\/product-transport-boundary\.test\.ts['"]/u,
      'focused-coverage must keep the product admission probe in its include list',
    );
    const phase13Collect = jobs['phase1-3-coverage-collect'];
    assert.equal(
      phase13Collect?.if,
      "needs.changes.outputs.full == 'true' || needs.changes.outputs.backend == 'true'",
    );
    assert.deepEqual(phase13Collect?.strategy?.matrix?.shard, [1, 2, 3, 4]);
    assert.equal(phase13Collect?.strategy?.['fail-fast'], false);
    const phase13CollectSetup = findBackendSetupStep(phase13Collect?.steps);
    assert.ok(inputIsTrue(phase13CollectSetup?.with?.postgres));
    assert.match(
      phase13Collect?.steps?.find((step) => step.name?.startsWith('Phase 1-3 unit coverage shard'))?.run ?? '',
      /test:unit:coverage:collect:inner.*matrix\.shard/u,
    );
    assert.match(
      phase13Collect?.steps?.find(
        (step) => step.name?.startsWith('Phase 1-3 PostgreSQL integration coverage shard'),
      )?.run ?? '',
      /test:integration:coverage:collect:inner.*matrix\.shard/u,
    );
    const collectUpload = phase13Collect?.steps?.find(
      (step) => usesAction(step.uses, 'actions/upload-artifact'),
    );
    assert.equal(collectUpload?.with?.name, 'phase1-3-coverage-shard-${{ matrix.shard }}');
    assert.match(String(collectUpload?.with?.path), /shard-\$\{\{ matrix\.shard \}\}-of-4/u);
    assert.equal(collectUpload?.with?.['if-no-files-found'], 'error');

    const phase13Coverage = jobs['phase1-3-coverage'];
    assert.deepEqual(phase13Coverage?.needs, ['changes', 'phase1-3-coverage-collect']);
    assert.equal(
      phase13Coverage?.if,
      "always() && (needs.changes.outputs.full == 'true' || needs.changes.outputs.backend == 'true')",
    );
    const phase13MergeSetup = findBackendSetupStep(phase13Coverage?.steps);
    assert.ok(inputIsFalse(phase13MergeSetup?.with?.postgres));
    const downloads = (phase13Coverage?.steps ?? []).filter(
      (step) => usesAction(step.uses, 'actions/download-artifact'),
    );
    assert.deepEqual(downloads.map((step) => step.with?.name), [1, 2, 3, 4].map(
      (shard) => `phase1-3-coverage-shard-${shard}`,
    ));
    assert.deepEqual(downloads.map((step) => step.with?.path), [1, 2, 3, 4].map(
      (shard) => `Known-Backend/coverage/phase1-3/shards/shard-${shard}-of-4`,
    ));
    assert.equal(
      phase13Coverage?.steps?.find(
        (step) => step.name === 'Aggregate Phase 1-3 coverage and enforce ratchet',
      )?.run,
      'npm run test:phase1-3:coverage:aggregate:inner',
    );
    const ciGate = jobs['ci-gate'];
    assert.ok(ciGate.needs?.includes('fast-gates'));
    assert.ok(ciGate.needs?.includes('system-contracts'));
    assert.ok(ciGate.needs?.includes('static-contracts'));
    assert.ok(ciGate.needs?.includes('phase1-3-coverage-collect'));
    assert.ok(ciGate.needs?.includes('phase1-3-coverage'));
    assert.ok(ciGate.needs?.includes('phase5-email-acceptance'));
    assert.ok(ciGate.needs?.includes('mcp-write-acceptance'));
    assert.ok(ciGate.needs?.includes('redis-rate-limit'));
    assert.ok(ciGate.needs?.includes('phase5-free-social-dependencies'));
    assert.ok(ciGate.needs?.includes('sync-budget-contract'));
    assert.ok(ciGate.needs?.includes('archive-memory'));
    const gateStep = ciGate.steps?.find((step) => step.name === 'Require every selected job to pass');
    assert.match(gateStep?.run ?? '', /PHASE1_3_COVERAGE_RESULT/u);
    assert.match(gateStep?.run ?? '', /PHASE1_3_COVERAGE_COLLECT_RESULT/u);
    assert.match(gateStep?.run ?? '', /SYSTEM_CONTRACTS_RESULT/u);
    assert.match(gateStep?.run ?? '', /PHASE5_EMAIL_RESULT/u);
    assert.match(gateStep?.run ?? '', /MCP_WRITE_RESULT/u);
    assert.match(gateStep?.run ?? '', /REDIS_RATE_LIMIT_RESULT/u);
    assert.match(gateStep?.run ?? '', /PHASE5_FREE_SOCIAL_DEPENDENCIES_RESULT/u);
    assert.match(gateStep?.run ?? '', /SYNC_BUDGET_CONTRACT_RESULT/u);
    assert.match(gateStep?.run ?? '', /ARCHIVE_MEMORY_RESULT/u);
    assert.equal(jobs['real-stack-e2e']?.name, 'real-stack-e2e');
    assert.equal(
      jobs['real-stack-e2e']?.if,
      "always() && (needs.changes.outputs.full == 'true' || needs.changes.outputs.phase2b == 'true' || needs.changes.outputs.real_stack == 'true')",
    );
    assert.deepEqual(jobs['real-stack-e2e']?.needs, ['changes', 'phase2b-acceptance']);
    const realStackSteps = jobs['real-stack-e2e']?.steps ?? [];
    assert.equal(
      realStackSteps.find((step) => step.name === 'Covered by phase2b-acceptance')?.if,
      "needs.phase2b-acceptance.result == 'success'",
    );
    assert.equal(
      realStackSteps.find(
        (step) => step.name === 'Real browser, Backend worker and PostgreSQL editor evidence',
      )?.if,
      "needs.phase2b-acceptance.result == 'skipped'",
    );
    assert.equal(
      jobs['real-stack-e2e']?.steps?.find(
        (step) => step.name === 'Real browser, Backend worker and PostgreSQL editor evidence',
      )?.run,
      'npm run test:e2e:real-stack',
    );
    assert.ok(ciGate.needs?.includes('real-stack-e2e'));
    const phase2bAcceptance = readFileSync(resolve(backendRoot, 'scripts/phase2b-acceptance.mjs'), 'utf8');
    const phase2bBindings = readFileSync(
      resolve(backendRoot, 'scripts/phase2b-acceptance-bindings.mjs'),
      'utf8',
    );
    assert.match(
      phase2bAcceptance,
      /npmArgs\('run', realStackScript\)/u,
      'skip-on-full must not drop editor E2E: phase2b-acceptance still invokes the real-stack script',
    );
    assert.match(
      phase2bBindings,
      /'test:e2e:real-stack'/u,
      'Phase 2B bindings must still name test:e2e:real-stack as the real-stack command',
    );
    const phase2bSteps = jobs['phase2b-acceptance']?.steps ?? [];
    assert.equal(
      phase2bSteps.find((step) => step.name === 'Phase 2B source-bound Search and regression acceptance')?.run,
      'npm run evidence:phase2b-acceptance',
    );
    const phase2bSetup = findBackendSetupStep(phase2bSteps);
    assert.equal(phase2bSetup?.uses, KNOWN_BACKEND_SETUP);
    assert.equal(phase2bSetup?.with?.playwright, 'frontend');
    assert.ok(inputIsTrue(phase2bSetup?.with?.['frontend-install']));
    assert.equal(
      phase2bSteps.some((step) => step.id === 'phase2b-playwright-cache'),
      false,
    );
    assert.equal(typeof filters, 'string');
    const parsedFilters = parse(filters as string) as Record<string, string[]>;
    assert.equal(parsedFilters.backend?.includes('colp/**'), false);
    assert.ok(
      parsedFilters.database?.includes('Known-Backend/src/modules/**'),
      'postgres-integration must select the full module tree, not only application/',
    );
    assert.equal(
      parsedFilters.database?.includes('Known-Backend/src/modules/**/application/**'),
      false,
      'database filter must not regress to application-only module paths',
    );
  });

  test('every job that uses known-backend-setup checks out first so GitHub can load the local composite', () => {
    const workflow = readFileSync(
      resolve(backendRoot, '../.github/workflows/known-backend-ci.yml'),
      'utf8',
    );
    const parsedWorkflow = parse(workflow) as Workflow;
    const setupAction = readFileSync(
      resolve(backendRoot, '../.github/actions/known-backend-setup/action.yml'),
      'utf8',
    );
    assert.doesNotMatch(
      setupAction,
      /actions\/checkout/u,
      'composite checkout cannot load the composite; callers must checkout first',
    );
    assert.doesNotMatch(
      setupAction,
      /fetch-depth/u,
      'fetch-depth belongs on the caller checkout, not the composite',
    );
    assert.deepEqual(
      jobsMissingCallerCheckout(parsedWorkflow.jobs ?? {}),
      [],
      'GitHub hosted runners read a local action.yml from the workspace before the composite starts',
    );
  });
});
