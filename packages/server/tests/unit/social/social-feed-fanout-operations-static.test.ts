import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'vitest';

const backendRoot = resolve(import.meta.dirname, '../../..');

async function readSource(relativePath: string): Promise<string> {
  return readFile(resolve(backendRoot, relativePath), 'utf8');
}

test('R5-12 public fanout-operations gate wraps PostgreSQL via with-postgres', async () => {
  const packageJson = JSON.parse(await readSource('package.json')) as {
    scripts: Record<string, string>;
  };
  assert.equal(
    packageJson.scripts['test:phase5:fanout-operations'],
    'node scripts/with-postgres.mjs -- npm run test:phase5:fanout-operations:inner',
  );
  const inner = packageJson.scripts['test:phase5:fanout-operations:inner'] ?? '';
  assert.match(inner, /social-feed-fanout-operations-static\.test\.ts/u);
  assert.match(inner, /social-feed-fanout-operations\.test\.ts/u);
  assert.match(inner, /social-feed-fanout-operations-postgres\.integration\.test\.ts/u);
});

test('R5-12 closed schema freezes remediation task identity', async () => {
  const schema = JSON.parse(
    await readSource('tests/fixtures/phase5/remediation/r5-12-fanout-operations.schema.json'),
  ) as {
    properties: {
      format: { const: string };
      task: { const: string };
    };
  };
  assert.equal(schema.properties.format.const, 'known.phase5.remediation.r5-12.v1');
  assert.equal(schema.properties.task.const, 'R5-12');
});

test('R5-12 operations recovery forbids auto authority reset and direct outbox completion', async () => {
  const operations = await readSource('src/infrastructure/social/feed-operations-postgres.ts');
  const application = await readSource('src/modules/social/application/feed-operations.ts');
  const cli = await readSource('scripts/phase5-feed-operations.ts');
  const combined = `${operations}\n${application}\n${cli}`;

  assert.doesNotMatch(combined, /update\s+social_feed_watermarks[\s\S]{0,200}fanout_source_event_id\s*=\s*null/iu);
  assert.doesNotMatch(combined, /set\s+state\s*=\s*'completed'/iu);
  assert.doesNotMatch(combined, /complete\s*\(\s*claim/iu);
  assert.match(combined, /replayDeadLetters/u);
});

test('R5-12 runbook covers continuation checks, recovery and alert thresholds', async () => {
  const runbook = await readSource('docs/runbooks/feed-projection-operations.md');
  for (const token of [
    'feed.fanout.progress_backlog',
    'feed.fanout.oldest_progress_age_ms',
    'feed.fanout.withdrawal_backlog',
    'stale progress',
    'normal continuation',
    'dead-letter',
    'orphan progress',
    'threshold',
    'suppression',
    'recovery',
  ]) {
    assert.match(runbook, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'iu'));
  }
  assert.match(runbook, /Do not\s+automatically reset watermark authority/iu);
  assert.match(runbook, /Never mark the outbox completed/iu);
});
