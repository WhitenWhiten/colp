/**
 * P4A-R05 contract suite: subprocess-level source-bound rejection of the
 * source/control-plane controls (plan §6 P4A-R05, §4.1(4), §4.3 mutation
 * control "source runner 忽略 migration head").
 *
 * The suite drives the FORMAL runner entry
 * (`scripts/phase4a-r05-source-rejection.ts`) as a REAL `node --import tsx`
 * subprocess against a TEMPORARY CLEAN CHECKOUT created with REAL git
 * (`git worktree add --detach <tmp> <revision>`). The subprocess inputs
 * (checkout path + pinned revision via fixed environment), the source digest
 * and the command are FIXED across every scenario.
 *
 * The suite FIRST proves one clean checkout + complete source/control-plane
 * attestation PASSES the boundary (exit 0, fixed facts). Every direct
 * corruption then starts from an independent checkout at that same reviewed
 * revision. The formal in-run executor separately owns its three fixed
 * controls (wrong/missing migration and I01 version drift), while this suite
 * directly exercises the three additional rejection branches:
 *   - migration file on disk but not in registry  -> migration_head_mismatch
 *   - I01 capability matrix item missing          -> i01_capability_missing
 *   - I01 capability target binding mismatch      -> i01_capability_missing
 *
 * Anti-false-positive (plan §4.1): no helper is called directly with
 * injected parameters, no test fixture is read by the runner entry, and no
 * expected error string is written into evidence — the stable code is
 * OBSERVED on the subprocess stderr from the real git/migration/control-plane
 * boundary. Anti-false-negative (plan §4.2): the canonical digest binds only
 * the tracked tree, the migration registry/head and the capability contract
 * facts (git object ids) — Windows path separators, mtimes and temporary
 * directory names never enter it, proven by digest equality across different
 * temp paths and byte-identical repeated runs.
 */
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, test } from 'vitest';
import {
  I16_MIGRATION_HEAD,
  I16NegativeControlExecutor,
} from '../../../scripts/evidence/phase4a-i16-acceptance.js';
import {
  R05_ATTESTOR_SCRIPT_PATH,
  R05_CAPABILITY_PROBE_PATH,
  executeR05SourceRejectionControls,
  r05RepoSubdir,
  type R05SourceBoundaryFacts,
} from '../../../scripts/evidence/phase4a-r05-controls.js';

const MAIN_REPO = process.cwd();
const R05_RUNNER_SCRIPT = resolve(MAIN_REPO, 'scripts/phase4a-r05-source-rejection.ts');
const UNREGISTERED_FILE = '209912319999_phase4a_r05_unregistered.ts';
const R05_MARKER = /phase4a_r05_source_rejection_failed:([a-z0-9_]+)/u;
const execFileAsync = promisify(execFile);

