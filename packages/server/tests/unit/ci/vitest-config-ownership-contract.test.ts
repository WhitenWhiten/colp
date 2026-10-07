import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { describe, test } from 'vitest';
import { parse } from 'yaml';
import { listDomainTestFilesSync } from '../../../scripts/shard-buckets.mjs';
import { INTEGRATION_SHARD_EXCLUDE } from '../../../scripts/vitest-project-files.mjs';
import {
  BROWSER_INCLUDE,
  EVIDENCE_INCLUDE,
  POSTGRES_EXCLUDE,
  POSTGRES_INCLUDE,
  REDIS_INCLUDE,
  STATIC_EXCLUDE,
  STATIC_INCLUDE,
  SYSTEM_INCLUDE,
  UNIT_EXCLUDE,
  UNIT_INCLUDE,
  WORKSPACE_PROJECT_NAMES,
} from '../../../vitest.workspace-projects.js';
import {
  COVERAGE_VITEST_CONFIGS,
  REMAINING_DEDICATED_VITEST_CONFIGS,
  UNREACHABLE_VITEST_CONFIG_ALLOWLIST,
  WORKSPACE_PROJECT_CONFIGS,
  collectCiReachability,
  collectWorkflowRunSteps,
  extractVitestConfigFlags,
  extractVitestProjectFlags,
  fileMatchesInclude,
  isConfigReachable,
  resolveIncludeFiles,
  stripJsComments,
  stripShellComments,
} from './vitest-config-reachability';

const backendRoot = resolve(import.meta.dirname, '../../..');
const repositoryRoot = resolve(backendRoot, '..');

function listVitestConfigs(): string[] {
  return readdirSync(backendRoot, { withFileTypes: true })
    .filter((entry) => (
      entry.isFile()
      && entry.name !== 'vitest.config.ts'
      && entry.name.startsWith('vitest.')
      && entry.name.endsWith('.config.ts')
    ))
    .map((entry) => entry.name)
    .sort();
}

