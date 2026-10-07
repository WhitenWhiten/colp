import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'vitest';

const backendRoot = resolve(import.meta.dirname, '../../..');

async function readSource(relativePath: string): Promise<string> {
  return readFile(resolve(backendRoot, relativePath), 'utf8');
}

test('R5-06 public unfollow-withdrawal gate wraps PostgreSQL via with-postgres', async () => {
  const packageJson = JSON.parse(await readSource('package.json')) as {
    scripts: Record<string, string>;
  };
  assert.equal(
    packageJson.scripts['test:phase5:unfollow-withdrawal'],
    'node scripts/with-postgres.mjs -- npm run test:phase5:unfollow-withdrawal:inner',
  );
  const inner = packageJson.scripts['test:phase5:unfollow-withdrawal:inner'] ?? '';
  assert.match(inner, /social-unfollow-withdrawal-static\.test\.ts/u);
  assert.match(inner, /social-unfollow-withdrawal\.test\.ts/u);
  assert.match(inner, /social-unfollow-withdrawal-postgres\.integration\.test\.ts/u);
  assert.match(inner, /follow-command\.test\.ts/u);
  assert.match(inner, /follow-command-postgres\.integration\.test\.ts/u);
});

test('R5-06 closed schema freezes remediation task identity', async () => {
  const schema = JSON.parse(
    await readSource('tests/fixtures/phase5/remediation/r5-06-unfollow-withdrawal.schema.json'),
  ) as {
    properties: {
      format: { const: string };
      task: { const: string };
    };
  };
  assert.equal(schema.properties.format.const, 'known.phase5.remediation.r5-06.v1');
  assert.equal(schema.properties.task.const, 'R5-06');
});

test('R5-06 Follow Outbox port uses appendAll and dual unfollow handlers', async () => {
  const command = await readSource('src/modules/social/application/follow-command.ts');
  const postgres = await readSource('src/infrastructure/social/follow-command-postgres.ts');
  assert.match(command, /appendAll\s*\(/u);
  assert.match(command, /social_feed_withdrawal/u);
  assert.match(command, /social_follow_activity/u);
  assert.equal(/outbox:\s*\{\s*append\s*\(/u.test(command), false,
    'Follow command must not keep a single-event append port');
  assert.match(postgres, /appendAll\s*\(/u);
  assert.match(postgres, /social_feed_withdrawal/u);

  const changedBlock = command.match(/if \(changed\) \{[\s\S]*?\n  \}/u)?.[0] ?? '';
  assert.ok(changedBlock.length > 0, 'changed-event appendAll block missing');
  assert.match(changedBlock, /appendAll/u);
  assert.match(changedBlock, /social_feed_withdrawal/u);
  assert.match(changedBlock, /social_follow_activity/u);
  assert.match(changedBlock, /social\.follow-removed/u);
  assert.match(changedBlock, /social\.follow-created/u);
});

test('R5-06 registers fenced withdrawal handler and keeps query-time recheck', async () => {
  const route = await readSource('src/infrastructure/social/feed-withdrawal-worker-route.ts');
  const postgres = await readSource('src/infrastructure/social/feed-withdrawal-worker-postgres.ts');
  const followHttp = await readSource('src/transport/product/follow-routes.ts');
  const feedQuery = await readSource('src/infrastructure/social/feed-query-postgres.ts');

  assert.match(route, /social_feed_withdrawal/u);
  assert.match(route, /delivery_each_event/u);
  assert.match(postgres, /withdrawal_reason='unfollowed'|withdrawal_reason=\$|'unfollowed'/u);
  assert.match(postgres, /published_at\s*<=/u);
  assert.match(postgres, /ownsAttempt|lease_generation/u);
  assert.equal(/update\s+social_feed_items/iu.test(followHttp), false,
    'Follow HTTP must not synchronously UPDATE Feed items');
  assert.match(feedQuery, /current_follow/u);
  assert.match(feedQuery, /followed_at\s*<=\s*item\.published_at/u);
});
