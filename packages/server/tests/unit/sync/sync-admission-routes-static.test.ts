/**
 * SYNC-Q-014: Sync HTTP routes must not mint their own fixed-window limiter.
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const colpSyncDir = dirname(fileURLToPath(new URL(
  '../../../src/transport/colp-sync/sync-session-routes.ts',
  import.meta.url,
)));

test('colp-sync routes do not call createFixedWindowRateLimiter', async () => {
  const names = (await readdir(colpSyncDir)).filter((name) => name.endsWith('.ts'));
  assert.ok(names.length >= 8);
  for (const name of names) {
    const source = await readFile(join(colpSyncDir, name), 'utf8');
    assert.doesNotMatch(
      source,
      /createFixedWindowRateLimiter/u,
      `${name} must use SyncAdmissionPolicy instead of a route-local limiter`,
    );
  }
});

// Know-N's multi-replica compose (AUTH_API_REPLICAS, shared Redis Sync
// limiters) is not part of this single-instance self-hosted stack
// (deploy/compose.yaml; tests/EXTRACTION.md). The runtime refusal
// `SYNC_RATE_LIMIT_SHARED=true` without Redis URL/secret is covered by the
// api-rate-limit-composition unit tests.
