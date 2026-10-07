/**
 * P4A-R07 contract suite: atomic evidence publication (temp file -> post-run
 * checks -> independent validator -> atomic rename).
 *
 * The formal evidence CLI may only place a bundle at the final output path
 * after the whole acceptance (including its post-run checks) succeeded AND
 * the INDEPENDENT validator accepted the serialized bundle in a subprocess
 * bound to the reviewed revision. The runner never validates its own digest:
 * publishing is impossible without the independent validator, and a failed
 * run must not leave a stale "success-looking" artifact behind (a previous
 * artifact at the final path is REMOVED on failure, never overwritten with
 * unvalidated content, never left in place).
 *
 * Anti-false-positive (plan §6 R07 / §4.2): reusing a historical artifact,
 * runner self-validation, hand-editing the JSON or skipping the independent
 * validator all fail. The hand-edit scenarios below run the REAL validator
 * CLI (`scripts/phase4a-i16-validate-evidence.mjs`) against real temp files.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  access, mkdir, readFile, readdir, rename as fsRename, unlink, writeFile,
} from 'node:fs/promises';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, test } from 'vitest';
import {
  I16_VALIDATOR_SCRIPT,
  publishI16EvidenceAtomically,
  type I16PublishDependencies,
} from '../../../scripts/evidence/phase4a-i16-publish.js';
import {
  I16_TEST_REVISION,
  buildI16FixtureEvidence,
} from '../../support/phase4a-i16-test-helpers.js';

const execFileAsync = promisify(execFile);

/** Recording real-fs dependencies; tests may override individual pieces. */
function realFsDeps(overrides: Partial<I16PublishDependencies> = {}) {
  const calls: string[] = [];
  const deps: I16PublishDependencies = {
    mkdir: async (directory) => {
      calls.push(`mkdir:${basename(directory)}`);
      await mkdir(directory, { recursive: true });
    },
    writeText: async (path, content) => {
      calls.push(`write:${basename(path)}`);
      await writeFile(path, content, 'utf8');
    },
    rename: async (from, to) => {
      calls.push(`rename:${basename(from)}->${basename(to)}`);
      await fsRename(from, to);
    },
    unlink: async (path) => {
      calls.push(`unlink:${basename(path)}`);
      await unlink(path);
    },
    exists: async (path) => {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    },
    runValidator: async (path, revision) => {
      calls.push(`validate:${basename(path)}@${revision}`);
      return { ok: true, stderr: '' };
    },
    ...overrides,
  };
  return { deps, calls };
}

const tempDirs: string[] = [];
function freshDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'known-r07-publish-'));
  tempDirs.push(directory);
  return directory;
}
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

async function tempFilesOf(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((name) => name.includes('.tmp-'));
}

