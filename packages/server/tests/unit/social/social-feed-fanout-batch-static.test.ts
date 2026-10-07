import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'vitest';

const backendRoot = resolve(import.meta.dirname, '../../..');

async function readSource(relativePath: string): Promise<string> {
  return readFile(resolve(backendRoot, relativePath), 'utf8');
}

test('R5-05 public fanout-batch gate wraps PostgreSQL via with-postgres', async () => {
  const packageJson = JSON.parse(await readSource('package.json')) as {
    scripts: Record<string, string>;
  };
  assert.equal(
    packageJson.scripts['test:phase5:fanout-batch'],
    'node scripts/with-postgres.mjs -- npm run test:phase5:fanout-batch:inner',
  );
  const inner = packageJson.scripts['test:phase5:fanout-batch:inner'] ?? '';
  assert.match(inner, /social-feed-fanout-batch-static\.test\.ts/u);
  assert.match(inner, /social-feed-fanout-batch\.test\.ts/u);
  assert.match(inner, /social-feed-fanout-batch-postgres\.integration\.test\.ts/u);
});

test('R5-05 closed schema freezes remediation task identity', async () => {
  const schema = JSON.parse(
    await readSource('tests/fixtures/phase5/remediation/r5-05-fanout-batch.schema.json'),
  ) as {
    properties: {
      format: { const: string };
      task: { const: string };
    };
  };
  assert.equal(schema.properties.format.const, 'known.phase5.remediation.r5-05.v1');
  assert.equal(schema.properties.task.const, 'R5-05');
});

test('R5-05 live fan-out batches Feed/ledger/outbox writes with UNNEST', async () => {
  const postgres = await readSource('src/infrastructure/social/feed-worker-postgres.ts');
  const projectFn = postgres.match(/async function project\([\s\S]*?\n\}/u)?.[0] ?? '';
  assert.ok(projectFn.length > 0, 'project() missing');

  assert.ok(/unnest/iu.test(postgres), 'live path must INSERT via UNNEST arrays');
  assert.ok(
    /returning\b/iu.test(postgres),
    'batch Feed INSERT must RETURNING new rows for ledger/outbox',
  );
  assert.ok(
    projectFn.includes('insertItemsBatch') || /unnest/iu.test(projectFn)
      || postgres.includes('insertItemsBatch'),
    'live project must call a batch insert path',
  );

  // Live write path must not loop per-recipient client.query writes.
  assert.equal(
    /for\s*\(\s*const\s+recipient\s+of\s+page\s*\)/u.test(projectFn),
    false,
    'live project() must not iterate recipients for per-row writes',
  );
  assert.equal(
    projectFn.includes('insertItem('),
    false,
    'live project() must not call per-recipient insertItem',
  );
  assert.equal(
    projectFn.includes('appendNotificationIntent('),
    false,
    'live project() must not call per-recipient appendNotificationIntent',
  );
});

test('R5-05 keeps Notification intents inside the fan-out transaction and does not advance cursor from RETURNING', async () => {
  const postgres = await readSource('src/infrastructure/social/feed-worker-postgres.ts');
  const projectFn = postgres.match(/async function project\([\s\S]*?\n\}/u)?.[0] ?? '';
  assert.ok(projectFn.length > 0, 'project() missing');

  assert.ok(
    /resource_id_ledger/u.test(postgres) && /social\.feed-item-published/u.test(postgres),
    'batch path must still write resource ledger and Notification Outbox',
  );
  assert.ok(
    /2_048|2048/u.test(postgres),
    'intent payload budget must remain enforced on the batch path',
  );

  // Cursor advances from the candidate page via the shared pure contract, never from
  // RETURNING success rows.
  assert.ok(
    /fanoutPageContinuationCursor\(\s*page\s*\)/u.test(projectFn),
    'continuation cursor must come from the candidate page via the shared pure function',
  );
  assert.ok(
    /feed-fanout-contract/u.test(postgres),
    'worker must import stable id and cursor derivation from the shared fanout contract',
  );
  assert.equal(
    /saveFanoutContinuation[\s\S]{0,200}returning/iu.test(projectFn),
    false,
    'must not derive continuation cursor from INSERT RETURNING',
  );
  assert.equal(
    /fanout_after_recipient_profile_id[\s\S]{0,120}returning/iu.test(projectFn),
    false,
    'must not bind durable cursor to RETURNING rows',
  );
});