function readPackageScripts(): Record<string, string> {
  const packageJson = JSON.parse(readFileSync(join(backendRoot, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  return packageJson.scripts ?? {};
}

function collectExistingTestFiles(): string[] {
  return [
    ...listDomainTestFilesSync(backendRoot, { kind: 'unit', suffix: '.test.ts' }),
    ...listDomainTestFilesSync(backendRoot, { kind: 'integration', suffix: '.integration.test.ts' }),
  ].map((file) => file.path);
}

function matchesAny(file: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => fileMatchesInclude(file, pattern));
}

function claimedByProject(file: string): string[] {
  const names: string[] = [];
  if (matchesAny(file, UNIT_INCLUDE) && !matchesAny(file, UNIT_EXCLUDE)) names.push('unit');
  if (matchesAny(file, STATIC_INCLUDE) && !matchesAny(file, STATIC_EXCLUDE)) names.push('static');
  if ((SYSTEM_INCLUDE as readonly string[]).includes(file)) names.push('system');
  if (matchesAny(file, POSTGRES_INCLUDE) && !matchesAny(file, POSTGRES_EXCLUDE)) names.push('postgres');
  if ((REDIS_INCLUDE as readonly string[]).includes(file)) names.push('redis');
  if ((BROWSER_INCLUDE as readonly string[]).includes(file)) names.push('browser');
  if ((EVIDENCE_INCLUDE as readonly string[]).includes(file)) names.push('evidence');
  return names;
}

function loadRepoReachability() {
  const workflow = parse(
    readFileSync(join(repositoryRoot, '.github/workflows/known-backend-ci.yml'), 'utf8'),
  ) as { jobs?: Record<string, { steps?: Array<{ run?: string }> }> };
  const packageScripts = readPackageScripts();
  return collectCiReachability({
    workflowRunSteps: collectWorkflowRunSteps(workflow),
    packageScripts,
    readSpawnedScript: (specifier) => {
      const absolute = join(backendRoot, specifier);
      try {
        return readFileSync(absolute, 'utf8');
      } catch {
        return undefined;
      }
    },
  });
}

describe('vitest config CI reachability helper', () => {
  test('a comment mention is not a --config invocation (old substring would pass)', () => {
    const run = [
      '# owned by vitest.ghost-comment.config.ts',
      'npm run test:unit:shard',
    ].join('\n');
    assert.equal(run.includes('vitest.ghost-comment.config.ts'), true);
    assert.deepEqual(extractVitestConfigFlags(stripShellComments(run)), []);

    const reachability = collectCiReachability({
      workflowRunSteps: [run],
      packageScripts: {
        'test:unit:shard': 'node scripts/unit-shard.mjs',
        'test:local:ghost': 'vitest run --config vitest.ghost-comment.config.ts',
      },
    });
    assert.equal(reachability.invokedConfigs.has('vitest.ghost-comment.config.ts'), false);
    assert.equal(
      isConfigReachable({
        configName: 'vitest.ghost-comment.config.ts',
        includeFiles: ['tests/unit/missing/ghost-comment.test.ts'],
        invokedConfigs: reachability.invokedConfigs,
        executedFiles: new Set(['tests/unit/ci/real.test.ts']),
        allowlist: [],
      }),
      false,
    );
  });

  test('an unused local npm script does not own a config', () => {
    const reachability = collectCiReachability({
      workflowRunSteps: ['npm run test:unit:shard'],
      packageScripts: {
        'test:unit:shard': 'node scripts/unit-shard.mjs',
        'test:local:orphan': 'vitest run --config vitest.orphan-local.config.ts',
      },
    });
    assert.equal(reachability.invokedConfigs.has('vitest.orphan-local.config.ts'), false);
  });

  test('an exclude-list or JS comment mention does not own a config', () => {
    const mjs = [
      'const excludedFiles = new Set([',
      "  'ghost.integration.test.ts', // vitest.ghost-exclude.config.ts",
      ']);',
      '// also mentioned: vitest.ghost-exclude.config.ts',
    ].join('\n');
    assert.equal(mjs.includes('vitest.ghost-exclude.config.ts'), true);
    assert.deepEqual(extractVitestConfigFlags(stripJsComments(mjs)), []);

    const reachability = collectCiReachability({
      workflowRunSteps: ['npm run test:integration:shard'],
      packageScripts: {
        'test:integration:shard': 'node scripts/integration-shard.mjs',
      },
      readSpawnedScript: (specifier) => (
        specifier === 'scripts/integration-shard.mjs' ? mjs : undefined
      ),
    });
    assert.equal(reachability.invokedConfigs.has('vitest.ghost-exclude.config.ts'), false);
  });

  test('workflow npm run → transitive script → --config is reachability', () => {
    const reachability = collectCiReachability({
      workflowRunSteps: ['npm run test:redis-rate-limit'],
      packageScripts: {
        'test:redis-rate-limit': 'npm run test:phase4a:rl03:redis:inner',
        'test:phase4a:rl03:redis:inner': 'vitest run --fileParallelism=false --config vitest.phase4a-rl03-redis.config.ts',
      },
    });
    assert.equal(reachability.invokedConfigs.has('vitest.phase4a-rl03-redis.config.ts'), true);
  });

  test('workflow npm run → transitive script → --project is extracted', () => {
    assert.deepEqual(
      extractVitestProjectFlags('vitest run --project redis tests/integration/phase4a/phase4a-rl03-redis.integration.test.ts'),
      ['redis'],
    );
    const scripts = {
      'test:redis-rate-limit': 'npm run test:phase4a:rl03:redis:inner',
      'test:phase4a:rl03:redis:inner': 'vitest run --project redis tests/integration/phase4a/phase4a-rl03-redis.integration.test.ts',
    };
    const reachability = collectCiReachability({
      workflowRunSteps: ['npm run test:redis-rate-limit'],
      packageScripts: scripts,
    });
    assert.deepEqual(
      extractVitestProjectFlags(scripts['test:phase4a:rl03:redis:inner']!),
      ['redis'],
    );
    assert.equal(reachability.invokedConfigs.has('vitest.phase4a-rl03-redis.config.ts'), false);
  });

  test('mjs spawn --config is a CI invocation', () => {
    const reachability = collectCiReachability({
      workflowRunSteps: ['npm run test:unit:coverage:collect:inner'],
      packageScripts: {
        'test:unit:coverage:collect:inner': 'node scripts/run-phase13-unit-coverage.mjs',
      },
      readSpawnedScript: (specifier) => (
        specifier === 'scripts/run-phase13-unit-coverage.mjs'
          ? "spawnSync('npx', ['vitest', 'run', '--config', 'vitest.coverage.config.ts']);"
          : undefined
      ),
    });
    assert.equal(reachability.invokedConfigs.has('vitest.coverage.config.ts'), true);
  });

  test('shard-executed include files own a config without --config', () => {
    assert.equal(
      isConfigReachable({
        configName: 'vitest.shard-only.config.ts',
        includeFiles: ['tests/unit/auth/auth.test.ts'],
        invokedConfigs: new Set(),
        executedFiles: new Set(['tests/unit/auth/auth.test.ts']),
        allowlist: [],
      }),
      true,
    );
    assert.equal(
      isConfigReachable({
        configName: 'vitest.shard-only.config.ts',
        includeFiles: ['tests/unit/auth/auth.test.ts', 'tests/unit/missing/skipped.test.ts'],
        invokedConfigs: new Set(),
        executedFiles: new Set(['tests/unit/auth/auth.test.ts']),
        allowlist: [],
      }),
      false,
    );
  });
});

describe('Known-Backend vitest workspace ownership', () => {
  test('workspace pins the named projects and no extra project files', () => {
    const workspace = readFileSync(join(backendRoot, 'vitest.config.ts'), 'utf8');
    assert.deepEqual([...WORKSPACE_PROJECT_NAMES], [
      'browser',
      'evidence',
      'postgres',
      'redis',
      'static',
      'system',
      'unit',
    ]);
    for (const name of WORKSPACE_PROJECT_NAMES) {
      assert.match(workspace, new RegExp(`vitest\\.${name}\\.config\\.ts`, 'u'));
    }
    assert.deepEqual(
      [...WORKSPACE_PROJECT_CONFIGS],
      WORKSPACE_PROJECT_NAMES.map((name) => `vitest.${name}.config.ts`),
    );
  });

  test('unit projects stay bounded-parallel; PG / Redis coverage stays serial', () => {
    const unit = readFileSync(join(backendRoot, 'vitest.unit.config.ts'), 'utf8');
    assert.equal(unit.includes('fileParallelism'), false);
    assert.match(unit, /maxWorkers:\s*4/u, 'unit parallelism must not saturate Vitest RPC');
    for (const name of ['static', 'system', 'postgres', 'redis', 'browser', 'evidence'] as const) {
      const source = readFileSync(join(backendRoot, `vitest.${name}.config.ts`), 'utf8');
      assert.match(source, /fileParallelism:\s*false/u, `${name} must stay serial`);
    }
    for (const name of COVERAGE_VITEST_CONFIGS.filter(
      (config) => config !== 'vitest.phase4-5-coverage.config.ts',
    )) {
      const source = readFileSync(join(backendRoot, name), 'utf8');
      assert.match(source, /fileParallelism:\s*false/u, `${name} must stay serial`);
    }
    const phase45Coverage = readFileSync(
      join(backendRoot, 'vitest.phase4-5-coverage.config.ts'),
      'utf8',
    );
    assert.match(phase45Coverage, /fileParallelism:\s*coverageSuite === 'unit'/u);
    assert.match(phase45Coverage, /maxWorkers:\s*coverageSuite === 'unit' \? 4 : 1/u);
  });

  test('every unit and integration test file is claimed by exactly one workspace project', () => {
    const files = collectExistingTestFiles();
    assert.ok(files.length > 0);
    const unclaimed: string[] = [];
    const duplicated: string[] = [];
    for (const file of files) {
      const owners = claimedByProject(file);
      if (owners.length === 0) unclaimed.push(file);
      if (owners.length > 1) duplicated.push(`${file} → ${owners.join(',')}`);
    }
    assert.deepEqual(unclaimed, [], `unclaimed test files: ${unclaimed.join(', ')}`);
    assert.deepEqual(duplicated, [], `files claimed by multiple projects: ${duplicated.join('; ')}`);
  });

  test('the fast unit project owns no subprocess or real-PostgreSQL test', () => {
    const directCapabilityPattern = /from\s+['"](?:node:child_process|@testcontainers\/postgresql|[^'"]*better-auth-postgres\.js)['"]/u;
    const indirectOpenApiProcessPattern = /import\s*\{[\s\S]*?\b(?:runGeneratorFixture|runNodeScript)\b[\s\S]*?\}\s*from\s*['"]\.\/openapi-contract-support\.js['"]/u;
    const hasSystemCapability = (source: string) => (
      directCapabilityPattern.test(source) || indirectOpenApiProcessPattern.test(source)
    );
    for (const file of collectExistingTestFiles()) {
      const source = readFileSync(join(backendRoot, file), 'utf8');
      if (claimedByProject(file).includes('unit')) {
        assert.equal(hasSystemCapability(source), false, `${file} must move to the system project`);
      }
    }
    assert.equal(SYSTEM_INCLUDE.length, 37, 'system ownership changes must be explicit and reviewed');
    for (const file of SYSTEM_INCLUDE) {
      const source = readFileSync(join(backendRoot, file), 'utf8');
      assert.equal(hasSystemCapability(source), true, `${file} must justify its system budget`);
      assert.deepEqual(claimedByProject(file), ['system']);
    }
  });

  test('the unreachable allowlist and dedicated leftovers stay retired', () => {
    assert.deepEqual([...UNREACHABLE_VITEST_CONFIG_ALLOWLIST], []);
    assert.deepEqual([...REMAINING_DEDICATED_VITEST_CONFIGS], []);
  });

  test('remaining vitest*.config.ts are exactly workspace projects plus coverage', () => {
    const expected = [
      ...WORKSPACE_PROJECT_CONFIGS,
      ...COVERAGE_VITEST_CONFIGS,
    ].sort();
    assert.deepEqual(listVitestConfigs(), expected);
  });

  test('coverage configs stay CI-reachable via collect --config, not the allowlist', () => {
    const reachability = loadRepoReachability();
    for (const name of COVERAGE_VITEST_CONFIGS) {
      assert.equal(reachability.invokedConfigs.has(name), true, `${name} must stay on the collect --config path`);
    }
  });

  test('no package.json script resurrects a dedicated --config beyond coverage', () => {
    const invokedFromPackage = new Set(
      Object.values(readPackageScripts()).flatMap((body) => extractVitestConfigFlags(body)),
    );
    const allowed = new Set<string>(COVERAGE_VITEST_CONFIGS);
    const resurrected = [...invokedFromPackage].filter((name) => !allowed.has(name));
    assert.deepEqual(
      resurrected,
      [],
      `focused scripts must use --project plus file lists, not --config: ${resurrected.join(', ')}`,
    );
  });

  test('Redis workspace files leave postgres shards as an explicit ownership transfer', () => {
    for (const file of REDIS_INCLUDE) {
      assert.equal(
        INTEGRATION_SHARD_EXCLUDE.includes(file),
        true,
        `${file} must leave default postgres shards because redis-rate-limit owns it`,
      );
      assert.deepEqual(claimedByProject(file), ['redis']);
    }
  });

  test('Redis suites are invoked with --project redis so 180s/300s timeouts apply', () => {
    const scripts = readPackageScripts();
    assert.match(scripts['test:redis-rate-limit'] ?? '', /test:phase4a:rl03:redis:inner/);
    assert.match(scripts['test:redis-rate-limit'] ?? '', /test:phase4a:p10:redis:inner/);
    const redisInners = Object.entries(scripts).filter(([name]) => /:redis:inner$/u.test(name));
    assert.ok(redisInners.length >= 6, 'expected the Phase 4A Redis inner scripts');
    for (const [name, body] of redisInners) {
      assert.deepEqual(extractVitestProjectFlags(body), ['redis'], `${name} must select --project redis`);
    }
  });

  test('this contract file is not an owner', () => {
    const self = readFileSync(resolve(import.meta.filename), 'utf8');
    const reachability = loadRepoReachability();
    assert.equal(basename(import.meta.filename), 'vitest-config-ownership-contract.test.ts');
    assert.equal(self.includes('vitest.ghost-comment.config.ts'), true);
    assert.equal(reachability.invokedConfigs.has('vitest.ghost-comment.config.ts'), false);
  });

  test('resolveIncludeFiles still expands explicit include arrays', () => {
    const existing = collectExistingTestFiles();
    const resolved = resolveIncludeFiles(EVIDENCE_INCLUDE, existing);
    assert.ok(resolved.length >= 2);
    assert.ok(resolved.every((file) => claimedByProject(file).length === 1));
  });
});
