import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

/** Binds evidence to a clean HEAD containing every tracked repository byte. */
export function readPhase2SourceIdentity(repositoryDirectory = resolve('..')) {
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryDirectory,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
  if (!/^[0-9a-f]{40}$/u.test(revision)) {
    throw new Error('Phase 2 evidence could not resolve an exact Git source revision');
  }
  const trackedDiff = execFileSync(
    'git',
    ['diff', '--binary', 'HEAD', '--', '.'],
    { cwd: repositoryDirectory, encoding: 'buffer', windowsHide: true, maxBuffer: 128 * 1024 * 1024 },
  );
  if (trackedDiff.byteLength > 0) {
    throw new Error(
      'Phase 2 evidence requires a clean worktree: tracked repository diffs are not replayable',
    );
  }
  const untracked = execFileSync(
    'git',
    ['ls-files', '--others', '--exclude-standard', '--', '.'],
    { cwd: repositoryDirectory, encoding: 'utf8', windowsHide: true },
  ).split(/\r?\n/u).filter(Boolean).sort();
  if (untracked.length > 0) {
    throw new Error(
      'Phase 2 evidence requires a clean worktree: untracked repository files are not replayable: '
        + untracked.join(', '),
    );
  }
  const digest = createHash('sha256').update(revision, 'utf8').update('\0').update(trackedDiff);
  return Object.freeze({
    sourceRevision: revision,
    sourceDigest: digest.digest('hex'),
  });
}
