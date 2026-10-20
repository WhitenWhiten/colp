import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { SYNC_AUDIT_OWNERS, SYNC_AUDIT_UNIT_TESTS, SYNC_AUDIT_POSTGRES_TESTS,
  SYNC_AUDIT_REPORT_DIRECTORY } from './scripts/sync-audit-coverage-scope.mjs';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  resolve: { alias: [{ find: /^@known\/sdk$/u, replacement: resolve(root, '../Known-Sdk/src/index.ts') }] },
  test: {
    setupFiles: ['./tests/support/colp-multi-user-default.ts'],
    include: [...SYNC_AUDIT_UNIT_TESTS, ...SYNC_AUDIT_POSTGRES_TESTS],
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    reporters: ['default', 'json'],
    outputFile: { json: `${SYNC_AUDIT_REPORT_DIRECTORY}/test-results.json` },
    coverage: {
      provider: 'v8',
      include: SYNC_AUDIT_OWNERS.map(owner => owner.path),
      reporter: ['text', 'json', 'json-summary'],
      reportOnFailure: true,
      reportsDirectory: SYNC_AUDIT_REPORT_DIRECTORY,
      // All tests contribute to one V8 report. Per-owner four-metric floors
      // and execution of every unit/PG file are enforced by the checker.
    },
  },
});
