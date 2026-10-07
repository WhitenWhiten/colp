import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'vitest';
import {
  FEED_CURSOR_PURPOSE,
  PUBLIC_ACTIVITY_CURSOR_PURPOSE,
  PUBLIC_ACTIVITY_CURSOR_TTL_MS,
  createFeedCursorKeyring,
  createPublicActivityCursorKeyring,
} from '../../../src/modules/social/index.js';

const NOW = new Date('2026-08-22T04:00:00.000Z');
const ACTIVITY_KEY = { id: 'activity-test-v1', secret: Buffer.alloc(32, 23).toString('base64') };
const FEED_KEY = { id: 'feed-test-v1', secret: Buffer.alloc(32, 24).toString('base64') };
const ACTOR = 'IiIiIiIiIiIiIiIiIiIiIg';
const EVENT = 'FRUVFRUVFRUVFRUVFRUVFQ';
const ACTIVITY = 'Dw8PDw8PDw8PDw8PDw8PDw';

test('public Activity cursor seals with an independent purpose and prefix', () => {
  const cursors = createPublicActivityCursorKeyring({ active: ACTIVITY_KEY, retained: [] });
  try {
    const token = cursors.activity.seal({
      v: 1,
      purpose: PUBLIC_ACTIVITY_CURSOR_PURPOSE,
      principalId: ACTOR,
      filter: '',
      limit: 30,
      comparatorVersion: 1,
      after: {
        publishedAt: NOW.toISOString(),
        sourceEventId: EVENT,
        activityId: ACTIVITY,
      },
      issuedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + PUBLIC_ACTIVITY_CURSOR_TTL_MS).toISOString(),
    });
    assert.match(token, /^spact1\./u);
    assert.equal(token.startsWith('sfeed1.'), false);
    const verified = cursors.activity.verify(token, new Date(NOW.getTime() + 1_000));
    assert.equal(verified.purpose, PUBLIC_ACTIVITY_CURSOR_PURPOSE);
    assert.equal(verified.principalId, ACTOR);
    assert.equal(verified.after.activityId, ACTIVITY);
  } finally {
    cursors.destroy();
  }
});

test('a Feed cursor is invalid against the public Activity codec', () => {
  const activity = createPublicActivityCursorKeyring({ active: ACTIVITY_KEY, retained: [] });
  const feed = createFeedCursorKeyring({ active: FEED_KEY, retained: [] });
  try {
    const token = feed.feed.seal({
      v: 1,
      purpose: FEED_CURSOR_PURPOSE,
      principalId: ACTOR,
      filter: '',
      limit: 30,
      comparatorVersion: 1,
      after: {
        publishedAt: NOW.toISOString(),
        sourceEventId: EVENT,
        feedItemId: ACTIVITY,
      },
      issuedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + PUBLIC_ACTIVITY_CURSOR_TTL_MS).toISOString(),
    });
    assert.match(token, /^sfeed1\./u);
    assert.throws(() => activity.activity.verify(token, new Date(NOW.getTime() + 1_000)), {
      name: 'PublicActivityCursorError',
      code: 'invalid_cursor',
    });
  } finally {
    activity.destroy();
    feed.destroy();
  }
});

test('public Activity cursor source does not import Feed cursor purpose', () => {
  const source = readFileSync(
    resolve(import.meta.dirname, '../../../src/modules/social/application/public-activity-cursor.ts'),
    'utf8',
  );
  assert.equal(source.includes('FEED_CURSOR_PURPOSE'), false);
  assert.equal(source.includes('feed-cursor'), false);
  assert.match(source, /social\.public-activity\.v1/u);
  assert.match(source, /spact1/u);
});
