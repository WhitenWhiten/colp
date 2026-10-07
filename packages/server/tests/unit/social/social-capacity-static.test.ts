import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { test } from 'vitest';

const backendRoot = resolve(import.meta.dirname, '../../..');

async function readSource(relativePath: string): Promise<string> {
  return readFile(resolve(backendRoot, relativePath), 'utf8');
}

test('R5-08 public social-capacity gate wraps PostgreSQL via with-postgres', async () => {
  const packageJson = JSON.parse(await readSource('package.json')) as {
    scripts: Record<string, string>;
  };
  assert.equal(
    packageJson.scripts['evidence:phase5:social-capacity'],
    'node scripts/with-postgres.mjs -- npm run evidence:phase5:social-capacity:inner',
  );
  const inner = packageJson.scripts['evidence:phase5:social-capacity:inner'] ?? '';
  assert.match(inner, /social-capacity-static\.test\.ts/u);
  assert.match(inner, /social-capacity-postgres\.integration\.test\.ts/u);
  assert.equal(/local-opt-out|describe\.skip|\.skip\(/u.test(inner), false);
});

test('R5-08 closed schema freezes capacity artifact contract', async () => {
  const schema = JSON.parse(
    await readSource('tests/fixtures/phase5/remediation/r5-08-social-capacity.schema.json'),
  ) as {
    additionalProperties: boolean;
    required: readonly string[];
    properties: {
      format: { const: string };
      task: { const: string };
      method: {
        properties: {
          warmupIterations: { const: number };
          measuredIterations: { const: number };
          jit: { const: string };
        };
      };
      seed: {
        properties: {
          fanoutFollows: { minimum: number };
          feedItems: { const: number };
          feedUnfollowItems: { const: number };
          feedPrivateDeletedItems: { const: number };
          feedValidItems: { const: number };
        };
      };
    };
  };
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.format.const, 'known.phase5.remediation.r5-08.v1');
  assert.equal(schema.properties.task.const, 'R5-08');
  assert.equal(schema.properties.method.properties.warmupIterations.const, 5);
  assert.equal(schema.properties.method.properties.measuredIterations.const, 30);
  assert.equal(schema.properties.method.properties.jit.const, 'off');
  assert.equal(schema.properties.seed.properties.fanoutFollows.minimum, 100_000);
  assert.equal(schema.properties.seed.properties.feedItems.const, 100_000);
  assert.equal(schema.properties.seed.properties.feedUnfollowItems.const, 90_000);
  assert.equal(schema.properties.seed.properties.feedPrivateDeletedItems.const, 5_000);
  assert.equal(schema.properties.seed.properties.feedValidItems.const, 5_000);
  for (const key of [
    'format', 'task', 'environment', 'method', 'seed', 'fanout', 'feed',
    'withdrawal', 'corners', 'pass',
  ]) {
    assert.ok(schema.required.includes(key), `schema must require ${key}`);
  }
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
  assert.equal(validate({ format: 'known.phase5.remediation.r5-08.v1', task: 'R5-08' }), false);
});

test('R5-08 harness and production surfaces keep fan-out index, withdrawal, sparse recheck', async () => {
  const fanoutStatement = await readSource(
    'src/infrastructure/social/feed-fanout-recipient-statement.ts',
  );
  const feedQuery = await readSource('src/infrastructure/social/feed-query-postgres.ts');
  const withdrawal = await readSource(
    'src/infrastructure/social/feed-withdrawal-worker-postgres.ts',
  );
  const worker = await readSource('src/bootstrap/worker.ts');
  const harness = await readSource('scripts/evidence/phase5-social-capacity.ts');

  assert.match(fanoutStatement, /buildFanoutRecipientPageStatement/u);
  assert.match(fanoutStatement, /followed_at\s*<=/u);
  assert.match(fanoutStatement, /actor_profile_id\s*>/u);
  assert.match(feedQuery, /join lateral/iu);
  assert.match(feedQuery, /current_follow/u);
  assert.match(feedQuery, /followed_at\s*<=\s*item\.published_at/u);
  assert.match(feedQuery, /collection_follows/u);
  assert.match(feedQuery, /union all|\bor\b/iu);
  assert.match(withdrawal, /withdrawal_reason='unfollowed'/u);
  assert.match(withdrawal, /published_at\s*<=/u);
  assert.match(worker, /createSocialFeedWithdrawalWorkerRoutes/u);
  assert.match(harness, /follows_target_actor_fanout_idx/u);
  assert.match(harness, /social_feed_items_recipient_page_idx/u);
  assert.match(harness, /warmupIterations|WARMUP_ITERATIONS/u);
  assert.match(harness, /MEASURED_ITERATIONS|measuredIterations/u);
  assert.match(harness, /jit\s*=\s*off|jit',\s*'off'|set local jit/u);
  assert.match(harness, /rowsRemovedByFilter/u);
  assert.match(harness, /sharedBufferBlocks/u);
  assert.match(harness, /SOCIAL_CAPACITY_FANOUT_SCANNED_FOLLOW_ROWS_MAX/u);
  assert.match(harness, /SOCIAL_CAPACITY_FEED_SCANNED_ROWS_MAX/u);
  assert.match(harness, /plan\.Plan\['Shared Hit Blocks'\]/u);
  assert.match(harness, /expectedResultIds/u);
  assert.match(harness, /scannedFeedRows|scannedFollowRows/u);
  assert.equal(/test\.skip|describe\.skip|local-opt-out/u.test(harness), false);
  const fanoutOracle = harness.match(
    /async function expectedFanoutPage\([\s\S]*?\n\}/u,
  )?.[0] ?? '';
  const feedOracle = harness.match(
    /async function expectedFeedPage\([\s\S]*?\n\}/u,
  )?.[0] ?? '';
  assert.equal(fanoutOracle.includes('buildFanoutRecipientPageStatement'), false);
  assert.equal(feedOracle.includes('buildFeedPageStatement'), false);
  assert.match(fanoutOracle, /exists \([\s\S]*?from accounts/u);
  assert.match(feedOracle, /join follows current_follow/u);
  assert.match(feedOracle, /collection_follows/u);
});

test('R5-08 completion criteria: removing index/handler/recheck is detectable in assertions', async () => {
  const harness = await readSource('scripts/evidence/phase5-social-capacity.ts');
  const integration = await readSource(
    'tests/integration/social/social-capacity-postgres.integration.test.ts',
  );
  // Fan-out index identity + no Sort/Seq Scan (fails if fan-out index is dropped).
  assert.match(harness, /follows_target_actor_fanout_idx/u);
  assert.match(harness, /hasSort/u);
  assert.match(harness, /hasFollowsSequentialScan/u);
  // Sparse LATERAL recheck correctness (fails if lateral/current_follow is removed).
  assert.match(harness, /buildFeedPageStatement/u);
  assert.match(harness, /feedValidItems|VALID_FEED_ITEMS/u);
  assert.match(integration, /actualResultIds/u);
  assert.match(integration, /expectedResultIds/u);
  // Withdrawal handler path (fails if withdrawal UPDATE/handler is removed).
  assert.match(harness, /createPostgresSocialFeedWithdrawalWorkerRepository|withdrawal_reason/u);
  assert.match(harness, /withdrawnCount/u);
  assert.match(integration, /withdrawal/u);
});