describe('P4A-R07 atomic evidence publication', () => {
  test('publishes through a temp file only after the independent validator passes', async () => {
    const directory = freshDir();
    const target = join(directory, 'phase4a-i16-acceptance.json');
    await writeFile(target, 'stale-old-artifact\n', 'utf8');
    const bundle = buildI16FixtureEvidence();
    const serialize = (): string => `${JSON.stringify(bundle, null, 2)}\n`;

    const { deps, calls } = realFsDeps();
    const result = await publishI16EvidenceAtomically({
      targetPath: target,
      expectedRevision: I16_TEST_REVISION,
      serialize,
      dependencies: deps,
    });

    assert.equal(result.published, true);
    assert.equal(result.finalPath, target);
    assert.ok(result.tempPath.includes('.tmp-'), 'a temp sibling must be used');
    assert.equal(result.tempPath.startsWith(directory), true);
    // The old artifact is atomically replaced, never merged or appended.
    assert.equal(await readFile(target, 'utf8'), serialize());
    assert.deepEqual(await tempFilesOf(directory), [], 'no temp file may remain');
    // The independent validator ran on the temp path BEFORE the rename.
    assert.ok(calls.some((call) => call.startsWith('validate:') && call.includes('.tmp-')), 'validator must run on the temp file');
    assert.ok(calls.some((call) => call === `rename:${basename(result.tempPath)}->${basename(target)}`));
    const renameIndex = calls.findIndex((call) => call.startsWith('rename:'));
    const validateIndex = calls.findIndex((call) => call.startsWith('validate:'));
    assert.ok(validateIndex >= 0 && renameIndex > validateIndex, 'rename must come after validation');
  });

  test('a validator rejection removes the temp file AND the stale success-looking artifact', async () => {
    const directory = freshDir();
    const target = join(directory, 'phase4a-i16-acceptance.json');
    await writeFile(target, 'stale-old-artifact\n', 'utf8');
    const { deps, calls } = realFsDeps({
      runValidator: async () => ({ ok: false, stderr: 'negative_control_not_executed:size_digest_mismatch\n' }),
    });

    await assert.rejects(
      publishI16EvidenceAtomically({
        targetPath: target,
        expectedRevision: I16_TEST_REVISION,
        serialize: () => JSON.stringify(buildI16FixtureEvidence()),
        dependencies: deps,
      }),
      /evidence_validation_failed/,
    );
    assert.deepEqual(await tempFilesOf(directory), [], 'the temp file must be cleaned');
    assert.equal(existsSync(target), false, 'a failed run must not leave a success-looking old artifact');
    assert.ok(calls.some((call) => call.startsWith('unlink:') && call.includes('.tmp-')), 'temp must be unlinked');
    assert.ok(calls.some((call) => call === `unlink:${basename(target)}`), 'stale artifact must be unlinked');
    assert.ok(!calls.some((call) => call.startsWith('rename:')), 'nothing may be renamed on failure');
  });

  test('a validator rejection with no prior artifact leaves no file behind', async () => {
    const directory = freshDir();
    const target = join(directory, 'phase4a-i16-acceptance.json');
    const { deps } = realFsDeps({
      runValidator: async () => ({ ok: false, stderr: 'evidence_schema:verdict' }),
    });
    await assert.rejects(
      publishI16EvidenceAtomically({
        targetPath: target,
        expectedRevision: I16_TEST_REVISION,
        serialize: () => JSON.stringify(buildI16FixtureEvidence()),
        dependencies: deps,
      }),
      /evidence_validation_failed/,
    );
    assert.equal(existsSync(target), false);
    assert.deepEqual(await tempFilesOf(directory), []);
  });

  test('the reviewed revision is always passed to the independent validator', async () => {
    const directory = freshDir();
    const target = join(directory, 'phase4a-i16-acceptance.json');
    const seen: Array<{ path: string; revision: string }> = [];
    const { deps } = realFsDeps({
      runValidator: async (path, revision) => {
        seen.push({ path, revision });
        return { ok: true, stderr: '' };
      },
    });
    await publishI16EvidenceAtomically({
      targetPath: target,
      expectedRevision: I16_TEST_REVISION,
      serialize: () => JSON.stringify(buildI16FixtureEvidence()),
      dependencies: deps,
    });
    assert.equal(seen.length, 1, 'validation must run exactly once');
    assert.ok(seen[0]!.path.startsWith(join(directory, '.phase4a-i16-acceptance.json.tmp-')),
      'validator receives the temp path next to the final artifact');
    assert.ok(!seen[0]!.path.endsWith('phase4a-i16-acceptance.json'), 'the final path is never validated in place');
    assert.equal(seen[0]!.revision, I16_TEST_REVISION);
  });

  test('an unavailable validator subprocess fails closed and removes the stale artifact', async () => {
    const directory = freshDir();
    const target = join(directory, 'phase4a-i16-acceptance.json');
    await writeFile(target, 'stale-old-artifact\n', 'utf8');
    const { deps } = realFsDeps({
      runValidator: async () => { throw new Error('ENOENT: validator script missing'); },
    });
    await assert.rejects(
      publishI16EvidenceAtomically({
        targetPath: target,
        expectedRevision: I16_TEST_REVISION,
        serialize: () => JSON.stringify(buildI16FixtureEvidence()),
        dependencies: deps,
      }),
      /evidence_validation_failed/,
    );
    assert.equal(existsSync(target), false, 'no artifact may remain when the validator could not run');
    assert.deepEqual(await tempFilesOf(directory), []);
  });

  test('a write failure cleans the temp file and never touches the final path', async () => {
    const directory = freshDir();
    const target = join(directory, 'phase4a-i16-acceptance.json');
    await writeFile(target, 'stale-old-artifact\n', 'utf8');
    const { deps, calls } = realFsDeps({
      writeText: async () => { throw new Error('disk_full'); },
    });
    await assert.rejects(
      publishI16EvidenceAtomically({
        targetPath: target,
        expectedRevision: I16_TEST_REVISION,
        serialize: () => JSON.stringify(buildI16FixtureEvidence()),
        dependencies: deps,
      }),
      /evidence_publish_failed/,
    );
    assert.equal(await readFile(target, 'utf8'), 'stale-old-artifact\n', 'the old artifact is never overwritten');
    assert.deepEqual(await tempFilesOf(directory), [], 'partial temp writes must be removed');
    assert.ok(calls.some((call) => call.startsWith('unlink:') && call.includes('.tmp-')));
    assert.ok(!calls.some((call) => call.startsWith('rename:')));
  });

  test('a rename failure cleans the temp file and preserves the old artifact', async () => {
    const directory = freshDir();
    const target = join(directory, 'phase4a-i16-acceptance.json');
    await writeFile(target, 'stale-old-artifact\n', 'utf8');
    const { deps } = realFsDeps({
      rename: async () => { throw new Error('EACCES'); },
    });
    await assert.rejects(
      publishI16EvidenceAtomically({
        targetPath: target,
        expectedRevision: I16_TEST_REVISION,
        serialize: () => JSON.stringify(buildI16FixtureEvidence()),
        dependencies: deps,
      }),
      /evidence_publish_failed/,
    );
    assert.equal(await readFile(target, 'utf8'), 'stale-old-artifact\n');
    assert.deepEqual(await tempFilesOf(directory), []);
  });

  test('a missing reviewed revision refuses to publish anything', async () => {
    const directory = freshDir();
    const target = join(directory, 'phase4a-i16-acceptance.json');
    const { deps, calls } = realFsDeps();
    await assert.rejects(
      publishI16EvidenceAtomically({
        targetPath: target,
        expectedRevision: '   ',
        serialize: () => JSON.stringify(buildI16FixtureEvidence()),
        dependencies: deps,
      }),
      /evidence_revision_unpinned/,
    );
    assert.equal(existsSync(target), false);
    assert.deepEqual(await tempFilesOf(directory), []);
    assert.ok(!calls.some((call) => call.startsWith('validate:')), 'validation must not run without a pinned revision');
  });

  test('the default validator dependency resolves to the real independent validator script', () => {
    assert.ok(existsSync(I16_VALIDATOR_SCRIPT), 'the CLI wiring must point at the committed validator');
    assert.ok(I16_VALIDATOR_SCRIPT.endsWith('phase4a-i16-validate-evidence.mjs'));
  });
});

