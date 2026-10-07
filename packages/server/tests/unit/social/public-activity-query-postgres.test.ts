import assert from 'node:assert/strict';
import { test } from 'vitest';
import { buildPublicActivityPageStatement } from '../../../src/infrastructure/social/index.js';

const ACTOR = 'IiIiIiIiIiIiIiIiIiIiIg';
const EVENT = 'FRUVFRUVFRUVFRUVFRUVFQ';
const ACTIVITY = 'Dw8PDw8PDw8PDw8PDw8PDw';

test('Activity page SQL copies public eligibility and exclusive keyset, not Feed rows', () => {
  const statement = buildPublicActivityPageStatement({
    actorProfileId: ACTOR,
    limit: 1,
    after: {
      publishedAt: new Date('2026-08-22T04:00:00.000Z'),
      sourceEventId: EVENT,
      activityId: ACTIVITY,
    },
  });
  assert.match(statement.text, /from social_public_activity item/u);
  assert.doesNotMatch(statement.text, /social_feed_items/u);
  assert.doesNotMatch(statement.text, /from follows/u);
  assert.match(statement.text, /collection\.visibility='public'/u);
  assert.match(statement.text, /collection\.publication_slug is not null/u);
  assert.match(statement.text, /collection\.published_at is not null/u);
  assert.match(statement.text, /collection\.deleted_at is null/u);
  assert.match(statement.text, /collection\.owner_subject_id=actor_account\.subject_id/u);
  assert.match(statement.text, /actor_account\.status='active'/u);
  assert.match(
    statement.text,
    /\(item\.published_at,item\.source_event_id,item\.activity_id\)\s+<\s+\(\$2::timestamptz,\$3::text,\$4::text\)/u,
  );
  assert.match(statement.text, /limit \$5/u);
  assert.equal(statement.values[0], ACTOR);
  assert.equal(statement.values[4], 2);
});
