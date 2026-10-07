import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  PUBLIC_ACTIVITY_CURSOR_PURPOSE,
  PUBLIC_ACTIVITY_CURSOR_TTL_MS,
  createPublicActivityCursorKeyring,
  queryCurrentPublicActivity,
  type PublicActivityPageReadInput,
  type PublicActivityPageReadPort,
  type PublicActivityQueryFact,
} from '../../../src/modules/social/index.js';

const NOW = new Date('2026-08-22T04:00:00.000Z');
const KEY = { id: 'activity-query-v1', secret: Buffer.alloc(32, 25).toString('base64') };
const ACTOR = 'IiIiIiIiIiIiIiIiIiIiIg';
const HANDLE = 'pa01-owner';

function fact(index: number): PublicActivityQueryFact {
  const stamp = new Date(NOW.getTime() - index * 1_000);
  return {
    activityId: `activity-${String(index).padStart(4, '0')}`,
    sourceEventId: `event-${String(index).padStart(4, '0')}`,
    kind: 'collection_change',
    collectionId: `collection-${String(index).padStart(4, '0')}`,
    collectionTitle: `Public title ${index}`,
    publicationSlug: `public-slug-${index}`,
    publishedAt: stamp,
  };
}

function reads(rows: PublicActivityQueryFact[], actorId = ACTOR): PublicActivityPageReadPort {
  return {
    async resolveActor(handle: string) {
      return handle === HANDLE ? { found: true, actorProfileId: actorId } : { found: false };
    },
    async loadPage(input: PublicActivityPageReadInput) {
      return rows.filter((row) => !input.after || row.publishedAt < input.after.publishedAt
        || (row.publishedAt.getTime() === input.after.publishedAt.getTime()
          && (row.sourceEventId < input.after.sourceEventId
            || (row.sourceEventId === input.after.sourceEventId
              && row.activityId < input.after.activityId))))
        .slice(0, input.limit + 1);
    },
  };
}

function ports(rows: PublicActivityQueryFact[]) {
  return {
    reads: reads(rows),
    cursors: createPublicActivityCursorKeyring({ active: KEY, retained: [] }),
    clock: { now: async () => NOW },
  };
}

test('maps joined title and slug and always includes optional keys', async () => {
  const queryPorts = ports([fact(0), fact(1)]);
  try {
    const page = await queryCurrentPublicActivity(queryPorts, { handle: HANDLE, limit: 10 });
    assert.equal(page.items.length, 2);
    assert.deepEqual(Object.keys(page.items[0]!).sort(), [
      'activityId', 'collectionId', 'collectionTitle', 'kind', 'publicationSlug', 'publishedAt', 'summary',
    ]);
    assert.equal(page.items[0]!.kind, 'collection_change');
    assert.equal(page.items[0]!.collectionTitle, 'Public title 0');
    assert.equal(page.items[0]!.publicationSlug, 'public-slug-0');
    assert.equal(page.items[0]!.summary, 'public_collection_updated');
    assert.doesNotMatch(JSON.stringify(page.items), /"details"|nodeIds|https?:\/\//u);
    assert.equal(page.nextCursor, null);
  } finally {
    queryPorts.cursors.destroy();
  }
});

test('rejects an unknown handle and a percent-encoded handle as not found', async () => {
  const queryPorts = ports([fact(0)]);
  try {
    await assert.rejects(
      () => queryCurrentPublicActivity(queryPorts, { handle: 'missing-owner' }),
      { name: 'PublicActivityNotFoundError', code: 'resource_not_found' },
    );
    await assert.rejects(
      () => queryCurrentPublicActivity(queryPorts, { handle: 'pa01%2eowner' }),
      { name: 'PublicActivityNotFoundError', code: 'resource_not_found' },
    );
  } finally {
    queryPorts.cursors.destroy();
  }
});

test('pages with exclusive keyset cursors without duplicate activity ids', async () => {
  const rows = [fact(0), fact(1), fact(2)];
  const queryPorts = ports(rows);
  try {
    const first = await queryCurrentPublicActivity(queryPorts, { handle: HANDLE, limit: 1 });
    assert.deepEqual(first.items.map((item) => item.activityId), ['activity-0000']);
    assert.equal(typeof first.nextCursor, 'string');
    const second = await queryCurrentPublicActivity(queryPorts, {
      handle: HANDLE, cursor: first.nextCursor!,
    });
    assert.deepEqual(second.items.map((item) => item.activityId), ['activity-0001']);
    assert.equal(second.items.some((item) => item.activityId === first.items[0]!.activityId), false);
  } finally {
    queryPorts.cursors.destroy();
  }
});

test('rejects unsafe projection rows from the read port', async () => {
  const queryPorts = ports([{ ...fact(0), collectionTitle: '' }]);
  try {
    await assert.rejects(
      () => queryCurrentPublicActivity(queryPorts, { handle: HANDLE }),
      /invalid public Activity safe projection/u,
    );
  } finally {
    queryPorts.cursors.destroy();
  }
  const slugPorts = ports([{ ...fact(0), publicationSlug: 'NOPE' }]);
  try {
    await assert.rejects(
      () => queryCurrentPublicActivity(slugPorts, { handle: HANDLE }),
      /invalid public Activity safe projection/u,
    );
  } finally {
    slugPorts.cursors.destroy();
  }
});

test('sealed Activity cursor purpose stays independent of Feed', async () => {
  assert.equal(PUBLIC_ACTIVITY_CURSOR_PURPOSE, 'social.public-activity.v1');
  assert.equal(PUBLIC_ACTIVITY_CURSOR_TTL_MS, 15 * 60 * 1000);
});
