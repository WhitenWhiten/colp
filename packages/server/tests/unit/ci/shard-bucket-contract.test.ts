import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'vitest';
import { tmpdir } from 'node:os';
import {
  KNOWN_DIRS,
  assignShards,
  bucketKey,
  isStaticContract,
  listDomainTestFilesSync,
} from '../../../scripts/shard-buckets.mjs';
import { LIBRARY_MANAGEMENT_BACKEND_INTEGRATION_SPECS } from '../../../scripts/library-management-acceptance-bindings.mjs';
import { PHASE2B_SEARCH_AUTHORIZATION_SPEC } from '../../../scripts/phase2b-acceptance-bindings.mjs';
import { INTEGRATION_SHARD_EXCLUDE } from '../../../scripts/vitest-project-files.mjs';
import { TEST_OWNERSHIP_MANIFEST } from '../../../scripts/test-ownership-manifest.mjs';
import {
  BROWSER_INCLUDE,
  EVIDENCE_INCLUDE,
  REDIS_INCLUDE,
  SYSTEM_INCLUDE,
} from '../../../vitest.workspace-projects.js';

const root = process.cwd();
const unitScript = resolve(root, 'scripts/unit-shard.mjs');
const integrationScript = resolve(root, 'scripts/integration-shard.mjs');
const vitestBin = resolve(root, 'node_modules/vitest/vitest.mjs');

const FORBIDDEN_DIRS = [
  'create', 'update', 'delete', 'get', 'move', 'read', 'better', 'same', 'test', 'unit',
];

// Exclusions come from the same path ownership lists as the shard scripts and
// Vitest projects; this contract verifies behavior without re-encoding names.
const browserBoundUnitTests = BROWSER_INCLUDE
  .filter((file) => file.startsWith('tests/unit/'));
const evidenceBoundUnitTests = EVIDENCE_INCLUDE
  .filter((file) => file.startsWith('tests/unit/'));
const systemBoundUnitTests = [...SYSTEM_INCLUDE];
const integrationExclusions = [...INTEGRATION_SHARD_EXCLUDE];

/**
 * The exclusive include lists, keyed by the Vitest project that owns them. This
 * comes from the single enumerable ownership manifest, so the contract and the
 * configs can never hold two private copies of the same ownership list.
 */
const EXCLUSIVE_INCLUDE_LISTS = TEST_OWNERSHIP_MANIFEST.exclusiveProjects;
const DEDICATED_JOB_INTEGRATION_OWNERS = TEST_OWNERSHIP_MANIFEST.dedicatedIntegrationOwners;

type VitestProject = 'unit' | 'static' | 'postgres' | keyof typeof EXCLUSIVE_INCLUDE_LISTS;

/** Which side of `tests/` each project may own. */
const PROJECT_KIND: Readonly<Record<VitestProject, 'unit' | 'integration' | 'both'>> = Object.freeze({
  unit: 'unit',
  static: 'unit',
  system: 'unit',
  redis: 'integration',
  postgres: 'integration',
  browser: 'both',
  evidence: 'both',
});

const discoveredProjects = new Map<VitestProject, string[]>();

/**
 * Real Vitest project discovery — the authority the shard runner is measured
 * against.
 *
 * The previous completeness check rebuilt `expected` by importing the same
 * include lists and re-running the runner's own
 * `listDomainTestFilesSync` + filter chain, so it was a mirror of the algorithm
 * it claimed to falsify: any drift inside that chain moved both sides together
 * and the check stayed green. Here `vitest list --project <name> --filesOnly
 * --json` lets the project configs resolve their own include/exclude globs with
 * picomatch, and the runner output has to agree with that instead.
 */
