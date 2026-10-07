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
const composeUrl = new URL('../../../../devops/docker-compose.yml', import.meta.url);

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

test('Compose wires AUTH_API_REPLICAS and shared Sync limiter env', async () => {
  const compose = await readFile(composeUrl, 'utf8');
  for (const fragment of [
    'AUTH_API_REPLICAS:',
    'SYNC_RATE_LIMIT_SHARED:',
    'SYNC_RATE_LIMIT_REDIS_URL:',
    'SYNC_RATE_LIMIT_KEY_SECRET:',
    'SYNC_EFFECT_PAGE_RATE_LIMIT_SHARED:',
    'SYNC_EFFECT_PAGE_RATE_LIMIT_REDIS_URL:',
    'SYNC_EFFECT_PAGE_RATE_LIMIT_KEY_SECRET:',
  ]) {
    assert.match(compose, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'), fragment);
  }
});
