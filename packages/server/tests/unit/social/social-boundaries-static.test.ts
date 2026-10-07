import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'vitest';

const backendRoot = resolve(import.meta.dirname, '../../..');

async function readSource(relativePath: string): Promise<string> {
  return readFile(resolve(backendRoot, relativePath), 'utf8');
}

const IDENTITY_SURFACE_FILES = [
  'src/modules/commands/application/social-identity.ts',
  'src/modules/social/application/follow-command.ts',
  'src/modules/social/application/follow-query.ts',
  'src/modules/social/application/follow-cursor.ts',
  'src/modules/social/application/feed-query.ts',
  'src/modules/social/application/feed-cursor.ts',
  'src/modules/social/application/feed-worker.ts',
  'src/modules/social/application/public-activity-query.ts',
  'src/modules/social/application/public-activity-cursor.ts',
  'src/infrastructure/social/public-activity-query-postgres.ts',
  'src/infrastructure/social/follow-postgres.ts',
  'src/infrastructure/social/follow-command-postgres.ts',
  'src/infrastructure/social/follow-query-postgres.ts',
  'src/infrastructure/social/feed-query-postgres.ts',
  'src/infrastructure/social/feed-worker-route.ts',
  'src/infrastructure/social/feed-projection-postgres.ts',
  'src/infrastructure/social/feed-operations-postgres.ts',
  'src/modules/notifications/application/notification-inbox-query.ts',
  'src/modules/notifications/application/notification-inbox-cursor.ts',
  'src/modules/notifications/application/notification-read-command.ts',
  'src/modules/notifications/application/notification-preference-command.ts',
  'src/infrastructure/notifications/notification-inbox-query-postgres.ts',
  'src/infrastructure/notifications/repository-postgres.ts',
  'src/infrastructure/notifications/notification-operations-postgres.ts',
  'src/infrastructure/notifications/social-notification-worker-route.ts',
] as const;

const QUERY_UOW_FILES = [
  'src/infrastructure/social/follow-query-unit-of-work-postgres.ts',
  'src/infrastructure/social/feed-query-unit-of-work-postgres.ts',
  'src/infrastructure/social/public-activity-query-unit-of-work-postgres.ts',
  'src/infrastructure/notifications/notification-inbox-query-unit-of-work-postgres.ts',
] as const;

test('R5-07 public social-boundaries gate wraps PostgreSQL via with-postgres', async () => {
  const packageJson = JSON.parse(await readSource('package.json')) as {
    scripts: Record<string, string>;
  };
  assert.equal(
    packageJson.scripts['test:phase5:social-boundaries'],
    'node scripts/with-postgres.mjs -- npm run test:phase5:social-boundaries:inner',
  );
  const inner = packageJson.scripts['test:phase5:social-boundaries:inner'] ?? '';
  assert.match(inner, /social-boundaries-static\.test\.ts/u);
  assert.match(inner, /social-boundaries\.test\.ts/u);
  assert.match(inner, /social-boundaries-postgres\.integration\.test\.ts/u);
});

test('R5-07 closed schema freezes remediation task identity', async () => {
  const schema = JSON.parse(
    await readSource('tests/fixtures/phase5/remediation/r5-07-social-boundaries.schema.json'),
  ) as {
    properties: {
      format: { const: string };
      task: { const: string };
    };
  };
  assert.equal(schema.properties.format.const, 'known.phase5.remediation.r5-07.v1');
  assert.equal(schema.properties.task.const, 'R5-07');
});

test('R5-07 shared SOCIAL_IDENTITY_MAX_LENGTH is 256 and consumed by social/notifications surfaces', async () => {
  const shared = await readSource('src/modules/commands/application/social-identity.ts');
  assert.match(shared, /export const SOCIAL_IDENTITY_MAX_LENGTH\s*=\s*256/u);
  assert.match(shared, /isSocialIdentityText/u);

  const followCommand = await readSource('src/infrastructure/social/follow-command-postgres.ts');
  assert.match(followCommand, /isSocialIdentityText/u);
  assert.match(followCommand, /socialFollowEventEnvelopeRegistrations/u);

  for (const relativePath of IDENTITY_SURFACE_FILES) {
    const source = await readSource(relativePath);
    assert.match(
      source,
      /SOCIAL_IDENTITY_MAX_LENGTH|isSocialIdentityText/u,
      `${relativePath} must consume the shared social identity bound`,
    );
    assert.equal(
      /\blength\s*(?:<=|>)\s*512\b/u.test(source),
      false,
      `${relativePath} must not keep a 512 identity length bound`,
    );
    assert.equal(
      /\b(?:MAX_IDENTITY|SAFE_TEXT_MAX)\s*=\s*512\b/u.test(source),
      false,
      `${relativePath} must not keep a local 512 identity constant`,
    );
  }
});

test('R5-07 OpenAPI ProfileStableId remains the frozen 22-character contract', async () => {
  const openapi = await readSource('openapi/product-v1.yaml');
  const block = openapi.match(/ProfileStableId:\r?\n(?:[ \t]+.+\r?\n){1,8}/u)?.[0] ?? '';
  assert.match(block, /minLength:\s*22/u);
  assert.match(block, /maxLength:\s*22/u);
  assert.match(block, /\^\[A-Za-z0-9_-\]\{21\}\[AQgw\]\$/u);
  assert.equal(/ProfileStableId:[\s\S]{0,200}maxLength:\s*256/u.test(openapi), false);
});

test('R5-07 Follow/Feed/Notification query UoWs use RR + database clock without wall clock', async () => {
  for (const relativePath of QUERY_UOW_FILES) {
    const source = await readSource(relativePath);
    assert.match(source, /repeatable read/u, `${relativePath} must use repeatable read`);
    assert.match(
      source,
      /databaseNow|current_timestamp/u,
      `${relativePath} must read PostgreSQL current_timestamp`,
    );
    assert.equal(
      /new\s+Date\s*\(\s*\)/u.test(source),
      false,
      `${relativePath} must not call new Date()`,
    );
  }
});

test('R5-07 remediation contract freezes identity 256 and query UoW clock policy', async () => {
  const contract = JSON.parse(
    await readSource('tests/fixtures/phase5/free-social-contract.v1.json'),
  ) as {
    remediation: {
      identity: {
        socialNotificationsTextMaxLength: number;
        openapiProfileStableIdLength: number;
      };
      queryUnitOfWork: {
        isolation: string;
        clock: string;
        forbidAdapterWallClock: boolean;
      };
    };
  };
  assert.equal(contract.remediation.identity.socialNotificationsTextMaxLength, 256);
  assert.equal(contract.remediation.identity.openapiProfileStableIdLength, 22);
  assert.equal(contract.remediation.queryUnitOfWork.isolation, 'repeatable-read');
  assert.equal(contract.remediation.queryUnitOfWork.clock, 'postgresql-current_timestamp');
  assert.equal(contract.remediation.queryUnitOfWork.forbidAdapterWallClock, true);
});
