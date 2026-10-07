import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'vitest';

const backendRoot = resolve(import.meta.dirname, '../../..');

async function readSource(relativePath: string): Promise<string> {
  return readFile(resolve(backendRoot, relativePath), 'utf8');
}

test('R5-04 public fanout-continuation gate wraps PostgreSQL via with-postgres', async () => {
  const packageJson = JSON.parse(await readSource('package.json')) as {
    scripts: Record<string, string>;
  };
  assert.equal(
    packageJson.scripts['test:phase5:fanout-continuation'],
    'node scripts/with-postgres.mjs -- npm run test:phase5:fanout-continuation:inner',
  );
  const inner = packageJson.scripts['test:phase5:fanout-continuation:inner'] ?? '';
  assert.match(inner, /social-feed-fanout-continuation-static\.test\.ts/u);
  assert.match(inner, /social-feed-fanout-continuation\.test\.ts/u);
  assert.match(inner, /social-feed-fanout-continuation-postgres\.integration\.test\.ts/u);
});

test('R5-04 closed schema freezes remediation task identity', async () => {
  const schema = JSON.parse(
    await readSource('tests/fixtures/phase5/remediation/r5-04-fanout-continuation.schema.json'),
  ) as {
    properties: {
      format: { const: string };
      task: { const: string };
    };
  };
  assert.equal(schema.properties.format.const, 'known.phase5.remediation.r5-04.v1');
  assert.equal(schema.properties.task.const, 'R5-04');
});

test('R5-04 live fan-out uses durable watermark cursor and OutboxContinuationRequested', async () => {
  const postgres = await readSource('src/infrastructure/social/feed-worker-postgres.ts');
  const route = await readSource('src/infrastructure/social/feed-worker-route.ts');

  for (const contract of [
    'fanout_source_event_id',
    'fanout_commit_ordinal',
    'fanout_after_recipient_profile_id',
    'fanout_candidate_count',
    'fanout_started_at',
  ]) {
    assert.ok(postgres.includes(contract), `missing live fan-out contract: ${contract}`);
  }
  assert.ok(
    postgres.includes('OutboxContinuationRequested') || route.includes('OutboxContinuationRequested'),
    'live path must request outbox continuation',
  );
  assert.ok(
    /maxRecipients\s*\+\s*1|pageSize\s*\+\s*1/u.test(postgres),
    'live path must read pageSize+1 candidates',
  );

  // Live project path must not keep an in-process recipient cursor loop.
  const projectFn = postgres.match(
    /async function project\([\s\S]*?\n\}/u,
  )?.[0] ?? '';
  assert.ok(projectFn.length > 0, 'project() missing');
  assert.equal(
    /while\s*\(\s*true\s*\)/u.test(projectFn),
    false,
    'live project() must not loop all followers in one invocation',
  );
  assert.equal(
    projectFn.includes('insertRecipientPages'),
    false,
    'live project() must not call unbounded insertRecipientPages',
  );
  assert.ok(
    projectFn.includes('withdrawVisiblePage'),
    'source withdrawal must use the bounded continuation path',
  );
  assert.equal(
    projectFn.includes('withdrawIneligible'),
    false,
    'public fan-out must not perform an unbounded historical eligibility sweep',
  );
  assert.match(
    postgres,
    /for update skip locked[\s\S]*?limit \$4/u,
    'withdrawal selection must be lock-safe and limited to one configured page',
  );
});

test('R5-04 forbids total hard-fail on live path and keeps query-time authority recheck', async () => {
  const postgres = await readSource('src/infrastructure/social/feed-worker-postgres.ts');
  const query = await readSource('src/infrastructure/social/feed-query-postgres.ts');
  const projectFn = postgres.match(
    /async function project\([\s\S]*?\n\}/u,
  )?.[0] ?? '';
  assert.ok(projectFn.length > 0, 'project() missing');
  assert.equal(
    /cap exceeded/iu.test(projectFn),
    false,
    'live fan-out must not hard-fail on total recipient volume',
  );
  assert.ok(
    query.includes("item.state='visible'") && query.includes('current_follow'),
    'query-time current-authority recheck must remain',
  );
  assert.ok(
    query.includes("collection.visibility='public'"),
    'query-time Collection authority recheck must remain',
  );
});

test('R5-04 application result surface includes continued disposition', async () => {
  const application = await readSource('src/modules/social/application/feed-worker.ts');
  assert.ok(
    application.includes("'continued'") || application.includes('"continued"'),
    'ProjectSocialCollectionChangeResult must allow continued disposition',
  );
});
