import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, test } from 'vitest';

interface SourceIdentity {
  readonly sourceRevision: string;
  readonly sourceDigest: string;
}

const temporaryRoots: string[] = [];

afterAll(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readPhase2SourceIdentity is deterministic on a clean tracked HEAD', async () => {
  const repository = createRepository();
  const first = await readSourceIdentity(repository);
  const second = await readSourceIdentity(repository);

  assert.match(first.sourceRevision, /^[0-9a-f]{40}$/u);
  assert.equal(first.sourceDigest, second.sourceDigest);

  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repository,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
  const expected = createHash('sha256').update(revision).update('\0').digest('hex');
  assert.equal(first.sourceDigest, expected);
});

test('readPhase2SourceIdentity rejects tracked diffs under Known-Backend/Known-Frontend', async () => {
  const repository = createRepository();
  writeFileSync(join(repository, 'Known-Backend', 'tracked.txt'), 'backend changed\n');

  await assert.rejects(
    readSourceIdentity(repository),
    /clean.*(?:tracked|worktree|diff)|tracked.*diff|dirty/iu,
  );
});

test('readPhase2SourceIdentity rejects untracked files under Known-Backend/Known-Frontend', async () => {
  const repository = createRepository();
  writeFileSync(join(repository, 'Known-Frontend', 'untracked.txt'), 'untracked\n');

  await assert.rejects(
    readSourceIdentity(repository),
    /untracked/iu,
  );
});

test('readPhase2SourceIdentity rejects tracked diffs outside Known-Backend/Known-Frontend', async () => {
  const repository = createRepository();
  writeFileSync(join(repository, 'docs', 'tracked.txt'), 'docs changed\n');

  await assert.rejects(
    readSourceIdentity(repository),
    /clean.*(?:tracked|worktree|diff)|tracked.*diff|dirty/iu,
  );
});

test('readPhase2SourceIdentity rejects untracked files outside Known-Backend/Known-Frontend', async () => {
  const repository = createRepository();
  mkdirSync(join(repository, 'colp'), { recursive: true });
  writeFileSync(join(repository, 'colp', 'untracked.txt'), 'untracked\n');

  await assert.rejects(
    readSourceIdentity(repository),
    /untracked/iu,
  );
});

async function readSourceIdentity(repositoryDirectory: string): Promise<SourceIdentity> {
  const module = await import('../../../scripts/phase2-source-identity.mjs') as {
    readPhase2SourceIdentity(repositoryDirectory?: string): SourceIdentity;
  };
  return module.readPhase2SourceIdentity(repositoryDirectory);
}

function createRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'phase2-source-identity-'));
  temporaryRoots.push(root);
  mkdirSync(join(root, 'Known-Backend'), { recursive: true });
  mkdirSync(join(root, 'Known-Frontend'), { recursive: true });
  writeFileSync(join(root, 'Known-Backend', 'tracked.txt'), 'backend\n');
  writeFileSync(join(root, 'Known-Frontend', 'tracked.txt'), 'frontend\n');
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'tracked.txt'), 'docs\n');
  git(root, ['init']);
  git(root, ['config', 'user.name', 'Test Agent']);
  git(root, ['config', 'user.email', 'test@example.test']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);
  return root;
}

function git(repositoryDirectory: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd: repositoryDirectory,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}
