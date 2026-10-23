/**
 * A-13 / SR-16 policy: a contract test may only grep production source when it is
 * registered in `tests/static-anchor-allowlist.ts` with a written reason.
 *
 * The rule is deliberately coarse (source read + any text assertion), because the
 * failure mode this guards against is a *new* `readFile` + `assert.match` contract
 * test slipping in unnoticed — the reviewer's job is then to either write a
 * behavioural test or add an explicit allowlist entry explaining why static is the
 * only option.
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { SOURCE_READER_HELPERS, STATIC_ANCHOR_ALLOWLIST } from './static-anchor-allowlist.js';

const testsDirectory = import.meta.dirname;

/** Any of these means the file reads production source as text. */
const SOURCE_READER_PATTERNS = [
  /readFile\s*\(/u, /readFileSync\s*\(/u, /readServiceWorkerGraph\s*\(/u, /readSyncStateSource\s*\(/u,
];

/** Any of these means the file makes a textual (non-behavioural) assertion. */
const TEXT_ASSERTION_PATTERNS = [
  /assert\.match\s*\(/u, /assert\.doesNotMatch\s*\(/u, /\.toMatch\s*\(/u, /\.toContain\s*\(/u,
  /toMatchInlineSnapshot\s*\(/u, /toContainEqual\s*\(/u,
];

async function contractTestFiles(): Promise<string[]> {
  const entries = await readdir(testsDirectory);
  return entries.filter((name) => name.endsWith('.contract.test.ts')).sort();
}

async function readContractTest(name: string): Promise<string> {
  return readFile(resolve(testsDirectory, name), 'utf8');
}

function matches(source: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(source));
}

describe('contract tests keep static anchors explicit [A-13 / SR-16]', () => {
  test('every source-grepping contract test is on the documented allowlist', async () => {
    const allowlisted = new Set(STATIC_ANCHOR_ALLOWLIST.map((entry) => entry.file));
    const offenders: string[] = [];
    for (const name of await contractTestFiles()) {
      const source = await readContractTest(name);
      const readsSource = matches(source, SOURCE_READER_PATTERNS);
      const assertsText = matches(source, TEXT_ASSERTION_PATTERNS);
      if (readsSource && assertsText && !allowlisted.has(`tests/${name}`)) offenders.push(name);
    }
    assert.deepEqual(offenders, [],
      'contract tests that read production source and assert on its text must either become behavioural tests '
      + 'or be registered in tests/static-anchor-allowlist.ts with a written reason');
  });

  test('the allowlist has no stale or malformed entry', async () => {
    const files = new Set((await contractTestFiles()).map((name) => `tests/${name}`));
    const seen = new Set<string>();
    for (const entry of STATIC_ANCHOR_ALLOWLIST) {
      assert.equal(files.has(entry.file), true, `${entry.file} is not a tests/*.contract.test.ts file`);
      assert.equal(seen.has(entry.file), false, `${entry.file} is listed twice`);
      seen.add(entry.file);
      const source = await readContractTest(entry.file.replace('tests/', ''));
      assert.equal(matches(source, SOURCE_READER_PATTERNS) && matches(source, TEXT_ASSERTION_PATTERNS), true,
        `${entry.file} no longer needs an allowlist entry — remove it or restore the contract it documents`);
      assert.equal(entry.anchors.trim().length >= 40, true, `${entry.file} must state what the anchors guard`);
      assert.equal(entry.reason.trim().length >= 40, true,
        `${entry.file} must state why a behavioural test cannot replace the static anchors`);
    }
    assert.equal(STATIC_ANCHOR_ALLOWLIST.length > 0, true);
  });

  test('the shared source readers document their purpose and stay out of the contract glob', () => {
    for (const helper of SOURCE_READER_HELPERS) {
      assert.equal(helper.file.endsWith('.contract.test.ts'), false,
        `${helper.file} would be scanned by the policy; register it in STATIC_ANCHOR_ALLOWLIST instead`);
      assert.equal(helper.purpose.trim().length >= 40, true, `${helper.file} needs a stated purpose`);
    }
    expect(SOURCE_READER_HELPERS.map((helper) => helper.file))
      .toEqual(['tests/service-worker-graph.ts', 'tests/read-sync-state-source.ts']);
  });

  test('the allowlist can actually see changes: it scans the live contract glob', async () => {
    const files = await contractTestFiles();
    assert.equal(files.length >= 14, true, `expected the audit-scoped contract tests, saw ${files.length}`);
    const registered = STATIC_ANCHOR_ALLOWLIST.map((entry) => entry.file.replace('tests/', ''));
    for (const name of registered) assert.equal(files.includes(name), true, `${name} missing from the glob`);
  });
});
