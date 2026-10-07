/**
 * Shared fixtures for Phase 5 free-social dependency tests. Not a test file.
 */
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { CI_LIVE_DEPENDENCY_MODE } from '../../scripts/phase5-free-social-dependencies.mjs';
import {
  canonicalizeExistingPath,
  resolveEvidenceRootFromEnv,
} from '../../scripts/phase5-evidence-root.mjs';

export const backendRoot = resolve(import.meta.dirname, '../..');
export const repositoryRoot = resolve(backendRoot, '..');
export const lockPath = resolve(backendRoot, 'tests/fixtures/phase5/free-social-evidence-lock.v1.json');

export const EXPECTED_RELATIVE_PATHS = Object.freeze({
  followAcceptance: 'p5-07/phase5-follow-acceptance.json',
  feedAcceptance: 'p5-15/phase5-feed-acceptance.json',
  notificationAcceptance: 'p5-23/phase5-notification-acceptance.json',
  feedOperations: 'p5-24/phase5-feed-operations-status.json',
  notificationOperations: 'p5-25/phase5-notification-operations-status.json',
});

export function readSource(relativePath: string): string {
  return readFileSync(resolve(backendRoot, relativePath), 'utf8');
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function headCommit(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot, encoding: 'utf8', windowsHide: true,
  }).trim();
}

export function requireEvidenceBundleRoot(): string {
  const root = process.env.KNOWN_PHASE5_EVIDENCE_ROOT;
  if (typeof root !== 'string' || root.trim() === '') {
    throw new Error(
      'KNOWN_PHASE5_EVIDENCE_ROOT must point at the portable Phase 5 evidence bundle for R5-17 dependency tests',
    );
  }
  return resolveEvidenceRootFromEnv(
    { KNOWN_PHASE5_EVIDENCE_ROOT: root },
    repositoryRoot,
  );
}

export function makeOutsideRoot(prefix: string): string {
  return canonicalizeExistingPath(mkdtempSync(join(tmpdir(), prefix)));
}

export function copyBundleInto(targetRoot: string, sourceRoot: string): void {
  for (const relativePath of Object.values(EXPECTED_RELATIVE_PATHS)) {
    const from = resolve(sourceRoot, ...relativePath.split('/'));
    const to = resolve(targetRoot, ...relativePath.split('/'));
    mkdirSync(resolve(to, '..'), { recursive: true });
    cpSync(from, to);
  }
}

export function readLock() {
  return JSON.parse(readFileSync(lockPath, 'utf8')) as {
    dependencies: Record<string, Record<string, unknown>>;
  };
}

export function writeJson(targetRoot: string, relativePath: string, value: unknown): void {
  const to = resolve(targetRoot, ...relativePath.split('/'));
  mkdirSync(resolve(to, '..'), { recursive: true });
  writeFileSync(to, `${JSON.stringify(value, null, 2)}\n`);
}

export function ciLiveAcceptance(
  name: 'followAcceptance' | 'feedAcceptance' | 'notificationAcceptance',
  claims: Record<string, unknown>,
): Record<string, unknown> {
  const formats = {
    followAcceptance: 'known.phase5.follow-acceptance.v1',
    feedAcceptance: 'known.phase5.feed-acceptance.v1',
    notificationAcceptance: 'known.phase5.notification-acceptance.v1',
  } as const;
  return {
    format: formats[name],
    accepted: true,
    claims,
    source: { checkoutCommit: 'a'.repeat(40) },
  };
}

export function ciLiveOperations(
  name: 'feedOperations' | 'notificationOperations',
  options: { dependency?: string; ready?: boolean } = {},
): Record<string, unknown> {
  const notification = name === 'notificationOperations';
  return {
    schema: notification
      ? 'known.phase5.notification-operations/v1'
      : 'known.phase5.feed-operations/v1',
    command: 'status',
    sourceRevision: 'a'.repeat(40),
    result: {
      status: { dependency: options.dependency ?? 'available' },
      readiness: { status: options.ready === false ? 'not-ready' : 'ready' },
    },
  };
}

export function writeCiLiveFixtureBundle(
  targetRoot: string,
  options: { omitFollowEligible?: boolean; omitFeedFile?: boolean } = {},
): void {
  const followClaims = options.omitFollowEligible
    ? { phase5Verified: false, deploymentProven: false, colpProfile: false }
    : { followEligible: true, phase5Verified: false, deploymentProven: false, colpProfile: false };
  writeJson(targetRoot, EXPECTED_RELATIVE_PATHS.followAcceptance,
    ciLiveAcceptance('followAcceptance', followClaims));
  if (!options.omitFeedFile) {
    writeJson(targetRoot, EXPECTED_RELATIVE_PATHS.feedAcceptance,
      ciLiveAcceptance('feedAcceptance', {
        feedEligible: true, phase5Verified: false, deploymentProven: false, colpProfile: false,
      }));
  }
  writeJson(targetRoot, EXPECTED_RELATIVE_PATHS.notificationAcceptance,
    ciLiveAcceptance('notificationAcceptance', {
      notificationEligible: true, phase5Verified: false, deploymentProven: false, colpProfile: false,
    }));
  writeJson(targetRoot, EXPECTED_RELATIVE_PATHS.feedOperations, ciLiveOperations('feedOperations'));
  writeJson(targetRoot, EXPECTED_RELATIVE_PATHS.notificationOperations,
    ciLiveOperations('notificationOperations'));
}

export function runCiLiveVerifier(evidenceRoot: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['scripts/phase5-free-social-dependencies.mjs'], {
    cwd: backendRoot,
    env: {
      ...process.env,
      KNOWN_PHASE5_EVIDENCE_ROOT: evidenceRoot,
      KNOWN_PHASE5_FREE_SOCIAL_EXPECTED_COMMIT: 'a'.repeat(40),
      KNOWN_PHASE5_FOLLOW_EXPECTED_COMMIT: 'a'.repeat(40),
      KNOWN_PHASE5_FREE_SOCIAL_DEPENDENCY_MODE: CI_LIVE_DEPENDENCY_MODE,
    },
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
  });
}
