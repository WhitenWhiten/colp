import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test } from 'vitest';
import { parse } from 'yaml';
import { SYSTEM_INCLUDE } from '../../../vitest.workspace-projects.js';
import {
  DEDICATED_ONLY_CHANGE_OUTPUTS,
  FOLLOW_ONLY_CHANGE_OUTPUTS,
  FOLLOW_ONLY_PRODUCER_OR_IF,
  PHASE5_FREE_SOCIAL_DEPENDENCIES_IF,
  PHASE5_FREE_SOCIAL_PRODUCER_OWN_FILTERS,
  KNOWN_BACKEND_SETUP,
  backendRoot,
  evaluateChangeOutputIf,
  expectedPhase5ProducerIf,
  findBackendSetupStep,
  inputIsFalse,
  inputIsTrue,
  producerJobsMissingDedicatedFilter,
  usesAction,
  validatePublicationJob,
  type Workflow,
} from './known-backend-ci-contract-support.js';

describe('known-backend CI named-owner contract', () => {
  test('email acceptance has a named CI owner and real_stack selects email/notification paths', () => {
    const workflow = readFileSync(
      resolve(backendRoot, '../.github/workflows/known-backend-ci.yml'),
      'utf8',
    );
    const parsedWorkflow = parse(workflow) as Workflow;
    const jobs = parsedWorkflow.jobs ?? {};
    const filters = jobs.changes?.steps?.find((step) => step.id === 'filter')?.with?.filters;
    assert.equal(typeof filters, 'string');
    const parsedFilters = parse(filters as string) as Record<string, string[]>;

    assert.match(
      workflow,
      /phase5_email:\s*\$\{\{ steps\.filter\.outputs\.phase5_email \}\}/u,
    );
    const emailJob = jobs['phase5-email-acceptance'];
    assert.ok(emailJob, 'phase5-email-acceptance job must exist');
    assert.equal(
      emailJob?.if,
      "needs.changes.outputs.full == 'true' || needs.changes.outputs.phase5_email == 'true'",
    );
    assert.deepEqual(emailJob?.needs, ['changes']);
    const evidenceStep = emailJob?.steps?.find(
      (step) => step.name === 'Phase 5 source-bound Email acceptance',
    );
    assert.equal(evidenceStep?.run, 'npm run evidence:phase5:email');
    assert.equal(evidenceStep?.['working-directory'], 'Known-Backend');
    const upload = emailJob?.steps?.find((step) => usesAction(step.uses, 'actions/upload-artifact'));
    assert.equal(upload?.with?.name, 'known-phase5-email-acceptance');
    assert.match(String(upload?.with?.path), /p5-31\/phase5-email-acceptance\.json/u);

    for (const glob of [
      'Known-Backend/src/infrastructure/email/**',
      'Known-Backend/src/infrastructure/notifications/**',
      'Known-Backend/src/modules/notifications/**',
      'Known-Backend/tests/unit/email/**',
      'Known-Backend/scripts/phase5-email-acceptance.mjs',
      'Known-Frontend/web/e2e-real-stack/email-preference-acceptance.spec.ts',
    ]) {
      assert.ok(
        parsedFilters.phase5_email?.includes(glob),
        `phase5_email filter must include ${glob}`,
      );
    }
    for (const glob of [
      'Known-Backend/src/infrastructure/email/**',
      'Known-Backend/src/infrastructure/notifications/**',
      'Known-Backend/src/modules/notifications/**',
      'Known-Backend/tests/unit/email/**',
    ]) {
      assert.ok(
        parsedFilters.real_stack?.includes(glob),
        `real_stack filter must include ${glob}`,
      );
    }
  });

  test('CI completeness matrix splits in-CI fixtures from real vendor cloud (TEST-13)', () => {
    // In CI: runner PostgreSQL 16, redis-rate-limit's redis:7-alpine service
    // (plus Testcontainers Redis in those suites), Playwright Chromium.
    // Not in CI: real Cloudflare R2, real DirectMail. Frozen Decision 8.
    const workflow = readFileSync(
      resolve(backendRoot, '../.github/workflows/known-backend-ci.yml'),
      'utf8',
    );
    const parsedWorkflow = parse(workflow) as Workflow;
    const jobs = parsedWorkflow.jobs ?? {};

    const setupAction = readFileSync(
      resolve(backendRoot, '../.github/actions/known-backend-setup/action.yml'),
      'utf8',
    );
    assert.ok(
      /uses: \.\/\.github\/actions\/setup-postgres/u.test(workflow)
        || /uses: \.\.\/setup-postgres/u.test(setupAction)
        || /uses: \.\/\.github\/actions\/setup-postgres/u.test(setupAction),
      'PostgreSQL setup must remain in the workflow or the known-backend-setup composite',
    );
    const jobsWithServices = Object.entries(jobs).filter(([, job]) => job.services);
    assert.deepEqual(
      jobsWithServices.map(([name]) => name),
      ['redis-rate-limit'],
      'only redis-rate-limit may declare a GitHub Actions service; Redis stays redis:7-alpine, not vendor cloud',
    );
    assert.equal(jobs['redis-rate-limit']?.services?.redis?.image, 'redis:7-alpine');
    assert.ok(
      /npx playwright install(?:-deps| --with-deps)? chromium/u.test(workflow)
        || /npx playwright install(?:-deps| --with-deps)? chromium/u.test(setupAction),
      'Playwright Chromium install must remain in the workflow or known-backend-setup',
    );

    const browser = readFileSync(resolve(backendRoot, 'vitest.browser.config.ts'), 'utf8');
    assert.match(
      browser,
      /never touches a real R2 endpoint/u,
      'P08 browser scope must stay on the local object server, not production R2',
    );

    assert.doesNotMatch(workflow, /EMAIL_DM_TARGET_ATTESTATION/u);
    assert.doesNotMatch(workflow, /CLOUDFLARE_ACCOUNT_ID|R2_ACCESS_KEY|R2_SECRET_ACCESS/u);
    assert.doesNotMatch(workflow, /DirectMail|ALIBABA_CLOUD_ACCESS/u);
    for (const jobName of Object.keys(jobs)) {
      assert.doesNotMatch(
        jobName,
        /r2-live|directmail|real-cloud/iu,
        `no production-cloud job may be added (${jobName})`,
      );
    }
  });

  test('MCP write acceptance has a named CI owner and mcp_write path filter', () => {
    const workflow = readFileSync(
      resolve(backendRoot, '../.github/workflows/known-backend-ci.yml'),
      'utf8',
    );
    const parsedWorkflow = parse(workflow) as Workflow;
    const jobs = parsedWorkflow.jobs ?? {};
    const filters = jobs.changes?.steps?.find((step) => step.id === 'filter')?.with?.filters;
    assert.equal(typeof filters, 'string');
    const parsedFilters = parse(filters as string) as Record<string, string[]>;

    assert.match(
      workflow,
      /mcp_write:\s*\$\{\{ steps\.filter\.outputs\.mcp_write \}\}/u,
    );
    const writeJob = jobs['mcp-write-acceptance'];
    assert.ok(writeJob, 'mcp-write-acceptance job must exist');
    assert.equal(
      writeJob?.if,
      "needs.changes.outputs.full == 'true' || needs.changes.outputs.mcp_write == 'true'",
    );
    assert.deepEqual(writeJob?.needs, ['changes']);
    const evidenceStep = writeJob?.steps?.find(
      (step) => step.name === 'Phase 4B source-bound MCP Write acceptance',
    );
    assert.equal(evidenceStep?.run, 'npm run evidence:phase4b:mcp-write-acceptance');
    assert.equal(evidenceStep?.['working-directory'], 'Known-Backend');
    const writeSetup = findBackendSetupStep(writeJob?.steps);
    assert.equal(writeSetup?.uses, KNOWN_BACKEND_SETUP);
    assert.ok(inputIsTrue(writeSetup?.with?.postgres), 'mcp-write-acceptance setup must start PostgreSQL');
    assert.equal(writeSetup?.with?.['npm-cache'], 'backend');
    const upload = writeJob?.steps?.find((step) => usesAction(step.uses, 'actions/upload-artifact'));
    assert.equal(upload?.with?.name, 'known-phase4b-mcp-write-acceptance');
    assert.match(String(upload?.with?.path), /known-phase4b-mcp-write-acceptance\.json/u);

    for (const glob of [
      'Known-Backend/src/modules/mcp/**',
      'Known-Backend/src/transport/mcp/**',
      'Known-Backend/scripts/phase4b-mcp-write-acceptance.mjs',
      'Known-Backend/scripts/phase4b-mcp-write-acceptance-adapter.ts',
      'Known-Backend/scripts/phase4b-mcp-write-acceptance-bindings.mjs',
      'Known-Backend/scripts/acceptance/phase4b-mcp-write-acceptance.ts',
    ]) {
      assert.ok(
        parsedFilters.mcp_write?.includes(glob),
        `mcp_write filter must include ${glob}`,
      );
    }
    for (const deadGlob of [
      'Known-Backend/src/transport/mcp-write-approval-routes.ts',
      'Known-Backend/src/transport/register-mcp.ts',
    ]) {
      assert.equal(
        parsedFilters.mcp_write?.includes(deadGlob),
        false,
        `mcp_write filter must not keep pre-move transport path ${deadGlob}`,
      );
    }
  });

  test('MCP compat protocol matrix is owned by the subprocess system lane', () => {
    const workflow = readFileSync(
      resolve(backendRoot, '../.github/workflows/known-backend-ci.yml'),
      'utf8',
    );
    const parsedWorkflow = parse(workflow) as Workflow;
    const jobs = parsedWorkflow.jobs ?? {};
    assert.ok(jobs.unit, 'unit job must exist');
    assert.deepEqual(jobs.unit?.strategy?.matrix?.shard, [1, 2, 3, 4]);
    assert.match(
      jobs.unit?.steps?.find((step) => step.name?.startsWith('Unit shard'))?.run ?? '',
      /test:unit:shard.*matrix\.shard/u,
    );
    assert.equal(jobs['mcp-compat-acceptance'], undefined);
    assert.equal(jobs['mcp-compat-matrix'], undefined);
    const system = jobs['system-contracts'];
    assert.ok(system, 'system-contracts job must own subprocess-based protocol clients');
    assert.match(
      system.steps?.find((step) => step.name === 'Subprocess and PostgreSQL system contracts')?.run ?? '',
      /test:system:inner/u,
    );

    const names = readdirSync(resolve(backendRoot, 'tests/unit/phase4b'))
      .filter((name) => /^phase4b-mcp-compat-.*\.test\.ts$/u.test(name));
    assert.ok(names.length >= 1, 'phase4b-mcp-compat-*.test.ts glob must be non-empty');
    assert.ok(names.includes('phase4b-mcp-compat-real-clients.test.ts'));
    assert.ok(SYSTEM_INCLUDE.includes('tests/unit/phase4b/phase4b-mcp-compat-real-clients.test.ts'));
  });

  test('Phase 5 free-social dependencies has a named CI owner over the five artifacts', () => {
    const workflow = readFileSync(
      resolve(backendRoot, '../.github/workflows/known-backend-ci.yml'),
      'utf8',
    );
    const parsedWorkflow = parse(workflow) as Workflow;
    const jobs = parsedWorkflow.jobs ?? {};
    const filters = jobs.changes?.steps?.find((step) => step.id === 'filter')?.with?.filters;
    assert.equal(typeof filters, 'string');
    const parsedFilters = parse(filters as string) as Record<string, string[]>;

    assert.match(
      workflow,
      /phase5_free_social_dependencies:\s*\$\{\{ steps\.filter\.outputs\.phase5_free_social_dependencies \}\}/u,
    );
    const job = jobs['phase5-free-social-dependencies'];
    assert.ok(job, 'phase5-free-social-dependencies job must exist');
    assert.equal(job?.if, PHASE5_FREE_SOCIAL_DEPENDENCIES_IF);
    assert.equal(
      evaluateChangeOutputIf(job?.if ?? '', FOLLOW_ONLY_CHANGE_OUTPUTS),
      false,
      'follow-only must skip phase5-free-social-dependencies',
    );
    assert.equal(
      evaluateChangeOutputIf(FOLLOW_ONLY_PRODUCER_OR_IF, FOLLOW_ONLY_CHANGE_OUTPUTS),
      true,
      'sanity: an any-producer OR if still selects follow-only and must stay rejected',
    );
    assert.equal(
      evaluateChangeOutputIf(job?.if ?? '', DEDICATED_ONLY_CHANGE_OUTPUTS),
      true,
      'the dedicated filter must still select the verifier',
    );
    assert.equal(
      evaluateChangeOutputIf(job?.if ?? '', {
        ...FOLLOW_ONLY_CHANGE_OUTPUTS,
        phase5_follow: true,
        phase5_feed: true,
        phase5_notification: true,
        phase5_feed_operations: true,
        phase5_notification_operations: true,
      }),
      true,
      'all five producer filters together must select the verifier',
    );
    assert.deepEqual(
      producerJobsMissingDedicatedFilter(jobs),
      [],
      'each Phase 5 producer if must OR phase5_free_social_dependencies (parsed job if)',
    );
    for (const [jobName, ownFilter] of Object.entries(PHASE5_FREE_SOCIAL_PRODUCER_OWN_FILTERS)) {
      const producerIf = jobs[jobName]?.if ?? '';
      assert.equal(
        producerIf,
        expectedPhase5ProducerIf(ownFilter),
        `${jobName} if must keep full || ${ownFilter} || phase5_free_social_dependencies`,
      );
      assert.equal(
        evaluateChangeOutputIf(producerIf, DEDICATED_ONLY_CHANGE_OUTPUTS),
        true,
        `${jobName} must run when only the dedicated filter is true`,
      );
    }
    const mutatedJobs = structuredClone(jobs);
    const followIf = mutatedJobs['phase5-follow-acceptance']?.if ?? '';
    mutatedJobs['phase5-follow-acceptance'] = {
      ...mutatedJobs['phase5-follow-acceptance'],
      if: followIf.replace(
        /\s*\|\|\s*needs\.changes\.outputs\.phase5_free_social_dependencies\s*==\s*'true'/u,
        '',
      ),
    };
    assert.deepEqual(
      producerJobsMissingDedicatedFilter(mutatedJobs),
      ['phase5-follow-acceptance'],
      'dropping the dedicated OR from one producer must fail the producer-if lock',
    );
    assert.equal(
      evaluateChangeOutputIf(
        mutatedJobs['phase5-follow-acceptance']?.if ?? '',
        DEDICATED_ONLY_CHANGE_OUTPUTS,
      ),
      false,
      'a producer that dropped the dedicated OR must not run on dedicated-only',
    );
    assert.deepEqual(job?.needs, [
      'changes',
      'phase5-follow-acceptance',
      'phase5-feed-acceptance',
      'phase5-notification-acceptance',
      'phase5-feed-operations-acceptance',
      'phase5-notification-operations-acceptance',
    ]);
    const verifyStep = job?.steps?.find(
      (step) => step.name === 'Verify Phase 5 free-social dependency binding',
    );
    assert.equal(verifyStep?.run, 'npm run verify:phase5:free-social-dependencies');
    assert.equal(verifyStep?.['working-directory'], 'Known-Backend');
    assert.equal(verifyStep?.env?.KNOWN_PHASE5_FREE_SOCIAL_DEPENDENCY_MODE, 'ci-live');
    const freeSocialSetup = findBackendSetupStep(job?.steps);
    assert.equal(freeSocialSetup?.uses, KNOWN_BACKEND_SETUP);
    assert.equal(freeSocialSetup?.with?.colp, undefined);
    const downloaded = (job?.steps ?? [])
      .filter((step) => usesAction(step.uses, 'actions/download-artifact'))
      .map((step) => step.with?.name);
    assert.deepEqual(downloaded, [
      'known-phase5-follow-acceptance',
      'known-phase5-feed-acceptance',
      'known-phase5-notification-acceptance',
      'known-phase5-feed-operations-acceptance',
      'known-phase5-notification-operations-acceptance',
    ]);
    assert.ok(jobs['ci-gate']?.needs?.includes('phase5-free-social-dependencies'));
    for (const glob of [
      'Known-Backend/scripts/phase5-free-social-dependencies.mjs',
      'Known-Backend/tests/unit/phase5/phase5-free-social-dependencies.test.ts',
    ]) {
      assert.ok(
        parsedFilters.phase5_free_social_dependencies?.includes(glob),
        `phase5_free_social_dependencies filter must include ${glob}`,
      );
    }
  });

  test('Redis rate-limit suites have a named CI owner with a Redis service', () => {
    const workflow = readFileSync(
      resolve(backendRoot, '../.github/workflows/known-backend-ci.yml'),
      'utf8',
    );
    const parsedWorkflow = parse(workflow) as Workflow;
    const jobs = parsedWorkflow.jobs ?? {};
    const filters = jobs.changes?.steps?.find((step) => step.id === 'filter')?.with?.filters;
    assert.equal(typeof filters, 'string');
    const parsedFilters = parse(filters as string) as Record<string, string[]>;

    assert.match(
      workflow,
      /redis_rate_limit:\s*\$\{\{ steps\.filter\.outputs\.redis_rate_limit \}\}/u,
    );
    const redisJob = jobs['redis-rate-limit'];
    assert.ok(redisJob, 'redis-rate-limit job must exist');
    assert.equal(
      redisJob?.if,
      "needs.changes.outputs.full == 'true' || needs.changes.outputs.redis_rate_limit == 'true'",
    );
    assert.deepEqual(redisJob?.needs, ['changes']);
    assert.equal(redisJob?.services?.redis?.image, 'redis:7-alpine');
    const suiteStep = redisJob?.steps?.find(
      (step) => step.name === 'Redis rate-limit and cache suites',
    );
    assert.equal(suiteStep?.run, 'npm run test:redis-rate-limit');
    assert.equal(suiteStep?.['working-directory'], 'Known-Backend');
    const redisSetup = findBackendSetupStep(redisJob?.steps);
    assert.equal(redisSetup?.uses, KNOWN_BACKEND_SETUP);
    assert.ok(inputIsTrue(redisSetup?.with?.postgres), 'redis-rate-limit setup must start PostgreSQL');

    for (const glob of [
      'Known-Backend/src/infrastructure/rate-limit/**',
      'Known-Backend/src/infrastructure/cache/**',
      'Known-Backend/tests/integration/phase4a/*redis*',
    ]) {
      assert.ok(
        parsedFilters.redis_rate_limit?.includes(glob),
        `redis_rate_limit filter must include ${glob}`,
      );
    }
  });

  test('publication acceptance installs frozen web dependencies before starting the harness', () => {
    const workflow = readFileSync(
      resolve(backendRoot, '../.github/workflows/known-backend-ci.yml'),
      'utf8',
    );
    const parsedWorkflow = parse(workflow) as Workflow;
    assert.deepEqual(validatePublicationJob(parsedWorkflow), []);

    const withoutInstall = structuredClone(parsedWorkflow);
    const withoutInstallSetup = findBackendSetupStep(
      withoutInstall.jobs?.['publication-acceptance']?.steps,
    );
    withoutInstallSetup!.with!['frontend-install'] = 'false';
    assert.match(validatePublicationJob(withoutInstall).join('\n'), /frozen web install/i);

    const wrongOrder = structuredClone(parsedWorkflow);
    const wrongOrderSteps = wrongOrder.jobs?.['publication-acceptance']?.steps ?? [];
    wrongOrderSteps.push(wrongOrderSteps.splice(
      wrongOrderSteps.findIndex((step) => step.uses === KNOWN_BACKEND_SETUP),
      1,
    )[0]!);
    assert.match(validatePublicationJob(wrongOrder).join('\n'), /must precede/);

    const withoutCacheDependency = structuredClone(parsedWorkflow);
    const setup = findBackendSetupStep(
      withoutCacheDependency.jobs?.['publication-acceptance']?.steps,
    );
    setup!.with!['npm-cache'] = 'backend';
    assert.match(validatePublicationJob(withoutCacheDependency).join('\n'), /cache must depend/);
  });

  test('sensitive-shaped search fixtures explicitly document their secret-scan exception', () => {
    const source = readFileSync(
      resolve(backendRoot, 'tests/integration/search/search-profile-annotation-postgres.integration.test.ts'),
      'utf8',
    );
    const fixtureLine = source.split(/\r?\n/).find((line) => line.includes("'private-secret'"));

    assert.ok(fixtureLine, 'sensitive-shaped search fixture must exist');
    assert.match(fixtureLine, /secret-scan: allow/);
  });

  test('transport budget and archive memory have named CI owners over existing unit contracts', () => {
    const workflow = readFileSync(
      resolve(backendRoot, '../.github/workflows/known-backend-ci.yml'),
      'utf8',
    );
    const parsedWorkflow = parse(workflow) as Workflow;
    const jobs = parsedWorkflow.jobs ?? {};
    const budget = jobs['sync-budget-contract'];
    const archive = jobs['archive-memory'];
    const backendIf = "needs.changes.outputs.full == 'true' || needs.changes.outputs.backend == 'true'";
    assert.equal(budget?.if, backendIf);
    assert.equal(archive?.if, backendIf);
    assert.deepEqual(budget?.needs, ['changes']);
    assert.deepEqual(archive?.needs, ['changes']);
    const budgetSetup = findBackendSetupStep(budget?.steps);
    const archiveSetup = findBackendSetupStep(archive?.steps);
    assert.ok(inputIsTrue(budgetSetup?.with?.['backend-install']));
    assert.ok(inputIsTrue(budgetSetup?.with?.['extension-install']));
    assert.ok(inputIsFalse(budgetSetup?.with?.postgres));
    assert.ok(inputIsFalse(archiveSetup?.with?.postgres));
    assert.equal(
      budget?.steps?.find((step) => step.name === 'Backend transport budget contract')?.run,
      'npm run test:sync-budget-contract',
    );
    assert.equal(
      budget?.steps?.find((step) => step.name === 'Extension transport budget contract')?.run,
      'npm run test:sync-budget-contract',
    );
    assert.equal(
      archive?.steps?.find((step) => step.name === 'Archive payload cache memory contract')?.run,
      'npm run test:archive-memory',
    );
    assert.ok(jobs['ci-gate']?.needs?.includes('sync-budget-contract'));
    assert.ok(jobs['ci-gate']?.needs?.includes('archive-memory'));
  });
});
