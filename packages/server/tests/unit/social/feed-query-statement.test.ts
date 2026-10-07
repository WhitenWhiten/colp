import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'vitest';
import { buildFeedPageStatement } from '../../../src/infrastructure/social/index.js';
import { readApiCompositionSource } from '../../support/api-composition-source.js';

const backendRoot = resolve(import.meta.dirname, '../../..');

const PRINCIPAL = 'feed-query-statement-recipient';

function laterals(text: string) {
  const collectionStart = text.indexOf('left join lateral (');
  const followStart = text.lastIndexOf('left join lateral (');
  assert.ok(collectionStart >= 0 && followStart > collectionStart);
  return {
    collection: text.slice(collectionStart, followStart),
    follow: text.slice(followStart),
  };
}

test('collection_authority accepts collection_follows without an owner follows row', () => {
  const statement = buildFeedPageStatement(
    { principalId: PRINCIPAL, limit: 10 },
    { includeCollectionFollowers: true },
  );
  const collectionLateral = laterals(statement.text).collection;

  assert.match(collectionLateral, /collection_follows/u);
  assert.match(
    collectionLateral,
    /union all|\bor\b/iu,
    'collection_authority must UNION or OR owner-follow with collection_follows',
  );
  assert.match(collectionLateral, /from follows current_follow/u);
  assert.match(
    collectionLateral,
    /current_follow\.target_profile_id=item\.actor_profile_id/u,
  );
  assert.match(
    collectionLateral,
    /current_follow\.followed_at <= item\.published_at/u,
  );
  assert.match(collectionLateral, /collection\.visibility='public'/u);
  assert.doesNotMatch(collectionLateral, /visibility in \('public','unlisted'\)/u);
  assert.equal(statement.values[0], PRINCIPAL);
});

test('omitted includeCollectionFollowers fails closed to owner-follow only', () => {
  // Same polarity as the fan-out recipient statement: only an explicit true
  // widens authority. A caller that forgets the option must not silently
  // bypass the collection-follow flag.
  const omitted = buildFeedPageStatement({ principalId: PRINCIPAL, limit: 10 });
  const disabled = buildFeedPageStatement(
    { principalId: PRINCIPAL, limit: 10 },
    { includeCollectionFollowers: false },
  );
  assert.equal(omitted.text, disabled.text);

  const collectionLateral = laterals(disabled.text).collection;
  assert.doesNotMatch(collectionLateral, /collection_follows/u);
  assert.match(collectionLateral, /from follows current_follow/u);
  assert.match(
    collectionLateral,
    /current_follow\.target_profile_id=item\.actor_profile_id/u,
  );
  assert.match(
    collectionLateral,
    /current_follow\.followed_at <= item\.published_at/u,
  );
  assert.doesNotMatch(disabled.text, /collection_follows/u);
  assert.doesNotMatch(omitted.text, /collection_follows/u);
  assert.equal(disabled.values[0], PRINCIPAL);
});

test('api feed query UoW threads collectionFollow.enabled into includeCollectionFollowers', async () => {
  const api = readApiCompositionSource(backendRoot);
  assert.match(
    api,
    /createPostgresFeedQueryUnitOfWork\(\s*database,\s*feedCursorKeys,\s*\{\s*includeCollectionFollowers:\s*config\.collectionFollow\.enabled,?\s*\}\)/u,
  );
});

test('follow_activity authority stays owner-follow only', () => {
  const statement = buildFeedPageStatement(
    { principalId: PRINCIPAL, kind: 'follow_activity', limit: 10 },
    { includeCollectionFollowers: true },
  );
  const followLateral = laterals(statement.text).follow;
  assert.match(followLateral, /item\.kind='follow_activity'/u);
  assert.doesNotMatch(followLateral, /collection_follows/u);
  assert.match(followLateral, /from follows current_follow/u);
});