describe('P4A-R07 hand-edited JSON against the real independent validator CLI', () => {
  const runValidatorCli = async (file: string, revision: string): Promise<{ status: number; stderr: string }> => {
    try {
      await execFileAsync(process.execPath, [I16_VALIDATOR_SCRIPT, file, '--expect-revision', revision], {
        encoding: 'utf8', windowsHide: true,
      });
      return { status: 0, stderr: '' };
    } catch (error) {
      const failure = error as { code?: number; stderr?: string };
      return { status: typeof failure.code === 'number' ? failure.code : 1, stderr: failure.stderr ?? String(error) };
    }
  };

  test('the untouched 24-control bundle passes the real validator CLI', async () => {
    const directory = freshDir();
    const file = join(directory, 'evidence.json');
    await writeFile(file, JSON.stringify(buildI16FixtureEvidence(), null, 2), 'utf8');
    const result = await runValidatorCli(file, I16_TEST_REVISION);
    assert.equal(result.status, 0, result.stderr);
  });

  test('hand-editing executed:true -> false is rejected', async () => {
    const directory = freshDir();
    const file = join(directory, 'evidence.json');
    const bundle = buildI16FixtureEvidence();
    bundle.negativeControls[0]!.executed = false;
    await writeFile(file, JSON.stringify(bundle), 'utf8');
    const result = await runValidatorCli(file, I16_TEST_REVISION);
    assert.notEqual(result.status, 0);
    assert.ok(/not_executed/.test(result.stderr), result.stderr);
  });

  test('hand-editing the canonical digest is rejected', async () => {
    const directory = freshDir();
    const file = join(directory, 'evidence.json');
    const bundle = buildI16FixtureEvidence();
    bundle.canonicalDigest = 'f'.repeat(64);
    await writeFile(file, JSON.stringify(bundle), 'utf8');
    const result = await runValidatorCli(file, I16_TEST_REVISION);
    assert.notEqual(result.status, 0);
    assert.ok(/digest/i.test(result.stderr), result.stderr);
  });

  test('hand-editing a control duplicate or removal is rejected', async () => {
    const directory = freshDir();
    const file = join(directory, 'evidence.json');
    const duplicate = buildI16FixtureEvidence();
    duplicate.negativeControls = [duplicate.negativeControls[0]!, ...duplicate.negativeControls];
    await writeFile(file, JSON.stringify(duplicate), 'utf8');
    const dupResult = await runValidatorCli(file, I16_TEST_REVISION);
    assert.notEqual(dupResult.status, 0);
    assert.ok(/duplicate/.test(dupResult.stderr), dupResult.stderr);

    const removed = buildI16FixtureEvidence();
    removed.negativeControls = removed.negativeControls.slice(1);
    await writeFile(file, JSON.stringify(removed), 'utf8');
    const removedResult = await runValidatorCli(file, I16_TEST_REVISION);
    assert.notEqual(removedResult.status, 0);
    assert.ok(/missing/.test(removedResult.stderr), removedResult.stderr);
  });

  test('hand-editing the reviewed revision binding is rejected via --expect-revision', async () => {
    const directory = freshDir();
    const file = join(directory, 'evidence.json');
    await writeFile(file, JSON.stringify(buildI16FixtureEvidence()), 'utf8');
    const result = await runValidatorCli(file, 'c'.repeat(40));
    assert.notEqual(result.status, 0);
    assert.ok(/revision/i.test(result.stderr), result.stderr);
  });

  test('an unparseable JSON file fails the validator CLI', async () => {
    const directory = freshDir();
    const file = join(directory, 'evidence.json');
    await writeFile(file, '{ not json', 'utf8');
    const result = await runValidatorCli(file, I16_TEST_REVISION);
    assert.notEqual(result.status, 0);
  });
});

describe('P4A-R07 publish uses a fresh run-scoped temp identity', () => {
  test('two publishes never collide on the temp path', async () => {
    const directory = freshDir();
    const target = join(directory, 'phase4a-i16-acceptance.json');
    const firstSerialized = JSON.stringify(buildI16FixtureEvidence(), null, 2) + '\n';
    const secondSerialized = JSON.stringify(buildI16FixtureEvidence({ runId: 'i16-second-run-0000' }), null, 2) + '\n';
    assert.notEqual(firstSerialized, secondSerialized);
    const { deps } = realFsDeps();
    const first = await publishI16EvidenceAtomically({
      targetPath: target,
      expectedRevision: I16_TEST_REVISION,
      serialize: () => firstSerialized,
      dependencies: deps,
    });
    const second = await publishI16EvidenceAtomically({
      targetPath: target,
      expectedRevision: I16_TEST_REVISION,
      serialize: () => secondSerialized,
      dependencies: deps,
    });
    assert.notEqual(first.tempPath, second.tempPath);
    assert.equal(await readFile(target, 'utf8'), secondSerialized, 'the second publish atomically replaces the first');
    assert.deepEqual(await tempFilesOf(directory), []);
  });
});