function vitestProjectFiles(project: VitestProject): string[] {
  const cached = discoveredProjects.get(project);
  if (cached) return cached;
  const stdout = execFileSync(process.execPath,
    [vitestBin, 'list', '--project', project, '--filesOnly', '--json'],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const discovered = (JSON.parse(stdout) as readonly { file: string }[])
    .map(({ file }) => relative(root, file).split(sep).join('/'))
    .sort();
  discoveredProjects.set(project, discovered);
  return discovered;
}

/** Set difference in both directions, named for the caller's assertion. */
function coverageProblems(expected: readonly string[], actual: readonly string[]): string[] {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  return [
    ...[...expectedSet].filter((path) => !actualSet.has(path))
      .map((path) => `enumeration is missing a discovered file: ${path}`),
    ...[...actualSet].filter((path) => !expectedSet.has(path))
      .map((path) => `enumeration added a file no project discovers: ${path}`),
  ];
}

/** Every discovery set a project resolves, deduplicated and sorted. */
function allDiscoveredProjects(): VitestProject[] {
  return ['unit', 'static', 'postgres', ...Object.keys(EXCLUSIVE_INCLUDE_LISTS) as VitestProject[]];
}

/**
 * Is each shared include list truthful about the project that owns it? A path
 * that does not exist, that no project of the right kind may own, or that the
 * owning project's OWN include resolution does not discover is a corrupted
 * ownership list — exactly the drift the old mirror check could not see.
 *
 * Pure over the lists it is handed so the negative control can corrupt one and
 * prove detection without touching the working tree.
 */
function includeListProblems(lists: Readonly<Record<string, readonly string[]>>): string[] {
  const problems: string[] = [];
  const owners = new Map<string, string[]>();
  for (const [project, list] of Object.entries(lists)) {
    const kind = PROJECT_KIND[project as VitestProject];
    const discovered = new Set(vitestProjectFiles(project as VitestProject));
    for (const path of list) {
      const pathKind = path.startsWith('tests/unit/') ? 'unit'
        : path.startsWith('tests/integration/') ? 'integration' : null;
      if (pathKind === null) { problems.push(`${project} owns a path outside tests/: ${path}`); continue; }
      if (kind !== 'both' && kind !== pathKind) {
        problems.push(`${project} is a ${kind} project but owns a ${pathKind} path: ${path}`);
      }
      if (!existsSync(join(root, path))) { problems.push(`${project} names a file that does not exist: ${path}`); }
      else if (!discovered.has(path)) {
        problems.push(`${project} names a file its own project does not discover: ${path}`);
      }
      owners.set(path, [...(owners.get(path) ?? []), project]);
    }
  }
  for (const [path, simultaneous] of owners) {
    if (simultaneous.length > 1) problems.push(`${path} is owned by more than one project: ${simultaneous.join(', ')}`);
  }
  return problems;
}

test('every test file lives in a declared domain directory (no orphans, no verbs)', () => {
  const listed = [
    ...listDomainTestFilesSync(root, { kind: 'unit', suffix: '.test.ts' }),
    ...listDomainTestFilesSync(root, { kind: 'integration', suffix: '.integration.test.ts' }),
  ];
  assert.ok(listed.length > 0);
  for (const file of listed) {
    assert.ok(KNOWN_DIRS.includes(file.dir), `${file.path} directory must be declared`);
    assert.equal(FORBIDDEN_DIRS.includes(file.dir), false, `${file.path} must not sit in a verb directory`);
  }
});

test('KNOWN_DIRS is deduplicated, sorted and non-empty', () => {
  assert.ok(KNOWN_DIRS.length > 0);
  assert.deepEqual(KNOWN_DIRS, [...new Set(KNOWN_DIRS)], 'no duplicate directories');
  assert.deepEqual(KNOWN_DIRS, [...KNOWN_DIRS].sort(), 'directories must stay sorted');
  for (const dir of FORBIDDEN_DIRS) {
    assert.equal(KNOWN_DIRS.includes(dir), false, `${dir} must not be a shard directory`);
  }
});

test('on-disk unit and integration directories equal KNOWN_DIRS intersect existing dirs', () => {
  assert.ok(KNOWN_DIRS.includes('email'), 'email unit tests must be a declared shard directory');
  assert.ok(
    KNOWN_DIRS.includes('infrastructure'),
    'infrastructure unit tests must be a declared shard directory',
  );
  for (const kind of ['unit', 'integration'] as const) {
    const existing = readdirSync(join(root, 'tests', kind), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
    const declaredExisting = KNOWN_DIRS.filter((dir) => existing.includes(dir));
    assert.deepEqual(
      existing,
      declaredExisting,
      `tests/${kind} directory set must equal KNOWN_DIRS ∩ existing directories`,
    );
  }
});

// TEST-01: an explicit, named assertion on the ownership source itself. The
// capture registration regression used to surface only indirectly — the shard
// enumeration happened to contain capture files, so a missing declaration read
// as a generic domain error instead of "capture is not a declared domain".
test('the ownership manifest declares the capture domain (TEST-01)', () => {
  assert.ok(
    TEST_OWNERSHIP_MANIFEST.shardDirectories.includes('capture'),
    'KNOWN_DIRS in scripts/shard-buckets.mjs must declare capture explicitly',
  );
  assert.equal(KNOWN_DIRS, TEST_OWNERSHIP_MANIFEST.shardDirectories,
    'the manifest must expose the very KNOWN_DIRS array the shard scripts read');
  for (const [kind, suffix] of [['unit', '.test.ts'], ['integration', '.integration.test.ts']] as const) {
    const capture = listDomainTestFilesSync(root, { kind, suffix }).filter((file) => file.dir === 'capture');
    assert.ok(capture.length > 0, `tests/${kind}/capture must own at least one test file`);
  }
});

test('bucketKey maps a directory to a stable shard in 0..3', () => {
  for (const dir of KNOWN_DIRS) {
    const key = bucketKey(dir);
    assert.ok(Number.isInteger(key) && key >= 0 && key <= 3, `${dir} -> ${key}`);
    assert.equal(bucketKey(dir), key, `${dir} hash must be deterministic`);
  }
});

test('assignShards keeps a small domain whole; only an oversized one is rebalanced', () => {
  // 9 files, 3 domains. auth (160 lines) exceeds the budget, so it spreads;
  // follow (45) and search (8) are small and stay whole on their hash shards.
  const files = [
    { path: 'follow-a.test.ts', prefix: 'follow', lines: 10 },
    { path: 'follow-b.test.ts', prefix: 'follow', lines: 20 },
    { path: 'follow-c.test.ts', prefix: 'follow', lines: 15 },
    { path: 'search-a.test.ts', prefix: 'search', lines: 8 },
    { path: 'auth-a.test.ts', prefix: 'auth', lines: 40 },
    { path: 'auth-b.test.ts', prefix: 'auth', lines: 40 },
    { path: 'auth-c.test.ts', prefix: 'auth', lines: 40 },
    { path: 'auth-d.test.ts', prefix: 'auth', lines: 40 },
  ];
  const shards = assignShards(files, 4);
  const followShards = shards
    .map((s, i) => ({ i, count: s.filter((p) => p.startsWith('follow')).length }))
    .filter((x) => x.count > 0);

  assert.equal(followShards.length, 1, 'the small follow bucket lands on one shard');
  assert.equal(followShards[0].count, 3, 'all three follow files stay together');

  const searchShards = shards
    .map((s, i) => ({ i, count: s.filter((p) => p.startsWith('search')).length }))
    .filter((x) => x.count > 0);
  assert.equal(searchShards.length, 1, 'the search bucket stays whole');

  // auth (160 lines > ceil(213/4)=54) must be rebalanced across more than one shard.
  const authCount = shards.reduce((sum, s) => sum + s.filter((p) => p.startsWith('auth')).length, 0);
  assert.equal(authCount, 4, 'all auth files are assigned exactly once');

  assert.ok(
    shards.every((s) => s.length > 0),
    'every shard is non-empty when enough files exist',
  );
});

test('assignShards is deterministic regardless of input order', () => {
  const files = [
    { path: 'a.test.ts', prefix: 'phase4a', lines: 10 },
    { path: 'b.test.ts', prefix: 'phase4a', lines: 30 },
    { path: 'c.test.ts', prefix: 'sync', lines: 5 },
    { path: 'd.test.ts', prefix: 'auth', lines: 20 },
    { path: 'e.test.ts', prefix: 'follow', lines: 40 },
    { path: 'f.test.ts', prefix: 'search', lines: 15 },
    { path: 'g.test.ts', prefix: 'phase5', lines: 60 },
  ];
  const a = assignShards(files, 4);
  const b = assignShards([...files].reverse(), 4);
  assert.deepEqual(a, b);
});

test('unit shards are deterministic, complete, disjoint and balanced', () => {
  const shards = [1, 2, 3, 4].map((index) => execFileSync(process.execPath, [
    unitScript, `--shard=${index}/4`, '--list',
  ], { cwd: root, encoding: 'utf8' }).trim().split(/\r?\n/u).filter(Boolean));

  const flattened = shards.flat();
  // TEST-03: the expected set is real Vitest discovery for the `unit` project —
  // the project config resolves its own include/exclude globs — not the
  // runner's own `listDomainTestFilesSync` + filter chain. The unit project
  // already excludes static contracts, browser/evidence/system-owned suites and
  // the externally provisioned phase5-free-social-dependencies file.
  const expected = vitestProjectFiles('unit');

  assert.ok(shards.every((files) => files.length > 0), 'every unit shard is non-empty');
  assert.equal(flattened.length, expected.length);
  assert.equal(new Set(flattened).size, flattened.length, 'no duplicate files across shards');
  assert.deepEqual([...flattened].sort(), expected, 'shards cover exactly the expected set');
  assert.deepEqual(coverageProblems(expected, flattened), [],
    'unit shards must cover exactly what Vitest discovers for the unit project');
  for (const path of expected) {
    assert.ok(KNOWN_DIRS.includes(path.split('/')[2] ?? ''),
      `${path} must sit in a declared shard directory, by its full path`);
  }
  const infrastructureTests = expected.filter((path) => path.startsWith('tests/unit/infrastructure/'));
  assert.ok(infrastructureTests.length > 0, 'the infrastructure bucket must own at least one unit test');
  for (const path of infrastructureTests) {
    assert.equal(
      flattened.filter((candidate) => candidate === path).length,
      1,
      `${path} must belong to exactly one unit shard`,
    );
  }

  for (const [index, files] of shards.entries()) {
    const again = execFileSync(process.execPath, [
      unitScript, `--shard=${index + 1}/4`, '--list',
    ], { cwd: root, encoding: 'utf8' }).trim().split(/\r?\n/u).filter(Boolean);
    assert.deepEqual(again, files, `unit shard ${index + 1} must be deterministic`);
  }
});

test('integration shards are deterministic, complete and disjoint', () => {
  const shards = [1, 2, 3, 4].map((index) => execFileSync(process.execPath, [
    integrationScript, `--shard=${index}/4`, '--list',
  ], { cwd: root, encoding: 'utf8' }).trim().split(/\r?\n/u).filter(Boolean));

  const flattened = shards.flat();
  // TEST-03: Vitest's postgres project resolves the shared exclude lists
  // itself; the only thing the runner may subtract on top of it is the named
  // dedicated-job ownership mapping.
  const expected = vitestProjectFiles('postgres')
    .filter((path) => !DEDICATED_JOB_INTEGRATION_OWNERS.includes(path));

  assert.ok(shards.every((files) => files.length > 0), 'every integration shard is non-empty');
  assert.equal(flattened.length, expected.length);
  assert.equal(new Set(flattened).size, flattened.length, 'no duplicate files across shards');
  assert.deepEqual([...flattened].sort(), expected, 'integration shards cover exactly the expected set');
  assert.deepEqual(coverageProblems(expected, flattened), [],
    'integration shards must cover exactly the postgres discovery minus dedicated owners');
});

test('tenant-isolation postgres suites ride default shards; dedicated jobs remain extra-evidence owners', () => {
  const searchAuthFile = 'search-authorization-postgres.integration.test.ts';
  const ownedPostgresFile = 'owned-collections-postgres.integration.test.ts';
  assert.equal(
    integrationExclusions.includes(searchAuthFile),
    false,
    'search-authorization postgres must ride postgres-integration shards',
  );
  assert.equal(
    integrationExclusions.includes(ownedPostgresFile),
    false,
    'owned-collections postgres must ride postgres-integration shards',
  );

  const flattened = [1, 2, 3, 4].flatMap((index) => execFileSync(process.execPath, [
    integrationScript, `--shard=${index}/4`, '--list',
  ], { cwd: root, encoding: 'utf8' }).trim().split(/\r?\n/u).filter(Boolean));
  assert.equal(
    flattened.filter((path) => path.endsWith(`/${searchAuthFile}`)).length,
    1,
    'search-authorization postgres must appear in exactly one integration shard',
  );
  assert.equal(
    flattened.filter((path) => path.endsWith(`/${ownedPostgresFile}`)).length,
    1,
    'owned-collections postgres must appear in exactly one integration shard',
  );

  assert.equal(
    LIBRARY_MANAGEMENT_BACKEND_INTEGRATION_SPECS.includes(
      'tests/integration/collections/owned-collections-postgres.integration.test.ts',
    ),
    true,
    'library-management-acceptance bindings must remain the extra-evidence owner; do not add a third job',
  );
  const libraryRunner = readFileSync(resolve(root, 'scripts/library-management-acceptance.mjs'), 'utf8');
  assert.match(
    libraryRunner,
    /LIBRARY_MANAGEMENT_BACKEND_INTEGRATION_SPECS/u,
    'library-management-acceptance must run the bindings-owned extra-evidence specs',
  );
  const phase2bRunner = readFileSync(resolve(root, 'scripts/phase2b-acceptance.mjs'), 'utf8');
  assert.equal(
    PHASE2B_SEARCH_AUTHORIZATION_SPEC,
    'tests/integration/search/search-authorization-postgres.integration.test.ts',
  );
  assert.match(
    phase2bRunner,
    /PHASE2B_SEARCH_AUTHORIZATION_SPEC|PHASE2B_OWNED_INTEGRATION_SPECS/u,
    'phase2b-acceptance must remain the extra-evidence owner of search-authorization postgres',
  );
});

test('unit shards enforce the fast 10s/20s timeout budget', () => {
  const source = readFileSync(unitScript, 'utf8');
  assert.match(source, /UNIT_SHARD_TEST_TIMEOUT_MS = 10_000/u);
  assert.match(source, /UNIT_SHARD_HOOK_TIMEOUT_MS = 20_000/u);
  assert.match(source, /UNIT_SHARD_MAX_WORKERS = 4/u);
  assert.match(source, /--testTimeout=\$\{UNIT_SHARD_TEST_TIMEOUT_MS\}/u);
  assert.match(source, /--hookTimeout=\$\{UNIT_SHARD_HOOK_TIMEOUT_MS\}/u);
  assert.match(source, /--maxWorkers=\$\{UNIT_SHARD_MAX_WORKERS\}/u);
});

test('static-contracts share the 60s/120s timeout floor', () => {
  const source = readFileSync(resolve(root, 'scripts/static-contracts-shard.mjs'), 'utf8');
  assert.match(source, /STATIC_CONTRACTS_TEST_TIMEOUT_MS = 60_000/u);
  assert.match(source, /STATIC_CONTRACTS_HOOK_TIMEOUT_MS = 120_000/u);
  assert.match(source, /--testTimeout=\$\{STATIC_CONTRACTS_TEST_TIMEOUT_MS\}/u);
  assert.match(source, /--hookTimeout=\$\{STATIC_CONTRACTS_HOOK_TIMEOUT_MS\}/u);
});

test('static-contracts select every -static.test.ts and never a unit shard file', () => {
  const staticScript = resolve(root, 'scripts/static-contracts-shard.mjs');
  const staticFiles = execFileSync(process.execPath, [
    staticScript, '--list',
  ], { cwd: root, encoding: 'utf8' }).trim().split(/\r?\n/u).filter(Boolean);

  const expectedStatic = vitestProjectFiles('static');

  assert.deepEqual([...staticFiles].sort(), expectedStatic, 'static-contracts covers exactly the -static set');
  assert.deepEqual(coverageProblems(expectedStatic, staticFiles), [],
    'static-contracts must cover exactly what Vitest discovers for the static project');

  // static files must never ride the shared unit shards.
  const unitFiles = [1, 2, 3, 4].flatMap((index) => execFileSync(process.execPath, [
    unitScript, `--shard=${index}/4`, '--list',
  ], { cwd: root, encoding: 'utf8' }).trim().split(/\r?\n/u).filter(Boolean));
  const unitSet = new Set(unitFiles);
  for (const file of staticFiles) {
    assert.equal(unitSet.has(file), false, `${file} must not appear in a unit shard`);
  }
});

test('every test file is discovered by exactly one Vitest project and no shard claims it twice', () => {
  // TEST-03 independent completeness: the union of the projects' own include
  // resolution must partition the on-disk test tree. A file silently dropped by
  // a corrupted include list, or added to two owners, fails here even though no
  // shard-mirroring assertion would notice.
  const discovered = allDiscoveredProjects().flatMap((project) =>
    vitestProjectFiles(project).map((path) => ({ project, path })));
  const onDisk = [
    ...listDomainTestFilesSync(root, { kind: 'unit', suffix: '.test.ts' }),
    ...listDomainTestFilesSync(root, { kind: 'integration', suffix: '.integration.test.ts' }),
  ].map((file) => file.path).sort();

  const owners = new Map<string, string[]>();
  for (const { project, path } of discovered) owners.set(path, [...(owners.get(path) ?? []), project]);
  for (const [path, projects] of owners) {
    assert.equal(projects.length, 1, `${path} must have exactly one Vitest project owner: ${projects.join(', ')}`);
  }
  assert.deepEqual([...owners.keys()].sort(), onDisk,
    'the Vitest project partition must cover every on-disk unit/integration test file');
});

test('shared include lists are truthful and the dedicated owners are enumerable', () => {
  assert.deepEqual(includeListProblems(EXCLUSIVE_INCLUDE_LISTS), [],
    'each shared include list must own only files its own project discovers');
  assert.ok(DEDICATED_JOB_INTEGRATION_OWNERS.length > 0);
  const projectExcludes = new Set([
    ...EVIDENCE_INCLUDE.filter((file) => file.startsWith('tests/integration/')),
    ...BROWSER_INCLUDE.filter((file) => file.startsWith('tests/integration/')),
    ...REDIS_INCLUDE,
  ]);
  for (const path of INTEGRATION_SHARD_EXCLUDE) {
    assert.ok(projectExcludes.has(path) || DEDICATED_JOB_INTEGRATION_OWNERS.includes(path),
      `${path} must be either project-excluded or a named dedicated owner`);
  }
  for (const path of DEDICATED_JOB_INTEGRATION_OWNERS) {
    assert.ok(INTEGRATION_SHARD_EXCLUDE.includes(path), `${path} must stay out of the default shards`);
    assert.ok(vitestProjectFiles('postgres').includes(path),
      `${path} must still be discovered by the postgres project for its dedicated job`);
  }
});

test('a deliberately corrupted shared include list is detected', async () => {
  // The corruption is applied to a real copy of the SHARED include-list file
  // (`scripts/vitest-project-files.mjs`) and loaded as a module, then audited
  // against the UNTOUCHED Vitest discovery. This is the case the old mirror
  // could never see: adding a plain unit suite to a capability list removed it
  // from the runner AND from the recomputed expectation, so both sides agreed
  // while the fast unit lane silently lost a test.
  const fixture = mkdtempSync(join(tmpdir(), 'known-include-corruption-'));
  try {
    const source = readFileSync(resolve(root, 'scripts/vitest-project-files.mjs'), 'utf8');
    const corruptedSource = source.replace('export const BROWSER_INCLUDE = Object.freeze([',
      "export const BROWSER_INCLUDE = Object.freeze([\n  'tests/unit/capture/capture-history.test.ts',");
    assert.notEqual(corruptedSource, source, 'the deliberate corruption must actually edit the include list');
    const corruptedModule = resolve(fixture, 'vitest-project-files.mjs');
    writeFileSync(corruptedModule, corruptedSource);
    const corrupted = await import(pathToFileURL(corruptedModule).href) as {
      BROWSER_INCLUDE: readonly string[];
    };
    assert.ok(corrupted.BROWSER_INCLUDE.includes('tests/unit/capture/capture-history.test.ts'));

    const problems = includeListProblems({ ...EXCLUSIVE_INCLUDE_LISTS, browser: corrupted.BROWSER_INCLUDE });
    assert.ok(
      problems.some((problem) => problem.includes('capture-history')),
      `a file a capability list claims but its project does not discover must be reported: ${problems.join(' | ')}`,
    );

    // Other ownership corruptions the shared lists must reject.
    const browserSuite = 'tests/unit/phase4a/phase4a-i03-browser-isolation.test.ts';
    for (const [label, corruptedLists] of [
      ['a stale path that no project discovers', {
        ...EXCLUSIVE_INCLUDE_LISTS,
        browser: [...BROWSER_INCLUDE, 'tests/unit/phase4a/phase4a-i99-browser-missing.test.ts'],
      }],
      ['a file owned by two projects', {
        ...EXCLUSIVE_INCLUDE_LISTS,
        system: [...SYSTEM_INCLUDE, browserSuite],
      }],
      ['an integration spec claimed by a unit-only project', {
        ...EXCLUSIVE_INCLUDE_LISTS,
        system: [...SYSTEM_INCLUDE, 'tests/integration/phase2/phase2-profile-conformance.integration.test.ts'],
      }],
    ] as readonly (readonly [string, Readonly<Record<string, readonly string[]>>])[]) {
      assert.ok(includeListProblems(corruptedLists).length > 0, `${label} must be reported as corruption`);
    }
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('phase4b MCP compat keeps pure tests in unit and real clients in system', () => {
  const listed = listDomainTestFilesSync(root, { kind: 'unit', suffix: '.test.ts' })
    .filter((file) => file.dir === 'phase4b' && /^phase4b-mcp-compat-.*\.test\.ts$/u.test(file.name));
  assert.ok(listed.length >= 1, 'phase4b-mcp-compat-*.test.ts must exist in tests/unit/phase4b');
  for (const file of listed) {
    assert.equal(isStaticContract(file.name), false, `${file.name} must not be a static-contracts file`);
    assert.equal(browserBoundUnitTests.includes(file.path), false, `${file.name} must not be browser-bound`);
    assert.equal(evidenceBoundUnitTests.includes(file.path), false, `${file.name} must not be evidence-bound`);
  }

  const flattened = [1, 2, 3, 4].flatMap((index) => execFileSync(process.execPath, [
    unitScript, `--shard=${index}/4`, '--list',
  ], { cwd: root, encoding: 'utf8' }).trim().split(/\r?\n/u).filter(Boolean));
  for (const file of listed) {
    const expectedCount = systemBoundUnitTests.includes(file.path) ? 0 : 1;
    assert.equal(
      flattened.filter((path) => path === file.path || path.endsWith(`/${file.name}`)).length,
      expectedCount,
      `${file.name} must follow its capability-based project ownership`,
    );
  }
  assert.deepEqual(
    listed.filter((file) => systemBoundUnitTests.includes(file.path)).map((file) => file.name),
    ['phase4b-mcp-compat-real-clients.test.ts'],
  );
});

test('attachments behavior ownership is documented as phase4a (TEST-12)', () => {
  const buckets = readFileSync(resolve(root, 'scripts/shard-buckets.mjs'), 'utf8');
  assert.match(
    buckets,
    /attachments behavior ownership is in phase4a\//u,
    'shard-buckets.mjs must pin that attachments behavior tests are owned by phase4a/',
  );
  assert.ok(KNOWN_DIRS.includes('attachments'));
  assert.ok(KNOWN_DIRS.includes('phase4a'));
});

test('unit discovery keeps a same-named file outside a dedicated project path', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'known-unit-path-owner-'));
  try {
    mkdirSync(join(fixture, 'tests/unit/auth'), { recursive: true });
    const collision = 'tests/unit/auth/phase4a-i03-browser-isolation.test.ts';
    writeFileSync(join(fixture, collision), "test('local unit', () => {});\n");
    const selected = execFileSync(process.execPath, [unitScript, '1/1', '--list'],
      { cwd: fixture, encoding: 'utf8' }).trim().split(/\r?\n/u);
    assert.deepEqual(selected, [collision]);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
