import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test } from 'vitest';
import {
  PHASE_1_3_DEFERRED_SOURCE_ROOT_PROMOTIONS,
  PHASE_1_3_OUT_OF_SCOPE_PATH_PATTERNS,
  PHASE_1_3_UNIVERSE_DOCUMENTED_EXCEPTIONS,
  assertPhase13UniverseDirectoriesClassified,
  classifyPhase13UniverseDirectory,
  isPhase13ProductionSourcePath,
  listPhase13UniverseDirectories,
} from '../../../vitest.phase1-3-coverage-scope.js';

const backendRoot = resolve(import.meta.dirname, '../../..');

function assertValidExpiry(expires: string, label: string): void {
  const parsed = new Date(`${expires}T00:00:00.000Z`);
  assert.ok(
    !Number.isNaN(parsed.getTime()) && /^\d{4}-\d{2}-\d{2}$/u.test(expires),
    `${label} expires must be a valid YYYY-MM-DD date, got ${expires}`,
  );
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  assert.ok(
    parsed.getTime() >= todayUtc,
    `${label} expires ${expires} (today is ${new Date(todayUtc).toISOString().slice(0, 10)}); ` +
      'promote the directory into the inventory or renew the dated exception',
  );
}

function assertTrackingDocumentExists(issue: string, label: string): void {
  const trackingDoc = issue.split('#')[0]!;
  assert.ok(
    existsSync(resolve(backendRoot, '..', trackingDoc)),
    `${label} issue tracking document ${trackingDoc} must exist`,
  );
}

describe('Phase 1-3 coverage universe completeness', () => {
  test('every modules/infrastructure subdirectory plus transport and bootstrap is classified', () => {
    assert.doesNotThrow(() => assertPhase13UniverseDirectoriesClassified(backendRoot));

    const directories = listPhase13UniverseDirectories(backendRoot);
    assert.ok(directories.includes('src/transport/'));
    assert.ok(directories.includes('src/bootstrap/'));
    assert.ok(directories.includes('src/modules/mcp/'));
    assert.ok(directories.includes('src/modules/attachments/'));
    assert.ok(directories.includes('src/modules/auth/'));
    assert.ok(directories.includes('src/infrastructure/async/'));
    assert.ok(directories.includes('src/infrastructure/auth/'));

    const unclassified = directories.filter(
      (directory) => classifyPhase13UniverseDirectory(directory) === 'unclassified',
    );
    assert.deepEqual(
      unclassified,
      [],
      `silent third state is forbidden: ${unclassified.join(', ')}`,
    );
  });

  test('MCP and attachments stay Phase 4 out-of-scope after the BT-07 named decision', () => {
    assert.equal(classifyPhase13UniverseDirectory('src/modules/mcp/'), 'out-of-scope');
    assert.equal(classifyPhase13UniverseDirectory('src/modules/attachments/'), 'out-of-scope');
    assert.equal(isPhase13ProductionSourcePath('src/modules/mcp/operations.ts'), false);
    assert.equal(isPhase13ProductionSourcePath('src/modules/attachments/index.ts'), false);
    assert.ok(
      PHASE_1_3_OUT_OF_SCOPE_PATH_PATTERNS.some((pattern) => pattern.test('src/modules/mcp/operations.ts')),
    );
    assert.ok(
      PHASE_1_3_OUT_OF_SCOPE_PATH_PATTERNS.some((pattern) => (
        pattern.test('src/modules/attachments/delivery-policy.ts')
      )),
    );
  });

  test('classification secret protection is included in the measured source inventory', () => {
    assert.equal(classifyPhase13UniverseDirectory('src/infrastructure/security/'), 'source-root-prefix');
    assert.equal(isPhase13ProductionSourcePath('src/infrastructure/security/classification-secret-envelope.ts'), true);
  });

  test('auth is a measured Phase 1-3 source-root prefix, not a deferred exception', () => {
    assert.equal(classifyPhase13UniverseDirectory('src/modules/auth/'), 'source-root-prefix');
    assert.equal(classifyPhase13UniverseDirectory('src/infrastructure/auth/'), 'source-root-prefix');
    assert.equal(isPhase13ProductionSourcePath('src/modules/auth/better-auth-config.ts'), true);
    assert.equal(isPhase13ProductionSourcePath('src/infrastructure/auth/better-auth-runtime.ts'), true);

    const directories = PHASE_1_3_DEFERRED_SOURCE_ROOT_PROMOTIONS.map((entry) => entry.directory).sort();
    assert.deepEqual(directories, []);
    assert.equal(
      PHASE_1_3_OUT_OF_SCOPE_PATH_PATTERNS.some((pattern) => (
        pattern.test('src/modules/auth/better-auth-config.ts')
      )),
      false,
    );
    assert.equal(
      PHASE_1_3_OUT_OF_SCOPE_PATH_PATTERNS.some((pattern) => (
        pattern.test('src/infrastructure/auth/better-auth-runtime.ts')
      )),
      false,
    );
  });

  test('shared async rejection observation is a Phase 1-3 source-root prefix', () => {
    const directory = 'src/infrastructure/async/';
    const source = `${directory}best-effort.ts`;

    assert.equal(classifyPhase13UniverseDirectory(directory), 'source-root-prefix');
    assert.equal(isPhase13ProductionSourcePath(source), true);
    assert.equal(
      PHASE_1_3_UNIVERSE_DOCUMENTED_EXCEPTIONS.some((entry) => entry.directory === directory),
      false,
    );
    assert.equal(
      PHASE_1_3_OUT_OF_SCOPE_PATH_PATTERNS.some((pattern) => pattern.test(source)),
      false,
    );
  });

  test('documented exceptions carry an issue, a reason, and a future expiry', () => {
    const directories = listPhase13UniverseDirectories(backendRoot);
    const exceptionDirectories = PHASE_1_3_UNIVERSE_DOCUMENTED_EXCEPTIONS.map(
      (entry) => entry.directory,
    ).sort();

    for (const exception of PHASE_1_3_UNIVERSE_DOCUMENTED_EXCEPTIONS) {
      assert.ok(
        directories.includes(exception.directory),
        `${exception.directory} must exist on disk`,
      );
      assert.equal(
        classifyPhase13UniverseDirectory(exception.directory),
        'documented-exception',
        exception.directory,
      );
      assert.equal(
        exception.issue,
        'docs/audits/known-backend/2026-08-20/tests-quality-audit.md#T-03',
      );
      assert.ok(exception.reason.trim().length > 0, exception.directory);
      assertValidExpiry(exception.expires, exception.directory);
      assertTrackingDocumentExists(exception.issue, exception.directory);
    }

    assert.deepEqual(exceptionDirectories, [
      'src/infrastructure/bookmark-subscriptions/',
      'src/infrastructure/egress/',
      'src/infrastructure/email/',
      'src/infrastructure/governance/',
      'src/infrastructure/object-storage/',
      'src/infrastructure/reports/',
      'src/modules/bookmark-subscriptions/',
      'src/modules/governance/',
      'src/modules/reports/',
    ]);
  });
});
