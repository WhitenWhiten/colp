import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'vitest';

test('P3-04 review records replay commands, fixed inputs, boundaries and non-deployment status', () => {
  const review = readFileSync(resolve('docs/evidence/phase3-sync-http-composition-review-2026-07-25.md'), 'utf8');
  for (const required of [
    'evidence:phase3-sync-http',
    'sync-http-manifest.json',
    'sync-http-proxy.json',
    'maxBatchOperations=1',
    'VerifiedExtensionCredential',
    'Sequence',
    'Canonical Mutation',
    'not `Deployment-proven`',
    'Manifest does not claim `sync`',
  ]) assert.ok(review.includes(required), `review is missing ${required}`);
});

test('P3-39 advances the unified status without claiming production deployment proof', () => {
  const status = readFileSync(resolve('docs/09-phase-execution-status.md'), 'utf8');
  const row = status.split('\n').find((line) => line.startsWith('| Phase 3：')) ?? '';
  assert.match(row, /\*\*Verified\*\*/u);
  assert.doesNotMatch(row, /\*\*Deployment-proven\*\*/u);
  assert.match(row, /P3-01.*P3-38/u);
  assert.match(row, /P3-39/u);
  assert.match(row, /Manifest[^|]*controller[^|]*`sync`/u);
  assert.match(row, /不是生产 `Deployment-proven`/u);
});
