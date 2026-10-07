import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test } from 'vitest';
import { parse } from 'yaml';
import {
  backendRoot,
  type Workflow,
} from './known-backend-ci-contract-support.js';

function onPathCoversFilterGlob(onGlob: string, filterGlob: string): boolean {
  if (onGlob === filterGlob) return true;
  if (onGlob.endsWith('/**')) {
    const prefix = onGlob.slice(0, -3);
    return filterGlob === prefix || filterGlob.startsWith(`${prefix}/`);
  }
  return false;
}

describe('known-backend CI path-filter contract', () => {
  test('phase2b and library_management filters select shard-excluded extra-evidence suites', () => {
    const workflow = readFileSync(
      resolve(backendRoot, '../.github/workflows/known-backend-ci.yml'),
      'utf8',
    );
    const parsedWorkflow = parse(workflow) as Workflow;
    const filters = parsedWorkflow.jobs?.changes?.steps?.find((step) => step.id === 'filter')?.with?.filters;
    assert.equal(typeof filters, 'string');
    const parsedFilters = parse(filters as string) as Record<string, string[]>;

    for (const glob of [
      'Known-Backend/tests/**/*search*',
      'Known-Backend/tests/support/postgres-test-runtime*',
      'Known-Backend/tests/support/better-auth-test-factory*',
      'Known-Backend/src/infrastructure/database/index.ts',
      'Known-Backend/src/infrastructure/database/runtime.ts',
      'Known-Backend/src/infrastructure/database/migrations.ts',
      'Known-Backend/src/infrastructure/database/postgres-shared-exposure-facts.ts',
    ]) {
      assert.ok(
        parsedFilters.phase2b?.includes(glob),
        `phase2b filter must include import-reachable ${glob}`,
      );
    }
    assert.equal(
      parsedFilters.phase2b?.includes('Known-Backend/src/infrastructure/database/**'),
      false,
      'phase2b must not dump the entire database tree; pin the imported modules',
    );

    for (const glob of [
      'Known-Backend/tests/**/*library-management*',
      'Known-Backend/tests/**/*owned-collections*',
      'Known-Backend/tests/**/*owned-collection*',
      'Known-Backend/tests/**/*saved-resource*',
      'Known-Backend/tests/**/*reading-progress*',
      'Known-Backend/tests/support/postgres-test-runtime*',
      'Known-Backend/tests/support/better-auth-test-factory*',
      'Known-Backend/src/infrastructure/database/index.ts',
      'Known-Backend/src/infrastructure/database/runtime.ts',
      'Known-Backend/src/infrastructure/database/migrations.ts',
      'Known-Backend/src/infrastructure/database/unit-of-work.ts',
    ]) {
      assert.ok(
        parsedFilters.library_management?.includes(glob),
        `library_management filter must include ${glob}`,
      );
    }
    assert.equal(
      parsedFilters.library_management?.includes('Known-Backend/src/infrastructure/database/**'),
      false,
      'library_management must not dump the entire database tree; pin the imported modules',
    );
  });

  test('backend filter excludes all Known-Backend docs; evidence still owns evidence docs', () => {
    const workflow = readFileSync(
      resolve(backendRoot, '../.github/workflows/known-backend-ci.yml'),
      'utf8',
    );
    const parsedWorkflow = parse(workflow) as Workflow;
    const filters = parsedWorkflow.jobs?.changes?.steps?.find((step) => step.id === 'filter')?.with?.filters;
    assert.equal(typeof filters, 'string');
    const parsedFilters = parse(filters as string) as Record<string, string[]>;

    assert.ok(parsedFilters.backend?.includes('Known-Backend/**'));
    assert.ok(
      parsedFilters.backend?.includes('!Known-Backend/docs/**'),
      'runbook and ADR edits must not select the full backend universe',
    );
    assert.equal(
      parsedFilters.backend?.includes('!Known-Backend/docs/evidence/**'),
      false,
      'backend must exclude the whole docs tree, not only evidence/',
    );
    assert.ok(
      parsedFilters.evidence?.includes('Known-Backend/docs/evidence/**'),
      'evidence-doc edits must still select backend-evidence',
    );
  });

  test('real_stack selects mcp/auth/attachments/sync application paths and documents intentional omissions', () => {
    const workflow = readFileSync(
      resolve(backendRoot, '../.github/workflows/known-backend-ci.yml'),
      'utf8',
    );
    const parsedWorkflow = parse(workflow) as Workflow;
    const filters = parsedWorkflow.jobs?.changes?.steps?.find((step) => step.id === 'filter')?.with?.filters;
    assert.equal(typeof filters, 'string');
    const parsedFilters = parse(filters as string) as Record<string, string[]>;

    for (const glob of [
      'Known-Backend/src/modules/mcp/**',
      'Known-Backend/src/modules/auth/**',
      'Known-Backend/src/modules/attachments/**',
      'Known-Backend/src/modules/sync/**',
      'Known-Backend/src/infrastructure/auth/**',
      'Known-Backend/src/infrastructure/object-storage/**',
      'Known-Frontend/web/e2e-real-stack/**',
      'Known-Frontend/web/playwright.real-stack.config.ts',
      'Known-Frontend/web/src/api/**',
      'Known-Frontend/web/src/**/*.ts',
      'Known-Frontend/web/src/**/*.tsx',
      'Known-Frontend/web/package.json',
      'Known-Frontend/web/package-lock.json',
    ]) {
      assert.ok(
        parsedFilters.real_stack?.includes(glob),
        `changing ${glob} must select real_stack`,
      );
    }
    assert.equal(
      parsedFilters.real_stack?.includes('Known-Frontend/web/**'),
      false,
      'real_stack must not select the entire frontend tree',
    );

    // Intentional omissions (TEST-08): sibling trees that exist on disk but are
    // not in Frozen Decision 7. Named jobs, unit/postgres, or non-browser
    // oracles already own them — keep the skip explicit so a later dump of
    // the whole modules/infrastructure tree cannot land as an accident.
    for (const glob of [
      // phase5_follow / phase5_feed / phase5_feed_operations already own this.
      'Known-Backend/src/modules/social/**',
      // Command receipts belong to focused-coverage, not browser E2E.
      'Known-Backend/src/modules/commands/**',
      // TEST-08 listed cache beside auth/object-storage; Frozen Decision 7
      // left it out. Redis is Testcontainers; TEST-13 keeps real vendor out.
      'Known-Backend/src/infrastructure/cache/**',
      // phase3_sync_http already selects this tree. Frozen Decision 7 added
      // modules/sync (application), not the postgres sequence store.
      'Known-Backend/src/infrastructure/sync/**',
      // Hardened egress is unit-tested; no unique browser oracle.
      'Known-Backend/src/infrastructure/egress/**',
      // Limiter families are unit/HTTP inject; replica Redis is a config gate.
      'Known-Backend/src/infrastructure/rate-limit/**',
      // Seed scripts are not product HTTP.
      'Known-Backend/src/infrastructure/seed/**',
      // Observability is not a user-visible E2E surface.
      'Known-Backend/src/infrastructure/telemetry/**',
      // COLP adapters are owned by colp-ci, not real-stack Playwright.
      'Known-Backend/src/infrastructure/colp/**',
      // Matching modules are already in real_stack; postgres/unit own adapters.
      'Known-Backend/src/infrastructure/collections/**',
      'Known-Backend/src/infrastructure/access-policy/**',
      'Known-Backend/src/infrastructure/social/**',
      'Known-Backend/src/infrastructure/publisher/**',
    ]) {
      assert.equal(
        parsedFilters.real_stack?.includes(glob),
        false,
        `real_stack must omit ${glob} until a browser-unique oracle exists`,
      );
    }
  });

  test('publication, phase2b, and phase3_sync_http filters watch post-move transport paths', () => {
    const workflow = readFileSync(
      resolve(backendRoot, '../.github/workflows/known-backend-ci.yml'),
      'utf8',
    );
    const parsedWorkflow = parse(workflow) as Workflow;
    const filters = parsedWorkflow.jobs?.changes?.steps?.find((step) => step.id === 'filter')?.with?.filters;
    assert.equal(typeof filters, 'string');
    const parsedFilters = parse(filters as string) as Record<string, string[]>;

    for (const glob of [
      'Known-Backend/src/transport/product/publication-*',
      'Known-Backend/src/transport/product/product-public-*',
    ]) {
      assert.ok(
        parsedFilters.publication?.includes(glob),
        `publication filter must include ${glob}`,
      );
    }
    for (const deadGlob of [
      'Known-Backend/src/transport/publication-**',
      'Known-Backend/src/transport/product-public-**',
    ]) {
      assert.equal(
        parsedFilters.publication?.includes(deadGlob),
        false,
        `publication filter must not keep pre-move transport path ${deadGlob}`,
      );
    }

    assert.ok(
      parsedFilters.phase2b?.includes('Known-Backend/src/transport/product/search-routes.ts'),
      'phase2b filter must include Known-Backend/src/transport/product/search-routes.ts',
    );
    assert.equal(
      parsedFilters.phase2b?.includes('Known-Backend/src/transport/search-routes.ts'),
      false,
      'phase2b filter must not keep pre-move transport path Known-Backend/src/transport/search-routes.ts',
    );

    for (const glob of [
      'Known-Backend/src/transport/product/publication-manifest-routes.ts',
      'Known-Backend/src/transport/colp-sync/sync-*',
    ]) {
      assert.ok(
        parsedFilters.phase3_sync_http?.includes(glob),
        `phase3_sync_http filter must include ${glob}`,
      );
    }
    for (const deadGlob of [
      'Known-Backend/src/transport/publication-manifest-routes.ts',
      'Known-Backend/src/transport/sync-*',
    ]) {
      assert.equal(
        parsedFilters.phase3_sync_http?.includes(deadGlob),
        false,
        `phase3_sync_http filter must not keep pre-move transport path ${deadGlob}`,
      );
    }
  });

  test('on.paths covers every changes-filter glob so acceptance jobs can still start', () => {
    const workflow = readFileSync(
      resolve(backendRoot, '../.github/workflows/known-backend-ci.yml'),
      'utf8',
    );
    const parsedWorkflow = parse(workflow) as {
      on?: { pull_request?: { paths?: string[] } };
      jobs?: Workflow['jobs'];
    };
    const onPaths = parsedWorkflow.on?.pull_request?.paths ?? [];
    const filters = parsedWorkflow.jobs?.changes?.steps?.find((step) => step.id === 'filter')?.with?.filters;
    assert.equal(typeof filters, 'string');
    const parsedFilters = parse(filters as string) as Record<string, string[]>;
    const uncovered: string[] = [];
    for (const [name, globs] of Object.entries(parsedFilters)) {
      for (const glob of globs) {
        if (glob.startsWith('!')) continue;
        if (!onPaths.some((onGlob) => onPathCoversFilterGlob(onGlob, glob))) {
          uncovered.push(`${name}: ${glob}`);
        }
      }
    }
    assert.deepEqual(
      uncovered,
      [],
      'every dorny filter glob must be reachable through on.paths; otherwise the workflow never starts',
    );
  });
});
