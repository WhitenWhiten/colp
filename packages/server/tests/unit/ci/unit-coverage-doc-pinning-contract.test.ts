import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'vitest';
import { unitExcludes } from '../../../vitest.coverage.config.js';

const backendRoot = resolve(import.meta.dirname, '../../..');

/**
 * TEST-09 named doc-pinning suites. Each must live under tests/unit/ci or use
 * the `-static.test.ts` suffix so unit coverage collect can exclude them.
 */
const DOC_PINNING_FILES = [
  'tests/unit/phase3/phase3-multi-device-recovery-contract-static.test.ts',
  'tests/unit/phase4b/phase4b-mcp-entry-gate-contract-static.test.ts',
  'tests/unit/collections/owned-collections-openapi-contract-static.test.ts',
  'tests/unit/email/email-capture-preview-catalog-static.test.ts',
  'tests/unit/ci/phase-execution-status.test.ts',
] as const;

test('unit coverage narrative excludes doc-pinning files (TEST-09)', () => {
  assert.ok(
    unitExcludes.includes('tests/unit/**/*-static.test.ts'),
    'unit coverage collect must exclude *-static.test.ts source/docs pins',
  );
  assert.ok(
    unitExcludes.includes('tests/unit/ci/**/*.test.ts'),
    'unit coverage collect must exclude tests/unit/ci contracts from the coverage narrative',
  );

  for (const relative of DOC_PINNING_FILES) {
    assert.equal(existsSync(resolve(backendRoot, relative)), true, `${relative} must exist`);
    const inCi = relative.startsWith('tests/unit/ci/');
    const isStatic = relative.endsWith('-static.test.ts');
    assert.ok(
      inCi || isStatic,
      `${relative} must live in tests/unit/ci or use the -static suffix`,
    );
  }
});

test('new suites must not use a fixed sleep as the only oracle (TEST-14)', () => {
  const helper = readFileSync(
    resolve(backendRoot, 'tests/support/redis-runtime-test-helpers.ts'),
    'utf8',
  );
  assert.match(
    helper,
    /a fixed sleep is never the only oracle/u,
    'shared Redis helpers must keep the waitUntil policy; existing sleeps are accepted residual',
  );
});
