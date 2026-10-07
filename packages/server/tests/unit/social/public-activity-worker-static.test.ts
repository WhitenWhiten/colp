import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'vitest';

const backendRoot = resolve(import.meta.dirname, '../../..');

test('public Activity worker does not call Feed fan-out or unfollow withdrawal', () => {
  const postgres = readFileSync(
    resolve(backendRoot, 'src/infrastructure/social/public-activity-worker-postgres.ts'),
    'utf8',
  );
  const route = readFileSync(
    resolve(backendRoot, 'src/infrastructure/social/public-activity-worker-route.ts'),
    'utf8',
  );
  const combined = `${postgres}\n${route}`;
  assert.doesNotMatch(combined, /from follows/iu);
  assert.doesNotMatch(combined, /unfollowed/u);
  assert.doesNotMatch(combined, /feed-withdrawal-worker/u);
  assert.doesNotMatch(combined, /insertItemsBatch/u);
  assert.match(combined, /social\.publish-public-activity/u);
  assert.match(route, /SOCIAL_PUBLIC_ACTIVITY_HANDLER_MODE/u);
});

test('public Activity sources do not put title, slug, handle, or raw cursor in log or metric labels', () => {
  const files = [
    'src/infrastructure/social/public-activity-worker-postgres.ts',
    'src/infrastructure/social/public-activity-worker-route.ts',
    'src/infrastructure/social/public-activity-query-postgres.ts',
    'src/infrastructure/social/public-activity-query-unit-of-work-postgres.ts',
    'src/modules/social/application/public-activity-cursor.ts',
    'src/modules/social/application/public-activity-query.ts',
    'src/modules/social/application/public-activity-worker.ts',
    'src/transport/product/product-public-activity-routes.ts',
    'src/transport/product/public-activity-rate-limit.ts',
  ];
  const combined = files
    .map((relative) => readFileSync(resolve(backendRoot, relative), 'utf8'))
    .join('\n');
  assert.doesNotMatch(combined, /\.(?:log|logger)\.(?:info|warn|error|debug)\s*\(/u);
  assert.doesNotMatch(combined, /increment\(\s*['"][^'"]+['"]\s*,\s*\{/u);
  const app = [
    readFileSync(resolve(backendRoot, 'src/transport/app.ts'), 'utf8'),
    readFileSync(resolve(backendRoot, 'src/transport/app-register-ready.ts'), 'utf8'),
  ].join('\n');
  const activityWarn = app.match(/log\.warn\(\{ publicActivityRateLimit:[^}]+\}[^)]*\)/u)?.[0] ?? '';
  assert.match(activityWarn, /publicActivityRateLimit: activityState\.reason/u);
  assert.doesNotMatch(activityWarn, /title|slug|handle|cursor/u);
});