interface BoundaryRun {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

let revision = '';
let worktree = '';
let subdir = '';
let extraWorktrees: string[] = [];
let mainStatusBefore = '';
let cleanBoundary: BoundaryRun | undefined;
let cleanFacts: R05SourceBoundaryFacts | undefined;

/**
 * Repo-relative prefix for every path inside a temporary checkout: the
 * checkout mirrors the WHOLE repository tree, and the package may live in a
 * subdirectory (monorepo layout). Empty when the package is the repository
 * top level.
 */
function checkoutRel(value: string): string {
  return subdir ? `${subdir}/${value}` : value;
}

function gitSync(repo: string, args: readonly string[]): string {
  const result = spawnSync('git', [...args], {
    cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr}`);
  }
  return result.stdout;
}

/**
 * The FIXED formal runner entry invocation with the FIXED environment inputs.
 *
 * Keep the subprocess asynchronous: this suite deliberately spends more than
 * Vitest's worker-RPC timeout in real source-boundary processes. A synchronous
 * child blocks the worker from receiving otherwise-immediate task-update
 * acknowledgements and produces a false `onTaskUpdate` timeout after the tests
 * pass.
 */
async function runBoundary(checkoutPath: string): Promise<BoundaryRun> {
  const options = {
    cwd: MAIN_REPO,
    encoding: 'utf8' as const,
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      P4A_R05_CHECKOUT: checkoutPath,
      P4A_R05_REVIEW_REVISION: revision,
    },
  };
  try {
    const result = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', R05_RUNNER_SCRIPT],
      options,
    );
    return { status: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const cause = error as Error & {
      code?: number | string | null;
      stdout?: string;
      stderr?: string;
      killed?: boolean;
    };
    if (cause.killed || typeof cause.code !== 'number') throw error;
    return { status: cause.code, stdout: cause.stdout ?? '', stderr: cause.stderr ?? '' };
  }
}

function failureCode(stderr: string): string | null {
  const match = R05_MARKER.exec(stderr);
  return match ? match[1]! : null;
}

function resetCheckout(): void {
  gitSync(worktree, ['reset', '--hard', 'HEAD']);
  gitSync(worktree, ['clean', '-fdq']);
}

/** Parse and validate the clean boundary facts emitted by the formal CLI. */
function readHappyBoundary(run: BoundaryRun): R05SourceBoundaryFacts {
  assert.equal(run.status, 0, run.stderr);
  const facts = JSON.parse(run.stdout) as R05SourceBoundaryFacts & { task: string };
  assert.equal(facts.task, 'phase4a-r05-source-rejection');
  assert.equal(facts.revision, revision);
  assert.match(facts.treeHash, /^[a-f0-9]{40,64}$/);
  assert.equal(facts.migrationHead, I16_MIGRATION_HEAD);
  assert.ok(facts.migrationRegistry.includes(I16_MIGRATION_HEAD));
  assert.match(facts.capability.probeModuleBlob, /^[a-f0-9]{40,64}$/);
  assert.match(facts.capability.attestorScriptBlob, /^[a-f0-9]{40,64}$/);
  assert.match(facts.digest, /^[a-f0-9]{64}$/);
  return facts;
}

/** The corruption must be rejected with the OWNING boundary's unique stable code. */
function assertRejected(run: BoundaryRun, expectedCode: string, scenario: string): void {
  assert.notEqual(run.status, 0, `${scenario}: the corrupted run must be non-zero: ${run.stdout}`);
  const observed = failureCode(run.stderr);
  assert.equal(
    observed,
    expectedCode,
    `${scenario}: unique stable code expected from the owning boundary: ${run.stderr}`,
  );
}

function capabilityContractIntact(checkoutPath: string): void {
  for (const path of [R05_CAPABILITY_PROBE_PATH, R05_ATTESTOR_SCRIPT_PATH]) {
    assert.equal(
      gitSync(checkoutPath, ['rev-parse', `:${checkoutRel(path)}`]).trim(),
      gitSync(checkoutPath, ['rev-parse', `HEAD:${checkoutRel(path)}`]).trim(),
      `capability contract ${path} must stay untouched`,
    );
  }
}

/** Tracked migration names (sorted, registry semantics mirroring the production boundary). */
function trackedMigrationNames(checkoutPath: string): string[] {
  return gitSync(checkoutPath, ['ls-files', checkoutRel('migrations/')])
    .split(/\r?\n/)
    .map((line) => line.split(/[\\/]/).pop() ?? '')
    .filter((name) => /^\d{12}_[a-z0-9_]+\.ts$/u.test(name))
    .map((name) => name.replace(/\.ts$/, ''))
    .sort();
}

function migrationRegistryHeadIntact(checkoutPath: string): void {
  const names = trackedMigrationNames(checkoutPath);
  assert.equal(names[names.length - 1], I16_MIGRATION_HEAD);
}

async function installUnregisteredMigrationFile(checkoutPath: string): Promise<void> {
  // Present on disk, NEVER registered in the tracked registry.
  await writeFile(
    join(checkoutPath, subdir, 'migrations', UNREGISTERED_FILE),
    '// P4A-R05 unregistered corruption.\n',
    'utf8',
  );
}

async function installMatrixCorruption(checkoutPath: string): Promise<void> {
  const probePath = join(checkoutPath, subdir, R05_CAPABILITY_PROBE_PATH);
  const source = await readFile(probePath, 'utf8');
  // Line-ending agnostic: the worktree may be checked out with CRLF
  // (core.autocrlf), so the matrix removal must not depend on `\n`.
  const corrupted = source.replace(/  'provider_error_classes',\r?\n] as const;/, "  // 'provider_error_classes',\n] as const;");
  assert.notEqual(corrupted, source, 'the capability matrix entry must be removable');
  await writeFile(probePath, corrupted, 'utf8');
  gitSync(checkoutPath, ['add', checkoutRel(R05_CAPABILITY_PROBE_PATH)]);
}

async function installTargetBindingMismatch(checkoutPath: string): Promise<void> {
  const probePath = join(checkoutPath, subdir, R05_CAPABILITY_PROBE_PATH);
  const source = await readFile(probePath, 'utf8');
  const corrupted = source.replace(
    '    bucket: configuration.bucket,',
    '    bucket: configuration.bucket + "-drift",',
  );
  assert.notEqual(corrupted, source, 'the target binding computation must be drifiable');
  await writeFile(probePath, corrupted, 'utf8');
  gitSync(checkoutPath, ['add', checkoutRel(R05_CAPABILITY_PROBE_PATH)]);
}

async function addExtraWorktree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'known-r05-extra-'));
  const checkout = join(root, 'checkout');
  gitSync(MAIN_REPO, ['worktree', 'add', '--detach', checkout, revision]);
  extraWorktrees.push(checkout);
  return checkout;
}

async function removeExtraWorktree(checkout: string): Promise<void> {
  try { gitSync(MAIN_REPO, ['worktree', 'remove', '--force', checkout]); } catch { /* already removed */ }
  extraWorktrees = extraWorktrees.filter((entry) => entry !== checkout);
  await rm(dirname(checkout), { recursive: true, force: true }).catch(() => {});
}

beforeAll(async () => {
  revision = gitSync(MAIN_REPO, ['rev-parse', 'HEAD']).trim();
  assert.match(revision, /^[a-f0-9]{40,64}$/);
  subdir = await r05RepoSubdir(MAIN_REPO);
  mainStatusBefore = gitSync(MAIN_REPO, ['status', '--porcelain']);
  const root = await mkdtemp(join(tmpdir(), 'known-r05-suite-'));
  worktree = join(root, 'checkout');
  gitSync(MAIN_REPO, ['worktree', 'add', '--detach', worktree, revision]);
  cleanBoundary = await runBoundary(worktree);
  cleanFacts = readHappyBoundary(cleanBoundary);
});

afterAll(async () => {
  for (const extra of extraWorktrees) {
    await removeExtraWorktree(extra);
  }
  try { gitSync(MAIN_REPO, ['worktree', 'remove', '--force', worktree]); } catch { /* already removed */ }
  await rm(dirname(worktree), { recursive: true, force: true }).catch(() => {});
  try { gitSync(MAIN_REPO, ['worktree', 'prune']); } catch { /* stale metadata tolerated */ }
  // The main worktree must stay byte-identical to its pre-suite state.
  assert.equal(gitSync(MAIN_REPO, ['status', '--porcelain']), mainStatusBefore);
});

describe('P4A-R05 source/control-plane boundary (formal subprocess)', () => {
  test('a clean checkout at the reviewed revision passes the boundary with the fixed facts', () => {
    assert.ok(cleanBoundary, 'beforeAll must execute the formal clean boundary');
    assert.ok(cleanFacts, 'beforeAll must validate the formal clean boundary facts');
    const facts = cleanFacts;
    assert.equal(facts.migrationRegistry[facts.migrationRegistry.length - 1], I16_MIGRATION_HEAD);
  });

  test('the source digest is deterministic across temp paths and contains no platform paths (anti-false-negative)', { timeout: 90_000 }, async () => {
    resetCheckout();
    assert.ok(cleanBoundary, 'the clean boundary must be captured before digest checks');
    const repeated = await runBoundary(worktree);
    assert.equal(repeated.stdout, cleanBoundary.stdout);
    const firstFacts = JSON.parse(repeated.stdout) as R05SourceBoundaryFacts;
    // A DIFFERENT temporary checkout path at the same revision: same digest —
    // temp directory names never enter the digest.
    const other = await addExtraWorktree();
    try {
      const otherRun = await runBoundary(other);
      assert.equal(otherRun.status, 0, otherRun.stderr);
      const otherFacts = JSON.parse(otherRun.stdout) as R05SourceBoundaryFacts;
      assert.equal(otherFacts.digest, firstFacts.digest);
      assert.deepEqual(otherFacts.migrationRegistry, firstFacts.migrationRegistry);
      assert.deepEqual(otherFacts.capability, firstFacts.capability);
      // No Windows path separators and no temp paths in the emitted facts.
      assert.ok(!repeated.stdout.includes('\\'), 'Windows path separators must never enter the output');
      assert.ok(!repeated.stdout.toLowerCase().includes(worktree.toLowerCase()));
      assert.ok(!repeated.stdout.toLowerCase().includes(other.toLowerCase()));
    } finally {
      await removeExtraWorktree(other);
    }
  });

  test('additional source corruptions fail at their owning boundary', { timeout: 90_000 }, async () => {
    const scenarios = [
      {
        name: 'unregistered migration file',
        expectedCode: 'migration_head_mismatch',
        install: installUnregisteredMigrationFile,
        assertOtherBoundaryIntact: capabilityContractIntact,
      },
      {
        name: 'missing I01 capability matrix item',
        expectedCode: 'i01_capability_missing',
        install: installMatrixCorruption,
        assertOtherBoundaryIntact: migrationRegistryHeadIntact,
      },
      {
        name: 'I01 capability target binding mismatch',
        expectedCode: 'i01_capability_missing',
        install: installTargetBindingMismatch,
        assertOtherBoundaryIntact: migrationRegistryHeadIntact,
      },
    ] as const;
    const prepared: Array<{ checkout: string; scenario: (typeof scenarios)[number] }> = [];
    try {
      for (const scenario of scenarios) {
        const checkout = await addExtraWorktree();
        prepared.push({ checkout, scenario });
        assert.equal(gitSync(checkout, ['rev-parse', 'HEAD']).trim(), revision);
        await scenario.install(checkout);
      }
      const runs = await Promise.all(prepared.map(({ checkout }) => runBoundary(checkout)));
      for (const [index, { checkout, scenario }] of prepared.entries()) {
        assertRejected(runs[index]!, scenario.expectedCode, scenario.name);
        scenario.assertOtherBoundaryIntact(checkout);
      }
    } finally {
      for (const { checkout } of prepared.reverse()) await removeExtraWorktree(checkout);
    }
  });

  test('the in-run R05 controls complete the executor contract through the formal subprocess', { timeout: 90_000 }, async () => {
    const ledger = new I16NegativeControlExecutor('r05-unit-run-00000000-0000-4000-8000-000000000000');
    const facts = await executeR05SourceRejectionControls({
      executionLedger: ledger,
      repositoryRoot: MAIN_REPO,
      reviewRevision: revision,
    });
    assert.equal(facts.mainWorktreeClean, true);
    assert.equal(facts.controls.wrong_migration.observedStableCode, 'migration_head_mismatch');
    assert.equal(facts.controls.missing_migration.observedStableCode, 'migration_head_missing');
    assert.equal(facts.controls.missing_i01_capability.observedStableCode, 'i01_capability_missing');
    for (const [control, expectedCode] of [
      ['wrong_migration', 'migration_head_mismatch'],
      ['missing_migration', 'migration_head_missing'],
      ['missing_i01_capability', 'i01_capability_missing'],
    ] as const) {
      const receipt = ledger.receiptFor(control);
      assert.equal(receipt.runId, ledger.runId);
      assert.equal(receipt.exitClass, 'clean');
      assert.equal(receipt.stableCode, expectedCode);
      assert.equal(receipt.verificationSource, 'contract-fail-closed');
      assert.equal(receipt.cleanupReceipt, 'temp-checkout-removed');
      assert.match(receipt.sourceDigest, /^[a-f0-9]{64}$/);
      assert.match(receipt.executionDigest, /^[a-f0-9]{64}$/);
    }
    // The main worktree porcelain must be unchanged by the in-run controls.
    assert.equal(gitSync(MAIN_REPO, ['status', '--porcelain']), mainStatusBefore);
  });
});
